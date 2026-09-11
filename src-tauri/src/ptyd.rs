// ptyd — the detached PTY daemon. Every terminal TaskHub opens lives HERE, not in the app process,
// so quitting, crashing, or rebuilding TaskHub never kills a shell (the unpeel / tmux model: the app
// is only an attachment). `taskhub __ptyd__ <dir>` runs this loop in place of the Tauri app; the
// host (terminals.rs) spawns it detached (own session, stdio to <dir>/ptyd.log) the first time it
// cannot connect, then talks to it over the Unix socket sock_path().
//
// Wire protocol: newline-delimited JSON, both directions, on one connection.
//   request  {"id":<n>, "op":"hello"|"create"|"write"|"resize"|"kill"|"killAll"|"list"|"attach"|"flow"|"foreground", ...}
//   response {"id":<n>, "ok":<value>}  or  {"id":<n>, "err":"..."}
//   event    {"ev":"data", "id":"pty..", "chunk":"..", "seq":<n>}   (fanned out to EVERY client)
//            {"ev":"exit", "id":"pty..", "exitCode":<n>, "signal":<n>}
// A request without "id" gets no response (writes/resizes/flow are fire-and-forget).
//
// Performance model (borrowed from unpeel's PTY core):
//   • The PTY master is O_NONBLOCK and each terminal has ONE poll()-driven thread that owns both
//     directions. Output is BATCHED: after the first byte it keeps collecting for a short window
//     (BATCH_WAIT_MS, up to BATCH_MAX_MS / BATCH_MAX_BYTES) so a flood becomes a few large events
//     per frame instead of thousands of tiny ones. One `seq` per batch == one ring chunk, so a
//     reattaching client's "replay ring, then events with seq > ring seq" stays exact.
//   • Input never blocks anyone: a write copies into the terminal's bounded queue (INPUT_MAX),
//     the poll thread drains it on POLLOUT. A program that stops reading stdin stalls only itself.
//   • Every client has its own outbox thread + byte budget. A client above OUTBOX_MAX, or one that
//     made no progress for STALL_DROP while owing bytes, is dropped — never waited on. While any
//     client owes more than BACKLOG_HIGH the PTY reads pause (resuming below BACKLOG_LOW), so a slow
//     viewer bounds memory instead of growing it. The renderer can also ask for a pause directly
//     ("flow") when its xterm write buffer runs ahead.
//
// On disk (for inspection / scripting; the daemon itself is the source of truth):
//   <dir>/terms/<id>.json   manifest — cwd, title, pairKey, hasContext, shell pid, created
//   <dir>/ptyd.pid          the daemon's pid
//   /tmp/taskhub-ptyd-<uid>.sock  the control socket (see sock_path)
// The daemon exits by itself once it holds no terminals and no client for IDLE_EXIT.
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::io::RawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const PROTOCOL: u32 = 2;
const RING_MAX: usize = 256 * 1024; // per-terminal rolling output tail replayed to (re)attaching clients
const IDLE_EXIT: Duration = Duration::from_secs(30);

const BATCH_WAIT_MS: i32 = 12; // after a read, wait this long for more before emitting
const BATCH_MAX_MS: u128 = 32; // …but never hold a batch longer than this
const BATCH_MAX_BYTES: usize = 128 * 1024; // …or larger than this
const READ_CHUNK: usize = 64 * 1024;

const INPUT_MAX: usize = 1024 * 1024; // queued keystrokes/paste per terminal before we drop input
const OUTBOX_MAX: usize = 8 * 1024 * 1024; // per-client unsent bytes before the client is dropped
const STALL_DROP: Duration = Duration::from_secs(60); // owing bytes with no progress this long → drop
const BACKLOG_HIGH: usize = 4 * 1024 * 1024; // any client owing this much pauses PTY reads…
const BACKLOG_LOW: usize = 1024 * 1024; // …until every client is below this

