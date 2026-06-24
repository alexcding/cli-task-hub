// TaskHub Tauri host. Mirrors the Electron host's job: own the window + tray, spawn/supervise
// the Node backend, and bridge native features to the renderer. The renderer + backend are
// unchanged from the Electron build — the renderer talks to the backend over HTTP+SSE, so the
// Tauri-specific work lives here, in commands.rs (window.taskhub.* native methods) and
// terminals.rs (PTYs).

mod avatars;
mod commands;
#[cfg(target_os = "macos")]
mod glass;
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
  // Target the "main" WEBVIEW's window, not get_webview_window(): once the window hosts child
  // webviews (an embedded tab is open) it's a multiwebview window and get_webview_window returns
  // None — so show/focus (and the tray/menu/notify evals) would silently no-op.
  if let Some(w) = app.get_webview("main") {
    let win = w.window();
    let _ = win.show();
    let _ = win.set_focus();
    // Re-apply the traffic-light inset on show. A login launch builds the window hidden (open_main_
    // window's .visible(!at_login)), where the titlebar may not have been laid out when first
    // positioned — and showing isn't a resize, so the resize handler wouldn't catch it. Without this
    // the lights could sit at the default top-left until the first manual resize.
    #[cfg(target_os = "macos")]
    if let Ok(ptr) = win.ns_window() {
      glass::set_traffic_lights(ptr, glass::TRAFFIC_X, glass::TRAFFIC_Y);
    }
  }
}

// Create the dashboard window. Built in Rust (rather than declared in tauri.conf.json) so we can
// attach the preload-equivalent init script (bridge.js → window.taskhub.*) and point it at the
// external backend origin. macOS gets the inset traffic lights over a unified top band, matching
// the Electron build's hiddenInset chrome.
fn open_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
  let url: tauri::Url = BACKEND_URL.parse().expect("valid backend URL");
  // Launched at login (the autostart LaunchAgent passes --autostart): bring the app up quietly in
  // the tray rather than popping the dashboard to the foreground and stealing focus. The window is
  // built hidden; the tray menu (or a Dock click → RunEvent::Reopen) reveals it. Any other launch
  // shows it as usual.
  let at_login = std::env::args().any(|a| a == "--autostart");
  let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
    .title("TaskHub")
    .inner_size(1320.0, 880.0)
    .min_inner_size(720.0, 480.0)
    .resizable(true)
    .visible(!at_login)
    .initialization_script(include_str!("../bridge.js"));

  #[cfg(target_os = "macos")]
  {
    // Transparent window so the NSVisualEffectView (applied below) shows through wherever the
    // renderer leaves a region transparent — the sidebar. Needs macOSPrivateApi (set in
    // tauri.conf.json); fine for our DMG distribution (private APIs only bar App Store submission).
    builder = builder
      .title_bar_style(tauri::TitleBarStyle::Overlay)
      .hidden_title(true)
      .transparent(true);
    // NB: the builder's .traffic_light_position() is intentionally NOT used — Tauri never applies
    // it on a webview window (tao drives it from its own view's drawRect, which the WKWebView
    // suppresses). We position the lights ourselves below (glass::set_traffic_lights) instead.
  }

  let _window = builder.build()?;
  // (No auto-opened devtools — use right-click → Inspect Element in a debug build if needed.)

  // Native translucent sidebar behind the transparent window. The renderer paints the content area
  // opaque and leaves the sidebar transparent (css: html.native-mac aside), so the material shows
  // ONLY behind the sidebar — the standard macOS look (Finder/Mail). macOS 26 (Tahoe) uses the new
  // Liquid Glass material (NSGlassEffectView); older systems get the classic NSVisualEffectView
  // frost. NSGlassEffectView doesn't exist before macOS 26, so pick at runtime.
  #[cfg(target_os = "macos")]
  {
    // Initial width = the renderer's default sidebar width (250px token); the renderer corrects it
    // on load via set_sidebar_glass_width once it knows its persisted width.
    let used_glass = glass::macos_major_version() >= 26
      && match glass::apply_glass_sidebar(&_window, 250.0) {
        Ok(()) => true,
        Err(e) => {
          log::warn!("[glass] Liquid Glass not applied ({e}); using vibrancy");
          false
        }
      };
    if !used_glass {
      // FollowsWindowActiveState dims the vibrancy when the window loses focus, like native sidebars.
      use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
      if let Err(e) = apply_vibrancy(
        &_window,
        NSVisualEffectMaterial::Sidebar,
        Some(NSVisualEffectState::FollowsWindowActiveState),
        None,
      ) {
        log::warn!("[vibrancy] sidebar material not applied: {e}");
      }
    }

    // Inset the traffic lights to sit centered in the taller sidebar header (reapplied on resize in
    // on_window_event). Done here, not via the builder, which Tauri ignores for webview windows.
    if let Ok(ptr) = _window.ns_window() {
      glass::set_traffic_lights(ptr, glass::TRAFFIC_X, glass::TRAFFIC_Y);
    }
  }
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
    // Single-instance: a second launch focuses the existing window instead of starting a rival
    // process (which would fight over port 3000 / the data dir). Must be the FIRST plugin.
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      show_main(app);
    }))
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    // Launch-at-login (macOS LaunchAgent). Backs the Settings "Launch at login" toggle; the
    // login-item state lives in the OS, read/written via commands::autostart_* (ManagerExt).
    .plugin(tauri_plugin_autostart::init(
      tauri_plugin_autostart::MacosLauncher::LaunchAgent,
      // Tag the login-launch with --autostart so open_main_window can come up quietly in the tray
      // (a menu-bar app shouldn't pop its window to the foreground on every login).
      Some(vec!["--autostart"]),
    ))
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
      commands::refresh_tray,
      commands::fetch_avatar,
      commands::autostart_get,
      commands::autostart_set,
      commands::set_sidebar_glass_width,
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
      // macOS rebuilds the titlebar container on resize, snapping the traffic lights back to the
      // top-left — so re-apply our inset every resize to keep them centered in the sidebar header.
      #[cfg(target_os = "macos")]
      if let tauri::WindowEvent::Resized(_) = event {
        if let Ok(ptr) = window.ns_window() {
          glass::set_traffic_lights(ptr, glass::TRAFFIC_X, glass::TRAFFIC_Y);
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

      // Holds the Liquid Glass sidebar view so the renderer can resize it (macOS 26+). Must be
      // managed before open_main_window, which applies the glass and stores the handle here.
      #[cfg(target_os = "macos")]
      app.manage(glass::SidebarGlass::default());

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
      // Poll embedded webviews for title/URL/nav state → live tab titles + Back/Forward enablement.
      // (The cold-load time is GitHub/network-bound, not this — confirmed: load stayed slow with it
      // off — so it's safe to run.)
      viewer::start_title_watch(app.handle());
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
