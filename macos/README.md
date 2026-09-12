# TaskHub Native

Native macOS client under implementation. macOS 14+, Xcode 16.3+ and Swift 6.1+;
Apple silicon is the initial build target. Open `TaskHub.xcworkspace` in Xcode.

The app target owns AppKit lifecycle and hosts SwiftUI. `TaskHubPackage` holds the
API client, SSE parser/client, backend owner, observable store, and views. The current
screen has a Cocoa sidebar with project/session selection, Pinned mirrors, saved
Tabs, native terminal panes, and a native SwiftUI Dashboard.
See [the port plan](../docs/SWIFTUI-PORT.md).

## Cocoa sidebar (M2)

The sidebar is an AppKit `NSOutlineView`, hosted through `NSViewRepresentable`.
It supports native disclosure/keyboard selection, retained expansion and selection,
and context menus for pin/unpin, Finder reveal, and copying paths/links. Projects,
sessions, and tabs come from the existing backend snapshots and refresh via SSE.
Pinning requires the updated backend's `PATCH /api/tasks/:id/pin` endpoint.

Selecting a session shows its saved worktree and branch. **Open Terminal** opens or
reattaches its shell; switching sidebar rows preserves the mounted emulator and
hidden parsing. Pinned rows are additional entries for the same session. Browser
tabs now open embedded context pages with native controls. Sidebar implementation is authorized ahead of the remaining
M1 terminal acceptance checks, which are still open.

For an isolated sample hierarchy, run `macos/scripts/backend-fixture.cjs` with
`TASKHUB_SIDEBAR_FIXTURE=1`, an isolated `TASKHUB_DATA_DIR`, and an unused `PORT`,
then launch the app with `--backend-url` pointing to it. The fixture starts no
pollers or agent hooks and uses no daily app data.

## Session workspace (M3, in progress)

**New Session** (Command-N) chooses a project, branch/base, agent, and optional page
URL. It creates or reuses a linked worktree and saves the session before opening its
native terminal. A newly created shell launches the chosen agent; reattaching a
running shell preserves its input. Restart requires confirmation and resumes a saved
agent conversation when its ID is known. Shell-only sessions launch no agent.

Context pages share persistent WebKit website storage and use a native page strip,
History, find bar, navigation, and AppKit split controls. Command-F finds in the page,
Command-brackets navigate, Shift-Command-brackets cycle pages, and Option-Command
plus/minus/zero zooms the page. Command-W closes a page while keeping its session;
with no page it hides the window. Page state is cached locally and synced to SQLite.
At most six remote views remain live; suspended pages reload when selected.

Run `bash macos/scripts/test-browser-ui.sh` for the isolated browser UI regression.
Remove Session previews affected sessions and asks separately before discarding
uncommitted/untracked work. Orphan folders are retained. Xcode-configured projects
offer Run Destination and a separate Build pane; Stop interrupts its build PTY.
PR/Jira URLs resolve branches and existing ticket worktrees in the creation sheet.
Existing saved web tabs and history seed native contexts; legacy file entries are
retained for the M5 document host. Terminal links and full session acceptance remain
under implementation; this does not close the M1 terminal acceptance gate.

## Native Dashboard (M4, in progress)

Overview renders native PR rows, CI/review states, labels, search, project filters,
and Mine/Review/Failing CI/Drafts filters. The review section retains open PRs already
commented on or approved, using `awaitingMyReview`; tray notifications keep the
strict requested-review classification. Snapshot reads and SSE drive updates; a
failed read retains the previous data and exposes Retry.

Opening a PR selects its existing session or creates a page-only context through
`POST /api/tabs`, which preserves other tabs and all existing editor state. The
context menu also opens the browser or copies the link. Agent usage uses the shared
native panel and refreshes once per minute while Overview is visible.
Project/Jira/board/settings/logs/workflow/git-action parity remains M4 work.

Project rows now show native Open/Merged/All PR lists and a Settings tab. **New Project**
opens a native creation sheet. Settings include workspace selection, GitHub remote
detection, Jira key/JQL, and IDE configuration. Unsaved edits survive snapshot refreshes
and reconnects. Deleting a project requires confirmation and retains its sessions,
workspace folders, and terminals. Jira, automation, and workflow tabs are still pending.

**Activity** (Command-3) is native, with category/error filters, search, copy, and
embedded PR opening. Clear Logs confirms the complete selected category, including
entries hidden by filters. Failed reads and clears keep the last available entries.

## Native tray and appearance (M2)

