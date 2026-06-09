// Bridge a tiny, explicit API into the sandboxed renderer (contextIsolation is on,
// nodeIntegration is off — the page can't use Node directly). Anything the dashboard
// needs from the Electron main process is exposed here as window.taskhub.*
const { contextBridge, ipcRenderer } = require('electron');

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

ipcRenderer.on('term:data', (_e, { id, chunk, seq }) => { dataListeners.get(id)?.forEach(cb => cb(chunk, seq)); });
ipcRenderer.on('term:exit', (_e, payload)      => { exitListeners.get(payload.id)?.forEach(cb => cb(payload)); });

contextBridge.exposeInMainWorld('taskhub', {
  // Host platform — the renderer uses this to enable the macOS native chrome (inset
  // traffic lights + vibrancy sidebar) only where the window opts into it.
  platform: process.platform,

  // Mirror the app's light/dark/auto choice to the native appearance so the vibrancy
  // sidebar material matches (see tray.js 'set-native-theme').
  setTheme: (value) => ipcRenderer.send('set-native-theme', value),

  // Open the native folder picker; resolves to the chosen absolute path, or null if
  // the dialog was cancelled. Used to set a project's workspace folder.
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),

  // Multiple independent terminals, each an OS pseudo-terminal in the main process.
  term: {
    // Spawn a login shell in `cwd`; opts.paired + opts.pairKey identify a GitHub/Jira split terminal.
    create: (opts = {}) => ipcRenderer.invoke('term:create', opts),
    // Type raw bytes into a terminal (include '\n'/'\r' for Enter).
    write:  (id, data) => ipcRenderer.send('term:write', { id, data }),
    // Keep the PTY size in sync with the xterm view.
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
    // Terminate a terminal's shell and free the PTY.
    kill:   (id) => ipcRenderer.invoke('term:kill', { id }),
    // Live list of terminals — for rehydrating the UI after a reload.
    list:   () => ipcRenderer.invoke('term:list'),
    // Reattach after a window reopen; resolves to { buf, seq }: the buffered backlog to
    // replay plus the seq of its last chunk (so live output can resume without a gap/dup).
    attach: (id) => ipcRenderer.invoke('term:attach', { id }),
    // Stream a terminal's output; cb(chunk, seq). Returns an unsubscribe function.
    onData: (id, cb) => subscribe(dataListeners, id, cb),
    // Notified when a terminal's shell exits; cb({ exitCode, signal }). Returns unsubscribe.
    onExit: (id, cb) => subscribe(exitListeners, id, cb),
  },
});
