// All tray/menu icon rasterization: the colored menu-bar dot, CI dots, author avatars
// with CI/approval badges, and the Jira mark. nativeImage can't rasterize SVG or round
// corners, so avatars are fetched as PNG, circular-masked, and composited by hand on
// the BGRA bitmap.
const { app, nativeImage, nativeTheme, net } = require('electron');
const path = require('path');
const zlib = require('zlib');

// Colored menu-bar dot by state: 'review' (bronze) | 'tasks' (blue) | 'idle' (green).
// NOT a template image, so macOS keeps the color. @2x is auto-loaded if present.
function trayIcon(state) {
  const dir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'build');
  const img = nativeImage.createFromPath(path.join(dir, `tray-icon-${state}.png`));
  // idle = monochrome template (macOS tints black/white to the menu bar);
  // tasks/review keep their color.
  img.setTemplateImage(state === 'idle');
  return img;
}

// ── Small custom CI dot (menu-item icon) ────────────────────────────────────────
// A tiny drawn circle reads cleaner than the oversized emoji. Built at 2x for retina.
function pngDot(size, [r, g, b]) {
  const u32 = n => { const x = Buffer.alloc(4); x.writeUInt32BE(n >>> 0); return x; };
  const table = []; for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[i] = c >>> 0; }
  const crc = b2 => { let c = 0xffffffff; for (const v of b2) c = table[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const tt = Buffer.from(t, 'ascii'); return Buffer.concat([u32(d.length), tt, d, u32(crc(Buffer.concat([tt, d])))]); };
  const rgba = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2, rad = size * 0.30;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = Math.max(0, Math.min(1, rad - Math.hypot(x - c, y - c) + 0.5));
    if (a > 0) { const i = (y * size + x) * 4; rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(a * 255); }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = []; for (let y = 0; y < size; y++) { rows.push(Buffer.from([0]), rgba.slice(y * size * 4, (y + 1) * size * 4)); }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const CI_COLORS = {
  none:    [0x9a, 0xa0, 0xa6], // gray
  running: [0xf5, 0x9e, 0x0b], // amber
  success: [0x16, 0xa3, 0x4a], // green
  failure: [0xdc, 0x26, 0x26], // red
};

// Map a CI snapshot to a color key — shared by the dot fallback and the avatar badge.
function ciKey(ci) {
  if (ci) {
    if (ci.status === 'in_progress' || ci.status === 'queued') return 'running';
    if (ci.conclusion === 'success') return 'success';
    if (ci.conclusion === 'failure') return 'failure';
  }
  return 'none';
}

const ciImgCache = {};
function ciIcon(ci) {
  const key = ciKey(ci);
  if (!ciImgCache[key]) {
    // 18px buffer rendered at scaleFactor 2 → ~9pt dot, small and subtle in the menu.
    ciImgCache[key] = nativeImage.createFromBuffer(pngDot(18, CI_COLORS[key]), { width: 9, height: 9, scaleFactor: 2 });
  }
  return ciImgCache[key];
}

// ── Author avatars (menu-item icons) ─────────────────────────────────────────────
// Mirror the sidebar's tab rows: each PR shows its author's ROUND avatar with a small
// CI badge. We fetch github.com/<login>.png, circular-mask it, and composite the CI dot
// by hand on the BGRA bitmap (same pixel approach as pngDot). Falls back to the plain
// CI dot if no avatar.
const AVATAR_PX = 32;            // bitmap px; rendered @2x → 16pt in the menu
const avatarCache = new Map();   // login -> circular BGRA bitmap (no badge) | null (failed)

// Download bytes via Chromium's net stack — follows the github.com→avatars redirect and
// shares the session. Resolves null on any failure so the menu still builds.
function fetchBytes(url) {
  return new Promise(resolve => {
    try {
      const req = net.request(url);
      const chunks = [];
      req.on('response', res => {
        if (res.statusCode >= 400) { res.on('data', () => {}); res.on('end', () => resolve(null)); return; }
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', () => resolve(null));
      req.end();
    } catch { resolve(null); }
  });
}

// Fetch an author's avatar PNG and return it as a base64 data URI (or null on failure).
// Lets the renderer FREEZE a tab's avatar at open time: any github.com URL always serves
// the author's CURRENT picture, so to pin the exact image we must store the bytes. A pinned
// tab then keeps that image even if the author later changes it; closing + reopening the PR
// re-runs this and re-freshes. size=64 keeps the data URI to a few KB.
async function avatarDataUrl(login) {
  if (!login) return null;
  const buf = await fetchBytes(`https://github.com/${encodeURIComponent(login)}.png?size=64`);
  return buf ? `data:image/png;base64,${buf.toString('base64')}` : null;
}

// Premultiplied-alpha circular mask: fade pixels to transparent outside the radius.
function maskCircle(bmp, size) {
  const c = (size - 1) / 2, r = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = Math.max(0, Math.min(1, r - Math.hypot(x - c, y - c) + 0.5));
    if (a < 1) {
      const i = (y * size + x) * 4;
      bmp[i] = Math.round(bmp[i] * a); bmp[i + 1] = Math.round(bmp[i + 1] * a);
      bmp[i + 2] = Math.round(bmp[i + 2] * a); bmp[i + 3] = Math.round(bmp[i + 3] * a);
    }
  }
}

// Fetch + circular-mask one author's avatar into a reusable base bitmap (cached by login).
async function loadAvatar(login) {
  if (!login) return null;
  if (avatarCache.has(login)) return avatarCache.get(login);
  const buf = await fetchBytes(`https://github.com/${encodeURIComponent(login)}.png?size=64`);
  let entry = null;
  if (buf) {
    let img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) {
      img = img.resize({ width: AVATAR_PX, height: AVATAR_PX, quality: 'best' });
      const bmp = Buffer.from(img.toBitmap());   // BGRA, AVATAR_PX² · 4
      maskCircle(bmp, AVATAR_PX);
      entry = bmp;
    }
  }
  avatarCache.set(login, entry);   // cache null too, so we don't re-fetch a bad login
  return entry;
}

// Distance from point (px,py) to the segment (ax,ay)→(bx,by) — used to stroke the
// approved checkmark with anti-aliased line segments.
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Source-over one BGRA pixel: color (r,g,b) at coverage a∈[0,1].
function blendPx(bmp, i, r, g, b, a) {
  if (a <= 0) return;
  const ia = 1 - a;
  bmp[i]     = Math.round(b * a + bmp[i]     * ia);
  bmp[i + 1] = Math.round(g * a + bmp[i + 1] * ia);
  bmp[i + 2] = Math.round(r * a + bmp[i + 2] * ia);
  bmp[i + 3] = Math.round(255 * a + bmp[i + 3] * ia);
}

// Final menu icon: cached circular avatar + a corner CI badge (colored dot ringed in the
// menu background, mirroring the sidebar's box-shadow ring). No avatar → plain CI dot.
function avatarIcon(login, ci, approved) {
  const base = login ? avatarCache.get(login) : null;
  if (!base) return ciIcon(ci);
  const bmp = Buffer.from(base);     // copy so the cached base stays badge-free
  const ring = nativeTheme.shouldUseDarkColors ? [38, 38, 40] : [255, 255, 255];
  // A failing build is the actionable signal, so it wins over the approved check: an approved
  // PR with red CI still shows the red dot. Approval (a positive state) only replaces the dot
  // when CI isn't failing.
  if (approved && ciKey(ci) !== 'failure') {
    // Approved PR: a larger green disc with a white checkmark REPLACES the CI dot —
    // mirrors the renderer's approvedMark(). Center inset so the ring stays in-bounds.
    const [r, g, b] = CI_COLORS.success;
    const cx = AVATAR_PX - 8, cy = AVATAR_PX - 8, R = 6.5;
    const segs = [[-3.2, 0.2, -0.9, 2.6], [-0.9, 2.6, 3.6, -2.6]]; // check, badge-local coords
    for (let y = 0; y < AVATAR_PX; y++) for (let x = 0; x < AVATAR_PX; x++) {
      const d = Math.hypot(x - cx, y - cy), i = (y * AVATAR_PX + x) * 4;
      blendPx(bmp, i, ring[0], ring[1], ring[2], Math.max(0, Math.min(1, R + 1.5 - d + 0.5))); // ring
      blendPx(bmp, i, r, g, b, Math.max(0, Math.min(1, R - d + 0.5)));                          // green disc
      if (d < R) {
        let dm = Infinity;
        for (const [ax, ay, bx, by] of segs) dm = Math.min(dm, segDist(x - cx, y - cy, ax, ay, bx, by));
        blendPx(bmp, i, 255, 255, 255, Math.max(0, Math.min(1, 0.95 - dm + 0.5)));              // white check
      }
    }
  } else {
    const key = ciKey(ci);
    if (key !== 'none') {
      const [r, g, b] = CI_COLORS[key];
      const cx = AVATAR_PX - 7, cy = AVATAR_PX - 7;
      for (let y = 0; y < AVATAR_PX; y++) for (let x = 0; x < AVATAR_PX; x++) {
        const d = Math.hypot(x - cx, y - cy), i = (y * AVATAR_PX + x) * 4;
        blendPx(bmp, i, ring[0], ring[1], ring[2], Math.max(0, Math.min(1, 6 - d + 0.5))); // ring
        blendPx(bmp, i, r, g, b, Math.max(0, Math.min(1, 4 - d + 0.5)));                    // dot
      }
    }
  }
  return nativeImage.createFromBitmap(bmp, { width: AVATAR_PX, height: AVATAR_PX, scaleFactor: 2 });
}

// Jira tabs have no author avatar, so without an icon they'd sit flush-left while GitHub
// rows are inset by their avatar — a ragged column. Use the EXACT same Jira mark the
// sidebar shows (public/js/icons.js TAB_ICON.jira), pre-rasterized to build/tray-jira.png
// (64px) since nativeImage can't render SVG. Downscale to an AVATAR_PX bitmap @2x so it
// renders at the same 16pt size as the avatar column. Cached — it never changes.
let _jiraIcon = null;
function jiraIcon() {
  if (_jiraIcon) return _jiraIcon;
  const dir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'build');
  const src = nativeImage.createFromPath(path.join(dir, 'tray-jira.png'));
  if (src.isEmpty()) return (_jiraIcon = src);   // asset missing → no icon (cached so we don't retry)
  const bmp = Buffer.from(src.resize({ width: AVATAR_PX, height: AVATAR_PX, quality: 'best' }).toBitmap());
  _jiraIcon = nativeImage.createFromBitmap(bmp, { width: AVATAR_PX, height: AVATAR_PX, scaleFactor: 2 });
  return _jiraIcon;
}

module.exports = { trayIcon, ciIcon, ciKey, avatarIcon, loadAvatar, avatarDataUrl, jiraIcon };
