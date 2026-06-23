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

// muda forces menu-item icons to 18px tall, so the two-group panel won't fit. We render a compact
// SINGLE-LINE strip — "Session [bar] 45%   Weekly [bar] 70%" — at 2× (36px tall) so it stays crisp
// when macOS scales it to 18px. Bars fill to % remaining in the agent accent, with 50/75% gridmarks.
pub fn render(session_left: Option<i64>, weekly_left: Option<i64>, accent: [u8; 3], dark: bool) -> Option<(Vec<u8>, u32, u32)> {
  let font = load_font()?;
  let segs: Vec<(&str, i64)> = [("Session", session_left), ("Weekly", weekly_left)]
    .into_iter()
    .filter_map(|(t, v)| v.map(|n| (t, n)))
    .collect();
  if segs.is_empty() {
    return None;
  }

  let h = 36i32; // 2× of muda's 18px row height
  let baseline = 24.0f32;
  let font_px = 21.0f32;
  let (bar_w, bar_h, bar_y) = (150.0f32, 11i32, 12i32);
  let text_c = if dark { [0xe8, 0xe8, 0xe8] } else { [0x16, 0x18, 0x1d] };
  let track_c = if dark { [255, 255, 255] } else { [0, 0, 0] };
  let track_a = if dark { 0.16 } else { 0.12 };
  let mark_a = if dark { 0.24 } else { 0.22 };

  // Two passes: measure total width, then draw.
  let seg_width = |t: &str, left: i64| measure(&font, t, font_px) + 8.0 + bar_w + 8.0 + measure(&font, &format!("{left}%"), font_px) + 24.0;
  let total: f32 = 12.0 + segs.iter().map(|(t, l)| seg_width(t, *l)).sum::<f32>();
  let w = total.ceil() as i32 + 4;

  let mut cv = Canvas::new(w, h);
  let mut x = 12.0f32;
  for (title, left) in &segs {
    cv.text(&font, x, baseline, title, font_px, text_c);
    x += measure(&font, title, font_px) + 8.0;

    let bx = x as i32;
    cv.fill(bx, bar_y, bar_w as i32, bar_h, track_c, track_a);
    let fw = (bar_w * (*left).clamp(0, 100) as f32 / 100.0) as i32;
    cv.fill(bx, bar_y, fw, bar_h, accent, 1.0);
    for frac in [0.5f32, 0.75] {
      cv.fill(bx + (bar_w * frac) as i32, bar_y, 1, bar_h, track_c, mark_a);
    }
    x += bar_w + 8.0;

    let pct = format!("{left}%");
    cv.text(&font, x, baseline, &pct, font_px, text_c);
    x += measure(&font, &pct, font_px) + 24.0;
  }
  Some((cv.buf, w as u32, h as u32))
}
