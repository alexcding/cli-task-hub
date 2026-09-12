# SwiftUI Native Port — plan

Porting the TaskHub desktop client from a Tauri-hosted web renderer to a **native
macOS app (SwiftUI + AppKit where needed)**, with the terminal on **libghostty**.
Branch: `feat/swiftui-native`. Worktree: `../cli-task-hub-swiftui`.

Companion docs: `ARCHITECTURE.md` (layers, HTTP-vs-IPC split), `TAURI-PORT.md`
(the previous shell port — the same boundary makes this one tractable), `CLAUDE.md`
(renderer conventions; the product rules there survive the port even though the code
does not).

## Why now, and why native

The Tauri shell works, but roughly half of `src-tauri/` exists to work around what a DOM
UI cannot do on WKWebView:

- child webviews float **above** every DOM layer, so a rAF loop (`wcv-shim.js`) tracks
  their bounds, `viewer.rs` polls title/URL via objc2, `webview_menu.rs` swizzles
  `willOpenMenu`, and every context menu had to become a native `muda` popup;
- `-webkit-app-region` is Chromium-only, so window drag is reimplemented in `bridge.js`;
- the usage panel is rendered to a **bitmap** (`usage_image.rs`) to sit in the tray menu;
- glass/vibrancy, Dock toggling and zoom animation are objc2 glue (`glass.rs`).

In a native app a `WKWebView` is a view, a menu is an `NSMenu`, the tray item can host a
SwiftUI view, and the split pane is `NSSplitView`. Those modules are deleted, not ported.

## What stays, what goes

| Layer | Today | Lines | Port verdict |
|---|---|---|---|
| `src/server/` | Express + `node:sqlite` + `gh`/`acli`/`git`/`xcodebuild` | ~4,450 | **Keep** as the backend. Runs as a sidecar exactly as under Tauri (`start_backend` logic moves to Swift). Port to Swift is an optional later phase. |
| `src/shared/` | `ROUTES`, `jira-keys`, `jql`, constants | ~220 | Keep; **generate** a Swift mirror of `ROUTES` and port the pure modules 1:1 with their tests. |
| `src/renderer/` | vanilla ESM, xterm.js, Monaco, hand-rolled diff | ~12,600 | **Rewrite** in SwiftUI. Nothing is reused except the pure `.mjs` logic. |
| `src-tauri/src/ptyd.rs` | detached PTY daemon, Unix socket, JSON protocol | 776 | **Keep unchanged.** Becomes a standalone binary the app spawns; Swift gets a client. |
| `src-tauri/src/terminals.rs` | Rust client of the daemon | 358 | Rewrite as a Swift client (`PtydClient`). |
| `src-tauri/src/{tray,notify,menu,glass,avatars,usage_image,viewer,webview_menu,commands,lib}.rs` + `bridge.js` | shell glue | ~2,700 + 556 | **Delete**; each becomes ordinary AppKit/SwiftUI. |

## Architecture of the native app

```
macos/
  TaskHub.xcodeproj            (or Package.swift + xcodegen; decide in M0)
  TaskHub/
    App/          TaskHubApp.swift, AppDelegate (tray, quit-only, Dock), Sparkle
    Backend/      BackendProcess (spawn node sidecar, TCP wait), APIClient (URLSession over
                  generated Routes), SSEClient, Models (Codable mirrors of API JSON)
    Store/        AppStore (@Observable) — the single state + pure lookups (prGroup, prByUrl…)
    Terminal/     PtydClient (Unix socket, JSON), GhosttySurfaceView, TerminalPane,
                  link/path detection, flow control
    Viewer/       WebTab (WKWebView), ContentTabStrip (chipOrder), History, Find bar
    Diff/         DiffParser (port of diff-parse.mjs), DiffView
    Sidebar/      ProjectOutline (project → session, Pinned mirror, Tabs group), context menus
    Pages/        Dashboard, Jira, Scrumboard, Logs, Settings, Project
    Layout/       SplitPane (paneView: off/term/diff/build) — the one place state → geometry
  Shared/         Routes.swift (GENERATED from src/shared/routes.mjs), JiraKeys, JQL
  scripts/        gen-routes.mjs, build-sidecar.sh (reuse), bench
```

Transport is unchanged: **HTTP + SSE to `localhost:3000`**. The `window.taskhub.*` bridge
disappears; its jobs are in-process Swift calls.

## Terminal design (the part that decides success)

Decision: **libghostty via `libghostty-spm`**, not SwiftTerm, not xterm-in-WKWebView.
Reference implementation: unpeel (`github.com/unpeel-com/unpeel`), which embeds the same
package in a SwiftUI client over a `portable-pty` daemon — the same shape as ours.

- **Daemon stays Rust.** `ptyd.rs` already gives us detached shells that survive
  reload/rebuild/crash, `TASKHUB_RUN_ID` for agent hooks, and `foreground` detection for
  the Run chip. Build it as its own crate (`crates/taskhub-ptyd`) with the existing
  protocol; the app bundles it next to the node sidecar.
