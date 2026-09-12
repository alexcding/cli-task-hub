# TaskHub Native

Native macOS client under implementation. macOS 14+, Xcode 16.3+ and Swift 6.1+;
Apple silicon is the initial build target. Open `TaskHub.xcworkspace` in Xcode.

The app target owns AppKit lifecycle and hosts SwiftUI. `TaskHubPackage` holds the
API client, SSE parser/client, backend owner, observable store, and views. The current
screen has a Cocoa sidebar with project/session selection, Pinned mirrors, saved
Tabs, and native terminal panes. The Dashboard is still pending.
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
tabs currently offer external opening; the embedded viewer and agent launch/resume
workflows follow in M3. Sidebar implementation is authorized ahead of the remaining
M1 terminal acceptance checks, which are still open.

For an isolated sample hierarchy, run `macos/scripts/backend-fixture.cjs` with
`TASKHUB_SIDEBAR_FIXTURE=1`, an isolated `TASKHUB_DATA_DIR`, and an unused `PORT`,
then launch the app with `--backend-url` pointing to it. The fixture starts no
pollers or agent hooks and uses no daily app data.

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
