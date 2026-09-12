# TaskHub Native

Native macOS client under implementation. macOS 14+, Xcode 16.3+ and Swift 6.1+;
Apple silicon is the initial build target. Open `TaskHub.xcworkspace` in Xcode.

The app target owns AppKit lifecycle and hosts SwiftUI. `TaskHubPackage` holds the
API client, SSE parser/client, backend owner, observable store, and views. The current
screen is a connection/project-list foundation; the Dashboard and native terminal
are not implemented yet. See [the port plan](../docs/SWIFTUI-PORT.md).

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
and exits. Terminal teardown will be connected when M1 adds PTY sessions.

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

Swift integration tests require Node and installed root dependencies. They launch the
real Express routes with temporary data through `scripts/backend-fixture.cjs`; no
pollers, GitHub/Jira CLIs, or production databases are used. Tests cover route escaping,
bounded SSE framing, Unicode, API identity, snapshots, real SSE, and backend ownership.
The Rust test uses an isolated socket and never connects to daily TaskHub sessions.

The daemon implementation now lives in `crates/taskhub-ptyd/src/lib.rs`. Tauri re-exports
the same crate; do not create a second implementation. Its terminal behavior is unchanged
in this extraction. Input, rendering, screen restoration, and performance still require
M1's acceptance tests before we call the native terminal ready.