Click the menu-bar icon or **Reviews & Usage** in the window toolbar to open the
native popover. It shows pending review requests with CI status, saved Mine/Review/
Jira/Web tabs, and Claude/Codex usage. Review requests open in the browser and are
then marked opened; saved tabs select their owning native session or tab detail.
Embedded browser routing remains M3 work.

PRs refresh through snapshot APIs and SSE. Usage loads separately on opening or
refreshing the panel, retaining previous data on error. Appearance (System/Light/Dark)
and the selected usage agent persist to the existing backend settings database.
The menu-bar icon is bronze for pending reviews, blue for open work, and neutral
when idle. Escape or clicking outside closes the panel; Quit remains explicit.

For sample PRs/usage, add `TASKHUB_TRAY_FIXTURE=1` to the isolated fixture command.
This replaces usage reads with synthetic data; no credentials or usage CLIs are
accessed. Automated tests can hold usage with `TASKHUB_HOLD_USAGE=1` until the
fixture data directory contains `release-usage`, or create `fail-usage` to test
retention on failure. Usage includes reserve/over-pace indicators using the existing
five-hour session and seven-day weekly windows.

Native File/Edit/View/Go/Window menus are owned by AppKit. Copy/paste/undo follow
the focused responder. Command-1 opens Overview, Command-2 focuses the terminal,
Control-Command-S focuses the sidebar, and Control-Command-T reveals/focuses the
current terminal. Command-Q hides the window; only tray Quit tears down the app.
Terminal font zoom uses Command-plus/minus/zero without recreating its emulator.

## Notifications (M2)

The tray's **Notifications** section offers **Enable Notifications**, activity alerts,
and the review sound choice. Permission is requested only when you click Enable;
macOS notification denial and delivery errors are shown in the panel. System sound
authorization is respected. The default review chime is Glass; None disables it,
and an existing custom sound from backend settings is retained.

The first successful review snapshot seeds silently. New request timestamps trigger
one notification per PR and one sound per batch. Reviews already opened or merely
in the broader review group do not alert. Backend reconnects retain the seed.

Activity arriving over SSE appears as a native toast while the main window is focused,
otherwise as a macOS notification. Recent activity stays in the tray (latest 20 during
this app session), including when activity alerts are switched off. Clicking a PR
notification opens its validated URL in the browser and marks a review opened only
after browser acceptance. Other activity opens the native tray. Embedded navigation
and the complete Activity page are still pending.

Automated notification tests use an injected recorder: no real permission prompts,
notifications, or sounds. Real Notification Center permission/banner/click acceptance
remains an interactive check on the bundled app. Permission and the foreground
activity toast have been verified; automated OS banner inspection timed out.
For isolated manual checks, add `TASKHUB_NOTIFICATION_FIXTURE=1`, then write
`{"type":"activity"}` or `{"type":"review"}` to `notification-command.json` in the
fixture data directory. The fixture consumes that file and emits synthetic events.

## Build and run

From the repository root:

```bash
npm ci --ignore-scripts
npm run gen:swift-routes
xcodebuildmcp macos build --workspace-path macos/TaskHub.xcworkspace --scheme TaskHub --derived-data-path macos/.build/xcode --arch arm64
```

Choose one backend mode through the Xcode scheme's launch arguments or the launch
command's `--launch-args` option:

- Existing server: `--backend-url http://127.0.0.1:3000`. The server must include the
  new `/api/backend/health` endpoint. The native app never stops an external server.
- Development child: `--backend-root /absolute/path/to/repo --node-path /absolute/path/to/node`.
  Add `--backend-port 43187 --data-dir /absolute/path/to/isolated-data` to isolate it
  from your daily app. Node must be 22.12 or later.
- Bundled child: no backend arguments. The app expects the bundle resources below.
  It defaults to port 3000 and `~/Library/Application Support/TaskHub`, respecting
  `TASKHUB_DATA_DIR` or `--data-dir`.

A port conflict fails visibly; the app never kills by port or adopts a foreign process.
Window close and Command-Q hide the window. The menu-bar Quit stops an owned backend
and the native spike's PTYs/daemon, then exits. This also works after relaunch before
opening a terminal pane. Quit waits for PTY teardown; a failure keeps the app open
with an error so teardown can be retried.

## Native terminal spike (M1, in progress)

Build the standalone helper with `cargo build --manifest-path crates/taskhub-ptyd/Cargo.toml`.
For development, add `--ptyd-path /absolute/path/to/repo/crates/taskhub-ptyd/target/debug/taskhub-ptyd`
to the app's launch arguments; a bundled app uses `Contents/Helpers/taskhub-ptyd`.
Click **Open native terminal**. **Show terminal** hides drawing while retaining the
emulator and shell. **Reattach** creates a fresh connection/emulator for the same
spike shell, including after an app rebuild.

