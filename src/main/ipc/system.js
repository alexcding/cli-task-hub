// The host's window/native IPC handlers — everything the renderer reaches via
// window.taskhub.* that isn't a terminal (those live in ipc/terminals.js): theme mirror,
// window close, avatar fetch, resource usage, folder picker, reveal-in-Finder, review-sound
// preview. Thin glue — parse → call a native helper → return. Channel names come from the
// shared CH contract. This + ipc/terminals.js are the renderer-facing IPC; the tray also
// registers CH.TRAY_REFRESH in app/main.js (it's app-lifecycle wiring, not a taskhub.* call).
const { ipcMain, shell, dialog, nativeTheme, Menu, clipboard } = require('electron');
const { getWin } = require('../windows/window');
const { avatarDataUrl } = require('../native/icons');
const { CH } = require('../../shared/channels');

// Only ever hand a clean http(s) URL to the OS: parse + protocol-check (not a prefix
// match) and reject control chars, so a file:/javascript: scheme or an embedded CRLF
// can't reach shell.openExternal. Shared by the open-external bridge and the tab menu.
const isHttpUrl = s => { try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } };
const openExternalHttp = s => { if (!/[\u0000-\u001F\u007F]/.test(s) && isHttpUrl(s)) shell.openExternal(s); };

function register() {
  // Drive native appearance from the dashboard's theme toggle so native chrome (inset
  // traffic lights, scrollbars, menus) renders light/dark to match — 'auto' follows the OS.
  ipcMain.on(CH.SET_NATIVE_THEME, (_e, value) => {
    nativeTheme.themeSource = value === 'light' || value === 'dark' ? value : 'system';
  });

  // ⌘W with no tab in view → close the window (the renderer can't close a BrowserWindow
  // it didn't open; see handleShortcut 'tab:close' in app.js).
  ipcMain.on(CH.CLOSE_WINDOW, () => getWin()?.close());

  // Fetch a PR author's avatar as a data URI so the renderer can freeze it onto a tab
  // (see freezeAvatar in viewer.js). Resolves null on any failure — the tab just falls
  // back to the live github.com/<login>.png URL.
  ipcMain.handle(CH.AVATAR_FETCH, (_e, login) => avatarDataUrl(login));

  // Resource usage (RAM + CPU summed across every TaskHub process) for the Settings page's
  // live readout. Computed in main because getAppMetrics() is main-process only. The require
  // is deferred to call time to sidestep the usage→terminals→window load-time cycle.
  ipcMain.handle(CH.USAGE_GET, () => require('../native/usage').computeUsage());

  // Reveal a folder in the system file manager (Finder). Backs the viewer titlebar's
  // workspace/worktree chip (see updateFolderChip in viewer.js).
  ipcMain.handle(CH.OPEN_PATH, (_e, p) => { if (p) shell.openPath(String(p)); });

  // Open an http(s) URL in the user's default browser. Backs the project page's repo/Jira
  // tags. The scheme/control-char guard lives in openExternalHttp (shared with the tab menu).
  ipcMain.handle(CH.OPEN_EXTERNAL, (_e, url) => openExternalHttp(String(url || '')));

  // Native right-click menu for a sidebar tab (matches the webview/tray menus and the
  // native-mac feel). Order follows the platform norm and our webview menu: positive
  // actions first (open, then copy — same order as window.js), the destructive Close
  // fenced off last so it isn't where the pointer lands. Copy Link / Open Link in Browser
  // run here in main; Close tab needs renderer tab state, so we resolve 'close' back to the
  // renderer to act on. The popup is non-blocking — resolve via the close callback (null if
  // dismissed without a choice).
  ipcMain.handle(CH.TAB_MENU, (_e, url) => new Promise((resolve) => {
    const s = String(url || '');
    let chosen = null;
    const menu = Menu.buildFromTemplate([
      { label: 'Open Link in Browser', enabled: isHttpUrl(s), click: () => openExternalHttp(s) },
      { label: 'Copy Link', enabled: !!s, click: () => clipboard.writeText(s) },
      { type: 'separator' },
      { label: 'Close Tab', click: () => { chosen = 'close'; } },
    ]);
    menu.popup({ window: getWin() || undefined, callback: () => resolve(chosen) });
  }));

  // Native folder picker for choosing a project's workspace folder.
  ipcMain.handle(CH.CHOOSE_FOLDER, async () => {
    const parent = getWin() || undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
      title: 'Choose workspace folder',
      properties: ['openDirectory'],
    });
    return canceled || !filePaths.length ? null : filePaths[0];
  });

  // Preview a review sound from Settings — same afplay path the live notification uses, so
  // the macOS system sound (which the sandboxed renderer can't decode/serve) plays identically.
  // Returns the afplay promise so a failure rejects back to the renderer (which toasts it).
  // Deferred require: notifications.js → window.js, so a top-level require would cycle.
  ipcMain.handle(CH.SOUND_PREVIEW, (_e, p) => require('../native/notifications').previewSound(p || 'system'));
}

module.exports = { register };
