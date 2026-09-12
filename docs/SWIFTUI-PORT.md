# SwiftUI Native Port — plan

Porting the TaskHub desktop client from a Tauri-hosted web renderer to a **native
macOS app (SwiftUI + AppKit where needed)**, with the terminal on **libghostty**.
Diff and code editing may remain web-based, embedded as focused `WKWebView` views.
The sprint board also remains web-based for now (user decision, 2026-09-12), hosted
as a focused board page inside the native project view. Native board rewriting is
deferred; existing board filtering, drag/drop, status, and assignment behavior stays.
The terminal is the first correctness gate, before the broader page rewrite.
Branch: `feat/swiftui-native`. Worktree: `../cli-task-hub-swiftui`.

## Final architecture pass (user requested)

After completing the migration phases, inspect the SwiftUI coordinator pattern in
`/Users/accedo/Workspace/elevate-ios` and apply the equivalent macOS structure here.
Coordinators own navigation, view models own business logic, and views render state
and forward user actions. Construct dependencies through DI and factories, with
replaceable services for tests. This is required follow-up work, not the optional
backend rewrite. Preserve AppKit sidebar and terminal ownership during the refactor.

## Implementation status

M0 foundation is committed as `bf0c7a6`; the M1 terminal spike is committed as
`c05a57a`; the M2 Cocoa sidebar is committed as `609d889` and native tray/appearance
as `5cf368a`; native menus/notifications are committed as `9d34f2b`.
Session workspace and terminal acceptance work continue in `macos/`
(see `macos/README.md` for commands).
The checked-in Xcode workspace uses a local Swift package, Swift 6, macOS 14 minimum,
and direct distribution without App Sandbox. Overview now renders the native
Dashboard; the remaining app pages and action parity are tracked under M4.

- Implemented: generated Swift routes with drift check, typed project API, backend
  identity/readiness endpoint, external/owned backend modes, bounded SSE parsing,
  snapshot refresh on reconnect, and a native window/menu-bar lifecycle.
- Extracted: `crates/taskhub-ptyd` is the shared daemon implementation for Tauri and
  the standalone helper. The extraction preserved protocol and terminal behavior;
  subsequent M1 corrections are recorded below.
- Added: isolated backend integration tests and daemon protocol/reconnect test;
  local bundling script for Node, production dependencies, and the daemon.
- Verified: native arm64 build, 6 Swift tests (including real API/SSE and ownership),
  32 Node API/contract tests, 1 isolated daemon protocol test, 1 native UI launch test,
  and the bundled app visibly connected to its own backend on an isolated port/data
  directory. The existing Tauri host still passes `cargo check` (existing vendor warnings).
- Started M1: pinned native Ghostty surface, Swift Unix-socket client, bounded output
  pipeline, replay sequence handling, hidden output parsing, and same-shell reattach.
  M0 data migration/rollback beyond preserving the existing
  data-directory convention remains unverified; release signing/notarization is M6.

### M1 progress — 2026-09-11 (acceptance gate not passed)

- Dependency: `Lakr233/libghostty-spm` **1.6.20260909**, revision
  `7e45d27160f9b34aca9ca5c9820e9207482f9f04`, `GhosttyTerminal` host-managed backend.
- Implemented: native Metal surface; off-main socket framing/output parsing; 1 MiB
  pause / 256 KiB resume watermarks and an 8 MiB output hard limit; sequence-bounded
  replay with a parser drain fence suppressing historical writeback; grid resize;
  parsed viewport reads; manual reattach and hidden/occluded drawing control.
- Fixed shared daemon UTF-8 decoding so split codepoints survive and invalid bytes
  cannot stall subsequent output. The standalone executable now detaches correctly
  from Foundation's process-group-leader launch. Protocol 2 remains unchanged.
- Isolation: spike uses its own `taskhub-native-ptyd.sock` and data subdirectory;
  development does not adopt existing Tauri terminals.
- Hardened flow ownership: each client's pause survives other viewers attaching,
  resuming, or disconnecting. Only its owner releasing/disconnecting removes it.
- Added an optional `truncated` flag to protocol 2 attachment responses, sampled
  under the same ring lock as the sequence boundary. Swift refuses an incomplete
  tail or a helper without this flag; it preserves the running shell and explains
  the failure. This detects unsafe restoration; it does not implement a VT snapshot.
- Hardened transport/lifecycle: one connected generation per Swift client, only
  absent/refused sockets permit helper startup, stale timed-out replies are ignored,
  and explicit Quit reconnects independently of any pane, waits for PTY reaping,
  then terminates the verified helper. A shutdown failure keeps the app open.
- Evidence: native arm64 app built and visibly ran an interactive shell. Thirteen Swift
  tests pass, including real daemon reconnect to the same shell PID, disconnect while
  paused, Unicode, fragmented framing, and real hidden Ghostty parsing/alternate-screen/
  Enter/bracketed-paste checks. Added timeout/mismatch/malformed-peer tests, multi-client
  pause ownership, a 390 KB real PTY history-truncation check, and Quit after relaunch
  with a live shell. Five Rust tests pass; existing Tauri `cargo check`
  passes with its existing vendor warnings. These are functional checks, not a
  performance result.
- Added a real Ghostty/TerminalPipe regression for output buffered during attach:
  replay includes sequence 1, sequence 2 races the reply, a duplicate is discarded,
  and final output is parsed before the exit callback. The test runs with the native
  surface hidden. It covers the Swift pipeline boundary, not all daemon exit races.
- Still open: complete VT restoration after ring truncation (the 256 KiB tail is not
  sufficient), automatic reconnect and full lifecycle/race
  coverage, IME/mouse/selection/scrollback/display
  testing, file/URL routing and workflow hooks, sustained flood/isolation tests, and
  the ten-minute one-active/nine-hidden benchmark with recorded hardware and metrics.
  The user has authorized starting M2 with the Cocoa sidebar while these M1
  acceptance items remain open; this does not mark the terminal gate complete.

### M1 byte transport — 2026-09-12

- Native connections negotiate base64 byte transport through the existing protocol-2
  hello. Exact PTY bytes now reach Ghostty and exact keyboard bytes reach the PTY;
  the native path no longer converts output to text or rejects non-UTF-8 input.
  JSON framing stays bounded, and decoding/flow accounting remain off the UI actor.
- Legacy Tauri connections retain their incremental UTF-8 text events and attachment
  format. Native and legacy clients share sequence boundaries; each output format
  is encoded once per broadcast. The ring retains both representations under a
  bounded budget and reports truncation even when invalid-byte expansion fills it.
- The native pane detects helpers without byte support before creating/attaching a
  terminal. Running shells are preserved; rebuilding a binary does not replace its
  already-running daemon. Control connections remain compatible for explicit Quit.
- Verification covers every byte value through a real raw PTY, incomplete UTF-8
  delivered before its continuation, exact attachment history, legacy/native clients
  on the same PTY, malformed base64 rejection, and real hidden Ghostty parsing of a
  Unicode character split between replay and live events. The test fixture's stty
  path was corrected to `/bin/stty` and now fails immediately if raw mode setup fails.
- The native app builds, all 48 Swift package tests and seven Rust tests pass, and
  the existing Tauri host passes `cargo check` with its existing vendor warnings.
- Full VT restoration after truncated history remains open. The pinned Ghostty
  embedding package does not expose a complete terminal-state serialization API;
  a text or ANSI viewport export is insufficient evidence of full restoration.

### M2 native shell — AppKit/Cocoa (implemented; OS notification acceptance open)

