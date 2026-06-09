// Generates build/icon.png (1024×1024 RGBA) — the macOS app icon.
// A brand-indigo checkmark on a white rounded square. The SAME checkmark geometry
// is used by gen-tray-icon.js so the dock icon and menu-bar icon are consistent.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;

// Brand colors (match the web UI --accent / --accent-hover).
const TOP = [0x6c, 0x6f, 0xf1]; // #6c6ff1
const BOT = [0x4f, 0x46, 0xe5]; // #4f46e5
const WHITE = [255, 255, 255];

// Checkmark vertices in a 0..1 box (shared with the tray glyph) + stroke radius.
const CHECK = [[0.27, 0.52], [0.44, 0.69], [0.74, 0.34]];
const STROKE = 0.06; // fraction of SIZE

// ── Minimal RGBA PNG writer ──────────────────────────────────────────────────
function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }
function crc32(buf) {
  let crc = 0xffffffff;
  const t = crc32.t || (crc32.t = (() => {
    const a = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; a[i] = c; }
    return a;
  })());
  for (let i = 0; i < buf.length; i++) crc = t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  return Buffer.concat([u32be(data.length), t, data, u32be(crc32(Buffer.concat([t, data])))]);
}
function makePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(0);
    for (let x = 0; x < size; x++) { const i = (y * size + x) * 4; rows.push(rgba[i], rgba[i+1], rgba[i+2], rgba[i+3]); }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// ── Canvas ────────────────────────────────────────────────────────────────────
const rgba = new Uint8Array(SIZE * SIZE * 4);

function blend(x, y, r, g, b, a) {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE || a <= 0) return;
  const i = (y * SIZE + x) * 4;
  const ea = rgba[i+3] / 255, na = a;
  const oa = na + ea * (1 - na);
  if (oa < 0.0001) return;
  rgba[i]   = Math.round((r * na + rgba[i]   * ea * (1 - na)) / oa);
  rgba[i+1] = Math.round((g * na + rgba[i+1] * ea * (1 - na)) / oa);
  rgba[i+2] = Math.round((b * na + rgba[i+2] * ea * (1 - na)) / oa);
  rgba[i+3] = Math.round(oa * 255);
}

// Rounded-square coverage (anti-aliased) at pixel (x,y), 0..1.
function squareCoverage(x, y, pad, radius) {
  const lo = pad, hi = SIZE - pad;
  if (x < lo - 1 || x > hi || y < lo - 1 || y > hi) return 0;
  // distance into the rounded rect
  const cx = Math.min(Math.max(x, lo + radius), hi - radius);
  const cy = Math.min(Math.max(y, lo + radius), hi - radius);
  const dx = x - cx, dy = y - cy;
  const d = Math.hypot(dx, dy);
  return Math.max(0, Math.min(1, radius - d + 0.5));
}

// 1. White rounded square with transparent corners.
const PAD = Math.round(SIZE * 0.085);
const RADIUS = Math.round(SIZE * 0.225);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cov = squareCoverage(x, y, PAD, RADIUS);
    if (cov > 0) blend(x, y, ...WHITE, cov);
  }
}

// 2. Brand-gradient checkmark (same geometry as the tray glyph).
const dot = (cx, cy, rad) => {
  for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++)
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      const a = Math.max(0, Math.min(1, rad - Math.hypot(x - cx, y - cy) + 0.5));
      if (a <= 0) continue;
      const t = y / (SIZE - 1);
      const r = Math.round(TOP[0] + (BOT[0] - TOP[0]) * t);
      const g = Math.round(TOP[1] + (BOT[1] - TOP[1]) * t);
      const b = Math.round(TOP[2] + (BOT[2] - TOP[2]) * t);
      blend(x, y, r, g, b, a);
    }
};
const P = CHECK.map(([px, py]) => [px * SIZE, py * SIZE]);
const r = SIZE * STROKE;
for (let s = 0; s < P.length - 1; s++) {
  const [x0, y0] = P[s], [x1, y1] = P[s + 1];
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= steps; i++) dot(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, r);
}

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, makePNG(SIZE, rgba));
console.log('Generated', out, `(${SIZE}×${SIZE})`);
