# Tauri Port — status & plan

Porting the TaskHub desktop shell from Electron to **Tauri v2** (macOS/WKWebView).
Branch: `feat/tauri-port`.

## Why this is tractable

The architecture (see `ARCHITECTURE.md`) already split the transport: the renderer talks
to the backend over **HTTP + SSE** (`services/api.js`), not Electron IPC. So the two big
layers port for **free**:

- **`src/renderer/`** — vanilla ESM served over HTTP. Unchanged. The Tauri window just
  loads `http://localhost:3000`.
- **`src/server/`** — the Express/CLI backend (poller, repositories, `node:sqlite`,
  `gh`/`acli`/`git`). Unchanged. Runs as a **Node sidecar** under Tauri.

Only the Electron host (`src/main/` + `src/preload/`, ~1,800 LOC) is replaced — by
`src-tauri/` (Rust) + a JS bridge shim that re-implements `window.taskhub.*` on Tauri
`invoke`/events.

## Run

```bash
bunx tauri dev        # starts `node src/server/app.js` (beforeDevCommand), opens the window at :3000
bunx tauri build      # packaged .app/.dmg (needs the backend sidecar — see Milestone 3)
```

Rust host lives in `src-tauri/` (`tauri.conf.json`, `src/lib.rs`). The CLI/API are dev
deps (`@tauri-apps/cli`, `@tauri-apps/api`).

## Milestones

| # | Goal | Status |
|---|------|--------|
| 1 | Tauri window renders the UI via the existing backend | ✅ done — Rust compiles, server serves :3000, window points at it |
| 2 | `window.taskhub.*` bridge (core methods) | ✅ done — remote-origin IPC **verified at runtime** (`invoke('platform')` → `"darwin"`) |
| 3 | Backend as a packaged Node sidecar (bundle node, `externalBin`, spawn in release) | ⛔ blocked — bun fails on `node:sqlite`; needs real-Node bundling (see below). `tauri dev` unaffected |
| 4 | Terminals — PTY host (Rust `portable-pty`) + bridge | 🟢 code complete, compiles — runtime test owed |
| 5 | Tray + menu, notifications, updater | 🟢 MVP (tray Open/Quit + quit-only invariant, plugins wired), compiles — context menus + dynamic tray deferred |
| 6 | Embedded GitHub/Jira viewer — child WKWebview over a shim div (the hard part) | 🟡 MVP built, compiles — runtime test owed; find/back-fwd deferred (see below) |
| 7 | macOS chrome polish (traffic-light inset), resource-usage readout (`sysinfo`) | 🟢 `getUsage` (host process) done; traffic-light inset + full-tree usage deferred |

## Bridge surface to re-implement (Milestone 2+)

The renderer's real native dependencies (`window.taskhub.*` — localStorage keys like
`taskhub.theme` are *not* bridge calls):

- **System** (`src/main/ipc/system.js`): `setTheme`, `chooseFolder`, `pathForFile`,
  `previewSound`, `openPath`, `openExternal`, `openInGitClient`, `tabMenu`, `folderMenu`,
  `closeWindow`, `refreshTray`, `fetchAvatar`, `getUsage`, `platform`.
- **Terminals** (`src/main/ipc/terminals.js`): `term.{create,write,resize,kill,list,attach,foreground,onData,onExit}`.
- **Viewer** (`webview` path): the embedded GitHub/Jira tabs. Tauri on macOS *is* WKWebView,
  so embedding arbitrary sites + shared login cookies work natively; find-in-page, custom
  context menu, and favicons need a small Rust plugin.

None of these are hit at renderer bootstrap (all interaction-driven), so the UI renders
before the bridge exists — they degrade gracefully until Milestone 2.

## Milestone 2 — the bridge (mechanism)

Remote-origin IPC is the crux: the renderer is served from `http://localhost:3000`, which Tauri
treats as a **remote** origin and denies IPC by default. Granted via:

