// Cache compiled V8 bytecode to disk for faster cold starts (no-op pre-Node 22.8).
try { require('node:module').enableCompileCache?.(); } catch {}

const { app, Tray, Menu, shell, nativeImage, BrowserWindow, session, ipcMain, dialog, nativeTheme, Notification, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const { fork, execSync, execFile } = require('child_process');
const path = require('path');
const os = require('os');
const http = require('http');
const zlib = require('zlib');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

// Show "TaskHub" (not "Electron") in the About panel, Dock, and userData path during dev.
// Must run before app is ready. The macOS app-menu label is set separately via an explicit
// application menu in whenReady() (setName alone can't relabel it in an unpackaged bundle).
// Packaged builds get all of this from the bundle's productName.
app.setName('TaskHub');

// Initialize logging before any window is created (log.initialize wires the renderer
// IPC bridge). Routes console.* in this process to <userData>/logs/main.log. Required for
// its side-effect — the import itself sets up logging.
require('./lib/logger');

const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_URL = `http://localhost:${PORT}`;

let tray = null;
let serverProcess = null; // forked backend server; null when using an external one
let serverStartedAt = 0;  // when the current server child was forked (for the healthy reset)
let serverFailures = 0;   // consecutive crash count, drives respawn backoff
let serverRestartTimer = null;
let appQuitting = false;   // set in before-quit so a deliberate kill isn't treated as a crash
let win = null;

// Respawn the backend if it crashes. A child that ran a while is treated as healthy (streak
// reset); too many crashes in quick succession stops the loop so a persistently broken build
// doesn't hot-spawn forever. Mirrors the webhook forwarder's backoff.
const SERVER_HEALTHY_MS = 30_000;
const SERVER_MAX_RESTARTS = 5;
function startServer() {
  // Clear the port in case a previous server (e.g. a stale dev run, or a half-dead child) lingers.
  freePort();
  serverStartedAt = Date.now();
  serverProcess = fork(path.join(__dirname, 'server.js'), [], {
    // The forked server is plain Node and can't read Electron's app paths, so hand it a
    // writable data dir explicitly (never inside the asar). ELECTRON_RUN_AS_NODE makes the
    // child run as plain Node — without it, fork() reuses the Electron binary (execPath)
    // and in a packaged build would boot a whole second Electron runtime, not Node.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT), TASKHUB_DATA_DIR: app.getPath('userData') },
    silent: false,
  });
  serverProcess.on('error', (err) => console.error('[tray] server error:', err));
  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;
    if (appQuitting) return; // deliberate teardown, not a crash
    console.warn(`[tray] server exited (${code ?? signal ?? 'unknown'})`);
    if (Date.now() - serverStartedAt > SERVER_HEALTHY_MS) serverFailures = 0;
    if (++serverFailures > SERVER_MAX_RESTARTS) {
      console.error(`[tray] server crashed ${serverFailures} times in quick succession — not restarting. Quit and relaunch TaskHub.`);
      return;
    }
    const delay = Math.min(1000 * 2 ** (serverFailures - 1), 30_000);
    console.warn(`[tray] restarting server in ${delay}ms (attempt ${serverFailures})`);
    serverRestartTimer = setTimeout(startServer, delay);
  });
}

// Main dashboard window. Hosts the SPA and lets it embed GitHub/Jira in a <webview>
// (the header-stripping below allows framing those sites). Reused if already open.
function openWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 720, title: 'TaskHub',
    // macOS native chrome: inset traffic lights over the 52px top band so the sidebar +
    // topbar read as one native unified toolbar. (Live `vibrancy` was tried but dropped —
    // blurring the desktop behind the heavy <webview> cost too much GPU; the sidebar stays
    // solid instead.) Other platforms keep the standard window chrome.
    ...(mac ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 12 }, // nudged up within the top band
    } : {}),
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
  win.on('blur', refreshMenu);   // refresh the menu's PR list as focus moves to the menu bar
  win.on('closed', () => { win = null; });
}

