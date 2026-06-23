// Render the Claude/Codex usage panel (Session/Weekly bars + labels) to an RGBA image, so the tray
// can show it as ONE menu-row icon — the Tauri equivalent of the Electron tray's HTML→screenshot
// usage panel (which a native menu can't do). Bars are drawn directly; text is rasterized with
// ab_glyph from a system font. Returns (rgba, width, height) or None if no font / no data.
use ab_glyph::{Font, FontVec, GlyphId, PxScale, ScaleFont};

const ACCENT_CLAUDE: [u8; 3] = [0xd9, 0x77, 0x57]; // coral
const ACCENT_CODEX: [u8; 3] = [0x71, 0x7a, 0xf0]; // periwinkle

pub fn accent(agent: &str) -> [u8; 3] {
  if agent == "codex" { ACCENT_CODEX } else { ACCENT_CLAUDE }
}

fn load_font() -> Option<FontVec> {
  for p in [
    "/System/Library/Fonts/SFNS.ttf",
    "/System/Library/Fonts/Geneva.ttf",
    "/System/Library/Fonts/Monaco.ttf",
    "/Library/Fonts/Arial.ttf",
  ] {
    if let Ok(bytes) = std::fs::read(p) {
      if let Ok(f) = FontVec::try_from_vec(bytes) {
        return Some(f);
      }
    }
  }
  None
}

struct Canvas {
  buf: Vec<u8>,
  w: i32,
  h: i32,
}

impl Canvas {
  fn new(w: i32, h: i32) -> Self {
    Canvas { buf: vec![0u8; (w * h * 4) as usize], w, h }
  }
  // Source-over blend of `c` at coverage `a` onto the (transparent) canvas.
  fn blend(&mut self, x: i32, y: i32, c: [u8; 3], a: f32) {
    if x < 0 || y < 0 || x >= self.w || y >= self.h || a <= 0.0 {
      return;
    }
    let a = a.clamp(0.0, 1.0);
    let i = ((y * self.w + x) * 4) as usize;
    let inv = 1.0 - a;
    for k in 0..3 {
      self.buf[i + k] = (c[k] as f32 * a + self.buf[i + k] as f32 * inv).round() as u8;
    }
    self.buf[i + 3] = ((a + self.buf[i + 3] as f32 / 255.0 * inv) * 255.0).round().min(255.0) as u8;
  }
  fn fill(&mut self, x: i32, y: i32, w: i32, h: i32, c: [u8; 3], a: f32) {
    for yy in y..y + h {
      for xx in x..x + w {
        self.blend(xx, yy, c, a);
      }
    }
  }
  fn text(&mut self, font: &FontVec, x: f32, baseline: f32, s: &str, px: f32, c: [u8; 3]) {
    let sf = font.as_scaled(PxScale::from(px));
    let mut pen = x;
    let mut prev: Option<GlyphId> = None;
    for ch in s.chars() {
      let id = sf.glyph_id(ch);
      if let Some(p) = prev {
        pen += sf.kern(p, id);
      }
      let glyph = id.with_scale_and_position(PxScale::from(px), ab_glyph::point(pen, baseline));
      if let Some(o) = font.outline_glyph(glyph) {
        let bb = o.px_bounds();
        o.draw(|gx, gy, cov| {
          self.blend(bb.min.x as i32 + gx as i32, bb.min.y as i32 + gy as i32, c, cov);
        });
      }
      pen += sf.h_advance(id);
      prev = Some(id);
    }
  }
}


// One plan-limit group to draw: title, bar fill = `left`% remaining, optional green pace tick at
// `pace_left`%, and a pre-formatted data line ("45% left · 12% in reserve · resets in 2h").
pub struct Group {
  pub title: String,
  pub left: i64,
  pub pace_left: Option<f64>,
  pub data: String,
}

// Render the full Session/Weekly usage panel to an RGBA image — the same layout as the Electron
// tray's HTML panel (usage-image.js): stacked groups, each a title + bar (accent fill to % left,
// 50/75% gridmarks, green pace tick) + data line. With the vendored muda (18px cap removed) this
// shows full-size as one menu row. Rendered at 2× for crispness.
pub fn render(groups: &[Group], accent: [u8; 3], dark: bool) -> Option<(Vec<u8>, u32, u32)> {
  if groups.is_empty() {
    return None;
  }
  let font = load_font()?;
  let s = 2.0f32; // 2× scale (device px); displayed at half via the patched muda(None) sizing
  let w = (300.0 * s) as i32;
  let pad = 12.0 * s;
  let group_h = (52.0 * s) as i32;
  let h = (10.0 * s) as i32 + group_h * groups.len() as i32;

  let text_c = if dark { [0xe8, 0xe8, 0xe8] } else { [0x16, 0x18, 0x1d] };
  let muted_c = if dark { [0x8a, 0x8a, 0x8a] } else { [0x92, 0x98, 0xa3] };
  let track_c = if dark { [255, 255, 255] } else { [0, 0, 0] };
  let track_a = if dark { 0.16 } else { 0.12 };
  let mark_a = if dark { 0.26 } else { 0.22 };
  let pace_c = [0x16, 0xa3, 0x4a]; // green
  let _ = muted_c;

  let mut cv = Canvas::new(w, h);
  let bar_w = w as f32 - pad * 2.0;
  let bar_h = (7.0 * s) as i32;
  for (i, g) in groups.iter().enumerate() {
    let gy = (6.0 * s) as i32 + group_h * i as i32;
    cv.text(&font, pad, gy as f32 + 15.0 * s, &g.title, 14.0 * s, text_c);

    let bar_y = gy + (24.0 * s) as i32;
    let bx = pad as i32;
    cv.fill(bx, bar_y, bar_w as i32, bar_h, track_c, track_a);
    let fw = (bar_w * g.left.clamp(0, 100) as f32 / 100.0) as i32;
    cv.fill(bx, bar_y, fw, bar_h, accent, 1.0);
    for frac in [0.5f32, 0.75] {
      cv.fill(bx + (bar_w * frac) as i32, bar_y, (1.0 * s) as i32, bar_h, track_c, mark_a);
    }
    if let Some(p) = g.pace_left {
      let px = bx + (bar_w * (p.clamp(0.0, 100.0) as f32) / 100.0) as i32;
      cv.fill(px - s as i32, bar_y - (1.0 * s) as i32, (2.0 * s) as i32, bar_h + (2.0 * s) as i32, pace_c, 1.0);
    }

    cv.text(&font, pad, (bar_y + bar_h) as f32 + 15.0 * s, &g.data, 12.5 * s, text_c);
  }
  Some((cv.buf, w as u32, h as u32))
}
