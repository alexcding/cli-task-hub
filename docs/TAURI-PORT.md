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
| 3 | Backend as a packaged Node sidecar | 🟢 implemented (official self-contained node + resources, spawn+wait in release), compiles both profiles — `tauri build` + launch verification owed |
| 4 | Terminals — PTY host (Rust `portable-pty`) + bridge | 🟢 code complete, compiles — runtime test owed |
| 5 | Tray + menu, notifications, updater | 🟢 tray with **open-tabs list** (click reopens) + Open/Quit + quit-only; context menus; updater wired; notifications. Review section + avatars + mono icon deferred |
| 6 | Embedded GitHub/Jira viewer — child WKWebview over a shim div (the hard part) | ✅ PRs embed; back/fwd/stop + find-in-page via JS injection (no match-count). Live title/favicon deferred (objc2) |
| 7 | macOS chrome polish (traffic-light inset), resource-usage readout (`sysinfo`) | 🟢 `getUsage` = full process tree; `fetchAvatar` via curl. Traffic-light inset deferred (objc2) |

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

## Milestone 3 — backend sidecar (implemented)

`bun build --compile` was a dead end (`No such built-in module: node:sqlite` — the backend uses
Node's built-in SQLite, which bun doesn't implement). Homebrew's `node` is also unusable as a
sidecar — it's a 67K launcher needing `@rpath/libnode` + a dozen `/opt/homebrew` dylibs absent from
the `.app`. The **official** node binary, however, is self-contained (138M, links only system
frameworks — verified), so:

- `scripts/build-sidecar.sh` (run via `beforeBuildCommand`) downloads the official node matching the
  local `node --version` and writes it to `src-tauri/binaries/taskhub-node-<triple>` (gitignored).
- `tauri.conf.json`: `bundle.externalBin = ["binaries/taskhub-node"]`; `bundle.resources` ships
  `src/server`, `src/shared`, `src/renderer`, and `node_modules` (so `app.js`'s `../shared` /
  `../renderer` resolve and `require('express')` etc. resolve by walking up to `<resources>/node_modules`).
- `lib.rs start_backend()` (release only) spawns the `taskhub-node` sidecar with arg
  `<resources>/src/server/app.js`, `PORT=3000`, and `TASKHUB_DATA_DIR=<app_data_dir>` (datadir.js
  falls back to a read-only path otherwise — it degrades gracefully outside Electron). `wait_for_backend()`
  TCP-probes `127.0.0.1:3000` (≤10s) before the window loads, so a cold start doesn't show a connection error.

Compiles in both debug and release. *Verification owed:* `bunx tauri build` then launch the `.app` —
confirm the backend boots (data dir under `~/Library/Application Support/tv.accedo.taskhub`) and the
UI loads. *Note:* the bundled server still runs its dev file-watcher (it keys "packaged" off Electron's
`app.asar`, absent here) — harmless on read-only resources, but a `TASKHUB_PACKAGED` guard would be tidier.

## Runtime fixes found while testing in `tauri dev` / packaged

- **Remote-origin permissions are per-command.** `core:webview:default` / `core:window:default` do
  NOT include the action commands. Creating child webviews and dragging the window failed silently
  (caught in JS) until `capabilities/remote.json` added `core:webview:allow-create-webview` +
  `allow-set-webview-position`/`size` + `allow-webview-close`, and `core:window:allow-start-dragging`
  + `allow-toggle-maximize`. Pattern: any new `window.taskhub.*` that calls a core command needs its
  explicit `allow-*` permission on the remote capability.
- **Window dragging.** `-webkit-app-region: drag` is Chromium-only (ignored by WKWebView). Reimplemented
  in `bridge.js`: mousedown on `.topbar` / `.sidebar-logo` / `.split-bar` (minus interactive controls)
  → `getCurrentWindow().startDragging()`; dblclick → `toggleMaximize()`. Has a small unavoidable latency
  vs Electron's compositor-level app-region.
- **Updater plugin** must NOT be initialized without a `plugins.updater` config block (endpoints +
  pubkey) — it panics at startup. Deferred (commented out in `lib.rs`).
- **Data dir.** Electron stores under `~/Library/Application Support/TaskHub` (product name); Tauri uses
  `tv.accedo.taskhub` (identifier). They don't share. Existing data was migrated by copying
  `taskhub.db` + `data.db` across. `beforeDevCommand` now sets `TASKHUB_DATA_DIR` to the Tauri dir so
  dev + packaged agree.
- **Port.** Dev server and the packaged backend both bind `:3000`, so they can't run at once.
  `beforeDevCommand` frees `:3000` first (kills the holder), mirroring `dev.sh`.
- **M3 verified in practice:** the packaged app's sidecar backend ran and created its DB — so the
  real-node sidecar approach works end-to-end.

## Updater (wired — to GitHub Releases, mirroring the Electron channel)

Auto-update from `github.com/alexcding/cli-task-hub` releases, same as the Electron build:
- `tauri.conf.json` → `plugins.updater.endpoints` = `…/releases/latest/download/latest.json`,
  `pubkey` = the minisign public key; `bundle.createUpdaterArtifacts = true`.
- `lib.rs setup_auto_updates()` (release only): `updater().check()` on startup + every 6h →
  `download_and_install` → applies on next launch.
- **Signing keypair** generated at `~/.tauri/taskhub-updater.key` (+ `.pub`) — **kept out of the
  repo; never commit it.** Only the public key lives in `tauri.conf.json`.

To cut a release the updater will consume:
1. Sign the build: `export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/taskhub-updater.key)"`
   (no password — key was generated with `--ci`), then `bunx tauri build`.
2. Upload the produced updater artifacts (`*.app.tar.gz` + `*.app.tar.gz.sig`) **and** a
   `latest.json` manifest to a GitHub release. Easiest is the `tauri-action` GitHub Action, which
   generates `latest.json` automatically; otherwise hand-write it ({ version, notes, pub_date,
   platforms: { "darwin-aarch64": { signature, url } } }).
3. The app checks `releases/latest/download/latest.json`, verifies the signature against the
   pubkey, and self-updates. (Unsigned/ad-hoc builds simply won't update — verification fails, logged.)
