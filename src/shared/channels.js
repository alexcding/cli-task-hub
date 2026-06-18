// Shared IPC channel names — the single source of truth for every Electron IPC channel,
// imported by the preload bridge (src/preload/index.js) and the main-process handlers (src/main/*)
// so the two sides can never drift on a magic string. Renderer code does NOT import this:
// it reaches the host only through window.taskhub.* (see src/preload/index.js), never raw channels.
//
// CommonJS on purpose — every consumer is a Node process (src/main + src/preload). The renderer is
// browser ES modules and has no business with channel names. See docs/ARCHITECTURE.md.

const CH = {
  // ── Terminals (src/main/ipc/terminals.js ⇄ preload term.*) ──────────────────────────
  TERM_CREATE: 'term:create',   // invoke  → { id, ... }
  TERM_WRITE:  'term:write',    // send    ← { id, data }
  TERM_RESIZE: 'term:resize',   // send    ← { id, cols, rows }
  TERM_KILL:   'term:kill',     // invoke  ← { id }
  TERM_LIST:   'term:list',     // invoke  → [{ id, cwd, ... }]
  TERM_ATTACH: 'term:attach',   // invoke  ← { id } → { buf, seq }
  TERM_DATA:   'term:data',     // send    → { id, chunk, seq }  (main → renderer)
  TERM_EXIT:   'term:exit',     // send    → { id, exitCode, signal } (main → renderer)

  // ── Window / native (src/main/ipc/system.js ⇄ preload) ──────────────────────────────
  SET_NATIVE_THEME: 'set-native-theme', // send   ← 'light' | 'dark' | 'auto'
  CLOSE_WINDOW:     'close-window',      // send
  CHOOSE_FOLDER:    'choose-folder',     // invoke → absolute path | null
  SOUND_PREVIEW:    'sound:preview',     // invoke ← path | null | 'system'
  OPEN_PATH:        'open-path',         // invoke ← path
  OPEN_EXTERNAL:    'open-external',     // invoke ← http(s) url (opened in the default browser)
  OPEN_IN_GIT_CLIENT: 'open-in-git-client', // invoke ← { cmd, path } (run the configured git-client command template)
  AVATAR_FETCH:     'avatar:fetch',      // invoke ← login → data URI | null
  USAGE_GET:        'usage:get',         // invoke → { totalKB, totalCPU, breakdown }
  TAB_MENU:         'tab:menu',          // invoke ← tab url → 'close' | null (native right-click menu)
  FOLDER_MENU:      'folder:menu',       // invoke ← { hasClient, clientLabel, isWorktree } → 'client'|'finder'|'delete'|null

  // ── Tray (src/main/app/main.js) ───────────────────────────────────────────────────────────
  TRAY_REFRESH: 'tray:refresh',          // send (renderer asks for an immediate rebuild)
};

module.exports = { CH };
