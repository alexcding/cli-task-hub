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
Existing saved web/file tabs and history seed native contexts with one shared tab order. Terminal links and full session acceptance remain
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
Settings, automation, workflow, git actions, and complete parity acceptance remain M4 work.

Project rows now show native Open/Merged/All PR lists and a Settings tab. **New Project**
opens a native creation sheet. Settings include workspace selection, GitHub remote
detection, Jira key/JQL, and IDE configuration. Unsaved edits survive snapshot refreshes
and reconnects. Deleting a project requires confirmation and retains its sessions,
workspace folders, and terminals.

**Tickets** is native SwiftUI. It reads the project's cached Jira feed, with local
text/facet filtering and saved filter preferences. An explicit search accepts keywords,
a ticket key, or JQL; SSE refreshes the feed without repeating the search. Status menus
offer known workflow statuses, and rejected transitions retain the original row.
Successful moves remain visible across stale snapshots while the existing explicit
sync action refreshes Jira. Ticket links open native contexts, with browser/copy actions
in the context menu. Services, search/filter state, and mutations live in an injected
view model; site discovery does not block the ticket feed.

**Sprint Board** remains web-based for now. Its focused WebKit page reuses the existing
board's filters, moves, assignment menus, and drag implementation. Ticket links open
native context pages; Option-click opens the browser. The board receives invalidations
from native SSE and releases its webview when you leave the section. No full SPA or
web terminal is loaded. Drag-gesture acceptance remains pending.

**Activity** (Command-3) is native, with category/error filters, search, copy, and
embedded PR opening. Clear Logs confirms the complete selected category, including
entries hidden by filters. Failed reads and clears keep the last available entries.

**Settings** (Command-comma or sidebar) has native General and Connections sections.
General shares the tray's offline-safe theme/notification preferences, adds the full
macOS sound list and explicit preview, and persists the default agent for new sessions.
Connections edits polling intervals, Jira site, token, and ticket limit. Saves send
only changed fields and preserve drafts on failure/reconnect. Interval edits reschedule
only running backend loops; saving to a fixture does not start polling.
The **CLIs** section probes installed tools and sign-in state on demand, offers
installation guides and login-command copying, and installs/removes agent hooks.
Unknown authentication remains distinct from signed out. Hook edits reject malformed
configuration and preserve other commands, permissions, and dotfile symlinks.
Diagnostics, launch at login, fonts, git-client actions, and native memory-budget
policy still need their remaining Settings/parity increments.

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
python3 macos/scripts/build-ghostty-vt.py
python3 macos/scripts/build-ghostty-native.py
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

## Focused working diff (M5, in progress)

Select a session and choose **Show Changes**. The existing web diff renderer runs
inside the native split with syntax highlighting, file collapse, and untracked-file
listing. Native controls own refresh and error recovery; failed reads preserve the
last displayed patch. Hiding the pane or switching sessions releases its webview and
patch storage while retaining the session's terminal.

The focused page receives its snapshot from `DiffViewModel` through an injected
`DiffService`. It cannot fetch APIs or navigate remotely. Its only message handler
reports ready/error from that exact local main frame, and Swift waits for ready
before supplying the patch. `macos/web-assets.txt` includes the reused renderer,
parser/highlighter, styles, and shared dependencies for bundling.

This first diff increment is read-only. Monaco editing, save/conflict recovery,
dirty-close protection, file-tab migration, terminal file links, discard/commit,
and document shortcuts remain part of M5.

The shared editor save contract now uses `/api/file` revisions. Reads return an
opaque revision; saves must submit it and retain the returned revision for the next
save. A stale revision fails without replacing the observed newer file. Edits stage
beside the destination before rename, preserving macOS file metadata and symlinks.
Hard-linked files are read-only. The existing web editor now retains edits made while
a save is in flight; this contract will also back the native document lifecycle.

## Native terminal spike (M1, in progress)

Build the pinned runtimes using the commands above, then build the standalone
helper with `cargo build --manifest-path crates/taskhub-ptyd/Cargo.toml --features terminal-snapshots`.
For development, add `--ptyd-path /absolute/path/to/repo/crates/taskhub-ptyd/target/debug/taskhub-ptyd`
to the app's launch arguments; a bundled app uses `Contents/Helpers/taskhub-ptyd`.
Click **Open native terminal**. **Show terminal** hides drawing while retaining the
emulator and shell. **Reattach** creates a fresh connection/emulator for the same
spike shell, including after an app rebuild.

