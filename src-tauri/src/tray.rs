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
struct Author {
  #[serde(default)]
  login: String,
}

#[derive(Deserialize, Clone, Default)]
struct Ci {
  #[serde(default)]
  status: Option<String>,
  #[serde(default)]
  conclusion: Option<String>,
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
  #[serde(default)]
  requested_at: Option<String>,
  #[serde(default)]
  author: Option<Author>,
  #[serde(default)]
  ci: Option<Ci>,
  #[serde(default)]
  review_decision: Option<String>,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct UsageWin {
  #[serde(default)]
  used_pct: Option<f64>,
  #[serde(default)]
  resets_at: Option<serde_json::Value>, // Claude: ISO string; Codex: unix seconds
}

const SESSION_MS: i64 = 5 * 3_600_000;
const WEEK_MS: i64 = 7 * 86_400_000;

fn fmt_until(ms: i64) -> Option<String> {
  let m = ms / 60_000;
  if m <= 0 {
    return None;
  }
  let (d, h, mm) = (m / 1440, (m % 1440) / 60, m % 60);
  Some(if d > 0 {
    format!("{d}d {h}h")
  } else if h > 0 {
    format!("{h}h {mm:02}m")
  } else {
    format!("{mm}m")
  })
}

fn parse_reset_ms(v: &serde_json::Value) -> Option<i64> {
  match v {
    serde_json::Value::Number(n) => n.as_f64().map(|x| if x > 1e12 { x as i64 } else { (x * 1000.0) as i64 }),
    serde_json::Value::String(s) => chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis()),
    _ => None,
  }
}

// Derived stats for one plan window — mirrors limitStats in usage-image.js: bar fills to `left`
// (% remaining), pace tick at `paceLeft`, and a data line "N% left · reserve · resets in …".
fn group_for(title: &str, win: &Option<UsageWin>, win_ms: i64, now: i64) -> Option<crate::usage_image::Group> {
  let w = win.as_ref()?;
  let used = w.used_pct?;
  let left = (100.0 - used).round() as i64;
  let reset_ms = w.resets_at.as_ref().and_then(parse_reset_ms);
  let pace_left = reset_ms.map(|end| {
    let elapsed = (100.0 - (end - now) as f64 / win_ms as f64 * 100.0).clamp(0.0, 100.0);
    100.0 - elapsed
  });
  let mut data = format!("{left}% left");
  if let Some(pl) = pace_left {
    let reserve = (left as f64 - pl).round() as i64;
    data += &if reserve >= 0 { format!(" · {reserve}% in reserve") } else { format!(" · {}% over pace", -reserve) };
  }
  if let Some(end) = reset_ms {
    if let Some(u) = fmt_until(end - now) {
      data += &format!(" · resets in {u}");
    }
  }
  Some(crate::usage_image::Group { title: title.to_string(), left, pace_left, data })
}

#[derive(Deserialize, Clone, Default)]
struct Limits {
  #[serde(default)]
  session: Option<UsageWin>,
  #[serde(default)]
  weekly: Option<UsageWin>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Usage {
  #[serde(default)]
  limits: Option<Limits>,
  #[serde(default)]
  codex_limits: Option<Limits>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
  #[serde(default)]
  usage_agent: Option<String>,
  #[serde(default)]
  review_sound: Option<String>,
  #[serde(default)]
  activity_notify: Option<String>,
}

// What a clicked menu item does: open `url` as a tab; if `viewed` is set, also POST it acknowledged.
// pub(crate) so notify.rs can reuse open_action for notification-click → open-PR.
#[derive(Clone)]
pub(crate) struct Action {
  pub(crate) url: String,
  pub(crate) title: String,
  pub(crate) kind: String,
  pub(crate) group: String,
  pub(crate) viewed: Option<(String, i64)>, // (repo, number) for /api/prs/viewed
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
    let out: String = s.chars().take(max - 1).collect();
    // trim trailing space before the ellipsis (matches Electron's .trimEnd() + '…')
    format!("{}…", out.trim_end())
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

// Build a GitHub PR row's author-avatar icon (with CI dot), or None for a plain row.
fn gh_icon(pr: Option<&Pr>, dark: bool) -> Option<tauri::image::Image<'static>> {
  let pr = pr?;
  let login = pr.author.as_ref().map(|a| a.login.clone()).unwrap_or_default();
  if login.is_empty() {
    return None;
  }
  let st = pr.ci.as_ref().and_then(|c| c.status.as_deref());
  let cc = pr.ci.as_ref().and_then(|c| c.conclusion.as_deref());
  let approved = pr.review_decision.as_deref() == Some("APPROVED");
  crate::avatars::avatar_icon(&login, st, cc, approved, dark).map(|(rgba, w, h)| tauri::image::Image::new_owned(rgba, w, h))
}

fn jira_img() -> Option<tauri::image::Image<'static>> {
  crate::avatars::jira_icon().map(|(rgba, w, h)| tauri::image::Image::new_owned(rgba, w, h))
}