- User decision: implement the sidebar with `NSOutlineView`, using AppKit's native
  row reuse, disclosure controls, keyboard selection, and context menus. SwiftUI
  hosts the outline through `NSViewRepresentable` and continues to own app pages.
- Reads projects, durable task sessions, and saved tabs through snapshot APIs.
  Sessions remain ordered oldest first; Pinned adds mirrors without moving the
  original row; task-owned URLs are excluded from Tabs; orphan sessions stay visible.
- Stable outline nodes retain selection, scroll position, and expansion across
  refreshes. Selection and collapsed groups persist across app launches.
- Pin/unpin uses a scoped `PATCH /api/tasks/:id/pin` so other session columns cannot
  be overwritten. Task mutations publish an SSE invalidation; no CLI is called.
  Native context menus also expose Reveal in Finder, Copy Path/Link, and browser opening.
- Opened session terminals are cached by task identity and remain mounted when
  switching rows. Hidden surfaces stop drawing and continue parsing; pinned and
  original rows select the same emulator. Opening a terminal starts a shell in the
  saved worktree, without automatically launching an agent or changing its resume ID.
- Verified: native app build, 15 Swift tests, 32 Node contract/API tests, and one
  native UI test pass. A running sample-data app verified the Cocoa context menu,
  pin/unpin mirrors, same shell PID/output across project/pinned selection, and
  output produced while its terminal was hidden. This is functional evidence;
  the sustained terminal performance benchmark remains open.
- Added native tray: an AppKit `NSStatusItem` opens an `NSPopover` hosting SwiftUI
  review rows, grouped saved tabs, and a live usage view. No bitmap-rendered usage
  row is used. Pending reviews use strict `category == review` plus `reviewPending`;
  saved GitHub tabs use the broader `awaitingMyReview` grouping. Opening a pending
  review in the browser acknowledges it only after the browser accepts the URL.
- Usage loads independently of PR snapshots and retains the last successful value
  on error. The panel shows Claude/Codex token totals, cost, session/weekly/model
  limits, reset timestamps, and freshness. Opening it triggers a cached API read;
  no per-frame polling or CLI calls are added to the native client.
- System/Light/Dark appearance and usage-agent preferences are backed by existing
  SQLite settings with a native startup cache. Writes are serialized; a stale read
  cannot override a newer local choice. Offline/failed writes remain queued locally
  and retry on backend reconnect. Settings/review mutations publish SSE
  invalidations. The status icon uses bronze for pending reviews, blue for open work.
- Tray verification: 17 Swift tests and 32 Node tests pass; two native UI tests
  cover sidebar recovery and opening/dismissing the tray while offline. Integration
  tests block usage while PRs load, retain usage on failure, acknowledge a review,
  and persist rapid/offline preference changes. The latest app built and ran with
  the native PR/usage popover visibly populated by isolated sample data.
- Added native notifications through `UNUserNotificationCenter`. First successful
  PR snapshot seeds silently; later strict review requests alert once per request
  timestamp. Failed reads do not reset the seed; reconnect retains it. One selected
  review sound plays per batch, respecting OS sound authorization and the None setting.
  Existing custom `reviewSound` paths are retained; the native picker currently offers
  default Glass/None plus the existing custom selection.
- Typed SSE activity events route to an eight-second native toast when the main
  window is key, or an OS notification otherwise. The delegate rechecks focus before
  foreground presentation. Identical timestamped events are deduplicated in a bounded
  cache; the tray retains the latest 20 activity entries for the current app session.
  The existing `activityNotify` preference controls alerts, not recent-history capture.
- Notification permission is requested only through **Enable Notifications** in the
  tray. Denial and delivery errors are visible. Activity/review-sound preferences use
  the same offline-safe settings persistence as appearance. Notification clicks open
  validated HTTP(S) URLs; review clicks acknowledge after browser acceptance, while
  a click received before backend readiness queues its acknowledgement. Non-URL
  activity opens the native tray. Embedded routing/full Activity page remain
  later milestones. Real OS permission/banner/click behavior still needs an interactive
  acceptance pass; automated delivery tests use a recorder and never prompt or chime.
- Verification: native arm64 build and both native UI tests pass. The Swift package
  suite now passes 23 tests, including review seeding/re-request/deduplication, permission
  denial, one sound per batch, OS sound disablement, delivery errors, activity focus
  routing, bounded recent events, safe URLs, offline notification preferences, and
  the native terminal attach/exit parser test described above.
- AppKit now owns the application entry point and lifecycle directly. The former
  dummy SwiftUI Settings scene replaced native menus after launch; removing it fixes
  that ownership conflict. SwiftUI continues to render hosted app pages. Native File,
  Edit, View, Go, and Window menus route editing through the responder chain; focus,
  overview/terminal navigation, refresh, font zoom, and hide/reopen have native shortcuts.
- Usage includes the existing five-hour/session and seven-day/weekly pace calculation,
  updated once a minute while the view is active. Explicit terminal focus reveals a
  hidden surface without starting a replacement shell.
- Shell acceptance: all 23 package tests and three native UI tests pass. The new UI
  test verifies menu presence/navigation and Command-Q hide without process termination.
  The latest app visibly shows the full AppKit menu bar and usage pace values. macOS
  notification permission was granted and the native foreground activity toast was
  verified with synthetic SSE data. Automated access to the transient OS notification
  banner timed out; background banner/click and audible sound acceptance remain open.
- Remaining M1 terminal gates continue to apply. Browser/document-specific shortcuts
  join the native menus with their M3/M5 surfaces; native Settings replaces the tray
  preferences shortcut in M4. Embedded context pages and session lifecycle are M3.

### M3 session workspace — in progress

- Added per-session and page-only contexts, one ordered page strip, bounded History,
  native navigation/find/zoom controls, popup tabs, and persistent WebKit cookies.
  Remote pages receive no host script or local-document capabilities. Unsafe schemes
  and credential-bearing addresses are rejected. Web process failures expose Reload.
- Remote view retention is bounded to six live WKWebViews using least-recently-used
  eviction. Eviction retains page URL/title/history and reloads on selection; terminal
  emulators remain mounted separately. This is a count bound, not a measured RSS bound.
- Page state uses `native.context.<identity>` settings with serialized writes and an
  atomic local recovery copy. Offline changes survive relaunch and retry on reconnect.
  Build pane selection is intentionally ephemeral. Existing web-renderer tab links
  and document history still need migration into this native context representation.
- New Session creates/reuses a linked worktree through existing local-git APIs, then
  persists a durable task. The native sheet chooses project, branch/base, optional
  context URL, and Shell/Claude/Codex. Failed record persistence keeps and identifies
  the created worktree for recovery. No replacement/force deletion is implicit.
- Agent launch happens only for a newly created shell. Claude IDs are saved before
  launch; restarts use the exact saved Claude/Codex ID. Existing shell attachment
  never types a launch command. Agent hook SSE matches the daemon run ID; scoped
  metadata PATCH preserves pin/worktree fields when saving agent conversation IDs.
  CLI argument verification used installed help and the official
  [Codex resume reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-resume).
- Restart confirms interruption, targets only the session's paired shell, and waits
  for daemon reaping. Other paired and scratch shells remain alive. Session removal
  and isolated build terminals remain the next increment.
- Native menus include New Session, page close/find/back/forward/cycle/zoom. Closing
  the last page keeps its session; closing with no page hides the window. AppKit now
  owns inner split collapse and window size; interactive tests caught and drove fixes
  for recursive constraints in the earlier nested SwiftUI split implementation.