// Drive the app's native appearance from the dashboard's theme toggle so native chrome
// (inset traffic lights, scrollbars, menus) renders light/dark to match — 'auto' follows
// the OS. Without this they'd track the system appearance even when the user forces a theme.
ipcMain.on('set-native-theme', (_e, value) => {
  nativeTheme.themeSource = value === 'light' || value === 'dark' ? value : 'system';
});

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
const terminals = new Map(); // id -> { pty, cwd, title, paired, pairKey, hasContext, chunks, bufLen, seq }
let termSeq = 0;
const TERM_BUF_MAX = 256 * 1024; // per-terminal output kept for replay when a window reattaches

// Push to the dashboard window if it's open; dropped otherwise (the renderer
// re-syncs via term:list when it reloads).
function sendToWin(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Spawn a login + interactive shell so it sources the user's dotfiles and gets the
// full environment (PATH, nvm, Homebrew, aliases) — identical to a Terminal.app tab.
ipcMain.handle('term:create', (_e, { cwd, shell: sh, paired = false, pairKey = '' } = {}) => {
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
  const entry = { pty: p, cwd: dir, title: path.basename(dir) || dir, paired: !!paired, pairKey: String(pairKey || ''), hasContext: false, chunks: [], bufLen: 0, seq: 0 };
  // Keep a rolling tail of output as WHOLE chunks (never sliced mid-byte/escape) so a
  // window that was closed and reopened can replay the recent screen. Each chunk carries a
  // monotonic seq so the renderer can replay the backlog and then resume the live stream
  // with neither a gap nor a duplicate across the attach round-trip.
  p.onData(chunk => {
    entry.chunks.push(chunk);
    entry.bufLen += chunk.length;
    while (entry.bufLen > TERM_BUF_MAX && entry.chunks.length > 1) entry.bufLen -= entry.chunks.shift().length;
    // A single chunk bigger than the cap would otherwise keep the buffer unbounded; clamp it
    // to its tail so replay memory stays bounded (rare — PTY reads are normally well under it).
    if (entry.bufLen > TERM_BUF_MAX && entry.chunks.length === 1) {
      entry.chunks[0] = entry.chunks[0].slice(-TERM_BUF_MAX);
      entry.bufLen = entry.chunks[0].length;
    }
    sendToWin('term:data', { id, chunk, seq: ++entry.seq }); // live stream always gets the full chunk
  });
  p.onExit(({ exitCode, signal }) => { terminals.delete(id); sendToWin('term:exit', { id, exitCode, signal }); });
  terminals.set(id, entry);
  return { id, cwd: dir, title: path.basename(dir) || dir, paired: entry.paired, pairKey: entry.pairKey, hasContext: entry.hasContext };
});

ipcMain.on('term:write',  (_e, { id, data })       => { const t = terminals.get(id); if (t) { t.hasContext = true; t.pty.write(data); } });
ipcMain.on('term:resize', (_e, { id, cols, rows }) => { try { terminals.get(id)?.pty.resize(cols, rows); } catch {} });
ipcMain.handle('term:kill', (_e, { id }) => {
  const t = terminals.get(id);
  if (t) { try { t.pty.kill(); } catch {} terminals.delete(id); }
  return true;
});
// Lets the renderer rehydrate its terminal list after a reload (PTYs outlive the page).
ipcMain.handle('term:list', () => [...terminals.entries()].map(([id, t]) => ({ id, cwd: t.cwd, title: t.title, paired: !!t.paired, pairKey: t.pairKey || '', hasContext: !!t.hasContext })));
// Reattach to a live PTY after the window was reopened: returns the buffered backlog to
// replay plus the seq of its last chunk, so the renderer can resume the live stream cleanly.
ipcMain.handle('term:attach', (_e, { id }) => {
  const t = terminals.get(id);
  return t ? { buf: t.chunks.join(''), seq: t.seq } : { buf: '', seq: 0 };
});

// ── App resource usage (memory + CPU) ──────────────────────────────────────────
// "How much RAM and CPU is TaskHub using, all in?" — shown in the menu-bar menu. We sum
// every Electron process via getAppMetrics(): the main tray process, each window, every
// embedded GitHub/Jira <webview>, the GPU process, and utilities. Then we add the forked
// backend server and terminals because they are plain OS child processes, not Electron
// processes, so getAppMetrics() never sees them. Memory is KB (getAppMetrics workingSetSize
// and ps rss); CPU is percent of one core (can exceed 100% across cores — same convention
// as Activity Monitor and ps %cpu).
const MEM_TYPE_LABELS = { Browser: 'Main', Tab: 'Windows & web views', GPU: 'GPU', Utility: 'Utilities' };
function computeUsage() {
  const groups = new Map(); // label -> { kb, cpu }
  const add = (label, kb, cpu) => {
    const g = groups.get(label) || { kb: 0, cpu: 0 };
    g.kb += kb; g.cpu += cpu;
    groups.set(label, g);
  };

  for (const m of app.getAppMetrics()) {
    add(MEM_TYPE_LABELS[m.type] || m.type, m.memory?.workingSetSize || 0, m.cpu?.percentCPUUsage || 0);
  }

  const snap = psSnapshot(); // one (cached) ps pass shared by both tree walks below
  const server = ptyTreeStats(serverProcess?.pid ? [serverProcess.pid] : [], snap);
  if (server.kb || server.cpu) add('Server', server.kb, server.cpu);

  const pty = ptyTreeStats([...terminals.values()].map(t => t.pty.pid).filter(Boolean), snap);
  if (pty.kb || pty.cpu) add('Terminals', pty.kb, pty.cpu);

  let totalKB = 0, totalCPU = 0;
  const breakdown = [];
  for (const [label, g] of groups) { totalKB += g.kb; totalCPU += g.cpu; breakdown.push({ label, ...g }); }
  breakdown.sort((a, b) => b.kb - a.kb);
  return { totalKB, totalCPU, breakdown };
}

// KB → a compact human figure for the menu (MB up to a GB, then GB).
function fmtKB(kb) {
  const mb = kb / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

// One `ps` pass parsed into { children: ppid->[pid], stat: pid->{kb,cpu} }, cached briefly so
// the two tree walks in a single menu build — and rapid rebuilds (blur + the 60s tick) — don't
// each shell out. macOS/Linux only; returns empty maps on any failure so the readout still
// shows the Electron totals. The TTL is well under the 60s refresh, so the figure stays fresh.
const PS_CACHE_MS = 3000;
let _psCache = null, _psCacheAt = 0;
function psSnapshot() {
  const now = Date.now();
  if (_psCache && now - _psCacheAt < PS_CACHE_MS) return _psCache;
  const children = new Map(); // ppid -> [pid]
  const stat = new Map();     // pid -> { kb, cpu }
  try {
    const out = execSync('ps -axo pid=,ppid=,rss=,%cpu=', { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)$/);
      if (!m) continue;
      const pid = +m[1], ppid = +m[2];
      stat.set(pid, { kb: +m[3], cpu: +m[4] });
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
  } catch { /* leave maps empty → zeros below */ }
  _psCache = { children, stat };
  _psCacheAt = now;
  return _psCache;
}

// Sum RSS (KB) and CPU (% of one core) of the given pids plus all their descendants, using a
// snapshot from psSnapshot(). Returns zeros when the pids aren't found.
function ptyTreeStats(rootPids, snap = psSnapshot()) {
  if (!rootPids.length) return { kb: 0, cpu: 0 };
  const { children, stat } = snap;
  let kb = 0, cpu = 0;
  const seen = new Set();
  const stack = [...rootPids];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const s = stat.get(pid);
    if (s) { kb += s.kb; cpu += s.cpu; }
    for (const c of children.get(pid) || []) stack.push(c);
  }
  return { kb, cpu };
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

// ── Review-request notifications ─────────────────────────────────────────────────
// Notify (and play a system sound) when a PR newly needs your review. GitHub drops you
// from a PR's reviewRequests the moment you submit a review, so a PR that LEAVES the
// review set and later RE-ENTERS it is a genuine re-request. That single absent→present
// transition covers both the first request and any re-request — so we just diff the
// current review set against last cycle and act on whatever newly entered it.
let reviewSeeded = false;        // first sync seeds silently — don't notify for reviews
                                 // already pending when the app launches
const knownReviews = new Set();  // PR keys requesting my review as of last cycle
// PR keys you've CLICKED in "Review requested" — hidden from that list afterward, until
// GitHub re-requests your review (the key re-enters the review set as 'fresh'; see below).
// In-memory: a fresh app launch re-surfaces all current requests.
const acknowledgedReviews = new Set();
let steadyState = 'idle';        // tray state (set by buildMenu)

const prKey = pr => `${pr.repo}#${pr.number}`;

// Play a macOS system sound to announce a newly-requested review (replaces the old
// menu-bar blink). Best-effort: afplay is macOS-only; fall back to the system beep.
function playReviewSound() {
  if (process.platform === 'darwin') {
    execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});
  } else {
    shell.beep();
  }
}

