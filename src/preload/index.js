// Bridge a tiny, explicit API into the sandboxed renderer (contextIsolation is on,
// nodeIntegration is off — the page can't use Node directly). Anything the dashboard
// needs from the Electron main process is exposed here as window.taskhub.*
//
// This preload is SANDBOXED (sandbox defaults on under contextIsolation), so it can only
// require('electron') — it CANNOT require('../shared/channels'). Channel names are inlined
// as literals below; keep them in sync with src/shared/channels.js (which the non-sandboxed
// main process does import). Do NOT add a local require here — it throws and silently kills
// the bridge, leaving window.taskhub undefined.
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

  // Preview a review-notification sound through main's afplay (pass a sound's path, or
  // null/'system' for the macOS default). Used by the Settings sound picker.
  previewSound: (p) => ipcRenderer.invoke('sound:preview', p),

  // Reveal a folder in the system file manager (Finder). Backs the viewer titlebar's
  // workspace/worktree chip; resolves once the OS hands the open off.
  openPath: (p) => ipcRenderer.invoke('open-path', p),

  // Open an http(s) URL in the default browser (main guards the scheme). Backs the project
  // page's repo/Jira tags.
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Open the active tab's worktree/checkout folder in the user's chosen git GUI by running
  // their configured command template (`cmd`, e.g. `open -a Fork {path}`) with `{path}`
  // substituted. Main tokenizes + spawns without a shell. Backs the viewer split bar's
  // "Open in git client" button (shown only when a client is set in Settings).
  openInGitClient: (cmd, path) => ipcRenderer.invoke('open-in-git-client', { cmd, path }),

  // Pop a native right-click menu for a sidebar tab at the cursor; resolves to the chosen
  // action ('close') or null. Copy Link / Open Link in Browser are handled in main.
  tabMenu: (url) => ipcRenderer.invoke('tab:menu', url),

  // Pop a native right-click menu for the viewer's folder/worktree chip; resolves to the chosen
  // action ('client' | 'finder' | 'delete') or null. The renderer acts on the result (it owns
  // the chip's path, git-client command, and the worktree-delete confirm/API).
  folderMenu: (ctx) => ipcRenderer.invoke('folder:menu', ctx),

  // Close the dashboard window — ⌘W's fallback when no tab is in view.
  closeWindow: () => ipcRenderer.send('close-window'),

  // Force a full tray rebuild now (e.g. after switching the usage agent) so its rendered panel
  // updates immediately instead of waiting for the 60s refresh. Open-tab changes don't need
  // this — the tray pulls the latest tabs itself as it opens (main's blur handler).
  refreshTray: () => ipcRenderer.send('tray:refresh'),

  // Fetch a PR author's avatar as a base64 data URI (or null). Used to freeze the image
  // onto a tab so it survives reloads unchanged; see freezeAvatar in viewer.js.
  fetchAvatar: (login) => ipcRenderer.invoke('avatar:fetch', login),

  // Current resource usage — { totalKB, totalCPU, breakdown:[{label,kb,cpu}] } summed over
  // every TaskHub process. Main-process only (getAppMetrics); the Settings page polls it.
  getUsage: () => ipcRenderer.invoke('usage:get'),

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
    // Foreground process of the PTY → { process, atShell }. Lets a workflow tell whether the
    // terminal is at a shell prompt (launch the CLI) or already running one (don't re-launch).
    foreground: (id) => ipcRenderer.invoke('term:fg', { id }),
    // Stream a terminal's output; cb(chunk, seq). Returns an unsubscribe function.
    onData: (id, cb) => subscribe(dataListeners, id, cb),
    // Notified when a terminal's shell exits; cb({ exitCode, signal }). Returns unsubscribe.
    onExit: (id, cb) => subscribe(exitListeners, id, cb),
  },
});
