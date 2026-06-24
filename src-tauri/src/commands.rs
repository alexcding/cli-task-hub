// The native bridge — the Tauri equivalent of src/main/ipc/system.js. Each command backs
// one window.taskhub.* method the renderer calls via invoke(). Plugin work (dialog, opener)
// is done here from Rust so the renderer never depends on plugin JS globals — it only ever
// invokes these app commands. Terminals (term.*), native context menus (tab/folder), the
// embedded viewer (wcv.*), tray refresh, avatar fetch and usage are later milestones — those
// are stubbed in bridge.js until then.
use serde::Serialize;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

// Host platform in Electron's process.platform vocabulary, because the renderer compares
// against 'darwin' (index.html enables the native-mac chrome on that value).
#[tauri::command]
pub fn platform() -> String {
  match std::env::consts::OS {
    "macos" => "darwin",
    "windows" => "win32",
    other => other,
  }
  .to_string()
}

// Mirror the app's light/dark/auto choice to the native window appearance so the native
// chrome (inset traffic lights, scrollbars) matches. 'auto' (anything not light/dark) follows
// the OS via None.
#[tauri::command]
pub fn set_theme(window: WebviewWindow, value: String) {
  let theme = match value.as_str() {
    "light" => Some(tauri::Theme::Light),
    "dark" => Some(tauri::Theme::Dark),
    _ => None,
  };
  let _ = window.set_theme(theme);
}

// ⌘W with no tab in view → close the window (the renderer can't close a window it didn't open).
#[tauri::command]
pub fn close_window(window: WebviewWindow) {
  let _ = window.close();
}

// Double-click-the-titlebar maximize/restore, tweened from the renderer (bridge.js) so the WKWebView
// relayouts in lockstep with the frame instead of lagging the native zoom animation — see glass for
// the why. zoom_begin sets up the tween (and toggles maximize vs. restore); zoom_apply steps it once
// per requestAnimationFrame with eased progress t. No-ops off macOS.
#[tauri::command]
pub fn zoom_begin(window: WebviewWindow) {
  #[cfg(target_os = "macos")]
  crate::glass::zoom_begin(window);
  #[cfg(not(target_os = "macos"))]
  let _ = window;
}

#[tauri::command]
pub fn zoom_apply(window: WebviewWindow, t: f64) {
  #[cfg(target_os = "macos")]
  crate::glass::zoom_apply(window, t);
  #[cfg(not(target_os = "macos"))]
  let _ = (window, t);
}

// Native folder picker for choosing a project's workspace folder. Resolves to the chosen
// absolute path, or null if cancelled.
#[tauri::command]
pub fn choose_folder(app: tauri::AppHandle) -> Option<String> {
  app
    .dialog()
    .file()
    .set_title("Choose workspace folder")
    .blocking_pick_folder()
    .map(|p| p.to_string())
}

// Reveal/open a folder in the system file manager (Finder). Backs the viewer titlebar's
// workspace/worktree chip.
#[tauri::command]
pub fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
  if path.is_empty() {
    return Ok(());
  }
  app
    .opener()
    .open_path(path, None::<&str>)
    .map_err(|e| e.to_string())
}

// Open an http(s) URL in the default browser. Scheme-guarded so only http(s) reaches the OS.
#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
  if !(url.starts_with("http://") || url.starts_with("https://")) {
    return Ok(());
  }
  app
    .opener()
    .open_url(url, None::<&str>)
    .map_err(|e| e.to_string())
}