GhosttyTerminal uses the source-built local package generated from
`Lakr233/libghostty-spm` **1.6.20260909**, revision
`7e45d27160f9b34aca9ca5c9820e9207482f9f04`, with TaskHub's maintained snapshot and
ordered-grid patches. The source builder requires Apple's Metal compiler component.
Socket I/O and output parsing run off the UI actor. Replay waits for actual parser
consumption before enabling input; output uses byte-counted flow-control watermarks.
Native connections negotiate `dataEncoding: "base64"` in the protocol-2 hello.
PTY output, attachment history, and keyboard input preserve exact bytes through
JSON `bytes` fields. Ghostty owns decoding, including incomplete UTF-8 across the
replay/live boundary. Tauri clients keep their existing `chunk`/`buf` text protocol;
both representations share one output sequence. An old helper without byte support
is detected before the native pane creates or attaches a shell.

The spike intentionally uses `taskhub-native-ptyd.sock` in the same private socket
directory convention as Tauri, and `ptyd-native-spike` under the selected data directory.
It does not attach to daily Tauri sessions. `--pty-socket` or `TASKHUB_PTYD_SOCK` can
override this; use a separate test socket because explicit Quit tears down the
connected daemon's sessions.

This is not yet a production terminal. Attachment negotiates the exact snapshot
revision, downloads a bounded binary capture, imports it into a fresh native
surface, and drains newer output/resize events in daemon order before enabling
input. History beyond the old 256 KiB tail is retained. Incompatible helpers are
rejected before shell creation; invalid captures and sequence gaps stop attachment
without terminating the shell. The capture supplies its logical grid even if a
physical view resize is still pending. Restored titles and working directories use
native callbacks; only local working-directory URIs become file-link bases, and
an empty directory report clears the previous base. The versioned
`daemon-state-v1` response owner covers status/cursor, mode (except Kitty clipboard mode),
DECRQSS and Kitty keyboard queries keep working without a viewer. Newly created
shells now select `daemon-identity-v1`, adding DA/version/terminfo replies and using
`TERM=xterm-ghostty` with the actual renderer version. The daemon keeps a private
copy of bundled terminfo until the shell exits, independent of app relocation or
rebuild. Existing state-owned shells retain their original profile. Native surfaces
suppress the matching set after import/reconnect; keyboard, paste and UI effects
keep their native paths. Unsupported helpers/owners are rejected without replacement.
New sessions also retain the pinned package's shell integration scripts. Zsh's
bootstrap preserves user startup files and prompt hooks while publishing working
directory and command boundaries, so a cd updates native file-link destinations.
Non-Apple Bash uses Ghostty's ENV startup mechanism; Apple Bash and other unsupported
shells retain normal startup behavior. These scripts are never written into user
dotfiles. UI/config-dependent offline queries and snapshot-v1 image/glyph omissions
still require work; see `crates/taskhub-ptyd/SNAPSHOTS.md`.

The helper and native bridge now support optional `daemon-geometry-v1`; app-side
negotiation is still pending. Complete imported pixel geometry is retained, and
geometry-owned native surfaces can suppress size reports while applying ordered
cell/pixel updates. `InMemoryTerminalSession.enableGeometryCallbacks()` opts into
engine-ordered measurements including actual cell pixels; consumers must enqueue
work without re-entering the native surface and leave pixel-only resize suppression
disabled. The legacy callback has no cell metrics. Native tests cover backing-scale
rounding, pixel-only changes, split queries/reset and preserved title/input policy.

Rebuilding the helper does not upgrade an already-running daemon; use an isolated
socket to test the new helper without ending an existing shell. Broader
lifecycle coverage, links, workflow hooks, IME/mouse/selection checks, and the
ten-minute multi-session performance benchmark remain part of M1's acceptance gate.

An established terminal automatically reconnects after a transient transport loss
when all input has been acknowledged. It replaces the native surface and restores
the same terminal ID/PID from a fresh snapshot, using up to five attempts with
backoff. Reconnect never launches a replacement daemon or shell. Pending or failed
keyboard input, app-issued commands and interrupts require manual Reattach; bytes
are never replayed. Removing the pane cancels recovery and rejects stale callbacks.