// The socket lives in a PRIVATE per-user directory at a SHORT path: AF_UNIX paths are capped at
// 104 bytes on macOS and "~/Library/Application Support/<bundle id>/…" overruns that for longer
// usernames, and a predictable name in the shared sticky /tmp could be squatted by another local
// user (our probe would then defer to their listener and the app would talk to it). macOS's
// per-user $TMPDIR (/var/folders/…/T/, mode 0700) is both short and private; otherwise
// /tmp/taskhub-<uid>/ is created 0700. Callers verify the path's owner before trusting it.
pub fn sock_path() -> PathBuf {
  // TASKHUB_PTYD_SOCK overrides it — for tests and for running a second, isolated daemon.
  if let Some(p) = std::env::var_os("TASKHUB_PTYD_SOCK").filter(|p| !p.is_empty()) {
    return PathBuf::from(p);
  }
  let uid = unsafe { libc::getuid() };
  let dir = std::env::var_os("TMPDIR")
    .map(PathBuf::from)
    .filter(|d| d.is_absolute() && d.as_os_str().len() < 70 && owned_private_dir(d))
    .unwrap_or_else(|| {
      let d = PathBuf::from(format!("/tmp/taskhub-{uid}"));
      let _ = std::fs::DirBuilder::new().mode(0o700).create(&d);
      d
    });
  dir.join("taskhub-ptyd.sock")
}

// True when `p` exists, is owned by us, and grants nothing to group/other.
pub fn owned_private_dir(p: &Path) -> bool {
  use std::os::unix::fs::MetadataExt;
  match std::fs::metadata(p) {
    Ok(m) => m.is_dir() && m.uid() == unsafe { libc::getuid() } && (m.mode() & 0o077) == 0,
    Err(_) => false,
  }
}

// True when the socket file at `p` is owned by us (refuse to talk to anyone else's listener).
pub fn owned_socket(p: &Path) -> bool {
  use std::os::unix::fs::MetadataExt;
  std::fs::metadata(p).map(|m| m.uid() == unsafe { libc::getuid() }).unwrap_or(false)
}

struct Ring {
  chunks: Vec<String>,
  len: usize,
  seq: u64,
}

// The write side of a PTY: the (non-blocking) writer plus the bounded queue of bytes it could not
// take yet. Held only for the duration of a non-blocking write, so it never blocks the caller.
struct Input {
  writer: Box<dyn Write + Send>,
  queue: VecDeque<u8>,
  dropped: usize,
}

struct Term {
  master: Box<dyn MasterPty + Send>,
  child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
  input: Arc<Mutex<Input>>,
  wake_w: RawFd, // self-pipe: poke the poll thread (queued input, flow change, kill)
  paused: Arc<AtomicBool>, // renderer-requested flow pause
  killed: Arc<AtomicBool>, // kill requested: the I/O thread reaps, removes, and announces exit
  info: TermInfo,
  ring: Arc<Mutex<Ring>>,
}

impl Drop for Term {
  fn drop(&mut self) {
    unsafe { libc::close(self.wake_w) };
  }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
  pub id: String,
  pub cwd: String,
  pub title: String,
  pub paired: bool,
  pub pair_key: String,
  pub has_context: bool,
  #[serde(default)]
  pub pid: u32,
  #[serde(default)]
  pub created: u64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateOpts {
  pub cwd: Option<String>,
  pub shell: Option<String>,
  #[serde(default)]
  pub paired: bool,
  #[serde(default)]
  pub pair_key: String,
}

// A connected client: lines go through `tx` to its outbox thread, which is the ONLY writer on the
// socket (responses and events share it, so frames never interleave). `owed` is the byte budget.
struct Client {
  id: u64,
  tx: mpsc::Sender<Arc<str>>,
  owed: Arc<AtomicUsize>,
  progress: Arc<Mutex<Instant>>,
  sock: UnixStream,
}

struct Daemon {
  dir: PathBuf,
  terms: Mutex<HashMap<String, Term>>,
  clients: Mutex<Vec<Client>>,
  seq: AtomicU64,
  client_seq: AtomicU64,
  boot: u64,
  idle_since: Mutex<Option<Instant>>,
}

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn log(msg: &str) {
  eprintln!("[ptyd {}] {msg}", chrono::Local::now().format("%H:%M:%S"));
}

// The executable name of a pid (macOS proc_pidpath), "" when it can't be read.
fn proc_name(pid: libc::pid_t) -> String {
  let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
  let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32) };
  if n <= 0 {
    return String::new();
  }
  let path = String::from_utf8_lossy(&buf[..n as usize]).into_owned();
  path.rsplit('/').next().unwrap_or("").to_string()
}

