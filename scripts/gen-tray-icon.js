// Generates the macOS menu-bar checkmark (same shape as the app icon), plus an @2x retina
// variant:
//   tray-icon-idle.png — black, used as a TEMPLATE image (macOS tints it white-on-dark /
//                        black-on-light). This is the only menu-bar glyph.
// The "review requested" state is no longer a recolored glyph — main/icons.js draws a
// bronze dot under this same checkmark at runtime (a template image can't carry color).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const COLORS = {
  idle: [0x00, 0x00, 0x00], // black — TEMPLATE image; macOS tints it to the menu bar.
};

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

// Checkmark geometry: a touch wider and thinner-stroked than the app icon for the menu bar.
const CHECK = [[0.20, 0.50], [0.42, 0.68], [0.80, 0.28]];

function render(size, [r, g, b]) {
  const rgba = new Uint8Array(size * size * 4); // transparent
  const set = (x, y, a) => {
    if (x < 0 || x >= size || y < 0 || y >= size || a <= 0) return;
    const i = (y * size + x) * 4;
    const na = Math.min(255, Math.round(a * 255));
    if (na <= rgba[i + 3]) return;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = na;
  };
  const dot = (cx, cy, rad) => {
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++)
      for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++)
        set(x, y, Math.max(0, Math.min(1, rad - Math.hypot(x - cx, y - cy) + 0.5)));
  };
  const P = CHECK.map(([px, py]) => [px * size, py * size]);
  const rad = size * 0.062;
  for (let s = 0; s < P.length - 1; s++) {
    const [x0, y0] = P[s], [x1, y1] = P[s + 1];
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
    for (let i = 0; i <= steps; i++) dot(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, rad);
  }
  return makePNG(size, rgba);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, rgb] of Object.entries(COLORS)) {
  fs.writeFileSync(path.join(outDir, `tray-icon-${name}.png`), render(22, rgb));
  fs.writeFileSync(path.join(outDir, `tray-icon-${name}@2x.png`), render(44, rgb));
}
console.log('Generated tray-icon-idle.png (+ @2x)');