- Verification so far: 26 Swift package tests, 28 backend API tests, generated-route
  drift check, and native app build pass. Tests exercise real worktree creation,
  metadata preservation, targeted PTY stop, navigation/find/cookies, page persistence,
  offline recovery, and bounded live view retention. Browser UI regression runs with
  `bash macos/scripts/test-browser-ui.sh` against an isolated external fixture because
  the XCUITest runner cannot bind its own server socket.
  The browser UI test now passes find, navigation, last-page close without terminating
  the session/window, and the native New Session sheet. Xcode reports an internal
  UI-runner QoS warning; no app crash remains in this exercised flow.
- Added removal with a native preview of all sessions sharing the worktree and open
  file holders. Default deletion refuses dirty worktrees; explicit discard warns
  about uncommitted/untracked loss and Xcode close-without-saving. Orphan sessions
  can be forgotten without deleting their folders. Session-set changes invalidate
  an open preview; targeted PTYs are reaped before folder deletion. Failed deletion
  retains recoverable records. Canonical path comparison fixes macOS `/var` versus
  `/private/var` worktree ownership checks without permitting foreign-folder deletion.
- Added Xcode scheme/simulator selection and project destination persistence. Run
  uses a distinct paired `build:<context URL>` PTY and a single foreground shell group
  for build/install/launch. Repeated Run is coalesced; an existing foreground build is
  adopted without typing; Stop interrupts only that build terminal. AppKit retains
  separate browser, agent, and build hosts while changing pane visibility. Removal
  invalidates pending builds before stopping their terminals.
- Latest verification: 28 package tests and 28 backend API tests pass. Added real
  dirty/shared/orphan removal checks, injected build-terminal coalescing/Stop tests,
  and shell syntax/quoting checks. The native browser UI regression also verifies
  Forget Session removes the record and retains its folder. A real Xcode simulator
  build/launch and build reattachment still need interactive acceptance.
- Added PR/Jira-aware creation through an injected NewSessionViewModel. PR lookup
  checks repository ownership and resolves the head branch; Jira resolves ticket
  summaries and reuses matching linked worktrees after revalidation. Lookup failures
  retain the context URL for manual branch entry. Views render state and forward actions.
- Import existing saved web tabs, active selection, pane visibility, and web history
  when no native context exists. File entries/history are preserved for the M5 document
  host. Session terminals occupy the primary pane; hiding context leaves the agent
  visible, while build mode shows the separate agent and build terminals together.
- Latest verification: 31 package tests and the browser UI regression pass, including
  PR creation, Jira worktree reuse, legacy tab import, and the native creation sheet.
- Still open: terminal link routing, legacy file-tab presentation, full login/popup acceptance,
  and the complete end-to-end session acceptance gate. M1/M2 acceptance gaps remain.

### M4 native app pages — in progress

- Native Dashboard replaces the foundation placeholder with PR rows, CI/review
  states, label/ticket metadata, search, project filtering, and Mine/Review/Failing
  CI/Drafts filters. Review grouping uses `awaitingMyReview` with legacy fallback;
  tray notification semantics remain unchanged. An injected service and view model
  own loading, filtering, actions, errors, and retained stale snapshots.
- Snapshot reads refresh through SSE with coalesced requests. Usage loads independently
  and uses a shared native panel with one-minute visible-page refresh. Failed reads
  retain prior results and expose retry. No new CLI call is added to a read handler.
- Opening a PR selects its session or persists a page-only tab. A new scoped
  `POST /api/tabs` transaction preserves all existing tab/document metadata and ordering
  instead of replacing the tab set from a partial native model. Existing tabs are
  activated without overwriting their saved editor state. Browser/copy actions are native.
- Verification: 33 package tests and 29 backend API tests pass, including review orbit,
  queued CI, filters, failure recovery, and preserving file tabs during page opening.
  All five native UI tests pass, including dashboard search/open and the existing
  browser/menu/offline/tray flows. Xcode still reports its internal runner QoS warning.
- Still open: remaining project/Jira/board/settings/logs/automation/workflow/git actions,
  dashboard Jira-link/session actions, and complete parity acceptance. M1–M3 gates remain.
- Added native project pages with Open/Merged/All PR selection and search, including
  other authors' PRs. Late responses cannot replace a newer state filter. Open lists
  continue reading snapshots; Merged/All use the existing explicit on-demand API.
- Native project creation/settings cover name, folder picker, repository detection,
  Jira key/JQL, IDE preset/custom template, and relative launch target. Injected
  services and factories construct editor/page view models. Dirty drafts survive
  refreshes and reconnects; failed writes retain them. Form saves preserve automation,
  workflows, and run destinations by sending only the form's owned fields.
- Deletion confirms the actual backend behavior: removes project configuration and
  PR/Jira links, keeps folders, sessions, and running PTYs. Cancel leaves the project.
  Package verification now passes 36 tests. The five existing native UI tests pass;
  the new create/edit/cancel-delete/confirmed-delete UI flow passes after scoping its
  alert controls to avoid duplicate Touch Bar accessibility matches.
- Added native Activity/Logs in the Cocoa sidebar and Go menu (Command-3), with
  category/error filters, local search, readable event details, raw fallback payloads,
  PR context links, and copy. JSON/event interpretation happens during off-main API
  decoding. Failed reads preserve the matching scope's last snapshot. Non-URL activity
  notification clicks now open this page.
- Clearing logs captures and confirms the category, explicitly covering entries
  hidden by search/error filtering. Failed deletion retains entries; pre-deletion reads
  cannot reinsert cleared rows. The 36-test package suite passed after page wiring;
  both new log tests and the native filter/cancel-clear/confirmed-clear UI test pass.
  Jira ticket links and the rest of the M4 action inventory remain open.
- User scope change: the sprint board remains web-based for now. Project's Sprint
  Board section embeds `/native/board.html`, reusing the existing board renderer,
  Sortable drag implementation, filters, status/assignment menus, and optimistic moves.
  The entry point does not start the full SPA, Tauri bridge, or web terminal.
- The WebKit host accepts only bounded ticket-link messages from its exact main
  document. Ticket links open native contexts; Option-click uses the browser. Remote
  navigation is blocked in the privileged board host. The native SSE connection
  forwards invalidations, and leaving the board releases its webview.
- Verification: the 38-test package suite passed during integration; the added bridge
  test passes with the corrected current WebKit delegate signature. Native UI testing
  passes rejected/successful moves, assignment, ticket routing, and returning to the
  board, including shared-SSE wiring and configured sprint columns. A visual check
  confirms the embedded board fits the native project pane. Drag gestures still need
  interactive acceptance; their existing implementation is reused without changes.
- `macos/web-assets.txt` lists the focused board dependencies. The manifest test and
  three shared route-contract tests pass. A copied development app bundles and signs
  successfully; its own Node helper serves all 19 board/shared assets in an isolated
  HTTP smoke test, with the full SPA absent. Bundling now runs `npm ci` inside the
  copied package, avoiding the observed `--prefix` installation failure.
- Added a native project Tickets section with snapshot/SSE loading, saved faceted
  filters, local text filtering, and explicit keyword/key/JQL search. Swift query
  interpretation mirrors the shared web helper. Search generations reject late
  responses and clearing restores the feed; SSE does not reissue live searches.
- Injected Jira services and a view model own discovery, filtering, search, links,
  and mutations. Site discovery is independent of snapshot rendering. Status changes
  are coalesced per ticket; rejection keeps the old state, while successful changes
  overlay stale snapshots until confirmation or a five-minute expiry. Only successful
  user mutations trigger the existing explicit sync action. Remote ticket contexts
  receive no local-document bridge. Filter writes are serialized and retryable.