- `app.withGlobalTauri: true` (tauri.conf.json) → injects `window.__TAURI__`.
- `capabilities/remote.json` → `remote.urls` allow-lists the local backend origin for the `main`
  window, with `core:default` (enough for app commands; they aren't permission-gated).
- The window is built in **Rust** (`open_main_window` in `lib.rs`), not declared in config, so it
  can carry a preload-equivalent **init script** (`src-tauri/bridge.js`) defining `window.taskhub.*`.
- Each method → a custom command in `src-tauri/src/commands.rs` that does plugin work (dialog,
  opener) from Rust, so the renderer never depends on plugin JS globals.

Ported now: `platform`, `setTheme`, `closeWindow`, `chooseFolder`, `openPath`, `openExternal`,
`openInGitClient`, `previewSound`. Stubbed in `bridge.js` until their milestone: `term.*` (M4),
`tabMenu`/`folderMenu`/`refreshTray` (M5), `wcv.*` (M6), `getUsage` (M7), `fetchAvatar`,
`pathForFile` (M4).

⚠️ **Runtime check still owed:** that a remote-origin `invoke` actually reaches a custom app
command (compiles clean, but only `tauri dev` + a real bridge call confirms the capability is
wired right). If blocked, fall back to loading the renderer from the bundled origin with
`api.js` pointed at an absolute backend URL (+ CORS).

## Milestone 6 — embedded viewer (MVP)

Replaces the Electron `<webview>` tag (unsupported by WKWebView, which is why PR/Jira tabs were
leaking to the external browser) with **Tauri child webviews** (multiwebview).

- `Cargo.toml`: `tauri` features += `unstable` (multiwebview is behind it).
- `capabilities/remote.json`: += `core:webview:default`, `core:window:default` (let the remote
  renderer create/position child webviews).
- `bridge.js` `wcv.*`: real impl over the JS `Webview` API — `create` (lazy, off-screen),
  `bounds` (position/size, or park off-screen to hide), `navigate` (recreate), `reload`, `destroy`.
- `src/renderer/components/wcv-shim.js` (new): a `<webview>`-compatible `<div>`. Intercepts
  `setAttribute('src')`/`loadURL`, runs a rAF loop pushing its on-screen rect to `wcv.bounds`, and
  closes the child webview on `.remove()`.
- `viewer.js` `createWebviewEl()`: one branch — returns the shim when `window.__TAURI__` is present;
  Electron path untouched.
- `viewer.css`: `.wcv-shim` shares the `webview` box rules.

**Deferred (need native objc2/WKWebView glue):** find-in-page (⌘F), back/forward + `canGoBack/Forward`,
`stop`, and `did-navigate`/`page-title-updated`/`page-favicon-updated` events (tab title/favicon won't
live-update from the page; PR/Jira tabs keep their given title). Renderer overlays (find bar, loading
spinner) sit *behind* the native webview — also native-glue territory.

**Runtime test (owed):** `bunx tauri dev`, click a PR card → it should embed in the left pane instead
of opening Chrome; resize the sidebar/split and switch tabs → the embedded page should track the pane
and hide when another tab/terminal is shown.

## Milestones 4 / 5 / 7 (code complete, compile-verified — runtime test owed)

**M4 — Terminals** (`src-tauri/src/terminals.rs`): PTYs via `portable-pty`, one per id, kept in a
global registry that outlives the window (matches Electron). Commands `term_{create,write,resize,
kill,list,attach,foreground}`; output streams as global `term://data` / `term://exit` events that
`bridge.js` fans out to the per-id callbacks the renderer registered. UTF-8 is decoded on whole-
codepoint boundaries (incomplete trailing bytes held over) so chunks never split mid-character; a
256 KB rolling tail backs `attach` replay. *Deferred:* `term_foreground` always reports at-prompt
(portable-pty doesn't expose the PTY's foreground process), and `pathForFile` (terminal drag-drop
paths) still returns '' — Tauri carries dropped-file paths via its own drag-drop event, not the DOM.

**M5 — Tray + plugins** (`lib.rs`): a menu-bar tray (Open TaskHub / Quit) with the **quit-only-from-
tray** invariant preserved — a window close hides the window (`CloseRequested` → `prevent_close` +
`hide`) and only the tray's Quit sets `QUITTING`, kills terminals, and exits; macOS Dock-reopen shows
the window again. `tauri-plugin-notification` and `tauri-plugin-updater` are initialized. *Deferred:*
the dynamic tray body (open tabs / pending reviews), the custom mono/template tray icon, the native
`tabMenu`/`folderMenu` context menus (still stubbed → no-op right-click), SSE-driven review
notifications (needs an SSE client + focus check in Rust), and updater endpoints/signing config.

**M7 — Usage** (`commands.rs get_usage`): RAM + CPU for the host process via `sysinfo` (two samples a
short interval apart for CPU), shape `{ totalKb, totalCpu, breakdown }` for the Settings readout.
*Deferred:* summing the full TaskHub process tree (host + backend sidecar + PTYs), the traffic-light
fine-inset (needs objc2), and `fetchAvatar` (returns null → renderer falls back to the live avatar URL).

## Milestone 3 — backend sidecar (BLOCKED, finding recorded)

`bun build --compile` of `src/server/app.js` builds, but the binary dies at runtime with
**`No such built-in module: node:sqlite`** — the backend uses Node's built-in SQLite, which bun
doesn't implement. So a bun single-file binary can't be the sidecar. The fix needs **real Node**:
either ship the `node` binary as `externalBin` + `src/server`/`src/shared`/`src/renderer` as
`bundle.resources` and spawn it in release (`start_backend` in `lib.rs` is already stubbed for this),
or Node SEA (esbuild-bundle → postject). Both need a full `tauri build` + launch to verify, so the
`externalBin`/`beforeBuildCommand` wiring is intentionally left out for now (it would otherwise break
`cargo check`, which validates `externalBin` paths). Details in `scripts/build-sidecar.sh`.