// Native notification; clicking it opens that PR in the dashboard.
function notifyReviewRequested(pr) {
  if (!Notification.isSupported()) return;
  const full = `PR #${pr.number} ${pr.title}`;
  const n = new Notification({ title: 'Review requested', body: full });
  n.on('click', () => openLinkInApp(pr.url, full, 'github'));
  n.show();
}

// Diff this cycle's review PRs against the last; notify + play a sound for any that
// just entered the set. PRs that left it (reviewed / closed / merged) just fall out.
function detectReviewChanges(reviewPRs) {
  const current = new Set(reviewPRs.map(prKey));
  const fresh = reviewPRs.filter(pr => !knownReviews.has(prKey(pr)));

  if (reviewSeeded && fresh.length) {
    for (const pr of fresh) notifyReviewRequested(pr);
    playReviewSound(); // one sound per cycle, even if several reviews arrive at once
  }

  // A (re-)requested PR must re-appear in "Review requested" even if you clicked it
  // before — so clear its acknowledgement whenever it newly (re-)enters the review set.
  for (const pr of fresh) acknowledgedReviews.delete(prKey(pr));
  // Drop acks for PRs no longer requesting review (a later re-request re-enters as
  // 'fresh' anyway), keeping the set bounded.
  for (const key of [...acknowledgedReviews]) if (!current.has(key)) acknowledgedReviews.delete(key);

  knownReviews.clear();
  for (const key of current) knownReviews.add(key);
  reviewSeeded = true;
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
// CI badge. nativeImage can't rasterize SVG or round corners, so we fetch
// github.com/<login>.png, circular-mask it, and composite the CI dot by hand on the BGRA
// bitmap (same pixel approach as pngDot). Falls back to the plain CI dot if no avatar.
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
// sidebar shows (public/index.html TAB_ICON.jira), pre-rasterized to build/tray-jira.png
// (64px) since nativeImage can't render SVG. Downscale to an AVATAR_PX bitmap @2x so it
// renders at the same 16pt size as the avatar column. Cached — it never changes.
let _jiraIcon = null;
function jiraIcon() {
  if (_jiraIcon) return _jiraIcon;
  const dir = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'build');
  const src = nativeImage.createFromPath(path.join(dir, 'tray-jira.png'));
  if (src.isEmpty()) return (_jiraIcon = src);   // asset missing → no icon (cached so we don't retry)
  const bmp = Buffer.from(src.resize({ width: AVATAR_PX, height: AVATAR_PX, quality: 'best' }).toBitmap());
  _jiraIcon = nativeImage.createFromBitmap(bmp, { width: AVATAR_PX, height: AVATAR_PX, scaleFactor: 2 });
  return _jiraIcon;
}

