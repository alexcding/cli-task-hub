// Terminals (M4) — the Tauri analog of src/main/ipc/terminals.js. Each open terminal is an
// independent OS pseudo-terminal (portable-pty) keyed by id, so many worktree folders can have
// their own live shell at once. The renderer (window.taskhub.term) drives each by id:
// create → write/onData → resize → kill. Output is pushed to the window as `term://data` events;
// the shell's death is announced as `term://exit`. PTYs outlive the window like in the Electron
// build (kept in the global registry until killed).
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const BUF_MAX: usize = 256 * 1024; // per-terminal output kept for replay when a window reattaches

// Rolling tail of output kept as whole UTF-8 string chunks (never split mid-codepoint — see the
// read loop) so a reopened window can replay the recent screen. Each chunk carries a monotonic
// seq so the renderer replays the backlog then resumes the live stream with no gap/dup.
struct Buf {
  chunks: Vec<String>,
  len: usize,
  seq: u64,
}

struct Term {
  writer: Box<dyn Write + Send>,
  master: Box<dyn MasterPty + Send>,
  child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
  cwd: String,
  title: String,
  paired: bool,
  pair_key: String,
  has_context: bool,
  buf: Arc<Mutex<Buf>>,
}

#[derive(Default)]
pub struct Terminals {
  map: Mutex<HashMap<String, Term>>,
  seq: AtomicU64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateOpts {
  cwd: Option<String>,
  shell: Option<String>,
  #[serde(default)]
  paired: bool,
  #[serde(default)]
  pair_key: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
  id: String,
  cwd: String,
  title: String,
  paired: bool,
  pair_key: String,
  has_context: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DataEvt {
  id: String,
  chunk: String,
  seq: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvt {
  id: String,
  exit_code: i64,
  signal: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attached {
  buf: String,
  seq: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Foreground {
  process: String,
  at_shell: bool,
}

fn fallback_dir(app: &AppHandle) -> String {
  // In dev the app's own repo; otherwise the user's home.
  if let Ok(p) = app.path().resource_dir() {
    if let Some(s) = p.to_str() {
      if !s.is_empty() {
        return s.to_string();
      }
    }
  }
  std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

#[tauri::command]
pub fn term_create(
  app: AppHandle,
  state: State<Terminals>,
  opts: Option<CreateOpts>,
) -> Result<TermInfo, String> {
  let opts = opts.unwrap_or_default();
  let id = format!("pty{}", state.seq.fetch_add(1, Ordering::SeqCst) + 1);

  let dir = match opts.cwd {
    Some(ref c) if !c.is_empty() => c.clone(),
    _ => fallback_dir(&app),
  };
  // Spawning a shell with a non-existent cwd fails deep in portable_pty as a cryptic
  // "No such file or directory (os error 2)" with no hint which path is missing. Catch it
  // here so the renderer toast names the directory — usually a worktree that wasn't created
  // (or was pruned) before we tried to open its terminal.
  if !std::path::Path::new(&dir).is_dir() {
    return Err(format!("working directory does not exist: {dir}"));
  }
  let shell_path = opts
    .shell
    .clone()
    .filter(|s| !s.is_empty())
    .or_else(|| std::env::var("SHELL").ok())
    .unwrap_or_else(|| "/bin/zsh".into());

  let pty_system = native_pty_system();
  let pair = pty_system
    .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
    .map_err(|e| e.to_string())?;

  // Login + interactive shell so it sources dotfiles and gets the full environment
  // (PATH, nvm, Homebrew, aliases) — like a Terminal.app tab.
  let mut cmd = CommandBuilder::new(&shell_path);
  cmd.args(["-l", "-i"]);
  cmd.cwd(&dir);
  cmd.env("TERM", "xterm-256color");
  cmd.env("COLORTERM", "truecolor");
  cmd.env("LANG", std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()));
  // TASKHUB_RUN_ID lets an installed Claude/Codex hook ping back tagged with THIS terminal's id.
  cmd.env("TASKHUB_RUN_ID", &id);

  let child = pair
    .slave
    .spawn_command(cmd)
    .map_err(|e| format!("failed to start shell {shell_path} in {dir}: {e}"))?;
  let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
  let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

  let buf = Arc::new(Mutex::new(Buf { chunks: Vec::new(), len: 0, seq: 0 }));
  let child = Arc::new(Mutex::new(child));
  let title = std::path::Path::new(&dir)
    .file_name()
    .and_then(|s| s.to_str())
    .unwrap_or(&dir)
    .to_string();

  let entry = Term {
    writer,
    master: pair.master,
    child: child.clone(),
    cwd: dir.clone(),
    title: title.clone(),
    paired: opts.paired,
    pair_key: opts.pair_key.clone(),
    has_context: false,
    buf: buf.clone(),
  };
  state.map.lock().unwrap().insert(id.clone(), entry);

  // Reader thread: decode bytes to whole UTF-8 chunks (keeping any incomplete trailing bytes for
  // the next read so we never emit a split codepoint), buffer a rolling tail, and stream live.
  let app2 = app.clone();
  let id2 = id.clone();
  std::thread::spawn(move || {
    let mut tmp = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    loop {
      match reader.read(&mut tmp) {
        Ok(0) | Err(_) => break,
        Ok(n) => {
          pending.extend_from_slice(&tmp[..n]);
          let valid = match std::str::from_utf8(&pending) {
            Ok(s) => s.len(),
            Err(e) => e.valid_up_to(),
          };
          if valid == 0 {
            continue;
          }
          let s = String::from_utf8_lossy(&pending[..valid]).into_owned();
          pending.drain(..valid);

          let seq = {
            let mut b = buf.lock().unwrap();
            b.seq += 1;
            b.len += s.len();
            b.chunks.push(s.clone());
            while b.len > BUF_MAX && b.chunks.len() > 1 {
              let removed = b.chunks.remove(0).len();
              b.len -= removed;
            }
            b.seq
          };
          let _ = app2.emit("term://data", DataEvt { id: id2.clone(), chunk: s, seq });
        }
      }
    }

    // Shell exited (or read failed): reap the child for its status, drop it from the registry,
    // and announce the death so the renderer can clean up the tab.
    let (exit_code, signal) = {
      let mut c = child.lock().unwrap();
      match c.wait() {
        Ok(status) => (status.exit_code() as i64, 0),
        Err(_) => (0, 0),
      }
    };
    if let Some(state) = app2.try_state::<Terminals>() {
      state.map.lock().unwrap().remove(&id2);
    }
    let _ = app2.emit("term://exit", ExitEvt { id: id2.clone(), exit_code, signal });
  });

  Ok(TermInfo {
    id,
    cwd: dir,
    title,
    paired: opts.paired,
    pair_key: opts.pair_key,
    has_context: false,
  })
}

#[tauri::command]
pub fn term_write(state: State<Terminals>, id: String, data: String) {
  let mut map = state.map.lock().unwrap();
  if let Some(t) = map.get_mut(&id) {
    t.has_context = true;
    let _ = t.writer.write_all(data.as_bytes());
    let _ = t.writer.flush();
  }
}

#[tauri::command]
pub fn term_resize(state: State<Terminals>, id: String, cols: u16, rows: u16) {
  let map = state.map.lock().unwrap();
  if let Some(t) = map.get(&id) {
    let _ = t.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
  }
}

#[tauri::command]
pub fn term_kill(state: State<Terminals>, id: String) -> bool {
  let entry = state.map.lock().unwrap().remove(&id);
  if let Some(t) = entry {
    let _ = t.child.lock().unwrap().kill();
    true
  } else {
    false
  }
}

#[tauri::command]
pub fn term_list(state: State<Terminals>) -> Vec<TermInfo> {
  state
    .map
    .lock()
    .unwrap()
    .iter()
    .map(|(id, t)| TermInfo {
      id: id.clone(),
      cwd: t.cwd.clone(),
      title: t.title.clone(),
      paired: t.paired,
      pair_key: t.pair_key.clone(),
      has_context: t.has_context,
    })
    .collect()
}

#[tauri::command]
pub fn term_attach(state: State<Terminals>, id: String) -> Attached {
  let map = state.map.lock().unwrap();
  match map.get(&id) {
    Some(t) => {
      let b = t.buf.lock().unwrap();
      Attached { buf: b.chunks.concat(), seq: b.seq }
    }
    None => Attached { buf: String::new(), seq: 0 },
  }
}

#[tauri::command]
pub fn term_foreground(_state: State<Terminals>, _id: String) -> Foreground {
  // portable-pty doesn't expose the PTY's foreground process; assume at-prompt. Accurate
  // detection (used to decide whether a workflow should launch the CLI) is deferred — see
  // docs/TAURI-PORT.md M4.
  Foreground { process: String::new(), at_shell: true }
}

// Kill every terminal — called on real app quit.
pub fn kill_all(app: &AppHandle) {
  if let Some(state) = app.try_state::<Terminals>() {
    let mut map = state.map.lock().unwrap();
    for (_, t) in map.drain() {
      let _ = t.child.lock().unwrap().kill();
    }
  }
}
