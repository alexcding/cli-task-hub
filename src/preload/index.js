// Bridge a tiny, explicit API into the sandboxed renderer (contextIsolation is on,
// nodeIntegration is off — the page can't use Node directly). Anything the dashboard
// needs from the Electron main process is exposed here as window.taskhub.*
const { contextBridge, ipcRenderer } = require('electron');
const { CH } = require('../shared/channels');

// ── Terminal output fan-out ───────────────────────────────────────────────────
// Main pushes per-terminal events tagged with the terminal id; we dispatch to the
// callbacks the renderer registered for that id. Keyed by id so many terminals can
// be read independently. onData/onExit each return an unsubscribe function.
const dataListeners = new Map(); // id -> Set<cb(chunk, seq)>
const exitListeners = new Map(); // id -> Set<cb({exitCode, signal})>

function subscribe(map, id, cb) {
  let set = map.get(id);
  if (!set) { set = new Set(); map.set(id, set); }
  set.add(cb);
  return () => { set.delete(cb); if (!set.size) map.delete(id); };
}

ipcRenderer.on(CH.TERM_DATA, (_e, { id, chunk, seq }) => { dataListeners.get(id)?.forEach(cb => cb(chunk, seq)); });
ipcRenderer.on(CH.TERM_EXIT, (_e, payload)      => { exitListeners.get(payload.id)?.forEach(cb => cb(payload)); });

contextBridge.exposeInMainWorld('taskhub', {
  // Host platform — the renderer uses this to enable the macOS native chrome (inset
  // traffic lights + vibrancy sidebar) only where the window opts into it.
  platform: process.platform,

  // Mirror the app's light/dark/auto choice to the native appearance so the vibrancy
  // sidebar material matches (see tray.js 'set-native-theme').
  setTheme: (value) => ipcRenderer.send(CH.SET_NATIVE_THEME, value),

  // Open the native folder picker; resolves to the chosen absolute path, or null if
  // the dialog was cancelled. Used to set a project's workspace folder.
  chooseFolder: () => ipcRenderer.invoke(CH.CHOOSE_FOLDER),

  // Preview a review-notification sound through main's afplay (pass a sound's path, or
  // null/'system' for the macOS default). Used by the Settings sound picker.
  previewSound: (p) => ipcRenderer.invoke(CH.SOUND_PREVIEW, p),

  // Reveal a folder in the system file manager (Finder). Backs the viewer titlebar's
  // workspace/worktree chip; resolves once the OS hands the open off.
  openPath: (p) => ipcRenderer.invoke(CH.OPEN_PATH, p),

  // Close the dashboard window — ⌘W's fallback when no tab is in view.
  closeWindow: () => ipcRenderer.send(CH.CLOSE_WINDOW),

  // Rebuild the tray menu now (e.g. after switching the usage agent) so its rendered
  // panel updates immediately instead of waiting for the 60s/blur refresh.
  refreshTray: () => ipcRenderer.send(CH.TRAY_REFRESH),

  // Fetch a PR author's avatar as a base64 data URI (or null). Used to freeze the image
  // onto a tab so it survives reloads unchanged; see freezeAvatar in viewer.js.
  fetchAvatar: (login) => ipcRenderer.invoke(CH.AVATAR_FETCH, login),

  // Current resource usage — { totalKB, totalCPU, breakdown:[{label,kb,cpu}] } summed over
  // every TaskHub process. Main-process only (getAppMetrics); the Settings page polls it.
  getUsage: () => ipcRenderer.invoke(CH.USAGE_GET),

  // Multiple independent terminals, each an OS pseudo-terminal in the main process.
  term: {
    // Spawn a login shell in `cwd`; opts.paired + opts.pairKey identify a GitHub/Jira split terminal.
    create: (opts = {}) => ipcRenderer.invoke(CH.TERM_CREATE, opts),
    // Type raw bytes into a terminal (include '\n'/'\r' for Enter).
    write:  (id, data) => ipcRenderer.send(CH.TERM_WRITE, { id, data }),
    // Keep the PTY size in sync with the xterm view.
    resize: (id, cols, rows) => ipcRenderer.send(CH.TERM_RESIZE, { id, cols, rows }),
    // Terminate a terminal's shell and free the PTY.
    kill:   (id) => ipcRenderer.invoke(CH.TERM_KILL, { id }),
    // Live list of terminals — for rehydrating the UI after a reload.
    list:   () => ipcRenderer.invoke(CH.TERM_LIST),
    // Reattach after a window reopen; resolves to { buf, seq }: the buffered backlog to
    // replay plus the seq of its last chunk (so live output can resume without a gap/dup).
    attach: (id) => ipcRenderer.invoke(CH.TERM_ATTACH, { id }),
    // Stream a terminal's output; cb(chunk, seq). Returns an unsubscribe function.
    onData: (id, cb) => subscribe(dataListeners, id, cb),
    // Notified when a terminal's shell exits; cb({ exitCode, signal }). Returns unsubscribe.
    onExit: (id, cb) => subscribe(exitListeners, id, cb),
  },
});
