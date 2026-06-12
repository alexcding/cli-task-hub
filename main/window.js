// Owns the dashboard BrowserWindow and the renderer-facing helpers around it.
const { BrowserWindow, shell, ipcMain, dialog, nativeTheme, session, Menu, clipboard } = require('electron');
const path = require('path');
const { BASE_URL } = require('./const');
const { avatarDataUrl } = require('./icons');
const { CH } = require('../src/shared/channels');

let win = null;

const getWin = () => (win && !win.isDestroyed() ? win : null);

// TaskHub is a menu-bar app: it exits ONLY via the tray menu's Quit. Every other quit
// trigger — ⌘Q, the app-menu's Quit, Dock → Quit, the window's close button — must keep
// the tray (and backend/terminals) running. quitApp() marks the one sanctioned exit;
// before-quit (in tray.js) reads isQuitting() to tell a real quit from one to intercept.
let _quitting = false;
const isQuitting = () => _quitting;
const quitApp = () => { _quitting = true; require('electron').app.quit(); };

// Main dashboard window. Hosts the SPA and lets it embed GitHub/Jira in a <webview>
// (the header-stripping in tray.js allows framing those sites). Reused if already open.
// `onBlur` lets the caller refresh the tray menu as focus moves to the menu bar;
// `onClosed` lets it reap empty terminals (wired from tray.js, not required directly —
// terminals.js already requires this module, so a require back would be a cycle).
let _onBlur = null;
const setOnBlur = fn => { _onBlur = fn; };
let _onClosed = null;
const setOnClosed = fn => { _onClosed = fn; };

// Embedded GitHub/Jira pages get no context menu by default (a bare <webview> has none),
// so a right-click does nothing — no copy, no paste in comment boxes, no "open in browser".
// Build one natively from the click params: spellcheck fixes and edit roles for inputs,
// copy/link actions for selections and links, then page navigation. `contents` is the
// webview's own webContents (from did-attach-webview), so navigation acts on that frame.
// Only ever hand http(s) URLs to the OS — never a file:/ or custom-scheme link a page
// could craft, which shell.openExternal would launch in its registered handler. Mirrors
// the setWindowOpenHandler guard in openWindow().
const isHttpUrl = url => /^https?:\/\//i.test(url || '');
const openExternalHttp = url => { if (isHttpUrl(url)) shell.openExternal(url); };

function attachWebviewContextMenu(contents) {
  contents.on('context-menu', (_e, params) => {
    const items = [];
    const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };

    // Spellcheck suggestions for a misspelled word in an editable field.
    if (params.isEditable && params.misspelledWord) {
      for (const s of params.dictionarySuggestions) items.push({ label: s, click: () => contents.replaceMisspelling(s) });
      sep();
      items.push({ label: 'Add to Dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      sep();
    }

    if (params.linkURL) {
      items.push(
        { label: 'Open Link in Browser', enabled: isHttpUrl(params.linkURL), click: () => openExternalHttp(params.linkURL) },
        { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) },
      );
      sep();
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push({ label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) });
      sep();
    }

    const f = params.editFlags;
    if (params.isEditable) {
      items.push(
        { role: 'cut', enabled: f.canCut },
        { role: 'copy', enabled: f.canCopy },
        { role: 'paste', enabled: f.canPaste },
        { role: 'selectAll' },
      );
      sep();
    } else if (params.selectionText) {
      items.push({ role: 'copy' });
      sep();
    }

    const nav = contents.navigationHistory;
    items.push(
      { label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() },
      { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() },
      { label: 'Reload', click: () => contents.reload() },
    );
    sep();
    items.push(
      { label: 'Open Page in Browser', enabled: isHttpUrl(contents.getURL()), click: () => openExternalHttp(contents.getURL()) },
      { label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) },
    );

    Menu.buildFromTemplate(items).popup({ window: getWin() });
  });
}

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
  // Give each embedded GitHub/Jira <webview> a right-click context menu as it attaches.
  win.webContents.on('did-attach-webview', (_e, contents) => attachWebviewContextMenu(contents));
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

  ipcMain.on(CH.SET_NATIVE_THEME, (_e, value) => {
    nativeTheme.themeSource = value === 'light' || value === 'dark' ? value : 'system';
  });

  // ⌘W with no tab in view → close the window (the renderer can't close a
  // BrowserWindow it didn't open; see handleShortcut 'tab:close' in app.js).
  ipcMain.on(CH.CLOSE_WINDOW, () => getWin()?.close());

  // Fetch a PR author's avatar as a data URI so the renderer can freeze it onto a tab
  // (see freezeAvatar in viewer.js). Resolves null on any failure — the tab just falls
  // back to the live github.com/<login>.png URL.
  ipcMain.handle(CH.AVATAR_FETCH, (_e, login) => avatarDataUrl(login));

  // Resource usage (RAM + CPU summed across every TaskHub process) for the Settings page's
  // live readout. Computed here because getAppMetrics() is main-process only. The require is
  // deferred to call time to sidestep the window→usage→terminals→window load-time cycle.
  ipcMain.handle(CH.USAGE_GET, () => require('./usage').computeUsage());

  // Reveal a folder in the system file manager (Finder). Backs the viewer titlebar's
  // workspace/worktree chip (see updateFolderChip in viewer.js).
  ipcMain.handle(CH.OPEN_PATH, (_e, p) => { if (p) shell.openPath(String(p)); });

  ipcMain.handle(CH.CHOOSE_FOLDER, async () => {
    const parent = getWin() || undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
      title: 'Choose workspace folder',
      properties: ['openDirectory'],
    });
    return canceled || !filePaths.length ? null : filePaths[0];
  });

  // Preview a review sound from Settings — same afplay path the live notification uses,
  // so the macOS system sound (which the sandboxed renderer can't decode/serve) plays
  // identically. Returns the afplay promise so a failure rejects back to the renderer
  // (which toasts it). Deferred require: notifications.js → window.js, so top-level cycles.
  ipcMain.handle(CH.SOUND_PREVIEW, (_e, p) => require('./notifications').previewSound(p || 'system'));
}

module.exports = { openWindow, getWin, sendToWin, runInApp, openLinkInApp, registerIpc, setOnBlur, setOnClosed, isQuitting, quitApp };
