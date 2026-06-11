// TaskHub Electron entry point. App lifecycle + wiring only — the actual work lives
// in main/: server-supervisor (backend child), terminals (PTYs), window (dashboard
// BrowserWindow + IPC), menu (tray menu), icons (rasterization), notifications
// (review alerts), usage (RAM/CPU readout, surfaced in Settings), updater (auto-updates).

// Cache compiled V8 bytecode to disk for faster cold starts (no-op pre-Node 22.8).
try { require('node:module').enableCompileCache?.(); } catch {}

const { app, Tray, session, ipcMain } = require('electron');
const path = require('path');

// Show "TaskHub" (not "Electron") in the About panel, Dock, and userData path during dev.
// Must run before app is ready. The macOS app-menu label is set separately via an explicit
// application menu in whenReady() (setName alone can't relabel it in an unpackaged bundle).
// Packaged builds get all of this from the bundle's productName.
app.setName('TaskHub');

// DO NOT add `app.commandLine.appendSwitch('process-per-site')`. It was tried as a memory
// optimization (collapse all same-site <webview> tabs into one shared renderer, since we
// show one tab at a time) but it broke the embedded GitHub login — webviews share the default
// session for its cookies, and the shared-renderer model destabilizes that auth state, so
// GitHub stops recognizing the session. Reducing webview memory must not touch the session.

// Initialize logging before any window is created (log.initialize wires the renderer
// IPC bridge). Routes console.* in this process to <userData>/logs/main.log. Required for
// its side-effect — the import itself sets up logging.
require('./lib/logger');

const supervisor = require('./main/server-supervisor');
const terminals = require('./main/terminals');
const win = require('./main/window');
const { trayIcon } = require('./main/icons');
const { refreshMenuData, buildMenuNow } = require('./main/menu');
const { setupAutoUpdates } = require('./main/updater');
const { BASE_URL } = require('./main/const');

let tray = null;

// Re-fetch the menu's data (open tabs, pending reviews, icon color), then re-arm the
// tray's context menu with it — the SET menu is what macOS opens on click, so every
// data refresh must land there (see the setContextMenu comment in whenReady).
async function refreshMenu() {
  if (!tray) return;
  await refreshMenuData(tray, refreshMenu);
  tray.setContextMenu(buildMenuNow());
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

// Only one TaskHub at a time — quit if another instance already holds the lock.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

app.whenReady().then(async () => {
  // macOS app menu (top-left, beside the Apple logo). Without our own template
  // Electron uses its default one, whose first item is hard-coded to "Electron"
  // in dev — app.setName() can't relabel it. Ours also carries every keyboard
  // shortcut as a menu accelerator (see main/app-menu.js for why).
  if (process.platform === 'darwin') {
    require('./main/app-menu').setAppMenu();
  }

  // Show the app icon in the Dock. Packaged builds pick it up from the bundle's
  // .icns automatically; in dev (`electron .`) set it explicitly so we show the
  // brand icon instead of Electron's default.
  if (app.dock && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, 'build', 'icon.png'));
  }

  win.registerIpc();        // theme mirror + folder picker
  terminals.registerIpc();  // PTY create/write/resize/kill/list/attach
  win.setOnBlur(refreshMenu); // refresh the menu's PR list as focus moves to the menu bar
  ipcMain.on('tray:refresh', () => refreshMenu()); // renderer asks for an immediate rebuild (e.g. usage-agent switch)
  // PTYs outlive the window so running work survives a reopen — but a bare prompt has
  // nothing to preserve, so reap those on window close (same policy as closing a tab).
  win.setOnClosed(() => terminals.killEmpty());

  // In dev (`npm run dev:app`) a watched server is already running — connect to it
  // instead of forking, so we get hot reload and don't fight over the port.
  if (process.env.TASKHUB_EXTERNAL_SERVER === '1') {
    console.log(`[tray] using external server at ${BASE_URL}`);
  } else {
    // Keep the backend out of the Electron main process; the supervisor also respawns
    // it if it crashes.
    supervisor.startServer();
  }

  try {
    await supervisor.waitForServer();
  } catch (err) {
    console.error('[tray] Could not connect to server:', err.message);
  }

  allowFraming();    // let the dashboard's <webview> embed GitHub/Jira
  win.openWindow();  // show the dashboard window on launch

  tray = new Tray(trayIcon('idle')); // colored by state in refreshMenuData()
  tray.setToolTip('TaskHub');

  // A context menu must stay SET: calling popUpContextMenu from a tray 'click' handler
  // returns without displaying anything (verified on macOS 26 / Electron 42), so the menu
  // is pre-built and re-armed via setContextMenu on every data refresh — the 60s tick,
  // window blur, and item clicks, all through refreshMenu(). Its contents no longer change
  // between those refreshes (the live usage readout moved to Settings), so there's nothing
  // to recompute when the menu opens.

  // Errors here must not abort startup wiring — fall back to an armed menu with
  // whatever body we have ('Loading…' before the first successful refresh).
  await refreshMenu().catch(err => {
    console.error('[tray] initial menu refresh failed:', err);
    tray.setContextMenu(buildMenuNow());
  });

  // Refresh menu every 60 seconds
  setInterval(refreshMenu, 60_000);

  setupAutoUpdates();
});

app.on('window-all-closed', () => {
  // Intentionally empty: TaskHub is a menu-bar app, so closing the dashboard window
  // must NOT quit it. The tray (and its backend/terminals) keep running; reopen the
  // window from the tray's "Open TaskHub" or the Dock icon (app.on('activate')). Do not
  // add app.quit() here — that would make a window close kill the whole app.
});

// Clicking the Dock icon (with no window open) reopens the dashboard — standard macOS.
app.on('activate', () => win.openWindow());

app.on('before-quit', (e) => {
  // The tray menu's Quit (quitApp) is the ONLY sanctioned exit. Any other quit trigger —
  // ⌘Q, the app-menu's Quit, Dock → Quit, even an OS-issued quit — fires before-quit too,
  // but for a menu-bar app those should just close the window and leave the tray running.
  // So unless this quit came from quitApp(), cancel it and close the window instead.
  if (!win.isQuitting()) {
    e.preventDefault();
    win.getWin()?.close();
    return;
  }
  supervisor.shutdown(); // stop the respawn loop + kill the backend child
  terminals.killAll();
});
