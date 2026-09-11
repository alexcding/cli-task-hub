// Terminals — the Tauri analog of src/main/ipc/terminals.js, now as a CLIENT of the detached PTY
// daemon (ptyd.rs). No PTY lives in this process: `term_create` asks the daemon to spawn the shell,
// output arrives as daemon events that we re-emit to the window as `term://data` / `term://exit`,
// and the daemon outlives the app, so a relaunched TaskHub finds every shell still running and the
// renderer's rehydrateTerminals() reattaches them (term_list + term_attach replay).
//
// Every command is `#[tauri::command(async)]` so a connect/retry or a slow daemon never blocks the
// main thread (a sync command would run there and freeze the UI).
// Connection lifecycle: lazily connected on the first command; if the socket is absent or refused
// we spawn `taskhub __ptyd__ <dir>` detached (own session via setsid, stdio → ptyd.log) and retry
// briefly. A dropped connection (daemon exit) clears the handle; the next command reconnects and
// respawns as needed. Writes/resizes are fire-and-forget; create/list/attach/kill wait for a reply.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

pub use crate::ptyd::TermInfo;

const REPLY_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_RETRIES: u32 = 40; // × 100ms — how long to wait for a freshly spawned daemon

struct Conn {
  writer: UnixStream,
  pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
  generation: u64,
}

#[derive(Default)]
pub struct Terminals {
  conn: Mutex<Option<Conn>>,
  connecting: Mutex<()>, // serialises connect(): one spawn + one connection, never two
  skew: std::sync::atomic::AtomicBool, // the daemon speaks another protocol version
  daemon_pid: std::sync::atomic::AtomicI32, // from the handshake — the daemon we are actually talking to
  req_seq: AtomicU64,
  gen_seq: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attached {
  buf: String,
  seq: u64,
  // false only when the daemon reports the id unknown (PTY gone). A daemon that couldn't answer
  // (timeout, older protocol without the field) reads as live: never dispose on doubt.
  live: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Foreground {
  process: String,
  at_shell: bool,
}

// Where the daemon keeps its socket, pid file, log, and manifests: <app data dir>/ptyd/.
pub(crate) fn ptyd_dir(app: &AppHandle) -> PathBuf {
  let base = app
    .path()
    .app_data_dir()
    .ok()
    .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())).join(".taskhub"));
  base.join("ptyd")
}

fn spawn_daemon(dir: &PathBuf) -> Result<(), String> {
  use std::os::unix::process::CommandExt;
  let exe = std::env::current_exe().map_err(|e| e.to_string())?;
  std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  let log = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(dir.join("ptyd.log"))
    .map_err(|e| e.to_string())?;
  let log2 = log.try_clone().map_err(|e| e.to_string())?;
  let mut cmd = std::process::Command::new(exe);
  cmd
    .arg("__ptyd__")
    .arg(dir)
    .stdin(std::process::Stdio::null())
    .stdout(log)
    .stderr(log2);
  // Own session + process group: the daemon must not die with the app, with the `tauri dev`
  // terminal, or with the shell that launched either (no SIGHUP/SIGINT inheritance).
  unsafe {
    cmd.pre_exec(|| {
      libc::setsid();
      Ok(())
    });
  }
  let mut child = cmd.spawn().map_err(|e| format!("spawn ptyd: {e}"))?;
  // Reap it when it eventually exits (idle) so it never lingers as a zombie of the app.
  std::thread::spawn(move || {
    let _ = child.wait();
  });
  log::info!("spawned ptyd in {}", dir.display());
  Ok(())
}

impl Terminals {
  // Get (or establish) the daemon connection. Holds the conn lock only briefly; the reader
  // thread owns the read half and dispatches replies/events.
  fn connect(&self, app: &AppHandle) -> Result<(), String> {
    if self.conn.lock().unwrap().is_some() {
      return Ok(());
    }
    // One connector at a time: a concurrent command waits here, then finds the connection made.
    let _guard = self.connecting.lock().unwrap();
    if self.conn.lock().unwrap().is_some() {
      return Ok(());
    }
    let dir = ptyd_dir(app);
    let sock = crate::ptyd::sock_path();
    if sock.exists() && !crate::ptyd::owned_socket(&sock) {
      return Err(format!("{} is not owned by this user; refusing to connect", sock.display()));
    }
    let mut stream = UnixStream::connect(&sock).ok();
    if stream.is_none() {
      spawn_daemon(&dir)?;
      for _ in 0..CONNECT_RETRIES {
        std::thread::sleep(Duration::from_millis(100));
        if let Ok(s) = UnixStream::connect(&sock) {
          stream = Some(s);
          break;
        }
      }
    }
    let stream = stream.ok_or_else(|| format!("ptyd did not come up at {}", sock.display()))?;
    let writer = stream.try_clone().map_err(|e| e.to_string())?;
    let pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
    let generation = self.gen_seq.fetch_add(1, Ordering::SeqCst) + 1;

    let app2 = app.clone();
    let pending2 = pending.clone();
    std::thread::spawn(move || {
      let reader = BufReader::new(stream);
      for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(ev) = v.get("ev").and_then(Value::as_str) {
          match ev {
            "data" => {
              let _ = app2.emit("term://data", json!({ "id": v["id"], "chunk": v["chunk"], "seq": v["seq"] }));
            }
            "exit" => {
              let _ = app2.emit("term://exit", json!({ "id": v["id"], "exitCode": v["exitCode"], "signal": v["signal"] }));
            }
            _ => {}
          }
        } else if let Some(id) = v.get("id").and_then(Value::as_u64) {
          if let Some(tx) = pending2.lock().unwrap().remove(&id) {
            let _ = tx.send(v);
          }
        }
      }
      // Daemon went away: drop the handle so the next command reconnects (and respawns). Waiters
      // are released by their timeout. Only clear if it is still OUR connection.
      log::warn!("ptyd connection closed");
      if let Some(state) = app2.try_state::<Terminals>() {
        let mut c = state.conn.lock().unwrap();
        if c.as_ref().map(|c| c.generation) == Some(generation) {
          *c = None;
        }
      }
    });

