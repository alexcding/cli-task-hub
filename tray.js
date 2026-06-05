const { app, Tray, Menu, shell, nativeImage } = require('electron');
const { fork, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_URL = `http://localhost:${PORT}`;

let tray = null;
let serverProcess = null;

// Kill whatever is holding our port (e.g. a stale server from a previous run).
function freePort() {
  try { execSync(`lsof -ti:${PORT} | xargs kill -9`, { stdio: 'ignore' }); }
  catch { /* nothing to kill */ }
}

// Colored menu-bar dot by state: 'review' (bronze) | 'tasks' (blue) | 'idle' (green).
// NOT a template image, so macOS keeps the color. @2x is auto-loaded if present.
function trayIcon(state) {
  const dir = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'build');
  const img = nativeImage.createFromPath(path.join(dir, `tray-icon-${state}.png`));
  // idle = monochrome template (macOS tints black/white to the menu bar);
  // tasks/review keep their color.
  img.setTemplateImage(state === 'idle');
  return img;
}

// Wait for the HTTP server to be ready
function waitForServer(retries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(BASE_URL, () => resolve()).on('error', () => {
        if (n <= 0) return reject(new Error('Server did not start'));
        setTimeout(() => attempt(n - 1), 500);
      });
    };
    attempt(retries);
  });
}

async function fetchJSON(path) {
  return new Promise((resolve) => {
    http.get(BASE_URL + path, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
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
const ciImgCache = {};
function ciIcon(ci) {
  let key = 'none';
  if (ci) {
    if (ci.status === 'in_progress' || ci.status === 'queued') key = 'running';
    else if (ci.conclusion === 'success') key = 'success';
    else if (ci.conclusion === 'failure') key = 'failure';
  }
  if (!ciImgCache[key]) {
    // 18px buffer rendered at scaleFactor 2 → ~9pt dot, small and subtle in the menu.
    ciImgCache[key] = nativeImage.createFromBuffer(pngDot(18, CI_COLORS[key]), { width: 9, height: 9, scaleFactor: 2 });
  }
  return ciImgCache[key];
}

// Build a labeled section of PR menu items.
function prSection(label, prs) {
  if (!prs.length) return [];
  const items = [{ label, enabled: false }];
  for (const pr of prs) {
    const title = pr.title.slice(0, 44) + (pr.title.length > 44 ? '…' : '');
    items.push({
      label: `#${pr.number} ${title}`,
      icon: ciIcon(pr.ci),
      click: () => shell.openExternal(pr.url),
    });
  }
  return items;
}

async function buildMenu() {
  const all = await fetchJSON('/api/prs/tray');
  // Menu shows only the user's own PRs (Tasks) and PRs awaiting their review.
  const mine   = all.filter(p => p.category === 'mine');
  const review = all.filter(p => p.category === 'review');
  const shown  = [...mine, ...review];

  let prItems = [...prSection('Tasks', mine), ...prSection('Review', review)];
  if (!prItems.length) prItems = [{ label: 'No tasks or reviews', enabled: false }];

  // Icon color by state: red = review requested, blue = only your tasks, green = clear.
  const state = review.length ? 'review' : mine.length ? 'tasks' : 'idle';
  if (tray) { tray.setImage(trayIcon(state)); tray.setTitle(''); }

  return Menu.buildFromTemplate([
    { label: 'Dashboard', click: () => shell.openExternal(BASE_URL) },
    { type: 'separator' },
    ...prItems,
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

async function refreshMenu() {
  if (!tray) return;
  const menu = await buildMenu();
  tray.setContextMenu(menu);
}

// Only one TaskHub at a time — quit if another instance already holds the lock.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

app.whenReady().then(async () => {
  // Suppress Dock icon — menu bar only
  if (app.dock) app.dock.hide();

  // Free the port in case a previous server is still lingering, then start ours.
  freePort();
  serverProcess = fork(path.join(__dirname, 'server.js'), [], {
    // The forked server is plain Node and can't read Electron's app paths,
    // so hand it a writable data dir explicitly (never inside the asar).
    env: { ...process.env, PORT: String(PORT), TASKHUB_DATA_DIR: app.getPath('userData') },
    silent: false,
  });

  serverProcess.on('error', (err) => console.error('[tray] server error:', err));

  try {
    await waitForServer();
  } catch (err) {
    console.error('[tray] Could not connect to server:', err.message);
  }

  tray = new Tray(trayIcon('idle')); // colored by state in buildMenu()
  tray.setToolTip('TaskHub');

  const menu = await buildMenu();
  tray.setContextMenu(menu);

  // Refresh menu every 60 seconds
  setInterval(refreshMenu, 60_000);
});

app.on('window-all-closed', () => {
  // Keep running without windows
});

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill();
});