// Build a labeled section of open-tab menu items. The tray menu MIRRORS the app's
// open tabs (the same /api/tabs list the sidebar restores from), so each item maps
// 1:1 to a sidebar row and clicking it focuses that exact tab. Titles are the ones
// saved on the tab (produced by the renderer's prTabTitle/jiraTabTitle at open time),
// so they read identically in both places. GitHub tabs show the PR author's avatar with
// a CI badge (looked up in prByUrl); Jira tabs show Jira's blue diamond mark.
// Truncate long titles so the menu doesn't stretch wide; trimEnd() drops a trailing space
// that would otherwise leave a visible gap before the ellipsis.
const menuLabel = s => s.length > 40 ? s.slice(0, 40).trimEnd() + '…' : s;
function tabSection(label, tabs, prByUrl) {
  if (!tabs.length) return [];
  const items = [{ label, enabled: false }];
  for (const t of tabs) {
    const title = t.title || t.url;
    const item = {
      label: menuLabel(title),
      click: () => openLinkInApp(t.url, title, t.kind),
    };
    if (t.kind === 'github') { const pr = prByUrl[t.url]; item.icon = avatarIcon(pr?.author?.login, pr?.ci, pr?.reviewDecision === 'APPROVED'); }
    else if (t.kind === 'jira') { item.icon = jiraIcon(); }
    items.push(item);
  }
  return items;
}