fn build_menu(app: &AppHandle, tabs: &[Tab], prs: &[Pr], usage: &Usage, settings: &Settings) -> tauri::Result<Menu<Wry>> {
  use std::collections::HashMap as Map;
  let dark = app
    .get_webview("main")
    .and_then(|w| w.window().theme().ok())
    .map(|t| t == tauri::Theme::Dark)
    .unwrap_or(true);
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

  // Review requested (PRs awaiting my review I haven't opened yet) — with author avatar + CI dot.
  if !pending.is_empty() {
    any = true;
    b = b.item(&MenuItemBuilder::with_id(format!("h{seq}"), "Review requested").enabled(false).build(app)?);
    seq += 1;
    for p in &pending {
      let id = format!("rev:{seq}");
      seq += 1;
      let title = format!("PR #{} {}", p.number, p.title);
      let label = truncate(&title, 38);
      b = match gh_icon(Some(p), dark) {
        Some(icon) => b.item(&tauri::menu::IconMenuItemBuilder::with_id(&id, label).icon(icon).build(app)?),
        None => b.text(&id, label),
      };
      map.insert(id, Action { url: p.url.clone(), title, kind: "github".into(), group: pr_group(p), viewed: Some((p.repo.clone(), p.number)) });
    }
    b = b.separator();
  }

  // Open-tab sections, grouped like the sidebar, with avatars (GitHub) / the Jira mark.
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
      let row = truncate(&title, 38);
      let icon = if t.kind == "jira" { jira_img() } else { gh_icon(pr_by_url.get(t.url.as_str()).copied(), dark) };
      b = match icon {
        Some(img) => b.item(&tauri::menu::IconMenuItemBuilder::with_id(&id, row).icon(img).build(app)?),
        None => b.text(&id, row),
      };
      let grp = if t.kind == "jira" { t.category.clone() } else { tab_group(t) };
      map.insert(id, Action { url: t.url.clone(), title, kind: t.kind.clone(), group: grp, viewed: None });
    }
  }

  if !any {
    b = b.item(&MenuItemBuilder::with_id("none", "Nothing to review or open").enabled(false).build(app)?);
  }

  // Claude/Codex plan usage for the selected agent — the full panel as one image menu row (same
  // layout + stats as the Electron tray / dashboard widget). The vendored muda (18px cap removed)
  // lets the row grow to the image.
  let agent = settings.usage_agent.as_deref().unwrap_or("claude");
  let limits = if agent == "codex" { usage.codex_limits.clone() } else { usage.limits.clone() };
  if let Some(lim) = limits {
    let now = chrono::Utc::now().timestamp_millis();
    let groups: Vec<crate::usage_image::Group> = [
      group_for("Session", &lim.session, SESSION_MS, now),
      group_for("Weekly", &lim.weekly, WEEK_MS, now),
    ]
    .into_iter()
    .flatten()
    .collect();
    if !groups.is_empty() {
      b = b.separator();
      match crate::usage_image::render(&groups, crate::usage_image::accent(agent), dark) {
        Some((rgba, w, h)) => {
          let image = tauri::image::Image::new_owned(rgba, w, h);
          b = b.item(&tauri::menu::IconMenuItemBuilder::with_id("usage:open", "").icon(image).build(app)?);
        }
        None => {
          // No font → text fallback.
          let label = if agent == "codex" { "Codex usage" } else { "Claude usage" };
          b = b.item(&MenuItemBuilder::with_id("uhdr", label).enabled(false).build(app)?);
          for g in &groups {
            b = b.text(format!("usage:{}", g.title), format!("{} — {}", g.title, g.data));
          }
        }
      }
    }
  }

  b = b.separator().text("quit", "Quit TaskHub");
  b.build()
}