fn set_nonblocking(fd: RawFd) {
  unsafe {
    let fl = libc::fcntl(fd, libc::F_GETFL);
    if fl >= 0 {
      libc::fcntl(fd, libc::F_SETFL, fl | libc::O_NONBLOCK);
    }
  }
}

fn poll2(fds: &mut [libc::pollfd], timeout_ms: i32) -> i32 {
  loop {
    let r = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout_ms) };
    if r < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
      continue;
    }
    return r;
  }
}

fn poke(fd: RawFd) {
  unsafe { libc::write(fd, [1u8].as_ptr() as *const libc::c_void, 1) };
}

// Drain the input queue with non-blocking writes. Returns true when something is still queued.
fn drain_input(inp: &mut Input) -> bool {
  while !inp.queue.is_empty() {
    let (a, _) = inp.queue.as_slices();
    match inp.writer.write(a) {
      Ok(0) => break,
      Ok(n) => {
        inp.queue.drain(..n);
      }
      Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
      Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
      Err(_) => {
        inp.queue.clear();
        break;
      }
    }
  }
  !inp.queue.is_empty()
}

impl Daemon {
  fn manifest_path(&self, id: &str) -> PathBuf {
    self.dir.join("terms").join(format!("{id}.json"))
  }

  fn write_manifest(&self, info: &TermInfo) {
    let p = self.manifest_path(&info.id);
    let _ = std::fs::create_dir_all(p.parent().unwrap());
    if let Ok(s) = serde_json::to_string_pretty(info) {
      let _ = std::fs::write(p, s);
    }
  }

  // Fan one line out to every client through its outbox. Never blocks: a client over budget, or
  // stalled while owing bytes, is dropped right here (its outbox thread then closes the socket).
  fn broadcast(&self, v: &Value) {
    let line: Arc<str> = Arc::from(format!("{v}\n"));
    let mut cs = self.clients.lock().unwrap();
    cs.retain(|c| self.offer(c, &line));
  }

  fn offer(&self, c: &Client, line: &Arc<str>) -> bool {
    let owed = c.owed.load(Ordering::Relaxed);
    let stalled = owed > 0 && c.progress.lock().unwrap().elapsed() > STALL_DROP;
    if owed > OUTBOX_MAX || stalled {
      log(&format!("client {} dropped: owed {owed} bytes{}", c.id, if stalled { ", stalled" } else { "" }));
      let _ = c.sock.shutdown(std::net::Shutdown::Both);
      return false;
    }
    c.owed.fetch_add(line.len(), Ordering::Relaxed);
    c.tx.send(line.clone()).is_ok()
  }

  fn reply(&self, cid: u64, v: &Value) {
    let line: Arc<str> = Arc::from(format!("{v}\n"));
    let cs = self.clients.lock().unwrap();
    if let Some(c) = cs.iter().find(|c| c.id == cid) {
      self.offer(c, &line);
    }
  }

  fn max_owed(&self) -> usize {
    self.clients.lock().unwrap().iter().map(|c| c.owed.load(Ordering::Relaxed)).max().unwrap_or(0)
  }