// Build a section from PR snapshot objects (not open tabs) — used for "Review
// requested": pending reviews you haven't opened yet. Title matches the renderer's
// prTabTitle() so it reads identically once clicked (which opens it as a tab).
function prMenuItems(label, prs) {
  if (!prs.length) return [];
  const items = [{ label, enabled: false }];
  for (const pr of prs) {
    const full = `PR #${pr.number} ${pr.title}`;
    items.push({
      label: menuLabel(full),
      icon: avatarIcon(pr.author?.login, pr.ci, pr.reviewDecision === 'APPROVED'),
      // Clicking acknowledges the request (hides it from "Review requested" until a
      // re-request) and opens it as a tab; rebuild so it drops on the next menu open.
      click: () => { acknowledgedReviews.add(prKey(pr)); openLinkInApp(pr.url, full, 'github'); refreshMenu(); },
    });
  }
  return items;
}

async function buildMenu() {
  // The menu LIST mirrors the app's open tabs (same /api/tabs source as the sidebar),
  // grouped exactly like the sidebar: GitHub tabs split into Tasks ('mine') and Review
  // ('review') by their saved category — anything not 'review' falls under Tasks, matching
  // the renderer's ghCat — plus Jira tabs. The PR snapshot (/api/prs/tray) is still read,
  // but only to attach CI dots, fire review notifications, and color the menu-bar icon for
  // ALL pending reviews (not just opened ones). fetchJSON returns [] on error.
  const [tabData, prs] = await Promise.all([
    fetchJSON('/api/tabs'),
    fetchJSON('/api/prs/tray'),
  ]);
  const tabs = (tabData && tabData.tabs) || [];
  const prList = Array.isArray(prs) ? prs : [];
  const prByUrl = {};
  for (const p of prList) if (p && p.url) prByUrl[p.url] = p;

  const github   = tabs.filter(t => t.kind === 'github');
  // Tasks / Review / Jira mirror your OPEN tabs (split by saved category). "Review
  // requested" (below) is the broader master list — every PR awaiting your review from
  // the snapshot, opened or not — so an unopened request is never missed.
  const taskTabs   = github.filter(t => t.category !== 'review');
  const reviewTabs = github.filter(t => t.category === 'review');
  const jiraTabs   = tabs.filter(t => t.kind === 'jira');

  // Notifications + icon color track ALL pending reviews from the snapshot, independent
  // of which tabs are open — so a newly-requested review still alerts you even unopened.
  const openPRs = prList.filter(p => !p.error && p.state === 'OPEN');
  const mine   = openPRs.filter(p => p.category === 'mine');
  const review = openPRs.filter(p => p.category === 'review');

  // Pre-load each author avatar we're about to render (unique logins, in parallel) so the
  // section builders below can read them synchronously from the cache.
  const logins = new Set();
  for (const pr of review) if (pr.author?.login) logins.add(pr.author.login);
  for (const t of [...taskTabs, ...reviewTabs]) { const l = prByUrl[t.url]?.author?.login; if (l) logins.add(l); }
  await Promise.all([...logins].map(loadAvatar));

  const tabItems = [
    ...tabSection('Mine', taskTabs, prByUrl),
    ...tabSection('Review', reviewTabs, prByUrl),
    ...tabSection('Jira', jiraTabs, prByUrl),
  ];

  // "Review requested": every PR awaiting your review, opened or not — MINUS the ones
  // you've already clicked (acknowledged). A re-request clears the ack and re-surfaces it
  // (see detectReviewChanges). Clicking opens the PR (focusing its tab if already open).
  const reviewReqItems = prMenuItems('Review requested', review.filter(pr => !acknowledgedReviews.has(prKey(pr))));

  // Notify + play a sound on any newly-requested review.
  detectReviewChanges(review);

  // Icon color by state: red = review requested, blue = only your tasks, green = clear.
  steadyState = review.length ? 'review' : mine.length ? 'tasks' : 'idle';
  if (tray) {
    tray.setImage(trayIcon(steadyState));
    tray.setTitle('');
  }

  // Review requested on top (the priority — others are waiting on you), then your opened
  // Tasks/Jira tabs. Separator between only when both exist; placeholder when empty.
  let body = (reviewReqItems.length && tabItems.length)
    ? [...reviewReqItems, { type: 'separator' }, ...tabItems]
    : [...reviewReqItems, ...tabItems];
  if (!body.length) body = [{ label: 'Nothing to review or open', enabled: false }];

  // Total RAM + CPU across every TaskHub process, with a per-component breakdown in the
  // submenu. Refreshed whenever the menu rebuilds (every 60s and on window blur).
  const usage = computeUsage();
  const usageItem = {
    label: `App Usage — CPU ${Math.round(usage.totalCPU)}% · Memory ${fmtKB(usage.totalKB)}`,
    submenu: usage.breakdown.map(b => ({ label: `${b.label}: ${fmtKB(b.kb)} · ${Math.round(b.cpu)}% CPU`, enabled: false })),
  };

  return Menu.buildFromTemplate([
    { label: 'Open TaskHub', click: () => openWindow() },
    { type: 'separator' },
    ...body,
    { type: 'separator' },
    usageItem,
    { label: 'Quit', click: () => app.quit() },
  ]);
}