- Jira verification: four Swift tests pass for query parity, search races, retained
  stale data, faceted preferences, rejected/coalesced moves, overlay expiry, and safe
  links. The native UI test passes ticket rendering without a webview, rejected and
  successful moves, key search/clear, and embedded ticket opening. Three shared JQL
  tests and the focused web-asset manifest test also pass. Full Jira parity and the
  remaining M4 actions are still tracked separately.
- Added native General/Connections Settings through the Cocoa sidebar and Command-comma.
  Reuses offline-safe appearance/notification persistence, loads the full sound list
  with explicit preview, and honors the saved default agent in new-session sheets.
  Config validation covers intervals, ticket limit, and safe Jira site URLs; token
  input is secure. Saving patches only changed fields and preserves unsaved/newer edits.
- Backend interval edits now reschedule existing PR/Jira loops without starting loops
  in an idle/read-only backend. Config changes emit an SSE invalidation. Native Jira
  site discovery is invalidated after a native site/token save. CLI/hooks, diagnostics,
  login items, fonts, git-client actions, and the native memory policy remain open.
- Settings verification: all 45 Swift package tests and all ten native UI scenarios
  pass, including config validation/save/revert, preserving edits across navigation,
  persisted default-agent choice, and existing board/Jira/project/menu/tray flows.
  The 38 backend API/poller/route tests pass; the interval ownership regression also
  passes after adding the one-day timer ceiling. Xcode's existing internal UI-runner
  QoS warnings remain; no application failure was reported in these scenarios.
- Native Settings now includes CLI presence/authentication checks, installation-guide
  links, login-command copying, and Claude/Codex hook install/remove. Probes run only
  on visiting CLIs or an explicit recheck; hook reads are independent of slow probes.
  Mutations are serialized and stale status reads cannot undo a completed edit.
- Hardened the shared hook service: malformed/unsupported configs are rejected,
  other commands in mixed hook entries survive install/remove, atomic writes retain
  private permissions and dotfile symlinks, and quoted data-directory paths remain
  literal in the hook shell command. These changes benefit both native and web clients.
- CLI/hook verification: two new Swift tests, 17 Node hook/CLI/route tests, and the
  native installation/rejection/removal UI flow pass. Node tests exercise real file
  installation/removal in an isolated directory and stdin forwarding through a fake
  curl command; native UI uses synthetic hook state. No daily agent config was edited.

Companion docs: `ARCHITECTURE.md` (layers, HTTP-vs-IPC split), `TAURI-PORT.md`
(the previous shell port — the same boundary makes this one tractable), `CLAUDE.md`
(renderer conventions; the product rules there survive the port even though the code
does not).

### M5 focused documents — working diff started (2026-09-12)

- Session **Show Changes** opens the existing highlighted diff renderer inside the
  native split. Swift owns the worktree identity, snapshot load, refresh, errors,
  appearance, and webview lifetime through an injected `DiffService` and view model.
  This increment is read-only; editor/save/discard actions remain below.
- The focused `/native/diff.html` receives data from Swift. Its CSP forbids network
  requests, and it has no file/terminal bridge. A narrowly scoped, main-frame status
  bridge reports renderer readiness/errors; remote navigation is refused. Native
  rendering waits for module readiness, not just WebKit navigation completion.
- Coalesced refreshes retain the last successful diff on error and reject stale
  responses after hiding or reconnecting. Hidden/inactive diff panes release their
  webview and patch storage; terminal emulators remain mounted independently.
  Existing file/line render caps are preserved, and untracked rows are capped at 200.
- Verification: all 49 Swift tests and 17 diff parser/highlighter tests pass. Native
  UI covers highlighted content, collapse/expand, failed/successful refresh, and
  hiding the surface; the existing browser find/navigation/close/session flow also
  passes with the shared split. The bundled backend serves all 26 board/diff dependencies and
  rejects the full SPA entry point. The bundle is still a development smoke artifact.
- Remaining M5: Monaco editor, document identity/order/history migration, typed
  editing/save bridge, save failure/conflict and dirty close/eviction protection,
  terminal file links, discard/commit actions, and document find/save shortcuts.
  Full M1 restoration and the remaining M3/M4/M6 gates continue to apply.

### M5 save contract — 2026-09-12

- `/api/file` now returns a revision tied to canonical file identity, metadata and
  content. PUT requires that revision, serializes writes to the same canonical path,
  stages edits beside the file, rechecks the revision, then atomically replaces it.
  Missing revisions return 428; observed disk changes return 409. Uncoordinated
  external writers can still race the final filesystem check/rename; this is
  optimistic conflict detection, not an OS-level compare-and-swap.
- Staging preserves macOS permissions, ACLs and extended attributes with `cp -p`;
  symlinks continue to target the same canonical file. Hard-linked files are read-only
  so a save cannot silently split their aliases. File reads/writes remain bounded to
  5 MB and reject binary/invalid text. Failed staging leaves the original intact.