// Open a tab's worktree/checkout folder in the user's chosen git GUI by running their
// configured command template (`open -a Fork {path}`, a deeplink, …) with {path} substituted.
// Tokenize-and-spawn with NO shell so the path can't inject — mirrors native/git-client.js.
#[tauri::command]
pub fn open_in_git_client(cmd: String, path: String) -> Result<(), String> {
  let parts: Vec<String> = cmd
    .split_whitespace()
    .map(|tok| tok.replace("{path}", &path))
    .collect();
  let (program, args) = parts.split_first().ok_or("empty git-client command")?;
  std::process::Command::new(program)
    .args(args)
    .spawn()
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// Preview a review-notification sound from Settings via macOS `afplay`. A path of null/"system"
// plays the system default. Matches the live-notification playback path.
#[tauri::command]
pub fn preview_sound(path: Option<String>) -> Result<(), String> {
  #[cfg(target_os = "macos")]
  {
    let p = path.unwrap_or_default();
    let file = if p.is_empty() || p == "system" {
      "/System/Library/Sounds/Ping.aiff".to_string()
    } else {
      p
    };
    std::process::Command::new("afplay")
      .arg(file)
      .spawn()
      .map(|_| ())
      .map_err(|e| e.to_string())?;
  }
  #[cfg(not(target_os = "macos"))]
  let _ = path;
  Ok(())
}

// ── Resource usage (M7) ───────────────────────────────────────────────────────
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UsageRow {
  label: String,
  kb: u64,
  cpu: f32,
}

#[derive(Serialize, Clone)]
pub struct Usage {
  // Field names match what the renderer reads (settings.js): totalKB / totalCPU.
  #[serde(rename = "totalKB")]
  total_kb: u64,
  #[serde(rename = "totalCPU")]
  total_cpu: f32,
  breakdown: Vec<UsageRow>,
}

// RAM + CPU summed over the whole TaskHub process tree (the host + every descendant — in a packaged
// build that's the backend node sidecar and the PTY shells), for the Settings live readout. CPU
// needs two samples a short interval apart.
#[tauri::command]
pub fn get_usage(app: tauri::AppHandle) -> Usage {
  use std::collections::{HashMap, HashSet, VecDeque};
  use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

  let mut sys = System::new();
  sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::everything());
  std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
  sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::everything());

  // Build a parent → children map, then BFS the subtree rooted at our own pid.
  let mut kids: HashMap<Pid, Vec<Pid>> = HashMap::new();
  for (pid, proc_) in sys.processes() {
    if let Some(parent) = proc_.parent() {
      kids.entry(parent).or_default().push(*pid);
    }
  }
  let me = Pid::from_u32(std::process::id());
  let mut seen: HashSet<Pid> = HashSet::new();
  let mut queue: VecDeque<Pid> = VecDeque::from([me]);

  let mut total_kb = 0u64;
  let mut total_cpu = 0f32;
  let mut breakdown = Vec::new();
  while let Some(pid) = queue.pop_front() {
    if !seen.insert(pid) {
      continue;
    }
    if let Some(proc_) = sys.process(pid) {
      let kb = proc_.memory() / 1024;
      let cpu = proc_.cpu_usage();
      total_kb += kb;
      total_cpu += cpu;
      breakdown.push(UsageRow { label: proc_.name().to_string_lossy().into_owned(), kb, cpu });
    }
    if let Some(children) = kids.get(&pid) {
      queue.extend(children);
    }
  }

  // The embedded pages run in macOS-managed WebKit content processes that aren't in our subtree;
  // add each one explicitly (pid via WKWebView._webProcessIdentifier) so they're counted + listed.
  for pid in crate::viewer::webview_pids(&app) {
    let p = Pid::from_u32(pid as u32);
    if !seen.insert(p) {
      continue;
    }
    if let Some(proc_) = sys.process(p) {
      let kb = proc_.memory() / 1024;
      let cpu = proc_.cpu_usage();
      total_kb += kb;
      total_cpu += cpu;
      breakdown.push(UsageRow { label: "Web Content".to_string(), kb, cpu });
    }
  }

  Usage { total_kb, total_cpu, breakdown }
}

// Fetch a PR author's GitHub avatar as a base64 data URI so the renderer can freeze it onto a tab
// (survives reloads). Returns null on any failure — the tab falls back to the live avatar URL.
// `login` is validated to GitHub's handle charset so it's safe to interpolate into the shell.
#[tauri::command]
pub fn fetch_avatar(login: String) -> Option<String> {
  if login.is_empty() || !login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
    return None;
  }
  let out = std::process::Command::new("sh")
    .arg("-c")
    .arg(format!("curl -fsSL --max-time 5 'https://github.com/{login}.png?size=64' | base64"))
    .output()
    .ok()?;
  if !out.status.success() {
    return None;
  }
  // Strip the line wrapping `base64` adds — a data URI must be a single token.
  let b64: String = String::from_utf8_lossy(&out.stdout).split_whitespace().collect();
  if b64.is_empty() {
    return None;
  }
  Some(format!("data:image/png;base64,{b64}"))
}

// Evaluate JS inside an embedded child webview (the M6 viewer). Backs the viewer's back/forward,
// stop, and find-in-page — driven from bridge.js via window.find() / history.back() rather than
// native objc2 glue. No-op if the webview id isn't found.
#[tauri::command]
pub fn wcv_eval(app: tauri::AppHandle, id: String, js: String) {
  if let Some(webview) = app.get_webview(&id) {
    let _ = webview.eval(&js);
  }
}

// Rebuild the tray menu now — the port of Electron's `tray:refresh`. The renderer fires this
// after changing tray-relevant state that doesn't move the PR snapshot (and so won't trigger an
// SSE `sync`): the usage-widget agent toggle and the review-sound / activity-notify settings.
// tray::refresh does blocking curl reads and then a run_on_main_thread menu mutation, so it must
// run off the command thread (which may itself be the main thread) — spawn a worker, like the
// SSE stream does.
#[tauri::command]
pub fn refresh_tray(app: tauri::AppHandle) {
  std::thread::spawn(move || crate::tray::refresh(&app));
}

// ── Launch at login ─────────────────────────────────────────────────────────────
// Back the Settings "Launch at login" toggle. The login-item state is owned by macOS (a
// LaunchAgent registered by tauri-plugin-autostart), NOT the snapshot DB — so the toggle reads
// and writes the OS directly rather than persisting a renderer copy that could drift from
// reality. get() returns the live state (false if it can't be read); set() enables/disables and
// echoes back the resulting state so the UI reflects what actually took, not what was requested.
#[tauri::command]
pub fn autostart_get(app: tauri::AppHandle) -> bool {
  use tauri_plugin_autostart::ManagerExt;
  app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
  use tauri_plugin_autostart::ManagerExt;
  let mgr = app.autolaunch();
  // No-op if already in the desired state. Disabling a never-registered LaunchAgent removes a plist
  // that isn't there (NotFound), which would otherwise surface as a spurious error toast when the
  // user clicks the already-active "Off" button (the toggle leaves the active option clickable).
  if mgr.is_enabled().unwrap_or(false) == enabled {
    return Ok(enabled);
  }
  (if enabled { mgr.enable() } else { mgr.disable() }).map_err(|e| e.to_string())?;
  Ok(mgr.is_enabled().unwrap_or(enabled))
}

