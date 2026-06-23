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
  // Horizontal capsule (pill): rounded left/right ends, radius = h/2, anti-aliased.
  fn fill_round(&mut self, x: i32, y: i32, w: i32, h: i32, c: [u8; 3], a: f32) {
    if w <= 0 || h <= 0 {
      return;
    }
    let (wf, hf) = (w as f32, h as f32);
    let r = hf / 2.0;
    for yy in 0..h {
      for xx in 0..w {
        let px = xx as f32 + 0.5;
        let py = yy as f32 + 0.5;
        let cov = if px >= r && px <= wf - r {
          1.0
        } else {
          let cx = if px < r { r } else { wf - r };
          (r - ((px - cx).powi(2) + (py - hf / 2.0).powi(2)).sqrt() + 0.5).clamp(0.0, 1.0)
        };
        if cov > 0.0 {
          self.blend(x + xx, y + yy, c, a * cov);
        }
      }
    }
  }
  fn text(&mut self, font: &FontVec, x: f32, baseline: f32, s: &str, px: f32, c: [u8; 3], bold: bool) {
    // Faux-bold by stamping each glyph twice with a sub-pixel x offset (ab_glyph can't synthesize
    // weight, and SF's variable default reads light at small sizes).
    let offsets: &[f32] = if bold { &[0.0, 0.7] } else { &[0.0] };
    let sf = font.as_scaled(PxScale::from(px));
    for &dx in offsets {
      let mut pen = x + dx;
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
}


fn measure(font: &FontVec, s: &str, px: f32) -> f32 {
  let sf = font.as_scaled(PxScale::from(px));
  let mut w = 0.0;
  let mut prev: Option<GlyphId> = None;
  for ch in s.chars() {
    let id = sf.glyph_id(ch);
    if let Some(p) = prev {
      w += sf.kern(p, id);
    }
    w += sf.h_advance(id);
    prev = Some(id);
  }
  w
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
  // Rendered at 2× (the patched muda halves it back → crisp at logical size on retina).
  let s = 2.0f32;
  // Match the macOS menu text: SF (SFNS) at ~14pt. Title gets a touch of weight (faux-bold) as a
  // section header; data is regular, like the menu rows.
  let title_px = 16.0 * s;
  let data_px = 14.0 * s;
  // Small left inset so the content sits near the menu's text leading; bars then span the rest of
  // the width so they FILL the row (like Electron) rather than stopping at the data-text width.
  let lpad = 2.0 * s;
  let rpad = 6.0 * s;
  // Fixed width wide enough to fill the row, but at least as wide as the longest data line.
  let mut content = 260.0 * s;
  for g in groups {
    content = content.max(measure(&font, &g.title, title_px));
    content = content.max(measure(&font, &g.data, data_px));
  }
  let w = (content + lpad + rpad).ceil() as i32;
  let group_h = (40.0 * s) as i32; // one group's content (title + bar + data), tight
  let inter = (12.0 * s) as i32; // gap BETWEEN groups (Session ↔ Weekly)
  let n = groups.len() as i32;
  let h = (4.0 * s) as i32 + group_h * n + inter * (n - 1);

  let text_c = if dark { [255, 255, 255] } else { [0, 0, 0] }; // default menu label color
  let muted_c = if dark { [0x8a, 0x8a, 0x8a] } else { [0x92, 0x98, 0xa3] };
  let track_c = if dark { [255, 255, 255] } else { [0, 0, 0] };
  let track_a = if dark { 0.16 } else { 0.12 };
  let mark_a = if dark { 0.26 } else { 0.22 };
  let pace_c = [0x16, 0xa3, 0x4a]; // green
  let _ = muted_c;

  let mut cv = Canvas::new(w, h);
  let bar_w = w as f32 - lpad - rpad;
  let bar_h = (6.0 * s) as i32; // CSS bar height 6px
  for (i, g) in groups.iter().enumerate() {
    let gy = (2.0 * s) as i32 + i as i32 * (group_h + inter);
    cv.text(&font, lpad, gy as f32 + 12.0 * s, &g.title, title_px, text_c, false);

    let bar_y = gy + (17.0 * s) as i32;
    let bx = lpad as i32;
    // Rounded (pill) track + accent fill — border-radius:3px in the Electron CSS.
    cv.fill_round(bx, bar_y, bar_w as i32, bar_h, track_c, track_a);
    let fw = (bar_w * g.left.clamp(0, 100) as f32 / 100.0).round() as i32;
    cv.fill_round(bx, bar_y, fw, bar_h, accent, 1.0);
    // 50% / 75% gridmarks.
    for frac in [0.5f32, 0.75] {
      cv.fill(bx + (bar_w * frac) as i32, bar_y, (1.0 * s).max(1.0) as i32, bar_h, track_c, mark_a);
    }
    // Pace tick: a green core flanked by track-color gaps (the Electron `s` notch), full bar height.
    if let Some(p) = g.pace_left {
      let center = bx + (bar_w * (p.clamp(0.0, 100.0) as f32) / 100.0) as i32;
      let core = (3.0 * s) as i32;
      let gap = (2.0 * s) as i32;
      let gap_c = if dark { [70, 70, 72] } else { [214, 216, 220] };
      cv.fill(center - core / 2 - gap, bar_y, gap, bar_h, gap_c, 1.0);
      cv.fill(center + core / 2, bar_y, gap, bar_h, gap_c, 1.0);
      cv.fill(center - core / 2, bar_y, core, bar_h, pace_c, 1.0);
    }

    cv.text(&font, lpad, (bar_y + bar_h) as f32 + 14.0 * s, &g.data, data_px, text_c, false);
  }
  Some((cv.buf, w as u32, h as u32))
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn preview() {
    let groups = vec![
      Group { title: "Session".into(), left: 45, pace_left: Some(60.0), data: "45% left · 12% in reserve · resets in 2h 30m".into() },
      Group { title: "Weekly".into(), left: 70, pace_left: Some(55.0), data: "70% left · 15% in reserve · resets in 4d 3h".into() },
    ];
    let (rgba, w, h) = render(&groups, ACCENT_CLAUDE, true).expect("render");
    let f = std::fs::File::create("/tmp/usage_preview.png").unwrap();
    let mut e = png::Encoder::new(std::io::BufWriter::new(f), w, h);
    e.set_color(png::ColorType::Rgba);
    e.set_depth(png::BitDepth::Eight);
    e.write_header().unwrap().write_image_data(&rgba).unwrap();
    eprintln!("wrote /tmp/usage_preview.png {w}x{h}");
  }
}