  fn create(self: &Arc<Self>, opts: CreateOpts) -> Result<TermInfo, String> {
    let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
    // Unique across daemon restarts so a stale id persisted by the renderer never collides.
    let id = format!("pty{}-{n}", self.boot);
    let dir = opts
      .cwd
      .filter(|c| !c.is_empty())
      .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/".into()));
    if !Path::new(&dir).is_dir() {
      return Err(format!("working directory does not exist: {dir}"));
    }
    let shell_path = opts
      .shell
      .filter(|s| !s.is_empty())
      .or_else(|| std::env::var("SHELL").ok())
      .unwrap_or_else(|| "/bin/zsh".into());

    let pair = native_pty_system()
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
    drop(pair.slave); // the master must see EOF when the child closes its side
    let pid = child.process_id().unwrap_or(0);
    let master_fd = pair.master.as_raw_fd().ok_or("pty master has no fd")?;
    set_nonblocking(master_fd); // shared by the reader/writer dups below
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let mut pipe = [0 as RawFd; 2];
    if unsafe { libc::pipe(pipe.as_mut_ptr()) } != 0 {
      return Err("pipe() failed".into());
    }
    set_nonblocking(pipe[0]);
    set_nonblocking(pipe[1]);
    let (wake_r, wake_w) = (pipe[0], pipe[1]);

    let title = Path::new(&dir).file_name().and_then(|s| s.to_str()).unwrap_or(&dir).to_string();
    let info = TermInfo {
      id: id.clone(),
      cwd: dir,
      title,
      paired: opts.paired,
      pair_key: opts.pair_key,
      has_context: false,
      pid,
      created: now_ms(),
    };
    let ring = Arc::new(Mutex::new(Ring { chunks: Vec::new(), len: 0, seq: 0 }));
    let input = Arc::new(Mutex::new(Input { writer, queue: VecDeque::new(), dropped: 0 }));
    let paused = Arc::new(AtomicBool::new(false));
    let killed = Arc::new(AtomicBool::new(false));
    let child = Arc::new(Mutex::new(child));
    self.terms.lock().unwrap().insert(
      id.clone(),
      Term {
        master: pair.master,
        child: child.clone(),
        input: input.clone(),
        wake_w,
        paused: paused.clone(),
        killed: killed.clone(),
        info: info.clone(),
        ring: ring.clone(),
      },
    );
    self.write_manifest(&info);
    *self.idle_since.lock().unwrap() = None;
    log(&format!("create {id} pid={pid} cwd={}", info.cwd));

    // The terminal's one I/O thread: poll the master (+ wake pipe), batch output, drain input.
    let me = self.clone();
    std::thread::spawn(move || {
      let mut tmp = vec![0u8; READ_CHUNK];
      let mut pending: Vec<u8> = Vec::new(); // bytes read but not yet emitted (batch + utf-8 tail)
      let mut backlog_paused = false;
      let hangup: bool;
      'io: loop {
        if killed.load(Ordering::Relaxed) {
          break 'io; // kill(): the child was signalled; fall through to reap + announce
        }
        // Interest: reads unless paused (renderer flow or client backlog); writes while queued.
        let owed = me.max_owed();
        if backlog_paused && owed < BACKLOG_LOW {
          backlog_paused = false;
        } else if !backlog_paused && owed > BACKLOG_HIGH {
          backlog_paused = true;
        }
        let read_ok = !paused.load(Ordering::Relaxed) && !backlog_paused;
        let want_write = !input.lock().unwrap().queue.is_empty();
        let mut ev: libc::c_short = 0;
        if read_ok {
          ev |= libc::POLLIN;
        }
        if want_write {
          ev |= libc::POLLOUT;
        }
        let mut fds = [
          libc::pollfd { fd: master_fd, events: ev, revents: 0 },
          libc::pollfd { fd: wake_r, events: libc::POLLIN, revents: 0 },
        ];
        // A client-backlog pause re-checks the budget on a short timer (no one pokes us when the
        // outbox drains); a renderer flow pause sleeps until flow()/kill()/write() pokes the pipe.
        let r = poll2(&mut fds, if backlog_paused { 20 } else { -1 });
        if r < 0 || fds[0].revents & libc::POLLNVAL != 0 {
          hangup = true; // poll failed or the master fd is gone
          break 'io;
        }
        if fds[1].revents & libc::POLLIN != 0 {
          let mut sink = [0u8; 64];
          while unsafe { libc::read(wake_r, sink.as_mut_ptr() as *mut libc::c_void, sink.len()) } > 0 {}
        }
        if fds[0].revents & libc::POLLOUT != 0 {
          drain_input(&mut input.lock().unwrap());
        }
        if fds[0].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
          // First read, then keep collecting for the batch window while bytes keep arriving.
          let start = Instant::now();
          let mut got_any = false;
          let mut eof = false;
          loop {
            match reader.read(&mut tmp) {
              Ok(0) => {
                eof = true;
                break;
              }
              Ok(n) => {
                got_any = true;
                pending.extend_from_slice(&tmp[..n]);
              }
              Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
              Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
              Err(_) => {
                eof = true; // EIO: the slave side is gone (macOS reports child exit this way)
                break;
              }
            }
            if !got_any && !eof {
              break; // spurious wake (POLLHUP with nothing to read yet) — poll again
            }
            let elapsed = start.elapsed().as_millis();
            if pending.len() >= BATCH_MAX_BYTES || elapsed >= BATCH_MAX_MS {
              break;
            }
            let wait = BATCH_WAIT_MS.min((BATCH_MAX_MS - elapsed) as i32);
            let mut one = [libc::pollfd { fd: master_fd, events: libc::POLLIN, revents: 0 }];
            if poll2(&mut one, wait) <= 0 {
              break; // quiet for the window → emit what we have
            }
          }
          if got_any {
            // Emit whole UTF-8 only; an incomplete trailing codepoint waits for the next read.
            let valid = match std::str::from_utf8(&pending) {
              Ok(s) => s.len(),
              Err(e) => e.valid_up_to(),
            };
            if valid > 0 {
              let s = String::from_utf8_lossy(&pending[..valid]).into_owned();
              pending.drain(..valid);
              let seq = {
                let mut b = ring.lock().unwrap();
                b.seq += 1;
                b.len += s.len();
                b.chunks.push(s.clone());
                while b.len > RING_MAX && b.chunks.len() > 1 {
                  let removed = b.chunks.remove(0).len();
                  b.len -= removed;
                }
                b.seq
              };
              me.broadcast(&json!({ "ev": "data", "id": id, "chunk": s, "seq": seq }));
            }
          }
          if eof {
            hangup = true;
            break 'io;
          }
        }
      }
      let _ = hangup;
      // Shell exited (or the master failed): reap it, drop it from the registry, announce the death.
      let exit_code = child.lock().unwrap().wait().map(|s| s.exit_code() as i64).unwrap_or(0);
      me.terms.lock().unwrap().remove(&id); // drops Term → closes wake_w
      unsafe { libc::close(wake_r) };
      let _ = std::fs::remove_file(me.manifest_path(&id));
      log(&format!("exit {id} code={exit_code}"));
      me.broadcast(&json!({ "ev": "exit", "id": id, "exitCode": exit_code, "signal": 0 }));
      me.note_idle();
    });
    Ok(info)
  }

  // Queue input for a terminal and try to push it through right away (non-blocking). Holds the
  // registry lock only to look the terminal up — a stuck program stalls nobody else.
  fn write(&self, id: &str, data: &str) {
    let (input, wake, manifest) = {
      let mut map = self.terms.lock().unwrap();
      let Some(t) = map.get_mut(id) else { return };
      let manifest = if !t.info.has_context {
        t.info.has_context = true;
        Some(t.info.clone())
      } else {
        None
      };
      (t.input.clone(), t.wake_w, manifest)
    };
    if let Some(info) = manifest {
      self.write_manifest(&info);
    }
    let still_queued = {
      let mut inp = input.lock().unwrap();
      if inp.queue.len() + data.len() > INPUT_MAX {
        inp.dropped += data.len();
        if inp.dropped == data.len() {
          log(&format!("{id}: input queue full ({INPUT_MAX} bytes) — dropping input until it drains"));
        }
        return;
      }
      inp.dropped = 0;
      inp.queue.extend(data.as_bytes());
      drain_input(&mut inp)
    };
    if still_queued {
      poke(wake); // make the poll thread watch POLLOUT
    }
  }

  fn resize(&self, id: &str, cols: u16, rows: u16) {
    if let Some(t) = self.terms.lock().unwrap().get(id) {
      let _ = t.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
  }

  // Renderer-driven flow control: pause PTY reads while its xterm write buffer runs ahead.
  fn flow(&self, id: &str, pause: bool) {
    if let Some(t) = self.terms.lock().unwrap().get(id) {
      t.paused.store(pause, Ordering::Relaxed);
      poke(t.wake_w);
    }
  }

  // Kill a terminal: signal the child and flag the I/O thread, which owns teardown (reap, remove
  // from the registry — closing the master fd only once nobody polls it — manifest, exit event).
  // The registry entry stays until then so a second kill/write can't race a half-torn-down term.
  fn kill(&self, id: &str) -> bool {
    let map = self.terms.lock().unwrap();
    match map.get(id) {
      Some(t) => {
        if !t.killed.swap(true, Ordering::SeqCst) {
          let _ = t.child.lock().unwrap().kill();
          poke(t.wake_w);
          log(&format!("kill {id}"));
        }
        true
      }
      None => false,
    }
  }

  fn kill_all(&self) -> usize {
    let ids: Vec<String> = self.terms.lock().unwrap().keys().cloned().collect();
    for id in &ids {
      self.kill(id);
    }
    ids.len()
  }

  fn list(&self) -> Vec<TermInfo> {
    self.terms.lock().unwrap().values().map(|t| t.info.clone()).collect()
  }

  // What the PTY is running: its foreground process group, read from the master with tcgetpgrp.
  // `atShell` is whether that group is the shell's own — the renderer uses it to know whether a
  // build is still running (build.js watchBuild) and whether it may type a command (cli-launch.js).
  // An unknown terminal, or a failed query, reads as at-shell so callers never wait on it forever.
  fn foreground(&self, id: &str) -> Value {
    let terms = self.terms.lock().unwrap();
    let Some(t) = terms.get(id) else { return json!({ "process": "", "atShell": true }) };
    let Some(fd) = t.master.as_raw_fd() else { return json!({ "process": "", "atShell": true }) };
    let pgid = unsafe { libc::tcgetpgrp(fd) };
    if pgid <= 0 {
      return json!({ "process": "", "atShell": true });
    }
    let at_shell = pgid as u32 == t.info.pid;
    let process = if at_shell { String::new() } else { proc_name(pgid) };
    json!({ "process": process, "atShell": at_shell })
  }

  // Attach: the ring for replay. A renderer flow pause belongs to the client that asked for it;
  // an attaching client starts with an empty xterm buffer, so any leftover pause is lifted here.
  fn attach(&self, id: &str) -> Value {
    match self.terms.lock().unwrap().get(id) {
      Some(t) => {
        if t.paused.swap(false, Ordering::Relaxed) {
          poke(t.wake_w);
        }
        let b = t.ring.lock().unwrap();
        json!({ "buf": b.chunks.concat(), "seq": b.seq })
      }
      None => json!({ "buf": "", "seq": 0 }),
    }
  }

  // Start the idle clock if nothing is left to serve; the watchdog exits after IDLE_EXIT.
  fn note_idle(&self) {
    let empty = self.terms.lock().unwrap().is_empty() && self.clients.lock().unwrap().is_empty();
    let mut idle = self.idle_since.lock().unwrap();
    if empty {
      if idle.is_none() {
        *idle = Some(Instant::now());
      }
    } else {
      *idle = None;
    }
  }

  fn handle(self: &Arc<Self>, req: &Value) -> Result<Value, String> {
    let op = req.get("op").and_then(Value::as_str).unwrap_or("");
    let sid = || req.get("term").and_then(Value::as_str).unwrap_or("").to_string();
    match op {
      "hello" => Ok(json!({ "protocol": PROTOCOL, "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION") })),
      "create" => {
        let opts: CreateOpts = req.get("opts").cloned().map(serde_json::from_value).transpose().map_err(|e| e.to_string())?.unwrap_or_default();
        self.create(opts).map(|i| serde_json::to_value(i).unwrap())
      }
      "write" => {
        self.write(&sid(), req.get("data").and_then(Value::as_str).unwrap_or(""));
        Ok(Value::Null)
      }
      "resize" => {
        let cols = req.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16;
        let rows = req.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16;
        self.resize(&sid(), cols, rows);
        Ok(Value::Null)
      }
      "flow" => {
        self.flow(&sid(), req.get("pause").and_then(Value::as_bool).unwrap_or(false));
        Ok(Value::Null)
      }
      "kill" => Ok(json!(self.kill(&sid()))),
      "killAll" => Ok(json!(self.kill_all())),
      "list" => Ok(serde_json::to_value(self.list()).unwrap()),
      "attach" => Ok(self.attach(&sid())),
      "foreground" => Ok(self.foreground(&sid())),
      other => Err(format!("unknown op {other:?}")),
    }
  }

  fn serve_client(self: Arc<Self>, stream: UnixStream) {
    let Ok(mut out) = stream.try_clone() else { return };
    let Ok(sock) = stream.try_clone() else { return };
    let cid = self.client_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = mpsc::channel::<Arc<str>>();
    let owed = Arc::new(AtomicUsize::new(0));
    let progress = Arc::new(Mutex::new(Instant::now()));
    self.clients.lock().unwrap().push(Client { id: cid, tx, owed: owed.clone(), progress: progress.clone(), sock });
    *self.idle_since.lock().unwrap() = None;
    log(&format!("client {cid} connected"));

    // Outbox: the single writer on this socket. Blocking here blocks only this client.
    std::thread::spawn(move || {
      for line in rx {
        if out.write_all(line.as_bytes()).and_then(|_| out.flush()).is_err() {
          break;
        }
        owed.fetch_sub(line.len(), Ordering::Relaxed);
        *progress.lock().unwrap() = Instant::now();
      }
      let _ = out.shutdown(std::net::Shutdown::Both);
    });

    let reader = BufReader::new(stream);
    for line in reader.lines() {
      let Ok(line) = line else { break };
      if line.trim().is_empty() {
        continue;
      }
      let req: Value = match serde_json::from_str(&line) {
        Ok(v) => v,
        Err(e) => {
          log(&format!("bad request: {e}"));
          continue;
        }
      };
      let res = self.handle(&req);
      if let Some(id) = req.get("id") {
        let resp = match res {
          Ok(v) => json!({ "id": id, "ok": v }),
          Err(e) => json!({ "id": id, "err": e }),
        };
        self.reply(cid, &resp);
      }
    }
    // Client gone: forget its outbox (dropping the sender ends the outbox thread). Terminals are
    // untouched — that is the whole point.
    self.clients.lock().unwrap().retain(|c| c.id != cid);
    // Its flow pauses die with it — a paused PTY with no one to resume it would freeze forever.
    for t in self.terms.lock().unwrap().values() {
      if t.paused.swap(false, Ordering::Relaxed) {
        poke(t.wake_w);
      }
    }
    log(&format!("client {cid} disconnected"));
    self.note_idle();
  }
}