- The shared Monaco save helper records the submitted model version before awaiting
  I/O. Edits made during a save stay dirty, undo back to the submitted version becomes
  clean, and failures preserve both edits and the old revision. Duplicate saves are
  coalesced. Export preserves BOM and the model's line endings; the API was checked
  against the vendored Monaco code and its [official reference](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.ICodeEditor.html#getValue).
- Verification: 38 API/filesystem/editor-save tests pass, covering revision conflicts,
  concurrent saves, permissions/xattrs, symlink retargeting, hard links, write/rename
  failures, bounded UTF-8 reads, submitted-version tracking and remote-origin rejection.
  Native document tabs and their typed edit/save/close bridge are the next increment.

### M5 native editor documents — 2026-09-12

- Local files and remote pages now share one native tab order, active selection, and
  History. New imports preserve interleaved web/file links and active files. Older
  native snapshots without order metadata retain their existing page order and append
  preserved file records; the previous format did not store their original positions.
  Paths and tab metadata persist, never file contents. Closed files do not resurrect
  from legacy metadata. File-URL entries also import without remote navigation.
- **Open File** (Command-O) uses a native picker. Swift owns each document identity,
  revision, loading/save errors, and service/factory injection. The render-only SwiftUI
  document view hosts a focused Monaco surface with typed buffer/save/status messages.
  Remote browser pages never receive the editor bridge; the editor cannot call HTTP
  APIs, choose paths, or navigate away. Native Command-S saves and Command-F finds.
- Saves coalesce and acknowledge only the submitted Monaco version, retaining later
  edits and conflicts. Close freezes and queries the current buffer before native
  Save/Discard/Cancel; cancel and failed saves retain edits. Session removal checks
  affected documents across contexts before stopping shells. Tray Quit checks all
  documents before stopping any terminal/backend, including files opened while a
  confirmation awaited. Window close/Command-Q continue to hide the running app.
- Hidden clean editors release their webviews after checking the current buffer;
  dirty editors retain the buffer/undo stack. Backend preference restoration finishes
  before editors become interactive. A crashed editor cannot silently close from a
  stale clean flag; it requires explicit discard. Crash recovery of unsaved text is
  still not provided, and dirty buffers are not an on-disk draft store.
- The shared Monaco loader is independent of SPA stores. A same-origin worker
  bootstrap replaces data-URL workers, which failed under the focused WebKit CSP.
  Packaged assets include the vendored editor, language grammars, workers and fonts.
- Verification: 54 native tests pass, including real WebKit/Monaco file saves with
  BOM/CRLF preservation, external-write conflict retention, rejected remote navigation,
  concurrent-save coalescing, last-keystroke close/cancel, clean/dirty eviction, and
  interleaved tab/history restoration. The existing eight filesystem/web-save tests
  also pass. The packaged backend serves all 125 focused assets and rejects the full
  SPA entry point. Direct native UI verification covers the picker, typing, Command-S,
  Cancel/Discard, and reopening saved content from History. XCUITest's synthetic
  confirmation stalled in the system picker, so the repeatable editor regression uses
  a saved file-tab fixture and passes save/cancel/discard/History; the picker was
  verified separately through native controls. The existing browser navigation/find/
  close/new-session UI regression also passes (its existing Xcode QoS warning remains).
- Remaining M5 work includes terminal/diff file-and-line routing, diff discard/commit
  actions, and wider shortcut/focus/IME acceptance. The sprint board remains web based;
  M1 fidelity/performance, remaining M3/M4/M6 gates, and the final coordinator/VM/DI
  alignment with elevate-ios remain open.

### M5 document locations — 2026-09-12

- Focused diffs expose Open File and current-file line buttons; deleted lines and
  binary/deleted files do not offer a misleading current-file location. Untracked
  files open through the same native document lifecycle. The scoped main-document
  message resolves paths under the canonical worktree and rejects traversal and
  symlink escapes. Resolution runs off the main actor and stale replies are ignored.
- Terminal links activated by Ghostty route into their owning session's native
  web/file tabs, including the independent build terminal. The standalone terminal
  now has a workspace context and split pane, retaining its mounted emulator.
  Reattachment preserves the link destination. Local file URLs, percent-encoded
  names, line/column suffixes and L/C fragments are supported; relative locations
  use the last valid terminal working directory, falling back to the session cwd.
  Unsupported schemes are refused without invoking Ghostty's external-open fallback.
- A platform-view factory adapter forwards all callbacks used by TerminalViewState,
  including lifecycle, input-related requests, clipboard confirmation and working
  directory. The pinned package exposes the URL delegate but its SwiftUI state
  does not adopt it. No dependency checkout changes or replacement input path.
- Editor locations survive asynchronous loading and select an existing file tab
  without creating a duplicate. Web surfaces remain renderers; native owners choose
  paths and perform file I/O.
- Verification: 58 native tests pass. The real Metal-backed Ghostty regression now
  uses the host adapter and verifies an OSC 8 link through actual mouse hit testing
  and the native callback, alongside hidden Unicode/alternate-screen parsing, key
  encoding, bracketed paste and attach deduplication. Path tests cover URI refusal,
  encoded filenames, invalid positions and canonical worktree containment. The diff
  UI regression passes collapse, failed-refresh recovery, opening a changed-file
  line into Monaco, and opening an untracked file.
- Still open: automatic detection of plain printed file paths, Option-click external
  browser routing, broader terminal link/focus/IME acceptance, and diff mutations.
  Ghostty's documented custom link-regex configuration is not currently settable;
  handling activated links does not establish plain-path detection parity. Remaining
  M1/M3/M4/M6 gates and the final elevate-ios architecture pass continue to apply.

### M5 native commit and push — 2026-09-12

- Changes now offers a native Commit and Push sheet with branch/divergence, a
  retained message draft, an explicit include-untracked choice, Commit, Commit and
  Push, and Push. It states that tracked changes on disk are committed and unsaved
  editor buffers must first be saved. Blank messages use “Update working changes”.
  Existing local Git endpoints continue to honor the user's signing and hooks.
- An injected service and observable view model own every operation. Duplicate
  clicks coalesce, draft options are captured once, failed commits retain the draft,
  and all outcomes refresh disk state (a failed hook can still stage or edit files).
  A successful commit followed by a failed push displays its local hash and allows
  Push without resubmitting Commit. A failed reconciliation disables mutations until
  a successful refresh. No force push or automatic retry is introduced.
- In-flight operations survive a hidden sheet/context. Quit and backend shutdown
  wait for them, preventing backend teardown during an authorized commit/push.
  Worktree removal refuses while an operation for that worktree is active.
- Verification: 61 native tests pass, including duplicate actions, failed signing,
  partial commit/push success, failed refresh recovery, and shutdown waiting. The
  native UI regression passes initial-load failure/retry, message and untracked
  selection, successful commit with rejected push, and Push-only recovery. It uses
  isolated backend fixtures; no project branch was pushed during verification.
- Diff block discard, Git history, other M4 workflow parity and remaining terminal/
  release gates are still open. The final elevate-ios coordinator/VM/DI pass remains
  required after migration.

### M5 native block discard — 2026-09-12

- Working diff blocks now offer Discard through a native confirmation sheet. The
  sheet displays the exact patch and requires explicit Discard Block; Cancel performs
  no write. Failed applies retain the proposal/error, and completion refreshes the
  visible diff. Preview and apply share the commit/push operation gate and shutdown
  waiting. Late previews cannot reopen a hidden changes view.
- The web surface sends only block indices plus its rendered diff revision. Swift
  rejects malformed indices and stale renderer messages. The backend constructs a
  read-only preview from a fresh Git diff, and reconstructs it again at confirmation.
  A changed revision rejects the operation; Git's context checks guard drift after
  that read. This is not an OS transaction with external editors. The scoped
  path check rejects traversal, symlink paths and targets outside the worktree.
- The pure diff parser now lives in src/shared, with the existing renderer import
  retained as a compatibility entry point. Patch headers use Git C quoting for
  special filenames; rename metadata preserves real leading a/ and b/ directories.
  Added/deleted files and rename-content discard retain their existing behavior.
  Legacy web raw-patch requests remain compatible. Temporary apply patches use
  private, unique directories and are cleaned after both success and failure.
- Verification: 64 native tests pass, covering preview/cancel, duplicate confirmation,
  failed apply, late preview and strict revision/index messages. 46 API/Git/parser
  tests pass, including real repositories, native preview/apply routes, stale
  confirmation, neighboring-block preservation, rename/added/deleted files, missing
  final newline, Unicode/space/tab/newline/quote/backslash filenames and Git rejection
  of drift after revision validation. Native discard and commit/push UI regressions
  both pass against isolated fixtures. A development bundle serves all 126 focused
  assets, including the shared parser, and rejects the full SPA.
- Git history and wider document/terminal acceptance remain open, together with the
  remaining M1/M3/M4/M6 requirements and the final elevate-ios architecture pass.

### M4/M5 native Git history — 2026-09-12

- The native review pane now switches between Changes and History, restoring that
  choice per workspace and importing the legacy history selection. History offers
  branch changes against the PR base from the existing dashboard snapshot, or the
  current branch's complete history. No request-time GitHub CLI call was added.
- An injected history service and observable view model own pagination, filtering,
  selection, loading, errors and cancellation. Returning to unchanged history keeps
  loaded older pages and selection. Explicit refresh starts again at the first page.
  Local Git resolves moving refs to immutable IDs; pagination rejects a changed
  history identity instead of silently skipping commits after a rebase or new commit.
- Native rows and metadata expose author, date, subject, refs, full message and Copy
  Commit SHA. Only the selected immutable patch uses the focused web diff renderer;
  historical patches expose neither working-file navigation nor discard controls.
  Initials are used for authors; the cached avatar pipeline is still a follow-up.
- The Cocoa workspace split opens with balanced panes and retains a user's divider
  width when hiding/reopening its right pane. Compact history controls fit the pane.
- Verification: 68 native tests pass, including older-page restoration, stale list
  and detail replies, failure recovery, independent context restoration and split
  geometry. Real-Git coverage includes unborn/root/merge commits, a non-default PR
  base, stable pagination and changed-head detection. The isolated native UI flow
  exercises list/detail retries, loading/searching older commits, switching review
  sections and the absence of historical mutation controls.
- The sprint board remains web based. Avatar parity, wider shortcut/focus acceptance,
  remaining M1/M3/M4/M6 gates and the final elevate-ios coordinator/VM/DI pass remain
  open; this increment does not complete the migration.

### M1/M5 link and find routing — 2026-09-12

- Command-F targets the native history search when History is visible, including a
  session with no browser/file tab. The view model emits the focus request and the
  rendering view applies focus. The native UI regression types into search using
  Command-F and passes the older-commit flow.
- Option-click uses Ghostty's recognized hyperlink at the actual down/up positions.
  A drag, release away from the link or released Option cancels opening. Ordinary
  terminal clicks still use the package input path. Ghostty does not activate its
  normal link action with Option added, so the host uses the public hover callback
  and surface mouse-position API; it does not synthesize terminal key input.
- The click intent travels through the terminal session into native routing. Safe
  HTTP(S) links open in the system browser when Option-clicked; ordinary links use
  the owning context, and local file links keep their native document destination.
  Surface detach clears hover/click state. No dependency checkout is modified.
- Verification extends the real Metal/Ghostty test with AppKit Option-click,
  Command-Option-click, ordinary Command-click, drag cancellation and release-away
  cancellation. The existing keyboard/paste/hidden-output checks remain in that test.
  Plain printed file-path detection, broad IME/focus acceptance, full VT restoration
  and the terminal performance benchmark remain open.

### M1 acknowledged terminal input — 2026-09-12

- Fixed a daemon correctness bug: full input queues and missing terminals previously
  returned success after discarding input. Writes now reject the entire new chunk
  before queue mutation. Nonblocking partial writes retain accepted order; a fatal
  writer error is latched and reported instead of silently clearing bytes. A failure
  during a later queue drain emits a terminal-specific inputError event.
- Native Ghostty input now passes through a bounded queue with one acknowledged
  64 KiB write at a time. The 1 MiB limit includes pending and in-flight bytes.
  Rejection, timeout or overflow stops the remaining suffix, reports that earlier
  input may have been sent, and requires checking the shell before reattaching.
  Nothing retries an uncertain command or paste automatically. Closing a pipeline
  also stops queued input. Acknowledgement means accepted by the daemon, not that
  the shell has executed or consumed the bytes.
- The hello response advertises acknowledgedInput; native sessions require it before
  attaching. An older running helper is explained without replacing it or killing
  its shells. The protocol remains version 2 and the legacy transport is compatible.
- Verification covers bounded pending/in-flight bytes, ordered acknowledgement,
  partial failure, stopped suffixes, helper capability checks and decoded drain-error
  events. Real-PTY tests fill the queue of a non-reading process, verify overflow
  and missing-terminal errors, and confirm the original process is preserved.
  The real Ghostty key-encoding path is exercised against a rejecting socket peer.
  All 73 native tests and nine Rust tests pass; the native app builds and the legacy
  Tauri host passes cargo check with its existing vendor warnings.
  Automatic reconnect, full VT restoration and the hardware performance acceptance
  gate remain open.

### M1 binary snapshot runtime — 2026-09-12 (integration in progress)

- Source verification found that Ghostty revision
  `82938b633ba646db38591d969c3c526332bd7e65`, already used by the pinned Swift
  package, includes a binary terminal snapshot codec. The Swift embedding API
  still does not expose surface import. This changes the implementation path:
  use the matching headless Ghostty state in the daemon and add a native surface
  import bridge, rather than treating the output tail as a complete state.
- Added the standalone taskhub-vt Rust owner and a small C boundary against the
  exact upstream headers. A pinned build script checks source revision and Zig
  version, verifies the downloaded toolchain checksum and builds in macos/.build.
  The linked test binary has only system-library dependencies; a unique archive
  name prevents Apple ld from selecting a same-named development dylib.
- Real-library tests pass for output beyond 256 KiB, retained old history, primary
  and alternate screens, saved cursor, modes, styles, hyperlinks and subsequent
  resize/mutation. Tests also restore unfinished CSI/OSC/DCS and split UTF-8,
  checkpoint an already-restored parser again, and reject truncated, corrupted
  and trailing snapshot data. Pending continuation is capped at 1 MiB, source
  scrollback at 8 MiB (with upstream page granularity), and encoded output at
  32 MiB. Diagnostic VT formatting is used for assertions, never restoration.
- This is a verified runtime foundation, not an enabled restore path: daemon
  ownership, atomic snapshot transport and native Metal-surface import are next.
  Snapshot v1 has no cross-version compatibility guarantee. Upstream explicitly
  omits Kitty image payloads/placements and glyph registrations; those remain
  fidelity gaps, together with the rest of the M1 acceptance gate. See the
  [pinned format](https://github.com/ghostty-org/ghostty/blob/82938b633ba646db38591d969c3c526332bd7e65/src/terminal/snapshot/terminal.zig)
  and [snapshot API](https://github.com/ghostty-org/ghostty/blob/82938b633ba646db38591d969c3c526332bd7e65/include/ghostty/vt/snapshot.h).

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
SwiftUI view, and the split pane is `NSSplitView`. Replace the shell glue while preserving
its behavior. Native code owns layout, focus, navigation, menus, and lifecycle; embedded
web views own only their document content.

## What stays, what goes

| Layer | Today | Lines | Port verdict |
|---|---|---|---|
| `src/server/` | Express + `node:sqlite` + `gh`/`acli`/`git`/`xcodebuild` | ~4,450 | **Keep** as the backend. Runs as a sidecar exactly as under Tauri (`start_backend` logic moves to Swift). Port to Swift is an optional later phase. |
| `src/shared/` | `ROUTES`, `jira-keys`, `jql`, constants | ~220 | Keep; **generate** a Swift mirror of `ROUTES` and port the pure modules 1:1 with their tests. |
| `src/renderer/` | vanilla ESM, xterm.js, Monaco, hand-rolled diff | ~12,600 | **Rewrite the shell and app pages** in SwiftUI. Extract and reuse the diff/editor views, their assets, and pure logic where useful. |
| `src-tauri/src/ptyd.rs` | detached PTY daemon, Unix socket, JSON protocol | 776 | **Keep and extract** as a standalone binary; Swift gets a client. Preserve the protocol initially; correctness fixes discovered by terminal tests are in scope. |
| `src-tauri/src/terminals.rs` | Rust client of the daemon | 358 | Rewrite as a Swift client (`PtydClient`). |
| `src-tauri/src/{tray,notify,menu,glass,avatars,usage_image,viewer,webview_menu,commands,lib}.rs` + `bridge.js` | shell glue | ~2,700 + 556 | **Delete**; each becomes ordinary AppKit/SwiftUI. |

## Architecture of the native app

```
macos/
  TaskHub.xcworkspace          (checked-in app project + local TaskHubPackage)
  TaskHub/
    App/          TaskHubApp.swift, AppDelegate (tray, quit-only, Dock), Sparkle
    Backend/      BackendProcess (spawn node sidecar, TCP wait), APIClient (URLSession over
                  generated Routes), SSEClient, Models (Codable mirrors of API JSON)
    Store/        AppStore (@Observable) — the single state + pure lookups (prGroup, prByUrl…)
    Terminal/     PtydClient (Unix socket, JSON), GhosttySurfaceView, TerminalPane,
                  link/path detection, flow control
    Viewer/       WebTab (WKWebView), ContentTabStrip (chipOrder), History, Find bar
    Documents/    DiffWebView, EditorWebView, DocumentBridge, document state
    Sidebar/      CocoaSidebar (NSOutlineView, project → session, Pinned mirrors, Tabs), native context menus
    Pages/        Dashboard, Jira tickets, Logs, Settings, Project + focused WebBoard host
    Layout/       SplitPane (paneView: off/term/diff/build) — the one place state → geometry
  Shared/         Routes.swift (GENERATED from src/shared/routes.mjs), JiraKeys, JQL
  WebAssets/      isolated board/diff/editor entry points + reused renderer assets and logic
  scripts/        gen-routes.mjs, build-sidecar.sh (reuse), bench
```

Transport remains **HTTP + SSE to the loopback backend**, default `127.0.0.1:3000`.
Replace the broad `window.taskhub.*` bridge with in-process Swift calls and a small,
typed document bridge for the embedded diff/editor views.

## Native and web view boundary

- The Dashboard is native SwiftUI, including PR cards, Mine/Review grouping, CI status,
  filters, loading/error states, and actions. It reads the existing snapshot API and
  refreshes through SSE. Opening a PR may show its remote page in the embedded viewer.
- SwiftUI/AppKit owns the window, sidebar, session and content tabs, split geometry,
  tray, menus, dialogs, and terminal. A document webview is a child of that native layout.
- The sprint board may remain a focused local web page inside the native project view.
  Its small ticket-link bridge is separate from remote browser pages and file documents.
- The sidebar specifically uses AppKit `NSOutlineView` hosted through
  `NSViewRepresentable`; do not replace it with a SwiftUI `List`/`OutlineGroup`.
- Reuse the current web diff and Monaco editor as the initial implementation. Extract
  their entry points from the full SPA; preserve highlighting, diff interactions,
  editing, saving, and keyboard behavior. A native replacement is optional later.
- Swift owns document identity, active tab, file path, and save/close lifecycle. The
  editor owns its text buffer and undo state and reports dirty/save/error events.
  Dirty documents cannot be evicted or closed silently; save/discard/cancel must work.
- Local document views receive only their document data and scoped actions through
  the bridge. Remote GitHub/Jira/web tabs never receive file or terminal capabilities.
  Share the existing website data store among remote tabs for login persistence.
- Test keyboard focus and shortcuts across terminal, editor, and browser. Keep native
  menus and split controls usable over every embedded view.

## Terminal design (the part that decides success)

Decision: **native libghostty rendering with a host-managed connection to our daemon**.
Initial candidate: [Lakr233/libghostty-spm](https://github.com/Lakr233/libghostty-spm),
whose `GhosttyTerminal` product provides `InMemoryTerminalSession` for host-managed
I/O. Pin an exact tested release/revision in M1; the package name alone is insufficient.
Its host-managed backend is a fork addition, so validate the actual shipped API and
resources. [Unpeel](https://github.com/unpeel-com/unpeel) is an architectural reference,
not proof that our protocol or performance requirements are met.

- **Daemon stays Rust.** `ptyd.rs` already gives us detached shells that survive
  reload/rebuild/crash, `TASKHUB_RUN_ID` for agent hooks, and `foreground` detection for
  the Run chip. Build it as its own crate (`crates/taskhub-ptyd`) with the existing
  protocol; the app bundles it next to the node sidecar.
- **Swift client** replaces `terminals.rs`: mirror `ptyd::sock_path()` and socket-owner
  checks, including `TASKHUB_PTYD_SOCK`, private `$TMPDIR`, and the private
  `/tmp/taskhub-<uid>/` fallback. Perform `hello` and check the protocol (currently 2)
  before operations. Support `create/write/resize/flow/kill/killAll/list/attach/foreground`,
  request IDs, bounded framing, timeouts, disconnects, and `data`/`exit` events.
  Connection generations must prevent stale replies from affecting a replacement connection.
- **Ownership**: one terminal session and emulator per PTY identity, independent of
  SwiftUI view reconstruction. Closing/hiding a pane must not create or kill a shell.
  Decode and route socket traffic off the main thread; obey the terminal package's
  thread requirements for surface access. Deliver input, output, and resize in order.
- **Rendering**: `GhosttySurfaceView` wraps a libghostty Metal surface. Coalesce resizes
  during split changes and always apply the final nonzero grid size. Verify Retina
  scale changes, font changes, and moving between displays. Hidden/occluded surfaces
  stop drawing but continue consuming output and updating their terminal state.
- **Flow control**: bound queues by bytes, including output queued during attachment.
  Start from the existing 1 MiB high / 256 KiB low watermarks and tune against measured
  consumption. Prove when the chosen Ghostty API has consumed output; enqueueing is
  not a drain acknowledgement. Unfocus must not indefinitely pause a process. Test
  disconnect while paused and multiple clients; change daemon pause ownership/recovery
  if needed so a crashed viewer cannot leave a PTY permanently paused.
- **Links**: file paths → editor tab, `http(s)` → content tab beside the terminal,
  ⌥-click → real browser. Same rules as `wireTermLinks`; implemented on the Ghostty
  selection/URL hooks.
- **Reattach**: subscribe to data and exit before requesting attachment; replay the
  returned buffer through its sequence watermark, then apply queued events newer than
  that watermark exactly once. Handle exit during attach and reconnect without spawning
  a replacement shell. Historical replay must suppress terminal replies/side effects
  so old device queries cannot inject responses into the live shell.
- **Screen restoration**: the current 256 KiB output ring is a tail, not a complete VT
  snapshot. Test reattach after truncation, alternate-screen use, and resize. If the
  retained tail cannot restore the correct screen, add a daemon VT snapshot with an
  atomic sequence boundary before accepting M1; this is a correctness decision, not
  merely a future replay optimisation.
- **Input and text**: use Ghostty's encoded keyboard input for keystrokes and its paste
  path for clipboard content. Test IME composition, Option/Control keys, Shift-Return,
  bracketed paste, Unicode, selection, mouse reporting, and scrollback. Audit the
  daemon's UTF-8 framing with split codepoints and invalid bytes: the current valid-prefix
  decoder can retain an invalid prefix and stall later output. Fix it with regression
  coverage; version the protocol if raw-byte transport is required.
- **Workflow integration**: preserve `TASKHUB_RUN_ID`, agent resume IDs, hook-driven
  busy/idle state, foreground detection, and a bounded read of parsed terminal rows for
  `terminal-tail`/workflow analysis, including while the surface is hidden. Build output
  uses its own PTY and cannot write into the agent terminal.

### Terminal acceptance gate (M1)

The original plan held M2 until this gate passed. The user explicitly authorized the
M2 Cocoa sidebar ahead of gate completion; all terminal acceptance requirements
remain outstanding where not evidenced above. Record the
package revision, Mac model, macOS version, workloads, and results with the milestone.

| Area | Required evidence |
|---|---|
| Protocol and bytes | Automated socket/PTY tests for fragmented and coalesced frames, split UTF-8, invalid bytes, request timeout, protocol mismatch, final output before exit, and stale callbacks. |
| Attach and lifecycle | Output generated during attach has no gaps/duplicates; exit during attach is handled; crash/rebuild reconnects to the same shell PID; window close hides; explicit tray Quit stops all PTYs and daemon. |
| Terminal fidelity | Interactive shell, Claude Code, Codex, and a full-screen TUI pass keyboard/IME/paste, mouse, Unicode, selection, scrollback, resize, and alternate-screen checks. Restored screen matches the live state after ring truncation. |
| Flow and isolation | A sustained output flood and a slow/disconnected client keep queues bounded; another session remains usable; disconnect while paused recovers; hidden terminals continue progressing. |
| Performance | Benchmark one active terminal with nine hidden sessions for at least 10 minutes. Initial targets: p95 key-to-display latency below 50 ms in the interactive workload, no continuously growing output queue, and no steady-state draw work for hidden surfaces. Record CPU/GPU/RSS versus the existing app on the same Mac; regressions need mitigation before the gate passes. |
| Product integration | File/URL links target the owning session, Option-click opens the browser, focus survives tab/split changes, hooks update activity, and workflow tail reads reflect hidden-terminal output. Link destination completion is rechecked in M3/M5. |

The terminal implementation remains unverified until these checks run. Any dependency
change or protocol change re-runs the affected checks.

## Product rules that must survive (from `CLAUDE.md`)

- Sidebar = project → **session**; sessions are the only rows; task-less tabs live in one
  "Tabs" group; pins are additive mirrors in a "Pinned" group; rows sort oldest-created.
- Every session has one **context tab**; a bare session has no page. One code path.
- Right pane is one state, `paneView ∈ {off, term, diff, build}`; only one mutator,
  only one state→geometry mapper; `build` never persisted.
- Nothing is pinned to the content strip by default; ＋ fills it; new chips go after
  the active chip; `chipOrder` is **one ordered list**, never per-chip indices.
- Mine vs Review uses `prGroup`, never raw `category`; tray/sound stay on `category`.
- Quit only from the tray; explicit Quit stops terminals and the daemon. Window close
  hides the app; crash/rebuild preserves shells for reattachment.
- Restrained slate + single accent, flat, SF Symbols / SVG, no emoji.

## Milestones

| # | Goal | Exit criterion |
|---|------|----------------|
| M0 | Foundation: choose minimum macOS version, project tooling, and distribution model; `BackendProcess`, generated routes, `APIClient`, `SSEClient`; extract daemon crate; minimal native window and tray; bundle smoke test | App loads projects and receives sync; route builders/encoding and representative JSON contracts tested; SSE reconnect refreshes snapshots; correct data directory and explicit backend ownership; bundled helpers launch outside the development tree |
| M1 | **Terminal correctness spike:** pinned Ghostty package, `PtydClient`, native surface, input, flow control, attach/restoration, parsed row access, lifecycle | The terminal acceptance gate above passes, with automated tests and recorded interactive/performance evidence. Resolve snapshot and byte-transport requirements here |
| M2 | Native shell: AppKit `NSOutlineView` project/session sidebar, Tabs/Pinned groups, tray PR rows + usage view, theme, notifications, native menus and focus routing | Session selection uses stable PTY identities; changing views preserves terminal state; close/quit behavior matches the lifecycle contract |
| M3 | Complete session workflow: new/restart/remove/pin, worktree + task creation, `build:` PTY and Run destinations; context webview, content-tab strip, History, find bar, page-only/session toolbar | One complete session works end to end with terminal and context page; links route correctly; GitHub/Jira login survives relaunch; build and agent terminals remain isolated |
| M4 | Native SwiftUI app pages and actions: Dashboard (cards, grouping, CI status, filters, and actions), Jira tickets, Logs, Settings, Project; focused web sprint board; project/settings edits, Jira actions, agent hooks, workflows, git history/commit/push/discard | Dashboard renders natively and updates through snapshot API + SSE; embedded board preserves its existing interactions; each existing workflow has an explicit parity check; failures remain recoverable and destructive actions retain confirmation |
| M5 | Embedded diff + code editor: isolate existing web assets, typed document bridge, highlighting, diff interactions, editing/saving, dirty state, native shortcut integration | Existing diff/editor behavior works inside native panes; save errors preserve edits; dirty views cannot be silently evicted; terminal file links open the correct document |
| M6 | Release hardening: node + daemon + Ghostty resources + document assets, Sparkle, notarisation, upgrade/rollback and data restoration; remove Tauri/full-SPA dependencies from the native build | `.dmg` installs and runs on a clean Mac; terminal acceptance checks pass in the packaged app; required web document assets remain bundled |
| M7 (optional) | Port `src/server/` to Swift (GRDB + `Process`), drop node | API tests re-pointed and green; standalone Rust PTY daemon remains unless separately replaced |

Previous estimate: M0–M6 ≈ 10–12 weeks solo; M7 ≈ 3–4 more. Re-estimate after
M1 and the feature inventory. Reusing web document views reduces rewrite scope, but
terminal correctness work must not be traded away to meet the old estimate.

## Development approach

- **Two UIs, one backend.** Run `node src/server/app.js` and point both the Tauri app and
  the native app at it during the transition. Explicitly select external-server mode
  or app-owned mode; never terminate a server owned by the other client. Verify backend
  identity/readiness instead of accepting any listener on port 3000. Keep the snapshot
  architecture; add compatible API routes only when needed.
- **Preserve durable state.** Use the actual current launcher default,
  `~/Library/Application Support/TaskHub`, honoring `TASKHUB_DATA_DIR`. Test with an
  isolated copy of existing data. Inventory DB-backed state and localStorage-only
  preferences; record migration or reset behavior and protect rollback compatibility.
- **Share pure logic where it stays web-based.** Keep `diff-parse` and its existing tests
  with the embedded diff view. Port `jira-keys`, `jql`, and `terminal-tail` only where
  Swift consumes them, with translated tests before use.
- **Webview lifetime.** Add bounded remote-view retention in M3 and document-specific
  retention in M5. Current per-webview RSS accounting uses private WebKit API; record
  an explicit decision and fallback before claiming equivalent memory-budget behavior.
- **One decision per ADR line here**, not in commit messages: package manager
  (xcodegen vs `.xcodeproj` checked in), pinned Ghostty revision, snapshot-vs-replay
  reattach, and document bridge contract.
- Commit straight to `main` once a milestone is usable; this branch is for the
  skeleton and spikes.

## Recorded decisions

- Native SwiftUI/AppKit shell and native libghostty terminal.
- Sidebar is Cocoa/AppKit `NSOutlineView` inside a SwiftUI host, per user direction.
- The native tray uses `NSStatusItem` + `NSPopover` with a SwiftUI content view;
  usage is rendered as native text/progress controls, replacing the image row.
- Native SwiftUI Dashboard, including all cards, filters, status indicators, and actions.
- Sprint board stays web-based for now, per user direction; native Jira tickets and
  surrounding project/navigation UI continue. Board links open native session contexts.
- Diff and code editing may remain web-based; initially reuse the existing diff and
  Monaco editor in focused `WKWebView` hosts. Preserve editing and saving.
- M1 terminal correctness remains a release gate. User authorized the M2 Cocoa
  sidebar to proceed while the remaining terminal checks are tracked explicitly.
- Preserve explicit tray Quit teardown; crashes/rebuilds retain shells.

## Open questions

- M0 decisions: macOS 14 minimum, checked-in Xcode workspace/project plus local Swift
  package; direct distribution, initially ad-hoc signed for development.
- Ghostty is pinned above; complete restoration still requires a daemon VT snapshot
  or another complete-state protocol solution (M1).
- iOS/remote client later? Keep it out of the initial Mac scope; assess its additional
  transport and session requirements separately.
- Does the tray need the full PR list, or does a native `MenuBarExtra` with a SwiftUI
  popover replace both the tray menu and the usage bitmap?
