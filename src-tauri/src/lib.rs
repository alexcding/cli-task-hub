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
  // Store under ~/Library/Application Support/TaskHub — the SAME dir dev.sh and the old Electron
  // build use (their product name), NOT the bundle identifier app_data_dir() gives
  // (…/tv.accedo.taskhub). This keeps one shared store so the packaged app sees the same projects
  // as dev instead of a separate, diverging database. Created if missing (mirrors dev.sh's mkdir).
  let data_dir = handle
    .path()
    .data_dir()
    .map(|d| d.join("TaskHub"))
    .unwrap_or_default();
  let _ = std::fs::create_dir_all(&data_dir);
  let data_dir = data_dir.to_string_lossy().into_owned();

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

// Show/hide the Dock icon (macOS) by switching the activation policy. Regular = Dock icon + menu
// bar; Accessory = menu-bar/tray only, no Dock icon. Used to start quietly (no Dock icon) when
// launched at login and to rejoin the Dock when the window is shown — NOT on window close, which
// keeps the app Regular (see hide_main). No-op off macOS.
pub(crate) fn set_dock_visible(app: &tauri::AppHandle, visible: bool) {
  #[cfg(target_os = "macos")]
  {
    let policy = if visible {
      tauri::ActivationPolicy::Regular
    } else {
      tauri::ActivationPolicy::Accessory
    };
    if let Err(e) = app.set_activation_policy(policy) {
      log::warn!("[dock] set_activation_policy(visible={visible}) failed: {e}");
    }
    // Switching to Regular makes AppKit re-derive the Dock icon from the (absent, in dev) bundle and
    // fall back to the generic executable icon — so reapply the real one. Only on the way to visible:
    // Accessory hides the Dock icon entirely, so there's nothing to fix there.
    if visible {
      glass::set_app_icon();
    }
  }
  #[cfg(not(target_os = "macos"))]
  let _ = (app, visible);
}

pub(crate) fn show_main(app: &tauri::AppHandle) {
  // Rejoin the Dock before showing — an Accessory app's window can't take focus reliably.
  set_dock_visible(app, true);
  // Target the "main" WEBVIEW's window, not get_webview_window(): once the window hosts child
  // webviews (an embedded tab is open) it's a multiwebview window and get_webview_window returns
  // None — so show/focus (and the tray/menu/notify evals) would silently no-op.
  if let Some(w) = app.get_webview("main") {
    let win = w.window();
    let _ = win.show();
    let _ = win.set_focus();
  }
}

// Hide the window, leaving the app resident (Dock icon + menu bar + tray stay). The shared path for
// every "close the window" trigger (red button, "Close Window", AND the app-menu ⌘Q "Quit TaskHub")
// — NOT a quit. Closing a window must NOT drop the Dock icon: like the Electron build (and any
// regular macOS app), TaskHub keeps its Dock presence and menu bar when its window is closed, and a
// Dock click re-opens it (RunEvent::Reopen → show_main). Only the tray's Quit (quit_app) exits.
pub(crate) fn hide_main(app: &tauri::AppHandle) {
  if let Some(w) = app.get_webview("main") {
    let win = w.window();
    // Un-minimize first so a window closed while minimized hides cleanly and re-shows as a real
    // window rather than restoring a stale thumbnail.
    let _ = win.unminimize();
    let _ = win.hide();
  }
}

// The one real quit — ONLY the tray's "Quit TaskHub" calls this, matching the Electron build where
// the tray Quit was the single sanctioned exit. Flip QUITTING (so the window's CloseRequested handler
// lets the close through), kill the child CLIs/PTYs, and exit — process death removes the Dock icon,
// menu bar, and tray together. Every OTHER close/quit trigger (red button, ⌘Q, app-menu "Quit
// TaskHub") just hides the window via hide_main and leaves the app fully resident. NOT the predefined
// .quit() menu role: that terminates immediately, skipping QUITTING and the PTY cleanup.
pub(crate) fn quit_app(app: &tauri::AppHandle) {
  QUITTING.store(true, Ordering::SeqCst);
  terminals::kill_all(app);
  app.exit(0);
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
    // Traffic lights are left at the macOS default position (stock). A custom inset jittered on
    // resize and the only jitter-free fix is an NSWindow-delegate wrap — not worth it for the look.
  }

  let _window = builder.build()?;
  // (No auto-opened devtools — use right-click → Inspect Element in a debug build if needed.)

  // Keep the Dock icon in lockstep with the window: launched at login the window starts hidden, so
  // start as a menu-bar-only app (no Dock icon) and let show_main flip to Regular when the tray/Dock
  // reveals it; any other launch shows the window, so show the Dock icon too (don't rely on the
  // process's default activation policy).
  set_dock_visible(app, !at_login);

  // Native translucent sidebar behind the transparent window. The renderer paints the content area
  // opaque and leaves the sidebar transparent (css: html.native-mac aside), so the material shows
  // ONLY behind the sidebar — the standard macOS look (Finder/Mail). macOS 26 (Tahoe) uses the new
  // Liquid Glass material (NSGlassEffectView); older systems get the classic NSVisualEffectView
  // frost. NSGlassEffectView doesn't exist before macOS 26, so pick at runtime.
  #[cfg(target_os = "macos")]
  {
    let used_glass = glass::macos_major_version() >= 26
      && match glass::apply_glass_sidebar(&_window) {
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
      commands::zoom_begin,
      commands::zoom_apply,
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
      terminals::term_create,
      terminals::term_write,
      terminals::term_resize,
      terminals::term_kill,
      terminals::term_list,
      terminals::term_attach,
      terminals::term_foreground,
    ])
    .on_menu_event(|app, event| {
      // App-menu "Quit TaskHub" (⌘Q): NOT a real quit — matching the Electron build, it just hides
      // the window (like the red button) and leaves the app resident (Dock icon + menu bar + tray
      // all stay). The one sanctioned exit is the tray's "Quit TaskHub" (quit_app).
      if event.id().as_ref() == "app:hide" {
        hide_main(app);
        return;
      }
      // App-menu accelerators: dispatch the "sc:<action>" id to the renderer's __shortcut.
      // Tray menu ids (no "sc:" prefix) are handled by the tray's own handler and ignored here.
      if let Some(action) = event.id().as_ref().strip_prefix("sc:") {
        menu::dispatch(app, action);
      }
    })
    .on_window_event(|window, event| {
      // Closing a window hides it (app stays resident); only a real quit (quit_app) exits.
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if !QUITTING.load(Ordering::SeqCst) {
          api.prevent_close();
          hide_main(&window.app_handle());
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
