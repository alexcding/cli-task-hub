// Menu-bar tray (M5). The menu mirrors the app's open tabs (same /api/tabs source as the sidebar) —
// clicking one focuses the window and reopens that tab — plus Open / Quit, with the
// quit-only-from-tray invariant. The tab list is refreshed on a timer (a menu-bar app rarely quits).
//
// Deferred vs the Electron tray: the "Review requested" section, per-tab author avatars + CI badges,
// the live usage image, and a custom mono/template icon (needs a designed silhouette asset).
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::menu::{Menu, MenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

#[derive(Deserialize, Clone, Default)]
struct Tab {
  url: String,
  #[serde(default)]
  title: String,
  #[serde(default)]
  kind: String,
  #[serde(default)]
  category: String,
}

// menu-item id ("tab:<n>") → tab, rebuilt on every refresh so the click handler can resolve it.
#[derive(Default)]
pub struct TrayTabs(Mutex<HashMap<String, Tab>>);

fn jstr(s: &str) -> String {
  serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn truncate(s: &str, max: usize) -> String {
  if s.chars().count() <= max {
    s.to_string()
  } else {
    let mut out: String = s.chars().take(max - 1).collect();
    out.push('…');
    out
  }
}

// Read the open tabs from the local backend (best-effort; empty on any failure).
fn fetch_tabs() -> Vec<Tab> {
  match std::process::Command::new("curl")
    .args(["-fsS", "--max-time", "2", "http://127.0.0.1:3000/api/tabs"])
    .output()
  {
    Ok(o) if o.status.success() => serde_json::from_slice(&o.stdout).unwrap_or_default(),
    _ => Vec::new(),
  }
}

fn build_menu(app: &AppHandle, tabs: &[Tab]) -> tauri::Result<Menu<Wry>> {
  let map_state = app.state::<TrayTabs>();
  let mut map = map_state.0.lock().unwrap();
  map.clear();

  let mut b = MenuBuilder::new(app).text("open", "Open TaskHub");
  if !tabs.is_empty() {
    b = b.separator();
    for (i, t) in tabs.iter().enumerate() {
      let id = format!("tab:{i}");
      let label = if t.title.trim().is_empty() { &t.url } else { &t.title };
      b = b.text(&id, truncate(label, 48));
      map.insert(id, t.clone());
    }
  }
  b = b.separator().text("quit", "Quit TaskHub");
  b.build()
}

fn on_event(app: &AppHandle, id: &str) {
  match id {
    "open" => crate::show_main(app),
    "quit" => {
      crate::QUITTING.store(true, Ordering::SeqCst);
      crate::terminals::kill_all(app);
      app.exit(0);
    }
    _ if id.starts_with("tab:") => {
      let tab = app.state::<TrayTabs>().0.lock().unwrap().get(id).cloned();
      if let Some(t) = tab {
        crate::show_main(app);
        if let Some(w) = app.get_webview_window("main") {
          let js = format!(
            "window.__openTab&&window.__openTab({},{},{},{})",
            jstr(&t.url),
            jstr(&t.title),
            jstr(&t.kind),
            jstr(&t.category)
          );
          let _ = w.eval(&js);
        }
      }
    }
    _ => {}
  }
}

// Reread tabs and re-arm the tray menu. Menu/tray mutations run on the main thread.
fn refresh(app: &AppHandle) {
  let tabs = fetch_tabs();
  let app = app.clone();
  let _ = app.clone().run_on_main_thread(move || {
    if let Ok(menu) = build_menu(&app, &tabs) {
      if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_menu(Some(menu));
      }
    }
  });
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
  let menu = build_menu(app, &[])?; // initial Open/Quit; the refresh loop fills in tabs
  // Embed the icon at compile time so the tray ALWAYS has one — app.default_window_icon() is None
  // in dev, which would build a blank/invisible tray item. (Mono template icon is a follow-up.)
  let tray = TrayIconBuilder::with_id("main")
    .icon(tauri::include_image!("icons/32x32.png"))
    .icon_as_template(false)
    .title("TaskHub") // macOS: show text in the menu bar so it's visible even if the icon isn't
    .tooltip("TaskHub")
    .menu(&menu)
    .show_menu_on_left_click(true)
    .on_menu_event(|app, event| on_event(app, event.id().as_ref()))
    .build(app);
  match &tray {
    Ok(_) => log::info!("[tray] created"),
    Err(e) => log::error!("[tray] build failed: {e}"),
  }
  tray?;

  // Refresh the open-tab list periodically (the menu only needs to be current when opened).
  let app = app.clone();
  std::thread::spawn(move || loop {
    refresh(&app);
    std::thread::sleep(Duration::from_secs(30));
  });
  Ok(())
}
