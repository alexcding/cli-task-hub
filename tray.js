// Cache compiled V8 bytecode to disk for faster cold starts (no-op pre-Node 22.8).
try { require('node:module').enableCompileCache?.(); } catch {}

const { app, Tray, Menu, shell, nativeImage, BrowserWindow, session, ipcMain, dialog } = require('electron');
const { fork, execSync } = require('child_process');
const path = require('path');
const os = require('os');
const http = require('http');
const zlib = require('zlib');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_URL = `http://localhost:${PORT}`;

let tray = null;
let serverProcess = null;
let win = null;

// Main dashboard window. Hosts the SPA and lets it embed GitHub/Jira in a <webview>
// (the header-stripping below allows framing those sites). Reused if already open.
function openWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 720, title: 'TaskHub',
    webPreferences: {
      webviewTag: true, contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'), // exposes window.taskhub.* (folder picker, …)
    },
  });
  win.loadURL(BASE_URL);
  // "Open in browser" / window.open(http…) → system browser, not a child window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  win.on('blur', refreshMenu);   // refresh tray tabs as focus moves to the menu bar
  win.on('closed', () => { win = null; });
}

// Native folder picker for choosing a project's workspace folder (window.taskhub.chooseFolder).
ipcMain.handle('choose-folder', async () => {
  const parent = win && !win.isDestroyed() ? win : undefined;
  const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
    title: 'Choose workspace folder',
    properties: ['openDirectory'],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

// ── Terminals (node-pty) ────────────────────────────────────────────────────────
// Each open terminal is an independent pseudo-terminal keyed by id, so many worktree
// folders can have their own live shell at once. The renderer (window.taskhub.term)
// drives each by id: create → write/onData → resize → kill. Output is pushed to the
// window as `term:data` events; the shell's death is announced as `term:exit`.
const terminals = new Map(); // id -> { pty, cwd, title }
let termSeq = 0;

// Push to the dashboard window if it's open; dropped otherwise (the renderer
// re-syncs via term:list when it reloads).
function sendToWin(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Spawn a login + interactive shell so it sources the user's dotfiles and gets the
// full environment (PATH, nvm, Homebrew, aliases) — identical to a Terminal.app tab.
ipcMain.handle('term:create', (_e, { cwd, shell: sh } = {}) => {
  const id = 'pty' + (++termSeq);
  // Fallback when no workspace is given: the app's own repo (dev), else home. In a
  // packaged build getAppPath() points inside app.asar, which isn't a usable cwd.
  const appPath = app.getAppPath();
  const fallback = appPath && !appPath.includes('app.asar') ? appPath : os.homedir();
  const dir = cwd && typeof cwd === 'string' ? cwd : fallback;
  const p = pty.spawn(sh || process.env.SHELL || '/bin/zsh', ['-l', '-i'], {
    name: 'xterm-256color',
    cwd: dir,
    cols: 80, rows: 24,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' },
  });
  p.onData(chunk => sendToWin('term:data', { id, chunk }));
  p.onExit(({ exitCode, signal }) => { terminals.delete(id); sendToWin('term:exit', { id, exitCode, signal }); });
  terminals.set(id, { pty: p, cwd: dir, title: path.basename(dir) || dir });
  return { id, cwd: dir, title: path.basename(dir) || dir };
});

ipcMain.on('term:write',  (_e, { id, data })       => { terminals.get(id)?.pty.write(data); });
ipcMain.on('term:resize', (_e, { id, cols, rows }) => { try { terminals.get(id)?.pty.resize(cols, rows); } catch {} });
ipcMain.handle('term:kill', (_e, { id }) => {
  const t = terminals.get(id);
  if (t) { try { t.pty.kill(); } catch {} terminals.delete(id); }
  return true;
});
// Lets the renderer rehydrate its terminal list after a reload (PTYs outlive the page).
ipcMain.handle('term:list', () => [...terminals.entries()].map(([id, t]) => ({ id, cwd: t.cwd, title: t.title })));

// Read the dashboard's open tabs (lives in the renderer) for the tray menu.
async function getOpenTabs() {
  if (!win || win.isDestroyed()) return [];
  try { return await win.webContents.executeJavaScript('window.__getTabs ? __getTabs() : []'); }
  catch { return []; }
}

// Focus the window and run JS in the renderer. If the window was just created the
// page isn't ready yet, so defer until it finishes loading.
function runInApp(js) {
  openWindow();
  if (!win || win.isDestroyed()) return;
  const exec = () => win.webContents.executeJavaScript(js).catch(() => {});
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', exec);
  else exec();
}

// Focus the window and switch it to the tab for `url`.
function activateTabInApp(url) {
  runInApp(`window.__activateTabByUrl && __activateTabByUrl(${JSON.stringify(url)})`);
}

// Open `url` inside the app's embedded viewer (new tab, or focus it if already open).
function openLinkInApp(url, title, kind) {
  runInApp(`window.__openTab && __openTab(${JSON.stringify(url)}, ${JSON.stringify(title || '')}, ${JSON.stringify(kind || 'github')})`);
}

// Strip frame-blocking headers so the <webview> can load GitHub/Jira pages, which
// otherwise refuse to be embedded (X-Frame-Options / CSP frame-ancestors).
function allowFraming() {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const h = details.responseHeaders || {};
    for (const key of Object.keys(h)) {
      const lk = key.toLowerCase();
      if (lk === 'x-frame-options') delete h[key];
      else if (lk === 'content-security-policy') {
        h[key] = (Array.isArray(h[key]) ? h[key] : [h[key]]).map(v => v.replace(/frame-ancestors[^;]*(;|$)/gi, ''));
      }
    }
    cb({ responseHeaders: h });
  });
}

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

// Per-kind dot for open-tab menu items: GitHub = dark gray, Jira = blue.
const TAB_COLORS = {
  github: [0x57, 0x60, 0x6a],
  jira:   [0x26, 0x84, 0xff],
};
const tabImgCache = {};
function tabIcon(kind) {
  const key = TAB_COLORS[kind] ? kind : 'github';
  if (!tabImgCache[key]) {
    tabImgCache[key] = nativeImage.createFromBuffer(pngDot(18, TAB_COLORS[key]), { width: 9, height: 9, scaleFactor: 2 });
  }
  return tabImgCache[key];
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
    // Same format as the renderer's prTabTitle(): "PR #1233 <title>".
    const full = `PR #${pr.number} ${pr.title}`;
    items.push({
      label: full.length > 48 ? full.slice(0, 48) + '…' : full,
      icon: ciIcon(pr.ci),
      click: () => openLinkInApp(pr.url, full, 'github'),
    });
  }
  return items;
}