async function refreshMenu() {
  if (!tray) return;
  const menu = await buildMenu();
  tray.setContextMenu(menu);
}

// Auto-update from GitHub Releases. The publish config baked into the build
// tells electron-updater where to look; it fetches latest-mac.yml, downloads a
// newer signed build in the background, and installs it on the next quit.
// Only meaningful in a packaged, Developer-ID-signed build — Squirrel.Mac
// rejects ad-hoc/unsigned updates, and dev runs have no update manifest.
const SIX_HOURS = 6 * 60 * 60 * 1000;
function setupAutoUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (err) => console.error('[updater]', err?.message || err));
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] ${info.version} downloaded — installs on quit`);
  });
  const check = () => autoUpdater.checkForUpdatesAndNotify().catch(
    (err) => console.error('[updater] check failed:', err?.message || err),
  );
  check();
  setInterval(check, SIX_HOURS); // tray app rarely quits, so poll periodically
}

// Only one TaskHub at a time — quit if another instance already holds the lock.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

app.whenReady().then(async () => {
  // macOS app menu (top-left, beside the Apple logo). Without our own template
  // Electron uses its default one, whose first item is hard-coded to "Electron"
  // in dev — app.setName() can't relabel it. `role: 'appMenu'` labels it with
  // app.name ("TaskHub"); edit/window menus keep ⌘C/⌘V/⌘W working.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]));
  }

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
    // Keep the backend out of the Electron main process. The tray process outlives window
    // closes and owns this child until Quit, while synchronous Jira/GitHub work stays off
    // the UI/menu event loop. startServer() also respawns it if it crashes.
    startServer();
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

  setupAutoUpdates();
});

app.on('window-all-closed', () => {
  // Keep running without windows
});

// Clicking the Dock icon (with no window open) reopens the dashboard — standard macOS.
app.on('activate', () => openWindow());

app.on('before-quit', () => {
  appQuitting = true; // so the exit handler treats this kill as teardown, not a crash
  if (serverRestartTimer) { clearTimeout(serverRestartTimer); serverRestartTimer = null; }
  if (serverProcess) {
    const child = serverProcess;
    serverProcess = null;
    try { child.kill(); } catch {}
  }
  for (const { pty } of terminals.values()) { try { pty.kill(); } catch {} }
});
