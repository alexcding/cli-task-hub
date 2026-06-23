// TaskHub Tauri host. Mirrors the Electron host's job: own the window + tray, spawn/supervise
// the Node backend, and bridge native features to the renderer. The renderer + backend are
// unchanged from the Electron build — the renderer talks to the backend over HTTP+SSE, so the
// Tauri-specific work lives here, in commands.rs (window.taskhub.* native methods) and
// terminals.rs (PTYs).

mod commands;
mod terminals;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// The local backend's origin. The renderer (and all its absolute /api, /events, /css, /shared
// URLs) is served from here, so the window loads this directly — same model as the Electron
// build. Kept in sync with capabilities/remote.json and tauri.conf.json's devUrl.
const BACKEND_URL: &str = "http://localhost:3000";

// TaskHub is a menu-bar app: it exits ONLY via the tray's Quit. Every other close trigger
// (red button, ⌘W with no tab) hides the window and leaves the tray + backend running. This flag
// marks the one sanctioned exit so the window CloseRequested handler can tell them apart.
static QUITTING: AtomicBool = AtomicBool::new(false);

// In a packaged build the Node backend ships as a sidecar binary and we spawn it on startup.
// In dev, `beforeDevCommand` in tauri.conf.json already runs `node src/server/app.js`, so the
// Rust side only spawns it for release builds.
#[cfg(not(debug_assertions))]
fn start_backend(handle: &tauri::AppHandle) {
  use tauri_plugin_shell::ShellExt;
  match handle.shell().sidecar("taskhub-server") {
    Ok(cmd) => {
      if let Err(e) = cmd.spawn() {
        log::error!("failed to spawn TaskHub backend sidecar: {e}");
      }
    }
    Err(e) => log::error!("TaskHub backend sidecar not configured: {e}"),
  }
}

fn show_main(app: &tauri::AppHandle) {
  if let Some(w) = app.get_webview_window("main") {
    let _ = w.show();
    let _ = w.set_focus();
  }
}

// Create the dashboard window. Built in Rust (rather than declared in tauri.conf.json) so we can
// attach the preload-equivalent init script (bridge.js → window.taskhub.*) and point it at the
// external backend origin. macOS gets the inset traffic lights over a unified top band, matching
// the Electron build's hiddenInset chrome.
fn open_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
  let url: tauri::Url = BACKEND_URL.parse().expect("valid backend URL");
  let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
    .title("TaskHub")
    .inner_size(1320.0, 880.0)
    .min_inner_size(720.0, 480.0)
    .resizable(true)
    .initialization_script(include_str!("../bridge.js"));

  #[cfg(target_os = "macos")]
  {
    builder = builder
      .title_bar_style(tauri::TitleBarStyle::Overlay)
      .hidden_title(true);
  }

  let window = builder.build()?;

  // Open the WKWebView inspector automatically in dev so the console is right there.
  #[cfg(debug_assertions)]
  window.open_devtools();

  Ok(())
}

// Menu-bar tray (M5). MVP: Open + Quit, with the quit-only-from-tray invariant. The Electron tray's
// dynamic body (open tabs, pending reviews, usage readout) and the custom mono/template icon are
// follow-ups — see docs/TAURI-PORT.md M5.
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
  let open_i = MenuItemBuilder::with_id("open", "Open TaskHub").build(app)?;
  let quit_i = MenuItemBuilder::with_id("quit", "Quit TaskHub").build(app)?;
  let menu = MenuBuilder::new(app).items(&[&open_i, &quit_i]).build()?;

  let mut tray = TrayIconBuilder::with_id("main")
    .tooltip("TaskHub")
    .menu(&menu)
    .show_menu_on_left_click(true)
    .on_menu_event(|app, event| match event.id().as_ref() {
      "open" => show_main(app),
      "quit" => {
        QUITTING.store(true, Ordering::SeqCst);
        terminals::kill_all(app);
        app.exit(0);
      }
      _ => {}
    });
  if let Some(icon) = app.default_window_icon() {
    tray = tray.icon(icon.clone());
  }
  tray.build(app)?;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    // NOTE: the updater plugin is intentionally NOT initialized yet — it panics at startup unless
    // `plugins.updater` (endpoints + minisign pubkey) is configured, which needs a real release
    // feed + signing key. Deferred with the rest of M5 (see docs/TAURI-PORT.md). Re-add
    // `.plugin(tauri_plugin_updater::Builder::new().build())` once that config exists.
    .manage(terminals::Terminals::default())
    .invoke_handler(tauri::generate_handler![
      commands::platform,
      commands::set_theme,
      commands::close_window,
      commands::choose_folder,
      commands::open_path,
      commands::open_external,
      commands::open_in_git_client,
      commands::preview_sound,
      commands::get_usage,
      terminals::term_create,
      terminals::term_write,
      terminals::term_resize,
      terminals::term_kill,
      terminals::term_list,
      terminals::term_attach,
      terminals::term_foreground,
    ])
    .on_window_event(|window, event| {
      // Menu-bar app: a window close hides it (tray keeps the app alive); only the tray's Quit
      // (which sets QUITTING) actually exits.
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if !QUITTING.load(Ordering::SeqCst) {
          api.prevent_close();
          let _ = window.hide();
        }
      }
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      #[cfg(not(debug_assertions))]
      start_backend(app.handle());

      open_main_window(app.handle())?;
      setup_tray(app.handle())?;
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while running tauri application");

  app.run(|app_handle, event| {
    // macOS Dock-click with no window open → reopen the dashboard (standard menu-bar behavior).
    if let tauri::RunEvent::Reopen { .. } = event {
      show_main(app_handle);
    }
  });
}
