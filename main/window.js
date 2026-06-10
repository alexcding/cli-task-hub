// Owns the dashboard BrowserWindow and the renderer-facing helpers around it.
const { BrowserWindow, shell, ipcMain, dialog, nativeTheme, session } = require('electron');
const path = require('path');
const { BASE_URL } = require('./const');
const { avatarDataUrl } = require('./icons');

let win = null;

const getWin = () => (win && !win.isDestroyed() ? win : null);

// Main dashboard window. Hosts the SPA and lets it embed GitHub/Jira in a <webview>
// (the header-stripping in tray.js allows framing those sites). Reused if already open.
// `onBlur` lets the caller refresh the tray menu as focus moves to the menu bar;
// `onClosed` lets it reap empty terminals (wired from tray.js, not required directly —
// terminals.js already requires this module, so a require back would be a cycle).
let _onBlur = null;
const setOnBlur = fn => { _onBlur = fn; };
let _onClosed = null;
const setOnClosed = fn => { _onClosed = fn; };

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
      preload: path.join(__dirname, '..', 'preload.js'), // exposes window.taskhub.* (folder picker, …)
    },
  });
  win.loadURL(BASE_URL);
  // "Open in browser" / window.open(http…) → system browser, not a child window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  win.on('blur', () => _onBlur && _onBlur());
  win.on('closed', () => { win = null; _onClosed && _onClosed(); });
}

// Push to the dashboard window if it's open; dropped otherwise (the renderer
// re-syncs via term:list when it reloads).
function sendToWin(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
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
// `category` ('mine'|'review') is passed so a tray-opened PR tab lands in the right
// sidebar group and keeps it across restarts — without it the renderer saves category=''
// and the tab falls under "Mine" until a dashboard visit backfills it (see __openTab).
function openLinkInApp(url, title, kind, category) {
  runInApp(`window.__openTab && __openTab(${JSON.stringify(url)}, ${JSON.stringify(title || '')}, ${JSON.stringify(kind || 'github')}, ${JSON.stringify(category || '')})`);
}

// Drive the app's native appearance from the dashboard's theme toggle so native chrome
// (inset traffic lights, scrollbars, menus) renders light/dark to match — 'auto' follows
// the OS. Without this they'd track the system appearance even when the user forces a theme.
// Plus the native folder picker for choosing a project's workspace folder.
function registerIpc() {
  // The Settings font picker enumerates installed fonts with queryLocalFonts() (Local Font
  // Access API), which is gated behind the 'local-fonts' permission. Grant it, and otherwise
  // keep Electron's allow-by-default so the embedded GitHub/Jira webviews — which share this
  // default session (see viewer.js, deliberately no partition) — aren't restricted.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  ipcMain.on('set-native-theme', (_e, value) => {
    nativeTheme.themeSource = value === 'light' || value === 'dark' ? value : 'system';
  });

  // ⌘W with no tab in view → close the window (the renderer can't close a
  // BrowserWindow it didn't open; see handleShortcut 'tab:close' in app.js).
  ipcMain.on('close-window', () => getWin()?.close());

  // Fetch a PR author's avatar as a data URI so the renderer can freeze it onto a tab
  // (see freezeAvatar in viewer.js). Resolves null on any failure — the tab just falls
  // back to the live github.com/<login>.png URL.
  ipcMain.handle('avatar:fetch', (_e, login) => avatarDataUrl(login));

  ipcMain.handle('choose-folder', async () => {
    const parent = getWin() || undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
      title: 'Choose workspace folder',
      properties: ['openDirectory'],
    });
    return canceled || !filePaths.length ? null : filePaths[0];
  });
}

module.exports = { openWindow, getWin, sendToWin, runInApp, openLinkInApp, registerIpc, setOnBlur, setOnClosed };