// A labeled section of open-tab menu items. Clicking focuses the window + that tab.
function tabSection(label, tabs) {
  if (!tabs.length) return [];
  const items = [{ label, enabled: false }];
  for (const t of tabs) {
    const title = (t.title || t.url).slice(0, 44);
    // Colored dot = kind (GitHub/Jira); native checkmark = the active tab.
    items.push({ label: title, icon: tabIcon(t.kind), type: 'checkbox', checked: !!t.active, click: () => activateTabInApp(t.url) });
  }
  return items;
}

async function buildMenu() {
  const [all, tabs] = await Promise.all([fetchJSON('/api/prs/tray'), getOpenTabs()]);
  // Menu shows only the user's own PRs (Tasks) and PRs awaiting their review.
  const mine   = all.filter(p => p.category === 'mine');
  const review = all.filter(p => p.category === 'review');

  let prItems = [...prSection('Tasks', mine), ...prSection('Review', review)];
  if (!prItems.length) prItems = [{ label: 'No tasks or reviews', enabled: false }];

  // Open tabs from the dashboard. GitHub tabs are omitted — they just duplicate the
  // Tasks/Review PR list above (clicking a PR there opens it in a GitHub tab). Only
  // Jira tabs are shown, since those aren't listed anywhere else in the menu.
  const tabItems = tabSection('Jira', tabs.filter(t => t.kind === 'jira'));

  // Icon color by state: red = review requested, blue = only your tasks, green = clear.
  const state = review.length ? 'review' : mine.length ? 'tasks' : 'idle';
  if (tray) { tray.setImage(trayIcon(state)); tray.setTitle(''); }

  return Menu.buildFromTemplate([
    { label: 'Open TaskHub', click: () => openWindow() },
    { type: 'separator' },
    ...prItems,
    ...(tabItems.length ? [{ type: 'separator' }, ...tabItems] : []),
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
  // Show the app icon in the Dock. Packaged builds pick it up from the bundle's
  // .icns automatically; in dev (`electron .`) set it explicitly so we show the
  // brand icon instead of Electron's default.
  if (app.dock && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, 'build', 'icon.png'));
  }

  // In dev (`npm run dev:app`) a watched server is already running — connect to it
  // instead of forking, so we get hot reload and don't fight over the port.
  if (process.env.TASKHUB_EXTERNAL_SERVER === '1') {
    console.log(`[tray] using external server at ${BASE_URL}`);
  } else {
    // Free the port in case a previous server is still lingering, then start ours.
    freePort();
    serverProcess = fork(path.join(__dirname, 'server.js'), [], {
      // The forked server is plain Node and can't read Electron's app paths,
      // so hand it a writable data dir explicitly (never inside the asar).
      env: { ...process.env, PORT: String(PORT), TASKHUB_DATA_DIR: app.getPath('userData') },
      silent: false,
    });
    serverProcess.on('error', (err) => console.error('[tray] server error:', err));
  }

  try {
    await waitForServer();
  } catch (err) {
    console.error('[tray] Could not connect to server:', err.message);
  }

  allowFraming();   // let the dashboard's <webview> embed GitHub/Jira
  openWindow();     // show the dashboard window on launch

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

// Clicking the Dock icon (with no window open) reopens the dashboard — standard macOS.
app.on('activate', () => openWindow());

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill();
  for (const { pty } of terminals.values()) { try { pty.kill(); } catch {} }
});