    *self.conn.lock().unwrap() = Some(Conn { writer, pending, generation });
    // A new connection may be a new daemon: forget the last one's pid (and skew) until this
    // handshake says otherwise, so a failed hello never leaves kill_all signalling a stale pid.
    self.daemon_pid.store(0, Ordering::SeqCst);
    self.skew.store(false, Ordering::SeqCst);
    // Handshake: a daemon from an older build keeps serving its shells (that is the point), but if
    // it speaks another protocol version we stop creating terminals through it and tell the user.
    if let Ok(h) = self.request(app, json!({ "op": "hello" })) {
      log::info!("ptyd hello: {h}");
      let proto = h["protocol"].as_u64().unwrap_or(0) as u32;
      self.daemon_pid.store(h["pid"].as_i64().unwrap_or(0) as i32, Ordering::SeqCst);
      let skew = proto != crate::ptyd::PROTOCOL;
      self.skew.store(skew, Ordering::SeqCst);
      if skew {
        log::error!("ptyd protocol {proto} != app protocol {} — quit TaskHub from the tray, then relaunch", crate::ptyd::PROTOCOL);
      }
    }
    Ok(())
  }

  fn send(&self, app: &AppHandle, mut req: Value, want_reply: bool) -> Result<Option<(mpsc::Receiver<Value>, u64)>, String> {
    self.connect(app)?;
    let mut guard = self.conn.lock().unwrap();
    let conn = guard.as_mut().ok_or("ptyd not connected")?;
    let rx = if want_reply {
      let id = self.req_seq.fetch_add(1, Ordering::SeqCst) + 1;
      req["id"] = json!(id);
      let (tx, rx) = mpsc::channel();
      conn.pending.lock().unwrap().insert(id, tx);
      Some((rx, id))
    } else {
      None
    };
    let line = format!("{req}\n");
    if let Err(e) = conn.writer.write_all(line.as_bytes()).and_then(|_| conn.writer.flush()) {
      *guard = None;
      return Err(format!("ptyd write: {e}"));
    }
    Ok(rx)
  }

  fn request(&self, app: &AppHandle, req: Value) -> Result<Value, String> {
    let (rx, id) = self.send(app, req, true)?.unwrap();
    let v = rx.recv_timeout(REPLY_TIMEOUT).map_err(|_| {
      // Forget the waiter so a timed-out request doesn't leak its slot.
      if let Some(c) = self.conn.lock().unwrap().as_ref() {
        c.pending.lock().unwrap().remove(&id);
      }
      "ptyd reply timed out".to_string()
    })?;
    if let Some(e) = v.get("err").and_then(Value::as_str) {
      return Err(e.to_string());
    }
    Ok(v.get("ok").cloned().unwrap_or(Value::Null))
  }

  fn fire(&self, app: &AppHandle, req: Value) {
    if let Err(e) = self.send(app, req, false) {
      log::warn!("ptyd: {e}");
    }
  }
}