// Entry point for `taskhub __ptyd__ <dir>`. Never returns.
pub fn main(dir: PathBuf) -> ! {
  let _ = std::fs::create_dir_all(dir.join("terms"));
  let sock = sock_path();
  // Never adopt or defer to a socket that isn't ours (see sock_path).
  if sock.exists() && !owned_socket(&sock) {
    log(&format!("{} is owned by another user; refusing to start", sock.display()));
    std::process::exit(1);
  }
  // A stale socket from a dead daemon blocks bind(); only remove it when nobody answers.
  if UnixStream::connect(&sock).is_ok() {
    log("another ptyd already serves this socket; exiting");
    std::process::exit(0);
  }
  let _ = std::fs::remove_file(&sock);
  let listener = match UnixListener::bind(&sock) {
    Ok(l) => l,
    Err(e) => {
      log(&format!("bind {}: {e}", sock.display()));
      std::process::exit(1);
    }
  };
  let _ = std::fs::write(dir.join("ptyd.pid"), std::process::id().to_string());
  // Manifests left by a previous daemon describe shells that died with it — clear them.
  if let Ok(rd) = std::fs::read_dir(dir.join("terms")) {
    for e in rd.flatten() {
      let _ = std::fs::remove_file(e.path());
    }
  }
  // SIGPIPE would kill the daemon on a write to a client that vanished; we handle the error instead.
  unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
  log(&format!("listening on {} (protocol {PROTOCOL}, v{})", sock.display(), env!("CARGO_PKG_VERSION")));

  let d = Arc::new(Daemon {
    dir: dir.clone(),
    terms: Mutex::new(HashMap::new()),
    clients: Mutex::new(Vec::new()),
    seq: AtomicU64::new(0),
    client_seq: AtomicU64::new(0),
    boot: now_ms() % 100_000_000,
    idle_since: Mutex::new(Some(Instant::now())),
  });

  // Idle watchdog: no terminals + no clients for IDLE_EXIT → leave (the host respawns on demand).
  let d2 = d.clone();
  let sock2 = sock.clone();
  std::thread::spawn(move || loop {
    std::thread::sleep(Duration::from_secs(5));
    let idle = *d2.idle_since.lock().unwrap();
    if let Some(t) = idle {
      if t.elapsed() >= IDLE_EXIT && d2.terms.lock().unwrap().is_empty() && d2.clients.lock().unwrap().is_empty() {
        log("idle with no terminals and no clients; exiting");
        let _ = std::fs::remove_file(&sock2);
        let _ = std::fs::remove_file(d2.dir.join("ptyd.pid"));
        std::process::exit(0);
      }
    }
  });

  for conn in listener.incoming() {
    match conn {
      Ok(stream) => {
        let d = d.clone();
        std::thread::spawn(move || d.serve_client(stream));
      }
      Err(e) => log(&format!("accept: {e}")),
    }
  }
  std::process::exit(0)
}