pub(crate) fn open_action(app: &AppHandle, a: &Action) {
  crate::show_main(app);
  if let Some(w) = app.get_webview("main") {
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
    "quit" => crate::quit_app(app),
    _ if id.starts_with("usage:") => {
      crate::show_main(app);
      if let Some(w) = app.get_webview("main") {
        let _ = w.eval("window.showPage && window.showPage('dashboard')");
      }
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

// Notify + play a sound for any review-category PR pending a request we haven't announced yet —
// the port of notifications.js detectReviewChanges. State (seeded flag + notified map) lives in
// notify.rs; runs on the refresh worker thread (notifications/afplay off the main thread is fine).
fn detect_review_changes(app: &AppHandle, prs: &[Pr], sound: Option<&str>) {
  let key = |p: &Pr| format!("{}#{}", p.repo, p.number);
  // Stable marker for "this exact request": its timestamp, or a constant when none is supplied.
  let marker = |p: &Pr| p.requested_at.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "pending".into());
  let pending: Vec<&Pr> = prs.iter().filter(|p| p.category == "review" && p.review_pending.unwrap_or(false)).collect();

  let mut map = crate::notify::NOTIFIED_AT.lock().unwrap();
  let fresh: Vec<&Pr> = pending.iter().copied().filter(|p| map.get(&key(p)).map(|m| *m != marker(p)).unwrap_or(true)).collect();

  if crate::notify::REVIEW_SEEDED.load(Ordering::SeqCst) && !fresh.is_empty() {
    for p in &fresh {
      let full = format!("PR #{} {}", p.number, p.title);
      // Clicking opens the PR in a tab (matches Electron's notifyReviewRequested). `pending` is
      // pre-filtered to category=="review", so the tab lands in the Review group.
      let click = crate::notify::NotifyClick::OpenTab { url: p.url.clone(), title: full.clone(), category: "review".to_string() };
      crate::notify::notify_native(app, "Review requested", &full, Some(click));
    }
    crate::notify::play_review_sound(sound); // one sound per cycle, even if several arrive at once
  }

  // Remember what we've announced for every pending PR; drop PRs no longer pending so a later
  // re-request re-alerts and the map stays bounded.
  let current: std::collections::HashSet<String> = pending.iter().map(|p| key(p)).collect();
  for p in &pending {
    map.insert(key(p), marker(p));
  }
  map.retain(|k, _| current.contains(k));
  crate::notify::REVIEW_SEEDED.store(true, Ordering::SeqCst);
}

// Reread tabs + PR snapshot and re-arm the menu + icon. Menu/tray mutations run on the main thread.
// The icon shows a bronze review dot when reviews are pending (matches the Electron tray).
pub(crate) fn refresh(app: &AppHandle) {
  let tabs = curl_json::<TabsResp>("/api/tabs").tabs;
  let prs = curl_json::<Vec<Pr>>("/api/prs/tray");
  let usage = curl_json::<Usage>("/api/usage");
  let settings = curl_json::<Settings>("/api/settings");
  // Warm the avatar cache here (worker thread) so build_menu reads it without blocking the main thread.
  for p in &prs {
    if let Some(a) = &p.author {
      crate::avatars::warm(&a.login);
    }
  }
  // Notifications: mirror the Appearance toggle for activity, and announce newly-requested reviews.
  crate::notify::ACTIVITY_OFF.store(settings.activity_notify.as_deref() == Some("off"), Ordering::SeqCst);
  detect_review_changes(app, &prs, settings.review_sound.as_deref());
  let review = has_pending_review(&prs);
  let app = app.clone();
  let _ = app.clone().run_on_main_thread(move || {
    if let Some(tray) = app.tray_by_id("main") {
      if let Ok(menu) = build_menu(&app, &tabs, &prs, &usage, &settings) {
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
  let menu = build_menu(app, &[], &[], &Usage::default(), &Settings::default())?; // initial; refresh fills the body
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
