// Menu-bar tray (M5). Mirrors the Electron tray menu (src/main/tray/menu.js):
//
//   Open TaskHub
//   ───
//   Review requested            (pending reviews from /api/prs/tray — click opens + marks viewed)
//   ───
//   Mine / Review / Jira         (open tabs from /api/tabs, grouped like the sidebar)
//   ───
//   Quit TaskHub                 (the one sanctioned exit — quit-only-from-tray)
//
// Refreshed on a timer. Deferred vs Electron: per-item avatars/CI badges, the usage image row,
// and the live status-colored icon (we use a static grayscale glyph, distinct from the app icon).
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
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

#[derive(Deserialize, Default)]
struct TabsResp {
  #[serde(default)]
  tabs: Vec<Tab>,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Pr {
  url: String,
  #[serde(default)]
  number: i64,
  #[serde(default)]
  title: String,
  #[serde(default)]
  category: String,
  #[serde(default)]
  repo: String,
  #[serde(default)]
  state: String,
  #[serde(default)]
  awaiting_my_review: Option<bool>,
  #[serde(default)]
  review_pending: Option<bool>,
}

// What a clicked menu item does: open `url` as a tab; if `viewed` is set, also POST it acknowledged.
#[derive(Clone)]
struct Action {
  url: String,
  title: String,
  kind: String,
  group: String,
  viewed: Option<(String, i64)>, // (repo, number) for /api/prs/viewed
}

#[derive(Default)]
pub struct TrayTabs(Mutex<HashMap<String, Action>>);

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

fn curl_json<T: for<'de> Deserialize<'de> + Default>(path: &str) -> T {
  match std::process::Command::new("curl")
    .args(["-fsS", "--max-time", "2", &format!("http://127.0.0.1:3000{path}")])
    .output()
  {
    Ok(o) if o.status.success() => serde_json::from_slice(&o.stdout).unwrap_or_default(),
    _ => T::default(),
  }
}

// Sidebar group for a PR — mirrors store.prGroup / the Electron tray's prGroup.
fn pr_group(p: &Pr) -> String {
  let review = p.awaiting_my_review.unwrap_or(p.category == "review");
  if review { "review".into() } else { "mine".into() }
}

fn build_menu(app: &AppHandle, tabs: &[Tab], prs: &[Pr]) -> tauri::Result<Menu<Wry>> {
  use std::collections::HashMap as Map;
  let pr_by_url: Map<&str, &Pr> = prs.iter().map(|p| (p.url.as_str(), p)).collect();
  let tab_group = |t: &Tab| -> String {
    match pr_by_url.get(t.url.as_str()) {
      Some(p) => pr_group(p),
      None => if t.category == "review" { "review".into() } else { "mine".into() },
    }
  };

  let github: Vec<&Tab> = tabs.iter().filter(|t| t.kind == "github").collect();
  let jira: Vec<&Tab> = tabs.iter().filter(|t| t.kind == "jira").collect();
  let mine: Vec<&Tab> = github.iter().copied().filter(|t| tab_group(t) != "review").collect();
  let review_tabs: Vec<&Tab> = github.iter().copied().filter(|t| tab_group(t) == "review").collect();
  let pending: Vec<&Pr> = prs
    .iter()
    .filter(|p| p.state == "OPEN" && p.category == "review" && p.review_pending.unwrap_or(false))
    .collect();

  let state = app.state::<TrayTabs>();
  let mut map = state.0.lock().unwrap();
  map.clear();
  let mut seq = 0usize;
  let mut any = false;

  let mut b = MenuBuilder::new(app).text("open", "Open TaskHub").separator();

  // Review requested (PRs awaiting my review I haven't opened yet).
  if !pending.is_empty() {
    any = true;
    b = b.item(&MenuItemBuilder::with_id(format!("h{seq}"), "Review requested").enabled(false).build(app)?);
    seq += 1;
    for p in &pending {
      let id = format!("rev:{seq}");
      seq += 1;
      let title = format!("PR #{} {}", p.number, p.title);
      b = b.text(&id, truncate(&title, 40));
      map.insert(id, Action { url: p.url.clone(), title, kind: "github".into(), group: pr_group(p), viewed: Some((p.repo.clone(), p.number)) });
    }
    b = b.separator();
  }

  // Open-tab sections, grouped like the sidebar.
  for (label, group) in [("Mine", &mine), ("Review", &review_tabs), ("Jira", &jira)] {
    if group.is_empty() {
      continue;
    }
    any = true;
    b = b.item(&MenuItemBuilder::with_id(format!("h{seq}"), label).enabled(false).build(app)?);
    seq += 1;
    for t in group.iter() {
      let id = format!("tab:{seq}");
      seq += 1;
      let title = if t.title.trim().is_empty() { t.url.clone() } else { t.title.clone() };
      b = b.text(&id, truncate(&title, 40));
      let grp = if t.kind == "jira" { t.category.clone() } else { tab_group(t) };
      map.insert(id, Action { url: t.url.clone(), title, kind: t.kind.clone(), group: grp, viewed: None });
    }
  }

  if !any {
    b = b.item(&MenuItemBuilder::with_id("none", "Nothing to review or open").enabled(false).build(app)?);
  }

  b = b.separator().text("quit", "Quit TaskHub");
  b.build()
}

fn open_action(app: &AppHandle, a: &Action) {
  crate::show_main(app);
  if let Some(w) = app.get_webview_window("main") {
    let js = format!(
      "window.__openTab&&window.__openTab({},{},{},{})",
      jstr(&a.url), jstr(&a.title), jstr(&a.kind), jstr(&a.group)
    );
    let _ = w.eval(&js);
  }
  // Acknowledge a review request server-side, then rebuild so it leaves the list.
  if let Some((repo, number)) = a.viewed.clone() {
    let app2 = app.clone();
    std::thread::spawn(move || {
      let body = serde_json::json!({ "repo": repo, "number": number }).to_string();
      let _ = std::process::Command::new("curl")
        .args(["-fsS", "-X", "POST", "-H", "Content-Type: application/json", "-d", &body, "http://127.0.0.1:3000/api/prs/viewed"])
        .output();
      refresh(&app2);
    });
  }
}

fn on_event(app: &AppHandle, id: &str) {
  match id {
    "open" => crate::show_main(app),
    "quit" => {
      crate::QUITTING.store(true, Ordering::SeqCst);
      crate::terminals::kill_all(app);
      app.exit(0);
    }
    _ => {
      let action = app.state::<TrayTabs>().0.lock().unwrap().get(id).cloned();
      if let Some(a) = action {
        open_action(app, &a);
      }
    }
  }
}

fn has_pending_review(prs: &[Pr]) -> bool {
  prs.iter().any(|p| p.state == "OPEN" && p.category == "review" && p.review_pending.unwrap_or(false))
}

// Reread tabs + PR snapshot and re-arm the menu + icon. Menu/tray mutations run on the main thread.
// The icon shows a bronze review dot when reviews are pending (matches the Electron tray).
fn refresh(app: &AppHandle) {
  let tabs = curl_json::<TabsResp>("/api/tabs").tabs;
  let prs = curl_json::<Vec<Pr>>("/api/prs/tray");
  let review = has_pending_review(&prs);
  let app = app.clone();
  let _ = app.clone().run_on_main_thread(move || {
    if let Some(tray) = app.tray_by_id("main") {
      if let Ok(menu) = build_menu(&app, &tabs, &prs) {
        let _ = tray.set_menu(Some(menu));
      }
      let icon = if review {
        tauri::include_image!("icons/tray-review.png")
      } else {
        tauri::include_image!("icons/tray-idle.png")
      };
      let _ = tray.set_icon(Some(icon));
    }
  });
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
  let menu = build_menu(app, &[], &[])?; // initial Open/Quit; the refresh loop fills the body
  let tray = TrayIconBuilder::with_id("main")
    .icon(tauri::include_image!("icons/tray-idle.png")) // white checkmark — matches the Electron tray glyph
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

  let app = app.clone();
  std::thread::spawn(move || loop {
    refresh(&app);
    std::thread::sleep(Duration::from_secs(20));
  });
  Ok(())
}
