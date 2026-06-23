// Notifications — the Tauri port of src/main/native/notifications.js + the activity wiring in
// main.js. Two surfaces:
//
//   • Review-requested  — fired from the tray refresh (tray::detect_review_changes uses the state
//     here): a native notification + sound when a PR newly needs your review. "Newly" is the
//     server's durable review state (reviewPending + requestedAt), not in-memory guesswork.
//   • Activity          — driven by the server SSE stream (start_stream below). The renderer toasts
//     new activity when its window is focused; we fire a native notification when it isn't (the main
//     process is the sole decider so the two can't double-fire). Honors the Appearance toggle.
use std::collections::HashMap;
use std::io::BufRead;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

// activityNotify == 'off' — mirrored from /api/settings on each tray refresh (defaults on/false).
pub static ACTIVITY_OFF: AtomicBool = AtomicBool::new(false);

// First tray refresh seeds silently (don't notify for reviews already pending at launch).
pub static REVIEW_SEEDED: AtomicBool = AtomicBool::new(false);
// prKey ("repo#number") -> the requestedAt marker we last announced. A fresh launch re-seeds, so
// currently-pending reviews don't re-alert on restart (the menu still lists them — server-driven).
pub static NOTIFIED_AT: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

// A native macOS notification (title + body). Clicking activates the app (default OS behavior);
// per-notification click routing isn't wired (minor vs the Electron build's open-this-PR click).
pub fn notify_native(app: &AppHandle, title: &str, body: &str) {
  let _ = app.notification().builder().title(title).body(body).show();
}

// The reviewSound setting → a sound file: an absolute path, or the macOS Glass chime for null/'system'.
fn sound_file(sound: Option<&str>) -> String {
  match sound {
    Some(s) if !s.is_empty() && s != "system" => s.to_string(),
    _ => "/System/Library/Sounds/Glass.aiff".to_string(),
  }
}

// Play the review sound via afplay (fire-and-forget, off-thread).
pub fn play_review_sound(sound: Option<&str>) {
  let f = sound_file(sound);
  std::thread::spawn(move || {
    let _ = std::process::Command::new("afplay").arg(&f).status();
  });
}

fn short_repo(repo: &str) -> String {
  repo.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or(repo).to_string()
}

// One activity entry → (title, body, optional PR url). Mirrors notifications.js activityMessage,
// which itself mirrors the renderer's presentEvent() copy so a notification reads like its feed row.
fn activity_message(ev: &Value) -> (String, String, Option<String>) {
  let p = ev.get("payload").cloned().unwrap_or(Value::Null);
  let ps = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
  let pr = p.get("pr").cloned().unwrap_or(Value::Null);
  let num = pr.get("number").and_then(|n| n.as_i64()).map(|n| n.to_string()).unwrap_or_else(|| "?".into());
  let pr_title = pr.get("title").and_then(|v| v.as_str()).unwrap_or("");
  let pr_body = format!("#{num} {pr_title}").trim().to_string();
  let pr_url = pr.get("url").and_then(|v| v.as_str()).map(|s| s.to_string());
  let typ = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
  match typ {
    "pr_opened" => (format!("Pull request opened in {}", short_repo(&ps("repo"))), pr_body, pr_url),
    "pr_merged" => (format!("Pull request merged in {}", short_repo(&ps("repo"))), pr_body, pr_url),
    "pr_closed" => (format!("Pull request closed in {}", short_repo(&ps("repo"))), pr_body, pr_url),
    "jira_transitioned" => {
      let key = if ps("key").is_empty() { "Ticket".into() } else { ps("key") };
      let tr = if ps("transition").is_empty() { "?".into() } else { ps("transition") };
      let body = if !ps("version").is_empty() { format!("Fix Version {}", ps("version")) } else { String::new() };
      (format!("{key} → {tr}"), body, None)
    }
    "jira_version_created" => (format!("Fix Version {} created", if ps("version").is_empty() { "?".into() } else { ps("version") }), ps("project"), None),
    "jira_fixversion_set" => (format!("Fix Version {} set", if ps("version").is_empty() { "?".into() } else { ps("version") }), ps("key"), None),
    "jira_transition_failed" => (format!("Failed to transition {}", if ps("key").is_empty() { "ticket".into() } else { ps("key") }), ps("error"), None),
    "jira_fixversion_failed" => ("Failed to set Fix Version".into(), ps("error"), None),
    "sync_failed" => (format!("Sync failed for {}", short_repo(&ps("repo"))), ps("error"), None),
    // Unknown/future types: title-case the tag, surface any error/detail the payload carries.
    other => {
      let title = if other.is_empty() { "Activity".to_string() } else { other.replace('_', " ") };
      let detail = if !ps("error").is_empty() { ps("error") } else { ps("detail") };
      (title, detail, None)
    }
  }
}

// A new activity entry arrived over SSE. Sole decider for the two surfaces: window focused → push
// the in-app toast into the renderer (window.isFocused stays true even when an embedded webview tab
// holds focus, where the renderer's own hasFocus() reads false); otherwise → a native notification.
fn maybe_notify_activity(app: &AppHandle, ev: &Value) {
  if ACTIVITY_OFF.load(Ordering::Relaxed) {
    return;
  }
  // get_webview("main") + .window(): get_webview_window returns None once an embedded tab is open.
  let main = app.get_webview("main");
  let focused = main.as_ref().and_then(|w| w.window().is_focused().ok()).unwrap_or(false);
  if focused {
    if let Some(w) = &main {
      let _ = w.eval(&format!("window.__activityToast&&window.__activityToast({})", ev));
    }
  } else {
    let (title, body, _url) = activity_message(ev);
    notify_native(app, &title, &body);
  }
}

// Subscribe to the backend SSE stream (the Tauri port of supervisor.subscribeStream): activity
// events drive notifications; sync events refresh the tray (more responsive than the 20s poll).
// Reconnects after the stream drops. Uses `curl -N` to avoid pulling in an async HTTP client.
pub fn start_stream(app: &AppHandle) {
  let app = app.clone();
  std::thread::spawn(move || loop {
    stream_once(&app);
    std::thread::sleep(Duration::from_secs(1)); // brief backoff, then reconnect
  });
}

fn stream_once(app: &AppHandle) {
  let mut child = match std::process::Command::new("curl")
    .args(["-sN", "--no-buffer", "http://127.0.0.1:3000/api/stream"])
    .stdout(std::process::Stdio::piped())
    .spawn()
  {
    Ok(c) => c,
    Err(_) => return,
  };
  let Some(stdout) = child.stdout.take() else { return };
  // Each SSE frame carries one `data:` line of JSON; a blank line separates frames.
  for line in std::io::BufReader::new(stdout).lines() {
    let Ok(line) = line else { break };
    let Some(data) = line.strip_prefix("data:") else { continue };
    let data = data.trim();
    if data.is_empty() {
      continue;
    }
    if let Ok(evt) = serde_json::from_str::<Value>(data) {
      match evt.get("type").and_then(|v| v.as_str()) {
        Some("activity") => {
          if let Some(e) = evt.get("event") {
            maybe_notify_activity(app, e);
          }
        }
        Some("sync") => crate::tray::refresh(app),
        _ => {}
      }
    }
  }
  let _ = child.kill();
}