- **Swift client** replaces `terminals.rs`: connect to `/tmp/taskhub-ptyd-<uid>.sock`,
  `create/write/resize/flow/kill/list/attach/foreground`, fan out `data` broadcasts to the
  surface that owns the terminal id. Keep the `FLOW_HIGH`/`FLOW_LOW` pause/resume policy
  from `terminal.js`.
- **Rendering**: `GhosttySurfaceView` wraps a libghostty Metal surface. Coalesce resizes
  (unpeel uses 80 ms) so a split-pane tween does not storm the PTY with SIGWINCH — this
  replaces `body.pr-tweening` + the ResizeObserver hold.
- **Links**: file paths → editor tab, `http(s)` → content tab beside the terminal,
  ⌥-click → real browser. Same rules as `wireTermLinks`; implemented on the Ghostty
  selection/URL hooks.
- **Reattach**: phase 1 replays the daemon's buffer as today. Phase 2 candidate: host-side
  VT snapshot (one emulator in the daemon, re-emit the grid on attach) as unpeel does —
  it removes the per-tab replay cost `fe58735` had to parallelise.
- **Known risk**: unpeel's only open issue is ~85 % GPU with a busy TUI agent visible.
  Budget a spike (M2) to measure with Claude Code running; mitigations are frame-rate
  capping when the surface is not focused and pausing render for occluded panes.

## Product rules that must survive (from `CLAUDE.md`)

- Sidebar = project → **session**; sessions are the only rows; task-less tabs live in one
  "Tabs" group; pins are additive mirrors in a "Pinned" group; rows sort oldest-created.
- Every session has one **context tab**; a bare session has no page. One code path.
- Right pane is one state, `paneView ∈ {off, term, diff, build}`; only one mutator,
  only one state→geometry mapper; `build` never persisted.
- Nothing is pinned to the content strip by default; ＋ fills it; new chips go after
  the active chip; `chipOrder` is **one ordered list**, never per-chip indices.
- Mine vs Review uses `prGroup`, never raw `category`; tray/sound stay on `category`.
- Quit only from the tray; the PTY daemon outlives the app.
- Restrained slate + single accent, flat, SF Symbols / SVG, no emoji.

## Milestones

| # | Goal | Exit criterion |
|---|------|----------------|
| M0 | Project skeleton: Xcode project, `BackendProcess` spawns the existing node server, `Routes.swift` generated from `routes.mjs`, `APIClient` + `SSEClient`, contract test that every `ROUTES` key has a Swift case | App launches, hits `/api/projects`, receives a `sync` SSE event |
| M1 | Shell + read-only pages: window, sidebar outline (projects → sessions, Tabs, Pinned), tray with PR rows + usage view, notifications, Dashboard / Jira / Logs / Settings / Project pages, theme | Feature parity with the web pages minus terminal/viewer; quit-only-from-tray works |
| M2 | Terminal spike: `PtydClient` + `GhosttySurfaceView` against the existing daemon; measure GPU with Claude Code running; links; flow control | A session opens in a pane, survives app relaunch, GPU acceptable or mitigated |
| M3 | Sessions: New-session dialog, worktree + task creation, restart, remove (confirm dialog), pin, context menus, `build:` PTY + Run chip (scheme/simulator pickers from `/api/xcode/*`) | Full session lifecycle from the sidebar |
| M4 | Viewer: `WKWebView` tabs sharing one website data store (GitHub/Jira login), content-tab strip with `chipOrder`, History submenu, page-only vs session toolbar, find bar, memory budget via `WKWebView` process accounting | PR/Jira tabs behave as today; no shim, no bounds loop |
| M5 | Diff + File tabs: `DiffParser` (port `diff-parse.mjs` with its tests), `DiffView` with highlighting, File tab (decide: `CodeEditSourceEditor` vs Monaco in a WKWebView vs drop) | Diff parity; file tab decision recorded here |
| M6 | Packaging: bundle node sidecar + `taskhub-ptyd`, Sparkle updates, notarisation; remove `src-tauri/` and `src/renderer/` from the build | `.dmg` installs and runs on a clean Mac |
| M7 (optional) | Port `src/server/` to Swift (GRDB + `Process`), drop node | Single binary; API tests re-pointed and green |

Estimate: M0–M6 ≈ 10–12 weeks solo; M7 ≈ 3–4 more.

## Development approach

- **Two UIs, one backend.** Run `node src/server/app.js` and point both the Tauri app and
  the native app at it during the transition. Nothing in `src/server/` changes for the
  port; if a native page needs data the API lacks, add a route to `routes.mjs` and both
  clients get it.
- **Port pure logic first, with tests.** `diff-parse`, `jira-keys`, `jql`,
  `terminal-tail` each get a Swift file and a translated test before any view uses them.
- **One decision per ADR line here**, not in commit messages: package manager
  (xcodegen vs `.xcodeproj` checked in), editor choice, snapshot-vs-replay reattach.
- Commit straight to `main` once a milestone is usable; this branch is for the
  skeleton and spikes.

## Open questions

- Editor tab: is Monaco parity required, or is a read-only native source view enough?
- iOS/remote client later? If yes, the host-side VT snapshot (M2 phase 2) becomes a
  requirement, not an optimisation.
- Does the tray need the full PR list, or does a native `MenuBarExtra` with a SwiftUI
  popover replace both the tray menu and the usage bitmap?
