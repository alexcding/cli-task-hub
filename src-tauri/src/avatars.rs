// Author-avatar menu icons — mirrors the Electron tray (src/main/native/icons.js avatarIcon):
// each GitHub PR row shows the author's ROUND avatar with a small CI-status dot; Jira rows show the
// Jira mark. Avatars are fetched once (github.com/<login>.png, PNG or JPEG) and cached. Rendered at
// 32px (@2× → ~16pt after muda's /2). Falls back to None (plain text row) if the avatar can't load.
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

const PX: u32 = 32;

// login → 32×32 RGBA circular-masked avatar (no dot), or None if it failed (cached so we don't refetch).
static CACHE: LazyLock<Mutex<HashMap<String, Option<Vec<u8>>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn ci_color(status: Option<&str>, conclusion: Option<&str>) -> Option<[u8; 3]> {
  match (status, conclusion) {
    (Some("in_progress"), _) | (Some("queued"), _) => Some([0xf5, 0x9e, 0x0b]), // amber
    (_, Some("success")) => Some([0x16, 0xa3, 0x4a]),                            // green
    (_, Some("failure")) => Some([0xdc, 0x26, 0x26]),                            // red
    _ => None,
  }
}

fn blend(buf: &mut [u8], i: usize, c: [u8; 3], a: f32) {
  let a = a.clamp(0.0, 1.0);
  if a <= 0.0 {
    return;
  }
  let ia = 1.0 - a;
  buf[i] = (c[0] as f32 * a + buf[i] as f32 * ia).round() as u8;
  buf[i + 1] = (c[1] as f32 * a + buf[i + 1] as f32 * ia).round() as u8;
  buf[i + 2] = (c[2] as f32 * a + buf[i + 2] as f32 * ia).round() as u8;
  buf[i + 3] = (255.0 * a + buf[i + 3] as f32 * ia).round().min(255.0) as u8;
}

fn decode_square(bytes: &[u8]) -> Option<Vec<u8>> {
  let img = image::load_from_memory(bytes).ok()?;
  Some(img.resize_to_fill(PX, PX, image::imageops::FilterType::Triangle).to_rgba8().into_raw())
}

fn circular_mask(rgba: &mut [u8]) {
  let c = (PX as f32 - 1.0) / 2.0;
  let r = PX as f32 / 2.0;
  for y in 0..PX {
    for x in 0..PX {
      let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
      let a = (r - d + 0.5).clamp(0.0, 1.0);
      if a < 1.0 {
        let i = ((y * PX + x) * 4) as usize;
        rgba[i + 3] = (rgba[i + 3] as f32 * a).round() as u8;
      }
    }
  }
}

// Fetch + circular-mask one author's avatar (cached, incl. failures). Blocking (curl) — call from a
// worker thread (warm), then build the menu off the cache.
fn fetch_base(login: &str) -> Option<Vec<u8>> {
  if let Some(cached) = CACHE.lock().unwrap().get(login) {
    return cached.clone();
  }
  let result = (|| {
    let out = std::process::Command::new("curl")
      .args(["-fsSL", "--max-time", "5", &format!("https://github.com/{login}.png?size=64")])
      .output()
      .ok()?;
    if !out.status.success() || out.stdout.is_empty() {
      return None;
    }
    let mut rgba = decode_square(&out.stdout)?;
    circular_mask(&mut rgba);
    Some(rgba)
  })();
  CACHE.lock().unwrap().insert(login.to_string(), result.clone());
  result
}

// Warm the cache for a login (worker thread).
pub fn warm(login: &str) {
  if !login.is_empty() {
    let _ = fetch_base(login);
  }
}

// Raw avatar bytes (PNG/JPEG, as GitHub serves them) for the renderer's <img>, cached so WKWebView
// re-renders don't re-fetch (the `avatar://` scheme in lib.rs serves these). Separate from the
// tray's processed-RGBA cache above — the renderer wants the original image, rounded by CSS.
static RAW: LazyLock<Mutex<HashMap<String, Option<Vec<u8>>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn avatar_raw(login: &str) -> Option<Vec<u8>> {
  if login.is_empty() {
    return None;
  }
  if let Some(cached) = RAW.lock().unwrap().get(login) {
    return cached.clone();
  }
  let bytes = std::process::Command::new("curl")
    .args(["-fsSL", "--max-time", "5", &format!("https://github.com/{login}.png?size=80")])
    .output()
    .ok()
    .filter(|o| o.status.success() && !o.stdout.is_empty())
    .map(|o| o.stdout);
  RAW.lock().unwrap().insert(login.to_string(), bytes.clone());
  bytes
}

// Final icon: cached circular avatar + a corner CI dot (ringed in the menu-bg color). Approved PRs
// show the green dot unless CI is failing. None → no avatar cached (caller uses a plain text row).
pub fn avatar_icon(login: &str, ci_status: Option<&str>, ci_conclusion: Option<&str>, approved: bool, dark: bool) -> Option<(Vec<u8>, u32, u32)> {
  let mut bmp = fetch_base(login)?;
  let dot = if approved && ci_conclusion != Some("failure") {
    Some([0x16, 0xa3, 0x4a])
  } else {
    ci_color(ci_status, ci_conclusion)
  };
  if let Some(col) = dot {
    let ring = if dark { [38, 38, 40] } else { [255, 255, 255] };
    let (cx, cy) = (PX as f32 - 7.0, PX as f32 - 7.0);
    for y in 0..PX {
      for x in 0..PX {
        let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
        let i = ((y * PX + x) * 4) as usize;
        blend(&mut bmp, i, ring, (6.0 - d + 0.5).clamp(0.0, 1.0));
        blend(&mut bmp, i, col, (4.0 - d + 0.5).clamp(0.0, 1.0));
      }
    }
  }
  Some((bmp, PX, PX))
}

// The Jira diamond (same asset the Electron tray uses), embedded + resized to the avatar size.
pub fn jira_icon() -> Option<(Vec<u8>, u32, u32)> {
  static JIRA: LazyLock<Option<Vec<u8>>> = LazyLock::new(|| decode_square(include_bytes!("../../build/tray-jira.png")));
  (*JIRA).clone().map(|v| (v, PX, PX))
}
