// Owns the dashboard BrowserWindow and the renderer-facing helpers around it.
const { BrowserWindow, shell, ipcMain, dialog, nativeTheme } = require('electron');
const path = require('path');
const { BASE_URL } = require('./const');

let win = null;

const getWin = () => (win && !win.isDestroyed() ? win : null);

// Main dashboard window. Hosts the SPA and lets it embed GitHub/Jira in a <webview>
// (the header-stripping in tray.js allows framing those sites). Reused if already open.
// `onBlur` lets the caller refresh the tray menu as focus moves to the menu bar.
let _onBlur = null;
const setOnBlur = fn => { _onBlur = fn; };

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
  win.on('closed', () => { win = null; });
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
function openLinkInApp(url, title, kind) {
  runInApp(`window.__openTab && __openTab(${JSON.stringify(url)}, ${JSON.stringify(title || '')}, ${JSON.stringify(kind || 'github')})`);
}

// Drive the app's native appearance from the dashboard's theme toggle so native chrome
// (inset traffic lights, scrollbars, menus) renders light/dark to match — 'auto' follows
// the OS. Without this they'd track the system appearance even when the user forces a theme.
// Plus the native folder picker for choosing a project's workspace folder.
function registerIpc() {
  ipcMain.on('set-native-theme', (_e, value) => {
    nativeTheme.themeSource = value === 'light' || value === 'dark' ? value : 'system';
  });

  ipcMain.handle('choose-folder', async () => {
    const parent = getWin() || undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
      title: 'Choose workspace folder',
      properties: ['openDirectory'],
    });
    return canceled || !filePaths.length ? null : filePaths[0];
  });
}

module.exports = { openWindow, getWin, sendToWin, runInApp, openLinkInApp, registerIpc, setOnBlur };
