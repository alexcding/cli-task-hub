// TaskHub Tauri host. Mirrors the Electron host's job: own the window + tray, spawn/supervise
// the Node backend, and bridge native features to the renderer. The renderer + backend are
// unchanged from the Electron build — the renderer talks to the backend over HTTP+SSE, so the
// Tauri-specific work lives here, in commands.rs (window.taskhub.* native methods) and
// terminals.rs (PTYs).

mod avatars;
mod commands;
mod menu;
mod notify;
mod terminals;
mod tray;
mod usage_image;
mod viewer;
#[cfg(target_os = "macos")]
mod webview_menu;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// The local backend's origin. The renderer (and all its absolute /api, /events, /css, /shared
// URLs) is served from here, so the window loads this directly — same model as the Electron
// build. Kept in sync with capabilities/remote.json and tauri.conf.json's devUrl.
const BACKEND_URL: &str = "http://localhost:3000";

// TaskHub is a menu-bar app: it exits ONLY via the tray's Quit. Every other close trigger
// (red button, ⌘W with no tab) hides the window and leaves the tray + backend running. This flag
// marks the one sanctioned exit so the window CloseRequested handler can tell them apart.
pub(crate) static QUITTING: AtomicBool = AtomicBool::new(false);

// In a packaged build the Node runtime ships as the `taskhub-node` sidecar and the backend
// source + node_modules ride along as bundle.resources (see tauri.conf.json). We spawn
// `node <resources>/src/server/app.js` with the backend's port + a writable data dir. In dev,
// `beforeDevCommand` already runs `node src/server/app.js`, so this is release-only.
#[cfg(not(debug_assertions))]
fn start_backend(handle: &tauri::AppHandle) {
  use tauri_plugin_shell::ShellExt;

  let resources = match handle.path().resource_dir() {
    Ok(p) => p,
    Err(e) => { log::error!("no resource dir: {e}"); return; }
  };
  let app_js = resources.join("src/server/app.js");
  let data_dir = handle
    .path()
    .app_data_dir()
    .map(|d| d.to_string_lossy().into_owned())
    .unwrap_or_default();

  match handle.shell().sidecar("taskhub-node") {
    Ok(cmd) => {
      let cmd = cmd
        .arg(app_js.to_string_lossy().to_string())
        .env("PORT", "3000")
        .env("TASKHUB_DATA_DIR", data_dir);
      if let Err(e) = cmd.spawn() {
        log::error!("failed to spawn TaskHub backend: {e}");
      }
    }
    Err(e) => log::error!("taskhub-node sidecar not configured: {e}"),
  }
}

// Auto-update from GitHub Releases (release builds only), mirroring the Electron build: check on
// startup, then every 6h (a menu-bar app rarely quits), download + install in the background. The
// update applies on next launch. Endpoints + pubkey are in tauri.conf.json (plugins.updater);
// builds must be signed (TAURI_SIGNING_PRIVATE_KEY) and ship latest.json for this to find anything.
#[cfg(not(debug_assertions))]
fn setup_auto_updates(handle: &tauri::AppHandle) {
  use tauri_plugin_updater::UpdaterExt;
  let handle = handle.clone();
  tauri::async_runtime::spawn(async move {
    loop {
      match handle.updater() {
        Ok(updater) => match updater.check().await {
          Ok(Some(update)) => {
            log::info!("[updater] {} available — downloading", update.version);
            if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
              log::error!("[updater] install failed: {e}");
            } else {
              log::info!("[updater] update installed; applies on next launch");
            }
          }
          Ok(None) => {}
          Err(e) => log::error!("[updater] check failed: {e}"),
        },
        Err(e) => log::error!("[updater] not configured: {e}"),
      }
      tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
    }
  });
}

// Wait (release only) for the backend to accept connections before loading the window, so the
// renderer doesn't hit a connection error on a cold start. Plain TCP probe — no HTTP client dep.
#[cfg(not(debug_assertions))]
fn wait_for_backend() {
  use std::net::{SocketAddr, TcpStream};
  use std::time::Duration;
  let addr: SocketAddr = "127.0.0.1:3000".parse().unwrap();
  for _ in 0..100 {
    if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
      return;
    }
    std::thread::sleep(Duration::from_millis(100));
  }
  log::warn!("backend did not become ready within ~10s; loading window anyway");
}

pub(crate) fn show_main(app: &tauri::AppHandle) {
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

  builder.build()?;
  // (No auto-opened devtools — use right-click → Inspect Element in a debug build if needed.)
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    // avatar://a/<login> → the cached raw GitHub avatar bytes (avatars.rs). Lets the renderer's
    // <img>s load from a local cache instead of re-fetching github.com on every re-render — which
    // WKWebView does (unlike Chromium), causing the avatar flicker. Async so the first-fetch curl
    // doesn't block the scheme thread.
    .register_asynchronous_uri_scheme_protocol("avatar", |_ctx, request, responder| {
      let uri = request.uri().to_string();
      std::thread::spawn(move || {
        let login = uri.rsplit('/').next().unwrap_or("").split(['?', '#']).next().unwrap_or("");
        let resp = match avatars::avatar_raw(login) {
          Some(bytes) => {
            let ct = if bytes.starts_with(&[0xFF, 0xD8]) { "image/jpeg" } else { "image/png" };
            tauri::http::Response::builder()
              .status(200)
              .header("Content-Type", ct)
              .header("Cache-Control", "public, max-age=604800")
              .body(bytes)
          }
          None => tauri::http::Response::builder().status(404).body(Vec::new()),
        };
        if let Ok(resp) = resp {
          responder.respond(resp);
        }
      });
    })
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(terminals::Terminals::default())
    .manage(tray::TrayTabs::default())
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
      commands::wcv_eval,
      commands::fetch_avatar,
      terminals::term_create,
      terminals::term_write,
      terminals::term_resize,
      terminals::term_kill,
      terminals::term_list,
      terminals::term_attach,
      terminals::term_foreground,
    ])
    .on_menu_event(|app, event| {
      // App-menu accelerators: dispatch the "sc:<action>" id to the renderer's __shortcut.
      // Tray menu ids (no "sc:" prefix) are handled by the tray's own handler and ignored here.
      if let Some(action) = event.id().as_ref().strip_prefix("sc:") {
        menu::dispatch(app, action);
      }
    })
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
      {
        start_backend(app.handle());
        wait_for_backend();
        setup_auto_updates(app.handle());
      }

      open_main_window(app.handle())?;
      tray::setup(app.handle())?;
      // App menu + keyboard accelerators (non-fatal: a bad accelerator must not block launch).
      if let Err(e) = menu::setup(app.handle()) {
        log::error!("[menu] app menu setup failed: {e}");
      }
      // SSE stream → activity notifications + tray refresh on sync.
      notify::start_stream(app.handle());
      // Native curated context menu on the embedded webviews (swizzles WKWebView's willOpenMenu).
      #[cfg(target_os = "macos")]
      webview_menu::install(app.handle().clone());
      // TEMP (diagnostic): the main-thread title poll is disabled to confirm it's what makes the
      // initial webview load take ~10s. Re-enable with a lighter design once confirmed.
      // viewer::start_title_watch(app.handle());
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
