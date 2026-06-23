// Generate the Tauri tray icons to match the Electron menu-bar icon 100% — the white checkmark
// from src/main/native/icons.js (renderTray), plus the bronze review dot. Pure JS + zlib (the
// Electron version's drawing is engine-independent), so we just port renderTray/pngEncode here and
// emit two PNGs the Rust tray embeds: tray-idle.png (check) and tray-review.png (check + dot).
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';

const TRAY_CHECK = [[0.20, 0.50], [0.42, 0.68], [0.80, 0.28]]; // same path as the Electron icon
const TRAY_FG = [255, 255, 255];
const REVIEW_DOT = [0x98, 0x71, 0x2c]; // bronze

const crcTable = [];
for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[i] = c >>> 0; }
function pngEncode(w, h, rgba) {
  const u32 = (n) => { const x = Buffer.alloc(4); x.writeUInt32BE(n >>> 0); return x; };
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const tt = Buffer.from(t, 'ascii'); return Buffer.concat([u32(d.length), tt, d, u32(crc(Buffer.concat([tt, d])))]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const rows = [];
  for (let y = 0; y < h; y++) { rows.push(Buffer.from([0]), Buffer.from(rgba.slice(y * w * 4, (y + 1) * w * 4))); }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function renderTray(size, review) {
  const rgba = new Uint8Array(size * size * 4);
  const set = (x, y, c, a) => {
    if (x < 0 || x >= size || y < 0 || y >= size || a <= 0) return;
    const i = (y * size + x) * 4, na = Math.min(255, Math.round(a * 255));
    if (na <= rgba[i + 3]) return;
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = na;
  };
  const disc = (cx, cy, rad, c) => {
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++)
      for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++)
        set(x, y, c, Math.max(0, Math.min(1, rad - Math.hypot(x - cx, y - cy) + 0.5)));
  };
  const P = TRAY_CHECK.map(([px, py]) => [px * size, py * size]);
  const rad = size * 0.062;
  for (let s = 0; s < P.length - 1; s++) {
    const [x0, y0] = P[s], [x1, y1] = P[s + 1];
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
    for (let i = 0; i <= steps; i++) disc(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, rad, TRAY_FG);
  }
  if (review) disc(size * 0.80, size * 0.74, size * 0.10, REVIEW_DOT);
  return pngEncode(size, size, rgba);
}

writeFileSync('src-tauri/icons/tray-idle.png', renderTray(44, false));
writeFileSync('src-tauri/icons/tray-review.png', renderTray(44, true));
console.log('wrote src-tauri/icons/tray-idle.png + tray-review.png');
