// The native bridge — the Tauri equivalent of src/main/ipc/system.js. Each command backs
// one window.taskhub.* method the renderer calls via invoke(). Plugin work (dialog, opener)
// is done here from Rust so the renderer never depends on plugin JS globals — it only ever
// invokes these app commands. Terminals (term.*), native context menus (tab/folder), the
// embedded viewer (wcv.*), tray refresh, avatar fetch and usage are later milestones — those
// are stubbed in bridge.js until then.
use serde::Serialize;
use tauri::WebviewWindow;
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
#[serde(rename_all = "camelCase")]
pub struct Usage {
  total_kb: u64,
  total_cpu: f32,
  breakdown: Vec<UsageRow>,
}

// RAM + CPU for the Tauri host process, for the Settings live readout. CPU needs two samples a
// short interval apart. NOTE (M7): the Electron build summed every TaskHub process (host + backend
// + PTYs); this reports the host only — summing the backend sidecar + PTY tree is a follow-up.
#[tauri::command]
pub fn get_usage() -> Usage {
  use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
  let pid = Pid::from_u32(std::process::id());
  let mut sys = System::new();
  let only = &[pid][..];
  sys.refresh_processes_specifics(ProcessesToUpdate::Some(only), true, ProcessRefreshKind::everything());
  std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
  sys.refresh_processes_specifics(ProcessesToUpdate::Some(only), true, ProcessRefreshKind::everything());

  let (kb, cpu) = match sys.process(pid) {
    Some(p) => (p.memory() / 1024, p.cpu_usage()),
    None => (0, 0.0),
  };
  Usage {
    total_kb: kb,
    total_cpu: cpu,
    breakdown: vec![UsageRow { label: "TaskHub".into(), kb, cpu }],
  }
}