GhosttyTerminal is pinned to `Lakr233/libghostty-spm` **1.6.20260909**, revision
`7e45d27160f9b34aca9ca5c9820e9207482f9f04`, using its host-managed in-memory backend.
Socket I/O and output parsing run off the UI actor. Replay waits for actual parser
consumption before enabling input; output uses byte-counted flow-control watermarks.

The spike intentionally uses `taskhub-native-ptyd.sock` in the same private socket
directory convention as Tauri, and `ptyd-native-spike` under the selected data directory.
It does not attach to daily Tauri sessions. `--pty-socket` or `TASKHUB_PTYD_SOCK` can
override this; use a separate test socket because explicit Quit tears down the
connected daemon's sessions.

This is not yet a production terminal. Reattachment replays the existing 256 KiB
output tail. The updated helper reports truncation atomically with its sequence;
Swift refuses truncated history or an older helper without this field, preserving
the shell and showing an error. Full VT state restoration remains unimplemented.
Rebuilding the helper does not upgrade an already-running daemon; use an isolated
socket to test the new helper without ending an existing shell. Input transport
currently requires UTF-8; unsupported bytes fail visibly. Automatic reconnect,
full lifecycle coverage, links, workflow hooks, IME/mouse/selection checks, and the
ten-minute multi-session performance benchmark remain part of M1's acceptance gate.

## Local bundle smoke test

```bash
bash scripts/build-sidecar.sh
bash macos/scripts/bundle-backend.sh /absolute/path/to/TaskHub.app
xcodebuildmcp macos launch --json '{"appPath":"/absolute/path/to/TaskHub.app","launchArgs":["--backend-port","43187","--data-dir","/absolute/path/to/isolated-data"]}'
```

The bundle script includes the official Node executable, production npm dependencies,
server/shared code, and the standalone Rust PTY helper, then signs the local bundle
ad hoc. It runs after Xcode builds; repeat it when rebuilding the app. It currently
expects the arm64 sidecar from `scripts/build-sidecar.sh` (or `TASKHUB_NODE_SIDECAR`).
Use an absolute app path. This is a development bundle, not a notarized release.

Distribution is a direct Mac app without App Sandbox: TaskHub orchestrates local CLIs,
worktrees, and detached PTYs. Developer ID signing, hardened-runtime entitlements,
notarization, and Sparkle remain M6 work. The separate development bundle identifier
is `tv.accedo.taskhub.native`.

## Verify

```bash
npm run check:swift-routes
node --test --test-force-exit test/contracts.test.js test/swift-routes.test.js test/api.test.js
xcodebuildmcp swift-package test --package-path macos/TaskHubPackage
cargo test --offline --manifest-path crates/taskhub-ptyd/Cargo.toml
cargo check --offline --manifest-path src-tauri/Cargo.toml
xcodebuildmcp macos test --workspace-path macos/TaskHub.xcworkspace --scheme TaskHub --derived-data-path macos/.build/ui-tests --extra-args '-only-testing:TaskHubUITests'
```

Swift integration tests require Node, installed root dependencies, and the built
debug PTY helper above. They launch the
real Express routes with temporary data through `scripts/backend-fixture.cjs`; no
pollers, GitHub/Jira CLIs, or production databases are used. Tests cover route escaping,
bounded SSE framing, Unicode, API identity, snapshots, real SSE, and backend ownership.
Terminal tests use isolated sockets and temporary shell scripts; they never connect
to daily TaskHub sessions. Native surface tests create an unshown Metal-backed
AppKit window and verify Unicode, alternate-screen restoration, hidden parsing,
Enter encoding, and bracketed paste without touching the system clipboard.
The native pipeline test also races output against an attachment snapshot, rejects
duplicate sequences, and checks final parsed output before exit while hidden.
Additional regressions cover stale replies after timeouts, incompatible/malformed
peers, disconnects, multi-client pause ownership, real PTY history truncation, and
explicit Quit with no existing connection. `pty-protocol-fixture.cjs` provides a
temporary Unix-socket peer for error cases without launching any shell.

The daemon implementation now lives in `crates/taskhub-ptyd/src/lib.rs`. Tauri re-exports
the same crate; do not create a second implementation. M1 fixes its incremental
UTF-8 decoder so invalid input cannot stall later output, and allows the standalone
helper to detach when Foundation launches it as a process-group leader. Protocol 2
remains compatible. Screen restoration and the remaining fidelity/performance checks
must pass before we call the native terminal ready.