## Native editor documents (M5, in progress)

Choose **Open File** (Command-O) from a session/page context. File tabs share the
native page strip and History; Monaco renders the editor, while Swift owns file I/O,
revision conflicts, and document lifecycle through injected services and factories.
Command-S saves, Command-F finds, and Command-W closes with Save/Discard/Cancel when
needed. Session removal and tray Quit check unsaved documents before stopping shells.
Hidden clean editors unload; unsaved editors retain their buffer and undo history.
Unsaved text is not persisted for crash recovery. Files must be UTF-8 text, at most
5 MB; hard-linked/unwritable files are read-only. Failed saves preserve edits.

The focused editor has no HTTP file API or remote navigation. Its scoped bridge
exchanges only the current document buffer and editor events. `web-assets.txt`
includes the shared Monaco loader, same-origin worker bootstrap, and vendored assets.
The sprint board remains web based; native diff actions and full terminal link parity are
still in progress.

## Local bundle smoke test

```bash
bash scripts/build-sidecar.sh
bash macos/scripts/bundle-backend.sh /absolute/path/to/TaskHub.app
xcodebuildmcp macos launch --json '{"appPath":"/absolute/path/to/TaskHub.app","launchArgs":["--backend-port","43187","--data-dir","/absolute/path/to/isolated-data"]}'
```

The bundle script includes the official Node executable, production npm dependencies,
server/shared code, focused web assets listed in `web-assets.txt`, and the standalone Rust PTY helper, then signs the local bundle
ad hoc. It runs after Xcode builds; repeat it when rebuilding the app. It currently
expects the arm64 sidecar from `scripts/build-sidecar.sh` (or `TASKHUB_NODE_SIDECAR`).
Use an absolute app path. This is a development bundle, not a notarized release.
Run `node macos/scripts/smoke-web-assets.cjs /absolute/path/TaskHub.app` from the repo
root to check all packaged board/diff/editor assets using the bundled Node helper and isolated data.

Distribution is a direct Mac app without App Sandbox: TaskHub orchestrates local CLIs,
worktrees, and detached PTYs. Developer ID signing, hardened-runtime entitlements,
notarization, and Sparkle remain M6 work. The separate development bundle identifier
is `tv.accedo.taskhub.native`.

## Verify

```bash
npm run check:swift-routes
node --test --test-force-exit test/contracts.test.js test/swift-routes.test.js test/api.test.js
xcodebuildmcp swift-package test --package-path macos/TaskHubPackage
cargo test --offline --manifest-path crates/taskhub-ptyd/Cargo.toml --features terminal-snapshots
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
duplicate sequences, completes a Unicode character split across that boundary, and
checks final parsed output before exit while hidden. A real PTY round-trips all 256
byte values with raw mode enabled, reattaches to identical bytes, and verifies that
incomplete UTF-8 is delivered immediately. Rust integration tests attach native byte
and legacy text clients to the same PTY, checking invalid input, split codepoints,
both attachment formats, shared sequences, and continued legacy input support.
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


Diff Open File and current-file line buttons now open native editor tabs, as do
Ghostty-activated local-file links. Web links open in the owning workspace, and the
standalone terminal supports the same split context pane as session terminals.
Line/column locations survive document loading. Diff paths stay within the
canonical worktree; terminal relative links use the current working directory.
Plain printed file-path detection and Option-click external routing remain open.


Changes → **Commit and Push…** opens native commit controls. Commit stages all
tracked changes, optionally includes untracked files, and uses the existing Git
signing/hooks. A failed push preserves the successful local commit and offers
Push without repeating Commit. Failed commit drafts survive; failed refreshes
disable actions until disk state is loaded again. Quit waits for running Git
operations. The focused web diff itself continues to render the patch.


Working diff blocks also offer **Discard**. A native sheet previews the exact patch
before **Discard Block**; Cancel makes no changes. The backend verifies the reviewed
diff revision again when applying, so stale confirmations ask for refresh and review.
Failed operations retain their error and proposal. Block selection is typed and
scoped to the originating worktree; the renderer never submits arbitrary patches.