#[tauri::command(async)]
pub fn term_create(app: AppHandle, state: State<Terminals>, opts: Option<Value>) -> Result<TermInfo, String> {
  state.connect(&app)?;
  if state.skew.load(Ordering::SeqCst) {
    return Err("The terminal daemon is from an older TaskHub build. Quit TaskHub from the tray, then relaunch.".into());
  }
  let v = state.request(&app, json!({ "op": "create", "opts": opts.unwrap_or(json!({})) }))?;
  serde_json::from_value(v).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn term_write(app: AppHandle, state: State<Terminals>, id: String, data: String) {
  state.fire(&app, json!({ "op": "write", "term": id, "data": data }));
}

#[tauri::command(async)]
// Unlike the other fire-and-forget ops this one REPORTS a failed send. The renderer memoizes the
// last grid it sent (terminal.js fitTerm, so an unchanged size doesn't SIGWINCH a full-screen TUI
// into a repaint); if the write is lost — ptyd disconnected mid-drag — that memo would suppress
// every later fit at the same size and leave the PTY stuck at its old dimensions. The error is
// what tells the renderer to drop the memo and re-send.
pub fn term_resize(app: AppHandle, state: State<Terminals>, id: String, cols: u16, rows: u16) -> Result<(), String> {
  state.send(&app, json!({ "op": "resize", "term": id, "cols": cols, "rows": rows }), false).map(|_| ())
}

// Renderer flow control: pause/resume this terminal's PTY reads while xterm's write buffer runs ahead.
#[tauri::command(async)]
pub fn term_flow(app: AppHandle, state: State<Terminals>, id: String, pause: bool) {
  state.fire(&app, json!({ "op": "flow", "term": id, "pause": pause }));
}

#[tauri::command(async)]
pub fn term_kill(app: AppHandle, state: State<Terminals>, id: String) -> bool {
  state.request(&app, json!({ "op": "kill", "term": id })).ok().and_then(|v| v.as_bool()).unwrap_or(false)
}

#[tauri::command(async)]
pub fn term_list(app: AppHandle, state: State<Terminals>) -> Vec<TermInfo> {
  state
    .request(&app, json!({ "op": "list" }))
    .ok()
    .and_then(|v| serde_json::from_value(v).ok())
    .unwrap_or_default()
}

#[tauri::command(async)]
pub fn term_attach(app: AppHandle, state: State<Terminals>, id: String) -> Attached {
  match state.request(&app, json!({ "op": "attach", "term": id })) {
    Ok(v) => Attached {
      buf: v["buf"].as_str().unwrap_or("").to_string(),
      seq: v["seq"].as_u64().unwrap_or(0),
      live: v["live"].as_bool().unwrap_or(true),
    },
    Err(_) => Attached { buf: String::new(), seq: 0, live: true },
  }
}

// Asked of the daemon, which owns the PTY: tcgetpgrp on the master vs the shell's pid. A daemon
// that can't answer (timeout, old protocol) reads as at-prompt, the pre-detection default — but
// NOT silently forever: build.js/cli-launch.js both act on `atShell`, and a stub that always said
// "true" once let a still-running build be re-launched on every click.
#[tauri::command(async)]
pub fn term_foreground(app: AppHandle, state: State<Terminals>, id: String) -> Foreground {
  match state.request(&app, json!({ "op": "foreground", "term": id })) {
    Ok(v) => Foreground {
      process: v["process"].as_str().unwrap_or("").to_string(),
      at_shell: v["atShell"].as_bool().unwrap_or(true),
    },
    Err(_) => Foreground { process: String::new(), at_shell: true },
  }
}

// Connect eagerly at startup so the daemon is up (and its events flowing) before the renderer's
// rehydrateTerminals() asks for the list.
pub fn warm_up(app: &AppHandle) {
  if let Some(state) = app.try_state::<Terminals>() {
    if let Err(e) = state.connect(app) {
      log::error!("ptyd: {e}");
    }
  }
}

// Kill every terminal and the daemon — the tray Quit's teardown (lib.rs quit_app).
pub fn kill_all(app: &AppHandle) {
  let Some(state) = app.try_state::<Terminals>() else { return };
  let sock = crate::ptyd::sock_path();
  // Nothing to stop: no connection and nobody listening. (request() would otherwise SPAWN a
  // daemon just to kill it, delaying the quit.)
  if state.conn.lock().unwrap().is_none() && UnixStream::connect(&sock).is_err() {
    return;
  }
  if let Err(e) = state.request(app, json!({ "op": "killAll" })) {
    // Leave the daemon (and its shells, manifests) inspectable rather than SIGHUP them blind.
    log::warn!("ptyd killAll failed ({e}); daemon left running");
    return;
  }
  // …and the daemon itself. Left to its own idle exit (30s with no terminals AND no client) it
  // survived any relaunch quicker than that — so after a rebuild, quit then
  // relaunch kept serving through the OLD binary, and a new op (foreground) never went live.
  // The pid is the one the daemon gave us in the handshake, never the pid file: that file outlives
  // a crash or a reboot and could then name an unrelated process.
  let pid = state.daemon_pid.load(Ordering::SeqCst);
  if pid <= 1 {
    log::warn!("ptyd pid unknown; daemon left running");
    return;
  }
  if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
    log::warn!("ptyd {pid}: SIGTERM failed ({})", std::io::Error::last_os_error());
    return;
  }
  // Wait (briefly) until the socket refuses: a relaunch racing a daemon that is only about to die
  // would otherwise connect to its still-bound listener.
  for _ in 0..20 {
    if UnixStream::connect(&sock).is_err() {
      break;
    }
    std::thread::sleep(Duration::from_millis(50));
  }
  let _ = std::fs::remove_file(ptyd_dir(app).join("ptyd.pid"));
  log::info!("ptyd {pid} stopped");
}
