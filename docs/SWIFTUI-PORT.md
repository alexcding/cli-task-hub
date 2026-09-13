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
- Native Settings now includes a Diagnostics inspector with database counts, separate
  GitHub/Jira/Sprint board snapshots, merge-transition configuration, sync timestamps
  and failures, and GitHub CLI latency/coalescing counters. The event count explicitly
  reflects the endpoint's 1,000-event limit; CLI counters are scoped to backend uptime.
  Reads reuse `/api/db` without invoking CLIs. The native decoder ignores the legacy
  endpoint's configuration/token dictionary and command text.
- An injected service and view model own reads, presentation rows, retained data on
  failure, and generation checks across navigation/reconnection/shutdown. Visible SSE
  invalidations coalesce with one trailing refresh; hiding the inspector cancels its
  request, and there is no background diagnostics timer. New connections clear data
  from the previous backend. Views render the state and forward user/lifecycle events.
- Diagnostics verification: both new Swift lifecycle/recovery tests and the existing
  Settings tests pass. The app and UI test target build; the native inspector refresh
  and section-navigation UI test passes against the isolated real API fixture. Its
  first sandboxed run timed out while enabling macOS automation before test execution;
  the outside-sandbox retry passed. Native process/resource usage, login items, fonts,
  git-client actions, and the memory policy remain open.
- Native session toolbars now open the session's checkout in its configured project
  IDE or app-level Git client. IDE actions reuse `/api/launch-target` for configured
  relative targets and Xcode workspace/project discovery; Git clients receive the
  worktree directory. All eight existing IDE and four Git-client presets are retained,
  and the IDE picker shares the launch catalog. macOS resolves preset application
  names, including installations outside `/Applications`; launch failures are visible.
- General Settings includes Git-client selection and a custom-command draft with
  explicit save/revert and quote validation. Preferences use the existing ordered,
  offline-safe local/backend persistence. Custom templates preserve the Tauri grammar:
  quotes group arguments, backslashes remain literal, and `{path}` substitution happens
  after tokenization without shell evaluation. Custom processes are handed off after
  successful spawn, so long-running editors survive TaskHub exit; preset `open` calls
  are awaited with a bounded timeout to report missing applications.
- Injected target/launcher services and a workspace launch view model keep process
  creation off the UI actor, coalesce per-session clicks, and cancel pending lookups
  on removal/reconnection/shutdown. Snapshot refresh also cancels launches for sessions
  removed by another client. Six focused Swift tests pass for target choice, literal
  arguments, failures/recovery, cancellation, and preference persistence. The real
  target-resolution API test passes, as does the native Settings/command validation/
  launch failure/recovery UI flow. The first UI attempt used a session title where the
  sidebar displays its branch; the corrected selector passes. Process/resource usage,
  login items, fonts, and native memory policy remain open.
- General Settings now uses `SMAppService.mainApp` through an injected service and
  view model for launch at login. macOS is the source of truth; enabled, unregistered,
  approval-required, unavailable, and unknown states remain distinct. Mutations are
  coalesced and reread OS status after success or failure. Returning from System
  Settings refreshes approval state and clears obsolete errors. Shutdown drains a
  user-requested mutation. Development/unbundled builds cannot register themselves;
  disabling an existing native registration stays available. Merely starting the
  app or visiting Settings never registers a login item.
- Native login launches (and explicit `--autostart`) start as a menu-bar app without
  the main window or Dock icon. AppKit now starts the backend independently of view
  appearance; Open TaskHub/reopen restores regular activation and window/menu behavior.
  `LSUIElement` is set in the built bundle to avoid initial Dock promotion. Detection
  follows Apple's [launch Apple event contract](https://developer.apple.com/documentation/coreservices/apple_events/1556410-launch_apple_event_constants);
  registration follows [SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice/mainapp).
- Login/startup verification: three new Swift tests and two existing Settings tests
  pass for status/approval/failure handling, coalescing, development guards, stale
  reads, shutdown, and actual Apple event descriptors. The approval-error regression
  passes after the final status-refresh adjustment. Quiet startup UI passes hidden
  window, connected tray, opening the main window, and read-only login status. Normal
  startup/menu navigation/Command-Q-hide UI also passes. The initial quiet UI attempt
  passed startup checks but assumed a checkbox accessibility type; identifier lookup
  fixes that assertion. Tests did not alter real login items. Packaged registration,
  System Settings approval, and logout/login acceptance remain release gates; legacy
  Tauri login items are not migrated or removed automatically. Process/resource usage,
fonts, and native memory policy remain implementation work.

### M4 font preferences — 2026-09-12

- Native Settings enumerates installed monospace families off the UI actor and
  retains unavailable saved choices. Terminal and code/diff family/size preferences
  use the existing backend keys, with independent defaults of 13/12 points and a
  9–24 range. Rapid changes coalesce; pending offline writes remain durable.
- Mounted terminals update Ghostty configuration in place, retaining the native
  surface, generation, daemon identity and shell PID. New font metrics flow through
  the ordered daemon geometry path. Diff CSS and Monaco options update in place,
  preserving the document buffer, dirty state and undo history.
- Native menu shortcuts adjust the visible code/diff size or terminal size; General
  settings routes them to code/diff preferences. Browser page zoom stays separate.
- Verified: validation/catalog and preference persistence tests; live daemon-backed
  font resize with unchanged surface/PID and retained viewport; real WebKit editor
  font changes with unchanged dirty buffer/version; diff updates preserving its DOM;
  bundled web dependency checks; native Settings family/reset/shortcut/navigation UI.
  These checks do not replace the outstanding terminal fidelity/performance gates.

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
- At this stage, plain printed paths and Option-click had only indirect evidence.
  The later M1/M5 printed-link acceptance section verifies the pinned core's built-in
  matcher directly; a custom regex configuration is not needed. Broader terminal
  link/focus/IME acceptance and other M1/M3/M4/M6 gates remain separate.

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

### M1 daemon snapshot transport — 2026-09-12 (native import pending)

- The `terminal-snapshots` integration feature adds daemon-owned headless Ghostty
  state from terminal creation. Output and snapshot capture share an atomic lock;
  kernel/parser resizes now execute on the I/O thread between output batches.
- Binary captures transfer through connection-owned, revision-negotiated tokens,
  at most 128 KiB per read and 32 MiB per capture. Legacy output sequences remain
  contiguous; a separate `stateSeq` orders output and resize events for importing
  clients. See `crates/taskhub-ptyd/SNAPSHOTS.md` for the contract and limits.
- The isolated real-PTY test restores older scrollback after tail truncation,
  primary/alternate state, saved cursor and unfinished SGR, then compares future
  output after resizing and reconnecting with the same shell PID. Token ownership,
  chunk bounds, expiry, bad dimensions and legacy byte/text clients are covered.
- Validation: 12 Rust tests with snapshots enabled, 9 with normal build features,
  all 73 Swift package tests, and Tauri compilation pass (26 existing vendor
  warnings). Swift validates the separate output and output/resize sequences
  against the real normal-build helper.
- This feature remains off in normal builds until the native surface imports
  binary state. Native import, offline terminal-query responses, side-effect
  ownership, Kitty image omissions and the terminal performance benchmark remain
  open. This phase does not claim the full restoration gate is complete.

### M1 native snapshot import bridge — 2026-09-12 (app wiring pending)

- Maintained patches add complete snapshot import to the pinned Ghostty native
  embedding API and Swift wrapper. Import requires a fresh host-managed surface
  and matching grid; invalid input preserves the original state. The read-only
  standard handler reconstructs continuation once, then transfers its owned
  parser/builders to the normal native handler for subsequent output and input.
- `build-ghostty-native.py` prepares pinned source and wrapper checkouts, applies
  both patch stacks, compiles Metal/native code and generates a local arm64 Swift
  package. Source fingerprints keep this separate from normal dependency
  checkouts. See `macos/patches/ghostty/README.md` for the build and test commands.
- The separate `GhosttySnapshotTests` package tests the real native surface,
  including large history, both screens, saved cursor, unfinished parser input,
  rejected imports and future terminal replies. A Rust fixture generator creates
  snapshots using the same runtime as the daemon.
- Validation: the native library builds from fresh pinned checkouts and rebuilds
  incrementally; both integration tests pass against the generated package.
  They cover large scrollback, UTF-8/SGR/OSC/DCS/APC continuation, preserved
  application-cursor and bracketed-paste modes, exact future cursor replies, and
  recovery after rejected imports. The scrollback assertion waits for Ghostty's
  asynchronous viewport binding before reading its rows.
- The production app has not switched to this extension yet. Connecting the
  download/import lifecycle, ordered live resizes, automatic reconnect, response
  ownership, restored title/pwd publication, image/glyph omissions and performance
  acceptance remains required.

### M1 ordered native grid and snapshot downloads — 2026-09-12

- Imported native surfaces now defer logical reflow until the daemon's ordered
  resize event. Physical view size changes still update rendering and request the
  new PTY dimensions. The Swift bridge drains earlier output before applying each
  host grid event, so buffered output retains its original wrapping and cursor.
- The typed snapshot downloader bounds allocations, validates revision/dimensions,
  sequence metadata and every chunk's token, offset, length and final marker. It
  releases captures after success, rejection and cancellation. These transport
  pieces are prepared for app integration; the normal app still uses legacy attach.
- Verification: all three real native-surface tests pass, including cursor replies
  before and after ordered reflow. Socket fixture checks pass for multi-chunk
  downloads, oversized headers, wrong tokens/offsets, short or early-final chunks,
  and cancellation. The source builder successfully reapplies changed patches,
  tracking newly created upstream files as well as modifications.
- App attachment/reconnect integration and the previously listed response,
  metadata, fidelity and performance gates remain open. The Sprint board remains
  web-based as requested; it is not a pending native rewrite.

### M1 app snapshot attachment — 2026-09-12

- The native app now uses the generated, pinned Ghostty package and requires the
  snapshot-enabled helper. It negotiates the exact runtime revision before shell
  creation, synchronizes the initial grid, downloads the capture, imports it into
  a fresh surface, then drains newer output and resize events before enabling input.
  The bundle script builds the helper with `terminal-snapshots`; preparation and
  development instructions now include both pinned runtime builds.
- The capture owns the logical grid independently of the view's asynchronous
  resize queue. This removes the initial-import race exposed by the app-level test.
  State sequence gaps, missing resize metadata and invalid grids fail the pipeline;
  attachment buffers bound both bytes and event count. Closed session generations
  cannot become ready through a delayed callback.
- The isolated app test restores the same live shell into two fresh native surfaces
  at different window widths. It verifies history exceeding the old replay tail,
  alternate and primary screens, split UTF-8 continuation, saved cursor state,
  retained first history line, and a cursor reply after a live ordered grid change.
  All 76 Swift tests, four native bridge tests and the snapshot-enabled daemon's
  12 tests pass. The macOS app builds with the generated local dependency.
- Automatic reconnect, restored title/cwd publication, offline response ownership,
  image/glyph fidelity, remaining interaction checks and the performance gate remain
  open. This establishes app attachment; it does not complete M1 acceptance.

### M1 automatic reconnect — 2026-09-12

- Established terminals recover transient transport failures through a fresh native
  surface and snapshot, with five bounded attempts and increasing delays. Recovery
  requires the original terminal ID and PID; it never starts a replacement daemon
  or shell. SwiftUI observes the new surface identity, and old surface callbacks
  cannot change the replacement's state. Hidden-surface visibility is retained.
- Reconnect atomically freezes the input queue and requires no pending or
  unacknowledged input. Keyboard failures and app-issued command/interrupt failures
  remain manual, preserving the uncertainty warning without replaying bytes.
  Pane removal and explicit Quit cancel recovery and prevent late readiness.
- The real SwiftUI pane test uses an isolated Unix-socket proxy to drop transport
  while retaining the PTY. It checks the same PID, output printed during the gap,
  surface replacement, no replacement shell after exit, cancellation during
  backoff, and manual recovery after lost keyboard and interrupt acknowledgements.
  The complete 78-test Swift suite passes.
- Restored metadata, offline response ownership, image/glyph fidelity, broader
  lifecycle/interaction acceptance and terminal performance remain open, along
  with the remaining M2–M6 and final coordinator/view-model/DI requirements.

### M1 restored terminal metadata — 2026-09-12

- Snapshot attachment publishes the captured title and working directory through
  Ghostty's native handlers before live output. OSC 7 URIs use its local-host
  validation and percent decoding; remote hosts and unsupported schemes never
  become native file-link bases. Empty directory reports clear the adapter's old
  base, and an empty explicit title falls back to the validated directory.
- Metadata is published once on a worker without inserting bytes into the VT
  parser. The main actor drains the bounded callback mailbox while awaiting the
  worker, including for hidden surfaces. Callback draining holds no active surface
  operation, so a callback can close its surface without deadlocking teardown.
- All 78 app-package tests and six native bridge tests pass, and the macOS app
  builds. The app test restores title and a directory containing spaces into two
  fresh surfaces, then verifies a live directory reset. Native tests cover local,
  remote, unsupported and empty URIs, title fallback, unchanged unfinished SGR,
  absence of historical terminal replies, and closure during metadata callbacks.
- Offline query response ownership, image/glyph fidelity, default/config
  synchronization, broader interaction checks and the performance gate remain
  open. The remaining M2–M6 and final architecture requirements still apply.

### M1 response capture foundation — 2026-09-12 (ownership wiring pending)

- The headless runtime can now capture Ghostty-generated protocol replies while
  parsing each input batch once. Response storage is bounded separately from
  snapshots, and synchronous C callback context is removed on every return path.
  Collection failure is explicit even though parser state has advanced; callers
  must not retry that batch or send the partial response buffer.
- Runtime tests verify exact cursor/status/mode replies, a query split across
  snapshot restoration, silent parsing without retained callbacks, and overflow
  followed by continued parsing without duplicate application of input.
- The daemon remains on silent parsing until response ownership is connected to
  native suppression. Capability/configuration reports and clipboard/UI effects
  need explicit ownership; this foundation does not yet answer offline queries.

### M1 state query ownership — 2026-09-12

- Added the fixed `daemon-state-v1` contract. Native shells select it at creation,
  and hello/list responses expose helper support and each shell's owner. Old
  helpers and old shell owners are rejected without replacing their processes;
  legacy/Tauri shells retain their silent headless parser.
- The daemon answers DSR operating status/cursor, DECRQM except clipboard mode
  5522, DECRQSS and Kitty keyboard flags for the entire shell lifetime. Replies
  enter the existing bounded nonblocking input queue without marking user context.
  Collection/queue/write errors stop the unsent suffix, latch input failure and
  report it. A collection failure also invalidates the snapshot; no bytes are
  replayed and no shell is killed.
- A maintained native extension enables selective suppression on a freshly
  imported surface before newer output. It suppresses only the matching state
  query handlers, persists through reset, and leaves native keyboard/paste and
  clipboard/UI handling active. It cannot switch ownership after live output.
- Real-PTY tests check exact replies without clients, with two snapshot observers
  and after both disconnect, preserving the original PID and `hasContext`.
  Runtime tests cover the fixed packet classes and split DCS restoration. Native
  bridge tests check split DCS, reset, native paste and capability replies; the app
  fixture verifies one cursor reply with two live native surfaces. Verification:
  six runtime tests, 14 feature-enabled daemon tests, ten legacy daemon tests,
  seven native bridge tests and 79 app-package tests pass; the macOS app builds.
- UI/configuration-dependent offline queries, identity/terminfo reports, image/glyph
  restoration, interaction/performance acceptance and remaining M2–M6 gates remain
  open. The pinned parser ignores ANSI DECRQM in both variants; this upstream
  limitation is unchanged. The Sprint board remains web-based, and the final
  elevate-ios coordinator/VM/DI pass follows the migration work.

### M1 native terminal identity — 2026-09-12

- Found and corrected an identity mismatch: native Ghostty advertised its own
  capabilities while shells started as xterm-256color. New shells negotiate
  `daemon-identity-v1` and use xterm-ghostty, the actual linked renderer version,
  and a daemon-owned copy of the bundled compiled terminfo. Copies survive app
  rebuilds/moves and are removed after shell reaping. Existing state-owned shells
  keep their original profile and remain attachable.
- The daemon now owns DA1/DA2, XTVERSION and XTGETTCAP for identity-profile shells,
  in addition to state queries. A fresh native import suppresses the matching set;
  its default clipboard policy must match the profile. Clipboard and geometry
  effects are still native and are not accidentally disabled.
- The real app test exposed a pinned parser bug: echoed DA2 response parameters
  were accepted as another query, producing a reply feedback loop. A shared patch
  now restricts DA requests to an omitted/zero parameter in both runtimes. The
  same patch enables the existing ANSI DECRQM handler. These rules follow the
  [xterm control-sequence reference](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html).
  The headless build verifies the exact patch marker; native preparation includes
  it in the artifact fingerprint. The upstream snapshot layout is unchanged.
- Runtime/native tests cover echo rejection, ANSI mode state changes, split
  XTGETTCAP and reset. App validation exercises the bundled entry with tput,
  removes a temporary source bundle, queries without a native view and with two
  live native surfaces, and checks snapshot reattachment and private-copy cleanup.
  Verification: eight runtime tests, 14 feature-enabled and ten legacy daemon tests,
  nine native bridge tests and 80 app-package tests pass; the macOS app builds.
- UI/config-dependent offline replies, image/glyph state, interaction/performance
  acceptance, remaining M2–M6 gates and the final coordinator/VM/DI refactor remain
  open. The Sprint board remains web-based.

### M1 native shell integration — 2026-09-12

- New shells retain a bounded private copy of the pinned package's MIT Zsh/Bash
  integration scripts and license. The creation profile records their location;
  helper capability negotiation prevents silently ignoring resources on older
  helpers. Existing shells keep their original startup behavior.
- Zsh uses the package's ZDOTDIR bootstrap. User startup files, ZDOTDIR relocation,
  login semantics, prompt and hooks are preserved. OSC 7 updates the native working
  directory and file-link base after cd; OSC 133 records command/prompt boundaries
  and exit status. Resource lifetime follows the shell, independent of app rebuilds.
- Non-Apple Bash uses Ghostty's ENV/POSIX startup mechanism with preserved ENV and
  history settings. Apple Bash, relative executables and other unsupported shells
  retain normal startup; no dotfiles are edited or runtime commands injected.
  Homebrew Bash execution remains an acceptance item because it is not installed
  on this machine. The Zsh end-to-end fixture uses isolated startup/history paths.
- The real native test verifies startup order, user prompt/hooks, unchanged files,
  a cd into a Unicode/spaced path, native directory propagation, failure exit
  markers, same-PID snapshot reattachment and private-resource cleanup. Resource
  copy bounds and startup environment preservation have Rust regressions. All
  81 app-package tests, 16 feature-enabled daemon tests and 12 legacy daemon tests
  pass, and the macOS app builds.
- Remaining terminal fidelity/performance checks, M2–M6 acceptance and the final
  coordinator/VM/DI refactor continue. The Sprint board remains web-based.

### M1 terminal geometry runtime — 2026-09-12 (transport wiring pending)

- Added pixel-aware headless geometry updates and size-query collection. Cell
  dimensions are nonzero and pixel products checked for overflow. Queries use
  the parser's current metrics, which survive binary snapshots and reset.
- Mode 2048 enable and resize notifications use Ghostty's existing encoder and
  effect path. Pixel-only changes report once; unchanged measurements are a
  no-op. Split size queries resume across snapshots. Temporary callbacks are
  cleared after success and response-buffer overflow.
- The new `daemon-geometry-v1` runtime set includes identity/state and size
  reports, preserving the existing ownership sets. Title/clipboard/color effects
  remain excluded. Ten runtime tests and 16 feature-enabled daemon tests pass.
- Next: carry actual native cell pixels through shell creation, kernel winsize,
  ordered resize/snapshot transport, and matching native response suppression.
  Production still uses the existing identity/state contract until that wiring
  lands. Remaining migration acceptance and the final coordinator/VM/DI pass are
  open; the Sprint board remains web-based.

### M1 daemon pixel geometry — 2026-09-12 (native wiring pending)

- Feature helpers now advertise optional `daemon-geometry-v1` ownership. It
  requires the native identity profile and complete cell/grid measurements from
  creation. The parser and kernel PTY start at those dimensions before the child
  can query them. Existing shells retain their original response path.
- Kernel pixel dimensions are checked against unsigned 16-bit winsize bounds;
  partial, zero, overflowing and inconsistent dimensions are rejected. Ordered
  resizes carry complete geometry into the parser, resize event and snapshot
  header. Pixel-only changes advance state; equal measurements do not.
- Size queries and mode 2048 notifications use the runtime's single effect path
  and bounded protocol input queue. Notifications do not set user context.
  Invalid parser state cannot acknowledge another resize as successful.
- A real raw PTY test checks TIOCGWINSZ against exact query/notification bytes,
  initially without clients, with two observers, and after disconnection. It
  verifies grid/pixel-only/no-op changes, mode disable, snapshot metrics, invalid
  request rejection, same PID and unchanged context. All 18 feature-enabled
  daemon tests and 13 feature-free tests pass.
- Native creation must next wait for measured cells, negotiate the capability,
  send geometry with resizes and suppress matching native reports after import.
  The production app still creates identity-owned shells. Terminal acceptance,
  remaining migration gates and the final coordinator/VM/DI pass remain open.
  The Sprint board stays web-based.

### M1 native geometry bridge — 2026-09-12 (app negotiation pending)

- Fresh imports can select geometry response ownership, suppressing size queries,
  mode 2048 enable notifications and native resize reports while retaining native
  title policy, clipboard mode reporting and user input. Split queries and reset
  preserve ownership. Geometry-owned surfaces reject grid-only/invalid resizes;
  legacy surfaces retain their grid-only API.
- Fixed snapshot import replacing saved pixel dimensions with local ones. Complete
  imported metrics are now retained; legacy snapshots retain their prior fallback
  but cannot claim geometry ownership. Imported pixel sizes beyond the kernel
  range are rejected by geometry negotiation rather than silently substituted.
- Added an explicit complete-geometry callback at the engine resize boundary.
  The old callback carries no cell pixels, and the wrapper's viewport updater is
  intentionally unused to avoid premature resize dispatch. The new callback
  reports current grid, content pixels and measured cells under the engine lock;
  its consumer must enqueue work without re-entering the surface.
- Real native tests cover backing-scale changes, one-pixel changes within the
  same grid, suppression across import/resize/reset, native title/input behavior,
  and legacy/oversized snapshot rejection. Backing-scale font rounding confirms
  that cell metrics must be measured rather than scaled arithmetically.
- All 11 native bridge tests and 81 app-package tests pass; the macOS app builds.
  Next is app-side
  capability negotiation, complete creation/resize transport and snapshot/event
  validation. The app still creates identity-owned shells until that wiring lands.
  Remaining migration gates and coordinator/VM/DI work are open. The Sprint board
  remains web-based.

### M1 app geometry integration — 2026-09-12

- New app terminals wait for measured native cells and negotiate
  `daemon-geometry-v1` at creation. The returned owner is checked; old
  state/identity-owned shells retain their established profile on reattachment.
- Full geometry travels with ordered resize requests, events and snapshots.
  Header/event grid consistency and pixel bounds are validated. Imported surfaces
  suppress the daemon-owned size replies before metadata/live output, and apply
  ordered cell/pixel updates without sending duplicate notifications.
- Resize requests now receive acknowledgements in callback order. The pre-capture
  resize fence enqueues under the same lock, preventing stale measurements from
  overtaking newer callbacks. Unchanged grid/cell dimensions are deduplicated;
  backing-scale/font-cell changes remain significant. Rejected resizes stop the
  pipeline visibly; transient transport loss uses existing reconnect/input checks.
- The real app fixture exercises geometry-owned history restoration, size queries
  without a surface and with two live surfaces, and exactly one mode 2048 enable
  and ordered-resize response. Native Zsh creation/reconnection verifies the new
  owner. Additional tests cover resize rejection and invalid geometry contracts.
  All 83 app-package tests pass and the macOS app builds; the final creation-owner
  guard also passes the targeted Zsh regression.
- Remaining terminal offline policies, image/glyph fidelity, interaction/performance
  acceptance, M2–M6 gates and the final coordinator/VM/DI refactor remain open.
  The Sprint board remains web-based.

### Native browser retention policy — 2026-09-12

- Decision: keep public WebKit APIs and use an explicit page-count fallback instead
  of private per-webview PID/RSS accounting. `native.remotePageLimit` is independent
  of the legacy `webviewBudgetMb` value; no MB-to-page conversion is implied.
  General settings supports 1–12 retained remote pages (default six), immediately
  applying reductions and persisting offline edits through the settings queue.
- The LRU policy protects the active page. Public Dispatch warning/critical memory
  pressure events and a manual Settings action suspend background remote pages;
  their identities, saved URLs and persistent website storage survive. Reopening
  materializes a new view. Unsent web forms/in-page navigation may be lost, which
  the control explains. Editors (including dirty buffers), terminals, local diffs,
  and the Sprint board are not eviction candidates.
- The injected pressure monitor cancels at shutdown, restarts on backend reconnect,
  and rejects queued callbacks from a stopped generation. There is no memory polling
  timer or private WebKit API.
- Package verification covers limit shrink/growth, active surface preservation,
  pressure cleanup and rehydration, hidden dirty-editor retention, monitor lifetime,
  and offline/backend preference persistence. Native UI suspension/reopening passes;
  an initial fixture assertion incorrectly assumed a bare session had a browser
  page, and was corrected to open two real fixture pages. Resource accounting and the terminal
  performance benchmark remain separate work; this is not a measured memory cap.

### Native resource diagnostics — 2026-09-12

- Resources is a native Settings table with per-process/component PID, resident
  memory and sampled CPU. Backend health and an existing-daemon hello discover
  roots, including detached terminals that are outside the app's process subtree.
  No daemon is started for diagnostics. Root overlap is deduplicated, and descendant
  parentage is checked during bounded (512-entry) traversal with public libproc APIs.
- CPU uses Mach counter deltas divided by elapsed Mach ticks, with 100% per core.
  Process start timestamps prevent recycled PIDs from inheriting a previous CPU
  baseline. New/reset counters stay unmeasured until a second sample. The counter
  units were checked against [Apple's recount tests](https://github.com/apple-oss-distributions/xnu/blob/main/tests/recount/recount_perf_tests.c)
  and the installed SDK; Context7 did not return a relevant libproc reference.
- Sampling runs off the UI actor on a three-second cadence only while the page is
  visible and the AppKit app is active. Generation checks reject late requests after
  navigation/reconnect; failures retain the last sample, and missing process reads
  are reported. Hidden/inactive periods reset the CPU baseline.
- Scope is explicit: public APIs do not reliably attribute macOS-managed WebKit/GPU
  processes outside these trees. Listed totals exclude those processes; resident
  memory can count shared pages more than once. This is resource visibility, not
  full process-footprint parity or evidence for the M1 performance gate.
- Verified six package tests covering CPU units/PID reuse, a real busy child, overlap
  deduplication, backend/daemon/shell accounting, a missing-daemon read without
  startup, and visibility/failure/reconnect races. Native UI verifies live app/backend
  rows, CPU sampling and navigation recovery. The first UI run exposed that this
  NSHostingView app does not supply an active SwiftUI scenePhase; AppKit activation
  events fixed sampling. The table's native accessibility role is an outline.

### M4 native workflow configuration — 2026-09-12

- Native project Workflows supports recipes, Claude/Codex choice, step goals and
  commands, add/remove/reorder, Save/Revert and local sample previews. Stable editor
  row identities are separate from persisted recipe IDs. Missing/duplicate legacy
  IDs normalize only when saved, and old `commands` arrays decode into steps.
- Shared Swift helpers match the web branch-slug and literal placeholder rules,
  including leaving unknown/empty values unresolved and avoiding recursive expansion.
  The editor validates the server's workflow/step counts and string-length limits
  instead of silently truncating text. Blank command rows are omitted on save.
- The injected service sends only `{workflows}` through the existing project route.
  View-model drafts survive navigation, refresh, disconnection and failed writes.
  External recipe changes are surfaced; Revert loads the latest observed list.
  Concurrent saves coalesce, old-connection replies cannot replace the draft, and
  shutdown waits for an outstanding write before stopping its backend.
- Seven focused Swift tests and the five existing JavaScript helper tests pass,
  including real SQLite/API verification that saving recipes preserves merge/fix-
  version automation and Xcode run destinations. The isolated native UI test also
  passes recipe creation, Codex selection, command previews, step reordering, save,
  navigation with an unsaved draft, and revert after local deletion; its screenshot
  was visually checked. The test waits for the sidebar before querying its project
  and scopes Codex selection to the picker (macOS Services also contains Codex).
  Native workflow execution, hook sequencing/advisory analysis, and the merge-
  automation editor remain separate work.

### M4 native project automation — 2026-09-12

- Native Automation configures event forwarding, Fix Version creation/assignment,
  and the subsequent Jira ticket transition. Draft state and asynchronous work live
  in an injected view model. Saves send only the five automation fields and preserve
  workflow recipes, project configuration, and Xcode run destinations.
- Explicit Preview Version evaluates the unsaved prefix/script through the existing
  backend evaluator, with its sample PR and existing Jira version list. It performs
  no Jira writes. Edits, navigation, Jira-project changes and reconnects invalidate
  stale replies; errors are recoverable without dropping the draft.
- Forwarding status distinguishes observed process state from saved intent because
  the backend starts/stops forwarding asynchronously. Refresh checks actual status;
  projects without a repository explain the prerequisite. Existing backend polling
  and merge execution retain ownership of CLI calls and Jira mutations.
- Ten focused Swift tests pass, including the real backend preview evaluator,
  non-string script rejection, scoped persistence, external changes, save failures,
  coalescing, reconnects and shutdown draining. The isolated fixture now explicitly
  disables project-write sync/forwarder starts and supplies sample Jira versions.
  The native UI test passes scrolling to controls, script-error recovery, existing-
  version preview, save, navigation with an unsaved transition and Revert. The saved
  screen was visually checked. No real Jira versions or transitions were created.
- Native workflow execution, terminal acceptance gates, release validation and the
  final coordinator/VM/DI refactor remain open. Sprint Board stays web-based.

### M1/M4 native agent turn tracking — 2026-09-12

- Native terminals own an observable hook-driven turn tracker, independent of pane
  visibility. AppStore accepts only events for the terminal and its configured CLI
  before updating busy state or persisting the conversation ID.
- A workflow step can arm before input delivery, require a matching Start before
  Stop, and consume an already-arrived completion. Wrong PTYs/CLIs and missing
  required conversation IDs cannot complete it. Conversation replacement or a second
  overlapping Start fails the pending step; duplicate Stop events are harmless.
- Cancellation releases its waiter without cancelling a later ticket. SSE loss,
  PTY loss, terminal exit/removal and app shutdown invalidate pending waits,
  including successful replies buffered but not yet consumed. Reconnect never
  resumes a partially observed workflow step automatically.
- Nine focused Swift tests pass, including real HTTP hook POST → SSE → tracker
  delivery, terminal attachment/output ordering, input acknowledgements and partial
  write failures. The real native-surface/daemon reconnect test additionally passes
  pending-step failure across idle, unacknowledged keyboard/interrupt input and
  missing-shell cases, retaining the original shell without replaying uncertain input.
  The ordered workflow runner, agent input ownership checks and
  advisory analysis are still in progress; this phase supplies their completion
  clock and fixes the native busy-state event boundary.

### M4 native session workflow execution — 2026-09-12

- Existing native session workspaces now offer saved recipe selection, Run/Stop,
  step status, advisory summary/error and an Open CLI Settings action when hooks
  are absent. The Cocoa sidebar displays step progress. Recipe edits during a run
  do not replace its captured commands; duplicate Run requests cannot overlap.
- The injected runner checks both hooks, prepares or reuses the session terminal,
  persists the selected CLI/conversation, resolves context placeholders, waits for
  matching turn completion, and allows one retry per step. Advisory stop/retry
  exhaustion reports a stopped outcome rather than incorrectly reporting completion.
  Analyzer failures retain the established Stop-hook → proceed fallback and show
  the failure. New turns invalidate analysis before it can advance the workflow.
- The daemon adds foreground process-group ID and executable path to its existing
  response. The native adapter checks that identity before input, Enter and analysis
  continuation. Node-hosted Claude requires the exact identity recorded by this
  app's launch; arbitrary Node processes are rejected. Older helpers lacking this
  metadata fail clearly instead of accepting unverified workflow input.
- Commands are bounded after expansion and reject terminal control characters;
  multi-line commands use bracketed paste and a separately acknowledged Enter.
  Stop cancels the waiter and sends Escape only to its retained foreground/surface.
  Removal, restart, reattachment and app shutdown stop the associated run. Shells
  remain recoverable when preparation or delivery fails.
- Runner tests cover frozen recipes, retries, attention stops, duplicate Run,
  cancellation, missing hooks, analyzer failure and changed turns. A real native
  Ghostty surface and isolated daemon verify exact multi-line paste/Enter bytes,
  Escape delivery and refusing input after the fixture process exits. The fixture
  is a locally compiled echo executable; no real coding agent is invoked.
  Sixteen focused Swift tests and eighteen daemon Rust tests pass. The native UI
  test verifies saved recipe controls and that missing hooks prevent terminal
  preparation while leaving Run available for recovery.
  The focused runner UI test seeds its recipe through the real fixture API and
  verifies navigation to CLI settings; its screenshot was visually checked.
  Startup preparation rereads session metadata after automatic launch so a newly
  saved conversation ID is preserved. The focused Swift checks pass after this fix.
- Direct workflow preparation from a taskless PR/Jira page, actual Claude/Codex
  startup/interaction acceptance, and the remaining M1–M6/final architecture gates
  are still open. Sprint Board remains web-based.

### M4 workflow preparation from PR/Jira pages — 2026-09-12

- Taskless PR/Jira pages expose native recipe controls for an unambiguous project
  mapping. Hook validation precedes worktree/session creation. Repeated Run is
  coalesced, and canonical page identities prevent parallel preparation through
  alternate PR URLs. Existing matching sessions are reused.
- The injected preparation service resolves the PR head or Jira summary/worktree.
  New Jira workflow branches follow `feature/<key>-<summary>` from the repository's
  default branch. Existing worktrees retain their branch and contents. Exact branch
  and canonical path verification rejects unrelated checkouts sharing a folder.
  Folder conflicts are reported without replacing their contents.
- Handoff moves the live context objects into the session, merging open tabs when
  it already has context. Pages, editor objects and unsaved buffers are retained;
  the same runner continues under the session and supports subsequent runs. Local
  context persistence moves to the session key while the prior snapshot stays as
  page history. New session creation for that active page is disabled during a run.
- Once checkout creation starts, Stop drains the durable record write, retains a
  shell-only session and skips agent startup. It does not mint an unused agent
  conversation ID. Preparation before that boundary remains cancellable.
- Verification: nine focused Swift tests pass, including actual isolated Git
  creation/reuse, PR branch checkout, branch-folder collision rejection, context
  merging and dirty editor preservation. A separate cancellation regression proves
  that Stop during checkout creation finishes the record write. The native UI test
  verifies both existing-session and taskless Jira recipe controls, and proves that
  missing hooks do not create a session.
- Real Claude/Codex interaction acceptance, remaining M1–M6 acceptance/release work
  and the final coordinator/view-model/DI pass remain open. Sprint Board stays web.

### M1 sustained native terminal measurement — 2026-09-12

- Added a standalone AppKit harness around the production terminal session, native
  view, output pipe and snapshot/geometry-enabled helper. It uses private compiled
  fixture programs and captures queue high-water values without publishing output
  through observable UI state. The shell override is injected only by the harness;
  normal sessions retain their existing shell selection.
- An optimized ten-minute run used one visible interactive terminal, one hidden
  ANSI/Unicode flood and eight hidden tickers. All 292 samples observed the visible
  window. Tick output progressed between samples, input stayed responsive, and PTY
  PIDs/surface generations stayed unchanged. A separate pause owner disconnected
  successfully while the other sessions continued.
- [Recorded evidence](measurements/native-terminal-stress-2026-09-12.md): 600.32 s,
  input-to-parsed-output p95 20.51 ms, maximum output queue 60,686 bytes, native host
  median CPU 179.7%, daemon tree 21.2%. Host RSS grew from 126.7 to 173.2 MiB and
  daemon-tree RSS from 32.1 to 74.5 MiB; no memory plateau is claimed.
- This verifies sustained native-path progress and bounded queues for the specified
  workload. It does not close M1: physical key-to-display/GPU measurements, hidden
  draw verification, slow socket stress, a matching Tauri baseline, full-app overhead
  and the remaining terminal interaction/fidelity checks are still required.
  Four focused terminal/PTY/workflow regressions and the native arm64 app build
  pass after adding the diagnostics and harness target.

### M1 unread socket recovery — 2026-09-12

- Fixed a daemon deadlock in client delivery backpressure. Once an unread socket
  exceeded the 4 MiB high-water mark, all PTY reads could pause before another
  output offer ran the 60-second stalled-client check. PTY backlog checks and the
  independent watchdog now enforce that deadline even without new output.
- A connection with no queued output starts a fresh delivery clock when work
  arrives. Partial socket writes count as progress and reduce the outstanding
  byte budget; a large frame no longer hides a reader that is making progress.
- Real Unix socket tests fill the production outbox with synthetic flood frames,
  keep a healthy reader draining, and verify that an actual PTY stops reading
  under backlog pressure and resumes with its original PID after expiry. Both
  legacy text and native byte transports pass. The test advances only the fixture
  delivery timestamp instead of waiting 60 seconds. Removing the backlog expiry
  check reproduces the failure. A deterministic idle-clock regression also passes.
- Verification: 16 daemon tests pass without snapshots and 21 with snapshots;
  all three focused outbox regressions pass after the final test refinement.
  Two native Swift tests verify same-process reattachment and reconnect without
  retrying unacknowledged input. Both debug and release snapshot helpers build.
- This retains the existing global backpressure policy and 60-second deadline;
  other terminals can still pause temporarily behind an unread client. It proves
  recovery from the indefinite freeze, not per-terminal socket isolation or a
  substitute for full-app performance and interaction acceptance.

### M1/M5 printed-link acceptance — 2026-09-12

- Verified that the pinned core already recognizes printed paths through its
  default URL/path matcher. No custom regex, dependency patch, output scanner or
  additional per-frame parsing is needed. This corrects the earlier assumption
  that unsettable custom link configuration prevented plain-path detection.
- A real native surface verifies relative, absolute and home-relative paths,
  line/column suffixes, Unicode filenames, wide/combining characters before a
  link, punctuation and soft-wrapped paths. Web URLs and OSC 8 links retain
  precedence; unsupported SSH addresses remain whole for the host to refuse.
  Local positions and scheme refusal remain covered by the host parser tests.
- Fixed the Option-click adapter's mouse-capture modifier. Command alone does
  not override Ghostty mouse reporting; the adapter now adds Shift while capture
  is active, subject to Ghostty's override policy. A real AppKit Option-click
  invokes external web routing while ordinary clicks continue producing SGR
  mouse input. Shift-Command-click activates a printed file under capture.
- Five focused Swift tests pass, including the existing OSC 8, Option-drag,
  hidden output, encoded keys/paste, URI and file-containment regressions. The
  native arm64 app builds. The fixture uses actual engine cell metrics after
  initial layout, and a valid localhost OSC 7 URI, rather than estimating columns
  from string length or accepting a zero-cell-size hit test.
- This covers synthetic native click events and basic mouse-button reporting.
  Broader motion/drag/focus/IME and interactive agent acceptance, performance,
  release checks and the final coordinator/ViewModel/DI pass remain open.

### M1 native motion and composition checks — 2026-09-12

- Expanded the native link regression to SGR all-motion reporting (mode 1003).
  Option-click and a cancelled Option-drag produce no process input; clicking
  ordinary text forwards button events at the real coordinates, without probe
  coordinates leaking into the TUI. No additional implementation change was needed.
- Added real AppKit marked-text coverage on the native Ghostty surface. Japanese,
  emoji and combining-character preedit updates retain UTF-16 selection ranges and
  do not reach the PTY or parsed output. The host key API commits composed text
  exactly once before Enter, without bracketed-paste markers. Replacing preedit
  with empty text cancels it; the next key cannot replay it. Candidate placement
  returns a nonzero rectangle, and negotiated Kitty Shift-Enter stays distinct.
- Both focused interaction tests pass. These are synthetic AppKit composition
  calls and native host key events, not an OS input-source/candidate-window test.
  Actual input methods, interactive agents, display/focus changes and the other
  terminal/release acceptance gates remain open.

### M6 independent native runtime packaging — 2026-09-13

- Native bundling no longer reads `src-tauri/binaries` or derives its runtime from
  the developer's installed Node version. A native lock file pins the already-used
  official Node v26.8.1 arm64 archive and its SHA-256 from Node's published checksums.
  Downloads live in `macos/.build/node`; cached archives are verified on every run.
- Preparation extracts only the regular Node executable and license, checks the
  exact version and an in-memory built-in SQLite query, and replaces cached outputs
  from the verified archive. Invalid checksums, missing licenses and symlink members
  fail before extraction. The app includes Node's license. Custom runtime overrides
  require their corresponding license path.
- Backend resources are assembled in a fresh staging directory, including production
  npm dependencies and the focused web allowlist, before replacing the generated
  backend tree. Re-bundling cannot retain removed SPA files or old dependencies.
- Four archive-integrity tests pass. The native arm64 Release app builds and bundles;
  a seeded stale SPA file and backend sentinel disappear. A copy outside the checkout
  passes deep/strict signature verification and serves the focused web assets through
  its own Node helper. The smoke check also verifies that SPA/index/terminal bootstrap
  files and Tauri npm tooling are absent, and that the Node license is present.
- The downloaded Node binary links only system libraries and declares macOS 13.5
  minimum, within the application's macOS 14 requirement. These are local ad-hoc
  bundle checks; Sparkle, Developer ID signing/notarization, DMG installation,
  clean-Mac upgrades/rollback, terminal release acceptance and the final architecture
  pass remain open.

### M6 native updater integration — 2026-09-13

- Pinned Sparkle 2.9.6 (`ac2def288cbff5cfc7df3ffef6abdf45b72bcb0a`) through SwiftPM.
  Xcode embeds its framework, installer and XPC services; native bundling includes
  the upstream license. The menu exposes Check for Updates. Debug, unbundled and
  unconfigured Release apps never start the updater. A packaged Release requires
  an HTTPS appcast and a valid-length Ed25519 public key supplied at build time.
  Custom keys use an explicit Info.plist merged with generated app metadata;
  arbitrary `INFOPLIST_KEY_*` settings were experimentally omitted by Xcode.
  A build-only feed/key fixture verifies both final plist values, then the normal
  unconfigured Release bundle is rebuilt. The fixture app is never launched.
- An injected termination coordinator serializes tray Quit and update restarts.
  Sparkle's restart callback arms AppKit's asynchronous termination gate; existing
  document confirmation may cancel and later retry without double cleanup. Approved
  update restarts stop workflow automation and the owned backend, then disconnect
  terminal clients while preserving the detached daemon/shells. Explicit tray Quit
  still reaps the daemon; Command-Q still hides the window.
- Three focused configuration/cancellation/retry/failure tests pass. The arm64
  Release app builds, bundles, and passes deep/strict ad-hoc signature verification.
  The native menu UI test verifies disabled development updates and Command-Q
  hide/reopen. Its first run failed at window reappearance; a diagnostic rerun
  passed without app changes, so that UI interaction remains potentially flaky.
- These checks do not exercise a real signed update. Feed/key provisioning,
  Developer ID signing/notarization, clean-Mac install/relaunch, retained-terminal
  compatibility across versions and rollback/data restoration remain release gates.
  The other migration gates and final elevate-ios coordinator/VM/DI pass remain
  open. Sprint Board stays web-based.

### M6 data snapshot and restoration tooling — 2026-09-13

- Added standalone backup/verify/restore commands shipped with the native backend.
  They never import application stores or run schema migrations before backup.
  SQLite's online backup captures committed WAL state, then produces a standalone
  database with no WAL/SHM dependency. The durable DB (including its legacy filename),
  optional logs and pending native page JSON are captured under a versioned manifest
  with per-file SHA-256 hashes. Source databases are opened read-only.
- Restore validates the allowlisted manifest, checksums, regular-file paths and
  SQLite integrity before creating a new destination. Existing destinations are
  always rejected. Copied files are rechecked; directories/files are private, and
  incomplete operations do not publish a completed manifest or restore receipt.
- Seven focused tests pass, including WAL-only committed rows, unknown legacy
  schema, symlink/sidecar and corruption rejection, no-overwrite guarantees and a
  full current-backend durable-state round trip. The suite takes about 71 seconds;
  no backup/startup performance gate is claimed. A packaged-resource smoke test
  outside the checkout passes and leaves the fixture source DB checksum unchanged.
- [Data recovery](DATA-RECOVERY.md) documents commands, storage ownership, native
  versus Tauri layout preferences, and rollback limits. Live PTYs, worktree files,
  regenerable CLI cache, browser data and UserDefaults are not copied by this tool.
  Online captures are consistent per database, not one transaction across all files.
- Automatic pre-upgrade checkpoint integration, real previous-release rollback,
  clean-Mac/signed update acceptance, other migration gates and the final requested
  coordinator/VM/DI architecture pass remain open. Sprint Board stays web-based.

### M6 automatic startup checkpoint — 2026-09-13

- Packaged native startup now enters a dedicated Node launcher before importing
  backend application stores. First adoption and release changes create and verify
  a private checkpoint. Fresh installs record their release without an empty backup;
  repeats verify the same checkpoint. Returning to an earlier release creates a new
  checkpoint while retaining all prior rollback copies. Broken checkpoints stop
  startup instead of being replaced by a snapshot of already-upgraded data.
- A separate SQLite transaction holds native data ownership for the backend's
  lifetime. Competing packaged native owners fail before schema loading. Process
  death releases the lock; no PID-based ownership or lock-file deletion is used.
  Standalone/Tauri backends do not participate and must be stopped before upgrading
  shared data, or used deliberately through external-backend mode.
- Bundling generates a deterministic identity from app version/build metadata and
  packaged backend/document source/dependency inputs; startup also incorporates
  Node's version. Distribution builds must increment `CFBundleVersion`. Snapshot
  files/directories and the checkpoint receipt are flushed before schema startup.
  The Swift host uses the packaged launcher with a two-minute readiness window;
  cancelling preparation terminates only its owned child.
- Thirteen Node recovery/checkpoint/lifetime tests pass, including destructive fixture-schema
  ordering, repeat/change/rollback, corruption refusal and a killed lock owner.
  A forced-GC regression first reproduced premature lock release after startup;
  retaining the launcher lease fixes it and keeps competitors excluded.
  The release identity test and Swift packaged-startup/cancellation integration test
  pass. The arm64 Release app builds/bundles with deep/strict ad-hoc signature
  verification. Its recorded identity matches final bundled inputs. Copied packaged
  recovery/launcher resources pass outside the checkout with fixture application
  code, including rejection before loading after checkpoint corruption.
- The checkpoint precedes the new backend's data opening, including after Sparkle
  relaunch; it does not save the previous app binary. Real old-release rollback,
  clean-Mac/signed installation, other migration gates and the final requested
  coordinator/VM/DI architecture pass remain open. Sprint Board stays web-based.

### Coordinator/VM/DI extraction: creation flows — 2026-09-13

- Inspected the `elevate-ios` coordinator, destination-view, ViewModel and DI
  registrations. The first extraction uses the same responsibility split with
  explicit injected factories. See `NATIVE-ARCHITECTURE.md` for source references
  and the remaining architecture scope.
- An application coordinator now owns identified project/session sheets and their
  models. Root rendering no longer constructs these models. Toolbar and menu
  commands share presentation rules; cancellation, success and repeated/late
  callbacks preserve the correct draft and presentation lifetime.
- Project and session sheets bind the coordinator-owned models and forward events;
  persistence and preparation stay in ViewModels/services. The live factory's
  folder picker can be replaced without invoking native UI in tests.
- Five focused Swift tests pass, covering duplicate routes, stale completion,
  save-time dismissal, retained failures/retry, factory injection and existing
  project/session business behavior. The native Debug app and UI test target
  compile. The project UI run and one retry both fail before any assertion because
  macOS times out enabling automation mode. Project and session cancel/reopen
  assertions are added, but UI execution remains pending; the session UI run was
  deferred after the repeated runner initialization failure.
- This starts the architecture extraction while externally verifiable migration
  acceptance remains open; it does not close those gates or complete the full
  architecture pass. Sprint Board remains web-based.

### Runtime framework correction and browser/creation architecture — 2026-09-13

- A direct Debug launch exposed `DYLD Library missing` for Sparkle. The framework
  was embedded, but neither Debug nor Release had a runtime search path to
  `Contents/Frameworks`. Previous signature and copied backend-tool checks did not
  exercise the main app loader. Shared build settings now retain inherited paths
  and add `@loader_path/../Frameworks`, matching Sparkle's documented setup.
- `check-runtime-frameworks.py` checks the arm64 executable's direct `@rpath`
  dependencies resolve to files inside the app. It rejected both broken artifacts
  before the correction and passes rebuilt Debug/Release bundles. Backend bundling
  runs the check before resource changes. This does not replace launch testing,
  transitive dependency checks, signing or clean-Mac acceptance.
- Release builds and bundles with deep/strict ad-hoc verification. A copied Release
  app outside the checkout stayed alive with explicit isolated backend/data/socket
  arguments and rendered the native Dashboard, fixture PRs and Cocoa sidebar. Its
  packaged recovery/launcher resources also pass the isolated backup/restore and
  corrupt-checkpoint refusal smoke. Both the Debug and copied Release fixture apps
  were stopped after verification. Signing/notarization and real update/rollback
  remain separate release gates.
- `BrowserControlsViewModel` owns address drafts, URL validation, loading actions,
  find, external opening and operation-specific retry. `BrowserPageFactory` carries
  injected desktop actions through new/restored/popup pages. Controls cannot retain
  closed pages, and terminal/context identities are preserved. Browser and worktree
  platform calls and tray opening/grouping are moved out of rendering views.
- Add Page now uses the existing identified creation coordinator and injected
  factory. Failed opens retain the draft; cancelled/obsolete sheet actions cannot
  open pages or dismiss a later sheet. New presentations start with a fresh address.
- Eleven focused Swift tests pass, including real WebKit navigation/find, cookie
  retention, view eviction/restoration, factory/lifetime checks and coordinator
  behavior. Native browser/session and project creation UI tests pass, closing the
  previous creation phase's pending UI checks. The session title field received a
  stable accessibility identifier after the first UI run could not find its label.
- Evidence: Swift log `swift_package_test_2026-09-13T11-48-43-732Z_pid64713_b95671f1.log`;
  browser/session UI log `test_macos_2026-09-13T13-57-27-853Z_pid96134_85541037.log`;
  project UI log `test_macos_2026-09-13T13-59-03-171Z_pid97035_153685ef.log`;
  Release build log `build_macos_2026-09-13T13-59-54-229Z_pid97450_2fcc0560.log`.
  See `NATIVE-ARCHITECTURE.md` for the remaining coordinator/VM/DI extraction.
  Sprint Board stays web-based; broader migration acceptance remains open.

### Workspace coordinator and ViewModel extraction — 2026-09-13

- Workspace titles, toolbar availability, pane presentation, review refresh and
  command routing now live in `SessionWorkspaceViewModel` with an injected service.
  A workspace factory creates models before rendering; context promotion retains
  their identity and open documents. The live service rejects actions from contexts
  that are no longer owned or selected.
- The root coordinator owns restart confirmations, build and removal sheets.
  Busy operations prevent dismissal; successful callbacks match presentation IDs;
  failed builds retain their destination for retry. Views render supplied models
  and forward actions. Terminal surfaces remain mounted through navigation.
- Twelve focused Swift tests passed in
  `swift_package_test_2026-09-13T14-19-53-627Z_pid3773_0bd89631.log`.
  Real-shell UI verification passed in
  `test_macos_2026-09-13T14-25-00-123Z_pid5605_2ff94843.log`: the same PID survives
  navigation and cancelled restart, confirmation creates a new shell, and tray Quit
  exits. Browser/session creation/removal passed in
  `test_macos_2026-09-13T14-33-03-815Z_pid7762_507584a5.log`; editor save/cancel/
  discard/history passed in `test_macos_2026-09-13T14-34-11-165Z_pid8337_7ab8bc41.log`.
- XCTest's copied app needs an explicit PTY helper path; the fixture script builds
  and passes it. The PID assertion reads the static text's accessibility value.
  Earlier setup/oracle failures were corrected and rerun. Cleanup verifies the
  private socket's protocol/PID and terminal directories before stopping its shells
  and daemon; it also handles a stopped daemon's stale socket without signaling
  its old PID. The earlier failed test's daemon and remaining shell were stopped.
- The shell UI run emitted a publication-during-view-update warning, pending the
  terminal adapter audit. Browser navigation emitted a WebKit QoS warning. These
  passing functional checks do not establish performance or full terminal fidelity.
  Remaining extraction is in `NATIVE-ARCHITECTURE.md`; migration acceptance gates
  remain open. Sprint Board stays web-based.

### Observable terminal presentation model — 2026-09-13

- `TerminalPaneViewModel` now owns mounted/activity/visibility policy, deferred font
  updates and focus eligibility through an injected `TerminalPaneServing` protocol.
  Each session creates its model before rendering and retains it across emulator
  generations; the model weakly references the session. Views forward lifecycle and
  input events. Showing/hiding a view never starts, stops or replaces the shell.
- Font/display updates coalesce after the synchronous view update. Focus uses the
  current mounted, active, visible and ready state, including the connection-ready
  callback, so an obsolete queued request cannot focus a hidden workspace.
- Seven Swift tests pass, including rapid presentation changes, model lifetime,
  latest-font application and real-daemon reconnection with idle input, lost keyboard
  acknowledgment, lost interrupt acknowledgment and a missing original shell.
  Log: `swift_package_test_2026-09-13T14-49-46-688Z_pid15133_621cdb31.log`.
- Final native UI verification passes in
  `test_macos_2026-09-13T14-50-30-399Z_pid15523_e93de549.log`: navigation and hide/show
  retain the PID; typing after showing the terminal writes the expected marker in
  the isolated fixture; cancelled restart retains the shell; confirmed restart
  replaces it; explicit Quit exits. Fixture cleanup remains enabled.
- The mount-time publication warning still occurs. Deferring wrapper theme adoption
  and nested hosting updates did not remove it; both experiments were reverted.
  The pinned Ghostty inputs and split controller remain unchanged. This warning,
  hardware/input-source checks and full terminal performance acceptance remain open.
- Reconfirmed the reference's `@Observable` pattern and audited all TaskHub-owned
  Swift sources: no `ObservableObject`, `@Published`, `@StateObject`, `@ObservedObject`
  or `@EnvironmentObject` remains. The legacy observation API is internal to the
  third-party Ghostty wrapper. `NATIVE-ARCHITECTURE.md` makes Swift Observation the
  explicit application-layer rule. Remaining migration/architecture work continues;
  Sprint Board remains web-based.

### Root presentation and coordinator action callbacks — 2026-09-13

- Root and workspace ViewModels emit typed `onAction` callbacks. The coordinator
  binds them before rendering, rejects obsolete roots/unowned contexts, owns
  presentations and delegates operational work to injected runtime services.
  ViewModels do not reference their coordinator; all remain `@Observable`.
- Sidebar selection and existing JSON persistence now belong to the coordinator.
  Native menus, sidebar and programmatic navigation share that entry point.
  The root model supplies titles, action gates and model-bearing destinations;
  rendering retains all prepared workspace identities and the native terminal.
  A missing session deactivates the previous workspace.
- Inspected `record-ios` action callbacks, typed routes, parser/printer handlers,
  immutable route chains and deferred startup dispatch. The reference and planned
  TaskHub boundaries are recorded in `NATIVE-ARCHITECTURE.md`; inbound deeplink
  handling is the next phase.
- Twelve focused Swift tests pass in
  `swift_package_test_2026-09-13T15-02-35-685Z_pid19289_6e8f8907.log`.
  Real-shell navigation/input/restart/Quit passes in
  `test_macos_2026-09-13T15-03-34-868Z_pid19630_5f0a3436.log`;
  native Dashboard in `test_macos_2026-09-13T15-04-51-531Z_pid20191_f9ad11b8.log`;
  web Sprint Board in `test_macos_2026-09-13T15-05-27-521Z_pid20434_80865c13.log`;
  Settings/menu navigation in `test_macos_2026-09-13T15-10-27-107Z_pid21836_d0f8851c.log`.
  Existing terminal publication and WebKit QoS warnings remain open, along with
  broader architecture and migration acceptance. Sprint Board remains web-based.

### Typed native deeplinks from the Record pattern — 2026-09-13

- Added injected URL parsing/printing handlers and immutable route chains for
  native root screens, existing projects/sections and existing sessions. The root
  coordinator forwards project sections to a factory-created child coordinator.
  The AppKit delegate only forwards URL events and manages window activation.
- The `taskhub://app` scheme waits for a complete backend snapshot, revalidates
  destination IDs and preserves open sheets, drafts and confirmation targets.
  New valid links replace older queued links. Unsupported paths and URL payloads
  are rejected; links cannot execute commands or create/open a shell.
  The supported grammar and lifecycle rules are in `NATIVE-ARCHITECTURE.md`.
- Twelve focused tests pass in
  `swift_package_test_2026-09-13T15-23-10-313Z_pid25978_0d097e81.log`.
  Actual cold/warm URL delivery passes in
  `test_macos_2026-09-13T15-21-58-861Z_pid25611_beb25a29.log`, including quiet launch,
  draft preservation, deferred Settings navigation, project tickets and missing
  sessions. Warm delivery targets the verified XCTest product and asserts its PID
  stays unchanged. XCTest's own `open` method relaunches; the initial test was
  corrected to use Launch Services for warm delivery. The runner also forbids
  spawning `ps`, so verification uses AppKit's foreground app and test-product path.
- Inspected Record's `query.didSet` and replacement-task cancellation pattern and
  recorded the rule: model state changes must not trigger business work through
  rendering-view `.onChange` or `.task(id:)`. That extraction is next. Migration
  acceptance and remaining coordinator/DI work remain open; Sprint Board stays web-based.

### Record-style model property observers — 2026-09-13

- Follow-up audit: Git History now binds scope and search directly to observable
  model properties. Guarded `didSet` handlers own scope refresh, pagination reset
  and filtered selection updates, including changes made without a mounted view.
  Four focused history tests pass in
  `swift_package_test_2026-09-13T17-01-51-571Z_pid58154_d0d2828d.log`.
  Native history search, pagination, section return and read-only patches pass in
  `test_macos_2026-09-13T17-02-11-393Z_pid58373_c16101f8.log`; the run reports a
  WebKit/UI-test thread priority inversion warning.
- Read Record's Search, Settings, Download Settings and Sign In models. TaskHub's
  Activity filters, project PR state and session project selection now react inside
  guarded `didSet` observers. Replacement tasks cancel their predecessors and
  retain generation checks. Unchanged selections do not reload or clear drafts.
- Browser URL/blur synchronization and terminal visibility/surface-generation
  reactions now originate in the owning models. The viewer store owns workspace
  activity; pane, review section, backend and snapshot changes notify the workspace
  model directly. Views no longer drive these effects through `.onChange`.
  Existing emulator, context, document and shell identities are preserved.
- No view `.task(id:)` remains. Initial/cancel lifecycle events and SwiftUI focus,
  environment/font and surface-visibility forwarding remain at the rendering
  boundary. TaskHub-owned models and coordinators still use only `@Observable`.
- Twenty-two focused tests pass in
  `swift_package_test_2026-09-13T15-29-56-072Z_pid28138_bf596716.log`, including
  automatic loading without views, repeated-value guards, cancelled requests,
  stale-response rejection, context promotion and real WebKit address changes.
  Native shell/input/restart/Quit passes in
  `test_macos_2026-09-13T15-30-26-279Z_pid28485_62a0605c.log`; Activity filters and
  confirmed clearing pass in `test_macos_2026-09-13T15-31-56-026Z_pid29078_a0d973f7.log`;
  browser navigation/session creation and removal pass in
  `test_macos_2026-09-13T15-32-51-717Z_pid29405_4523a85c.log`.
  History section changes, pagination and read-only patches pass in
  `test_macos_2026-09-13T15-34-18-267Z_pid29945_de537626.log`.
- The existing terminal mount publication warning and WebKit QoS warning remain
  open. Full terminal/release acceptance and the remaining feature factories,
  callbacks and runtime extraction continue. Sprint Board remains web-based.

### Project factory and typed coordinator completions — 2026-09-13

- Project feature assembly moved from `AppStore` to an injected factory with
  protocol-based services and desktop/clipboard dependencies. The root coordinator
  retains each project's child coordinator and models across navigation, preserving
  drafts and section selection. Sidebar and deeplink section actions share the
  same child coordinator handler.
- Project editor, workflow and automation models emit typed `onAction` callbacks.
  The parent model's `didSet` forwards the latest callback to its children by value.
  Factories construct editors; coordinators install their action handlers before
  rendering. Parent completion handling validates project IDs and model identity.
  Background saves/deletions preserve unrelated navigation.
- Snapshot removal retires obsolete project coordinators/services. Recreated IDs
  get fresh models. A newer refresh supersedes an older in-flight inventory before
  it can replace state or prune newly created models. API reads retain the backend's
  snapshot/SWR behavior. Native Dashboard, Cocoa sidebar and terminal ownership are
  unchanged; Sprint Board remains web-based.
- Twenty-three focused tests pass in
  `swift_package_test_2026-09-13T15-53-12-818Z_pid36017_6f5c0344.log`, including
  factory reuse/injection, callback rebinding without parent retention, obsolete
  completions, deleted/recreated projects, creation flows, workflows and automation.
  Native project create/edit/delete passes in
  `test_macos_2026-09-13T15-50-21-270Z_pid34992_b959bfa4.log`;
  workflow ordering/save/draft retention in
  `test_macos_2026-09-13T15-51-37-985Z_pid35538_94c30651.log`;
  automation preview/save/recovery in
  `test_macos_2026-09-13T15-53-48-754Z_pid36324_e9a2d6b3.log`;
  web board move/assign/native ticket opening in
  `test_macos_2026-09-13T15-54-47-851Z_pid36750_5e8869cb.log`.
  Cold/warm deeplinks and draft preservation pass in
  `test_macos_2026-09-13T15-56-02-394Z_pid37133_d3f1edcc.log`.
- Remaining child presentation/lifetime handling, shared action services,
  settings/document factories, backend runtime extraction and migration acceptance
  gates remain tracked in `NATIVE-ARCHITECTURE.md` and this plan. Existing terminal
  mount and WebKit QoS warnings remain open.

### Creation model lifetime and stale preparation — 2026-09-13

- Creation factories now only assemble models. New Session and Add Page emit typed
  `onAction` completions installed by the coordinator, matching project editors.
  Closing or completing a creation sheet permanently retires its model and clears
  its callback. Retained dismissed models cannot start backend operations; a
  successful creation is single-use even without a coordinator. Existing project
  editors remain reusable until deletion or removal from the snapshot.
- New Session receives a protocol-based `SessionCreating` dependency. Guarded
  project-selection observers invalidate pending resolution. Both the lookup and
  the handoff to creation validate the current request, project generation and
  draft. A stale response or failure cannot overwrite a newer draft or start a
  worktree creation. Retired models cannot restart branch loading. Project folder
  and repository responses also reject retired/disconnected lifetimes.
- Busy writes still prevent dismissal, and failures retain their drafts for retry.
  These guards prevent new operations; they do not roll back backend writes that
  already started. Build runtime and removal cleanup lifetimes remain a separate
  phase. No view observers or legacy observation APIs were introduced.
- Twenty-four focused tests pass in
  `swift_package_test_2026-09-13T16-11-04-443Z_pid41611_28b91b3a.log`, covering
  held lookup success/failure, project switching, dismissal, retry, repeated
  creation, deleted editor reuse, late folder responses and coordinator/deeplink
  regressions. Native browser/session creation and removal pass in
  `test_macos_2026-09-13T16-09-20-520Z_pid40814_6d507304.log`; native project
  create/edit/delete passes in
  `test_macos_2026-09-13T16-11-26-169Z_pid41845_fad21986.log`. Cold/warm
  deeplinks and open-draft preservation pass in
  `test_macos_2026-09-13T16-12-24-530Z_pid42292_e79519fa.log`.
- Remaining coordinator/runtime extraction and terminal/release acceptance gates
  remain open. The existing WebKit QoS warning is still emitted by native UI tests.

### Build and removal presentation lifetimes — 2026-09-13

- Build sheets now receive a fresh factory-created `BuildDestinationViewModel`
  over the retained build runtime. Dismissed/completed destinations cannot issue
  commands or mutate a replacement sheet. Scheme/simulator choices survive
  reopening. Retiring a destination leaves the build monitor and detached PTY
  intact, while runtime disconnection invalidates pending operations and prevents
  an obsolete model from interrupting a retained shell.
- `BuildServing` supplies data access through injection. Destination reads reject
  stale presentation/generation results; preparation captures its selection and
  checks lifetime before persistence and after the asynchronous shell-state check
  before submitting a command. Monitor replacement cancels the previous task via
  `didSet` and guards completion by generation.
- Removal uses an injected `SessionRemoving` service, coalesces preview loads and
  permanently retires cancelled/completed models. Late previews cannot restore a
  removal plan. Busy removal prevents dismissal; failures allow retry. Started
  operations retain cleanup and lock release through retirement. This does not
  roll back a removal already in progress.
- Build/removal completions are typed coordinator actions. Removal cleanup in
  `AppStore` no longer chooses navigation; the coordinator returns to Overview
  only when the selected session was removed. Views retain rendering/lifecycle
  forwarding, without new state-driven view observers or legacy observation APIs.
- Twenty-eight focused tests pass in
  `swift_package_test_2026-09-13T16-25-10-009Z_pid46660_31fb7002.log`, including held
  requests through replacement/disconnect, stale shell checks, running-build
  retention, retry, single-use removal and cleanup after retirement. Native build
  selection/cancel/reopen and preparation-error recovery pass in
  `test_macos_2026-09-13T16-22-20-832Z_pid45468_c73dbfdc.log`. That test replaces
  Xcode route registration only in its isolated fixture; it starts no Xcode build
  and does not establish real build/install/launch acceptance.
  Browser/session navigation and removal cancel/reopen/confirmation pass in
  `test_macos_2026-09-13T16-23-40-198Z_pid46003_20324fbf.log`; the unlinked fixture
  folder remains after forgetting its session. The existing WebKit QoS warning
  is still emitted in this test.
  Real shell input, visibility/navigation, cancelled/confirmed restart and explicit
  Quit pass in `test_macos_2026-09-13T16-25-37-448Z_pid46881_3bd52a24.log`; the
  existing terminal mount publication warning remains reproducible.
- Remaining project confirmation/action boundaries, settings/document factories,
  runtime extraction and terminal/release acceptance gates remain open.

### Project deletion through the child coordinator — 2026-09-13

- `ProjectEditorView` now emits a typed deletion request instead of owning an alert
  or calling deletion. The request identifies its project and connection generation;
  the editor rejects stale/recreated-model or reconnected-backend tokens before a
  write. The child coordinator owns confirmation identity, cancellation and retry.
  `ProjectCoordinatorView` renders the child content and confirmation sheet.
- The root presentation gate includes child confirmations and in-flight deletion.
  Competing creation/restart requests and external deeplinks wait. Cancelled,
  duplicate or obsolete confirmations cannot act. Busy deletion prevents dismissal;
  failure preserves the confirmation for retry. Leaving the screen ends the sheet,
  while a write already started finishes against its original project. Unrelated
  navigation is preserved after completion.
- Removed/replaced child coordinators retire their editor and clear callbacks.
  Current inventory and runtime ownership are checked before accepting an action.
  Cancellation/completion/removal schedules queued deeplinks after the originating
  callbacks. Application observation remains `@Observable`; there is no new view
  `.onChange`/`.task(id:)` business work.
- Twenty-five focused tests pass in
  `swift_package_test_2026-09-13T16-34-29-151Z_pid49525_37901fc0.log`, including held
  deletion failure/retry, cancelled/stale confirmations, connection changes,
  removed/recreated models, released owners, unrelated navigation and queued links.
  Native project creation, editing, cancellation and confirmed deletion pass in
  `test_macos_2026-09-13T16-35-15-284Z_pid49887_dbba75da.log`.
  Cold/warm links, preservation of creation/deletion sheets, disabled competing
  creation and resumed navigation after cancellation pass in
  `test_macos_2026-09-13T16-36-27-117Z_pid50359_4ea4010c.log`.
- Remaining shared project PR/Jira/board actions, settings/document factories,
  platform/runtime extraction and the terminal/release gates remain open. The
  native project test still emits the existing WebKit QoS warning.

### Project PR actions and cancellable page opening — 2026-09-13

- Project PR rendering and the root project destination no longer depend on the
  Dashboard model. Opening state and action errors belong to the project model.
  Typed open/browser/copy callbacks pass through the child coordinator's ownership
  and presentation guards, then use an injected `PageActionServing` dependency.
  The native project factory supplies page, desktop and clipboard operations.
- Opens of the same row coalesce; newer opens replace older tasks using `didSet`
  cancellation. Section/state changes, navigation, new dialogs, disconnect and
  retirement cancel pending project PR actions. Late errors cannot overwrite newer
  action feedback. Retired project models cannot reconnect or restart operations.
- `AppStore.openPage` checks cancellation before navigation and after awaited tab
  persistence. A tab already saved is retained, but its cancelled response cannot
  redirect navigation or replace the current tab inventory. Project/Dashboard
  metadata conversion preserves Mine/Review/Other, including review-orbit overrides;
  the narrow tray notification category is unchanged.
- Twenty-six focused tests pass in
  `swift_package_test_2026-09-13T16-51-58-475Z_pid55084_e0ceff6d.log`, covering local
  failures/retry, injected effects, duplicate/superseding opens, lifecycle/ownership
  checks and classification. Native delayed-response cancellation and retry pass
  in `test_macos_2026-09-13T16-50-41-264Z_pid54662_b9a0d8b4.log`: the real fixture
  tab write completes before its response is held, a new-project draft is opened,
  and releasing the response leaves that draft and the project navigation intact.
  Retrying opens the native page with Review metadata.
  Native Dashboard filtering/opening passes in
  `test_macos_2026-09-13T16-52-59-246Z_pid55432_45eafaad.log`; web Sprint Board
  move/assign/native ticket opening passes in
  `test_macos_2026-09-13T16-54-26-167Z_pid55911_99dcab9c.log`.
- At this phase the Merged/All endpoint still called the CLI directly; the following
  snapshot phase addresses that SWR violation. Jira/board actions, remaining factories/runtime
  extraction and terminal/release acceptance also remain open.

### Snapshot-backed project PR history — 2026-09-13

- Merged, Closed and All now read a separate `data.db` scope cache, preserving the
  existing latest-30 window. Open remains complete and separate. The poller owns
  coalesced history fetches with CI and the lean UI projection; history reads never
  trigger merge automation, review tracking or tray classification changes.
- Every state returns immediately; missing/stale snapshots revalidate in the
  background and publish SSE after storage. Failed attempts retain matching cards
  and back off for 30 seconds. Explicit retry bypasses age checks while still
  coalescing. Invalid states fail before CLI scheduling; corrupt timestamps are stale.
- Cache identity includes repository, Jira key and project creation identity.
  Edits/deletion invalidate scoped caches and pending generations; stopped pollers
  cannot publish obsolete scope results. History does not enter open-snapshot metrics.
- Native and web consumers opt into snapshot metadata (`snapshot=1`), render initial
  refresh/error states and re-read every active PR scope on SSE. The legacy array
  response remains supported. Native model generation/cancellation guards and web
  request/DOM identity guards reject obsolete replies. Web transport failures keep
  previously rendered cards from the same scope.
- Forty-two backend/API/web adapter tests pass (`pr-scope-snapshot`,
  `pr-scope-renderer`, `poller`, `api`). Thirty-three focused native tests pass in
  `swift_package_test_2026-09-13T17-14-24-275Z_pid63787_92b295b2.log`, including
  refresh status, retained cards/errors, retry, repository changes, cancellation
  and existing coordinator lifetimes.
- Native Open/Merged/All switching, initial progress, late background completion,
  SSE updates and explicit failure recovery pass in
  `test_macos_2026-09-13T17-14-50-553Z_pid64047_edd06ed0.log`. Earlier UI runs exposed
  a missing picker test identifier and an actual retry race: background reads
  cleared the error row during a click. The view model now retains error feedback
  until a response replaces it and owns the retry task; a delayed-read model test
  covers the retained feedback. The final fixture observes one Merged fetch and
  two All fetches (initial failure plus explicit retry), despite repeated SSE reads.
- Jira/board action callbacks, remaining DI/runtime extraction and terminal/release
  acceptance remain open. The arbitrary pasted-PR lookup retains its existing
  on-demand resolution contract; this phase covers project PR list reads.

### Jira and web board navigation ownership — 2026-09-13

- Jira open/browser/copy and board ticket links now emit typed callbacks through
  the project model. The coordinator verifies project ownership, active section
  and presentation availability before dispatch. Native factory injection supplies
  the same page/browser/clipboard service contract to all three project surfaces.
- Each ticket surface owns a separate `PageActionViewModel`. Duplicate opens
  coalesce; newer opens cancel older tasks. Navigation, section changes, dialogs,
  disconnect and retirement cancel pending navigation without clearing drafts or
  cancelling independent ticket edits. Filter/site changes and board suspension
  also cancel pending opens. Error feedback is separate from Jira data errors and
  board loading failures; late failures cannot overwrite newer feedback.
- Ticket actions resolve their key against current visible rows. Board callbacks
  retain trusted main-frame/document/URL checks and reject obsolete webview senders,
  suspended/disconnected state and retired models. Retired children cannot reconnect
  or resume operations. Views emit synchronous navigation actions and render state.
- Sixteen focused tests (including parameterized lifecycle cases) pass in
  `swift_package_test_2026-09-13T17-27-37-002Z_pid68626_d66e30f6.log`. They cover
  ownership, dialogs, hidden sections, obsolete keys, duplicate/superseding opens,
  error isolation, retained drafts, cancellation and permanent retirement. An
  explicit All filter still wins over delayed stored preferences, even when the
  provisional selection was already empty.
- Native held-response cancellation passes in
  `test_macos_2026-09-13T17-24-35-842Z_pid67238_ed593216.log`: a ticket tab is persisted,
  switching to the board cancels its pending navigation, and releasing the response
  preserves the board and ticket search draft. A subsequent board click opens the
  ticket through the coordinator. The first test run used the wrong accessibility
  element type; the passing run uses the existing Jira link selector.
  Native search, failed/successful status transitions and ticket opening pass in
  `test_macos_2026-09-13T17-25-32-417Z_pid67640_b36ceb1b.log`.
  Web board failed/successful moves, assignment, native ticket opening and return
  pass in `test_macos_2026-09-13T17-26-31-209Z_pid67979_41b70c2f.log`.
- Dashboard callbacks, remaining settings/document/platform factories and runtime
  extraction remain open, along with terminal and release acceptance. The Sprint
  Board remains web-based.

### Dashboard coordinator and factory — 2026-09-13

- A Dashboard feature factory injects page/browser/clipboard operations. The root
  coordinator owns the child/model, and `AppStore` reads that model through the
  coordinator instead of retaining a separate copy. Replacement retires old models.
- Open/browser/copy use typed callbacks. The child accepts only current visible
  rows while owned, selected and free of competing presentations. The shared page
  action model owns duplicate/superseding opens, cancellation and navigation errors.
  Snapshot reads no longer clear navigation feedback or conflate it with data errors.
- Navigation and accepted dialogs cancel pending Dashboard opens. Guarded model
  setters for search/project/filter and snapshot removal also cancel obsolete opens.
  Views render state and issue synchronous actions. Connection generations prevent
  stale snapshot application and old cleanup from clearing a replacement connection.
- Twenty-four focused tests pass in
  `swift_package_test_2026-09-13T17-38-48-846Z_pid72490_d9246ad5.log`, including
  ownership, hidden rows, preserved errors, repeated/superseding opens, parameterized
  navigation/dialog/filter lifetimes, snapshot removal, retirement, released
  coordinators and reconnect. Cached browser/copy actions remain available offline;
  native opens show connection feedback until reconnected.
- Native held-response cancellation and retry pass in
  `test_macos_2026-09-13T17-36-04-944Z_pid71498_9e55afeb.log`: a saved Dashboard tab's
  delayed response cannot redirect a new-project draft, and retry opens it after
  cancellation. The initial build exposed one workspace lookup still assuming a
  non-optional Dashboard; it now reads through the coordinator safely.
  Existing native Dashboard filtering, review grouping and context opening pass in
  `test_macos_2026-09-13T17-40-05-322Z_pid72940_22f99948.log`.
- Activity actions/clear confirmation, remaining settings/document/platform factories
  and runtime extraction remain open, along with terminal and release acceptance.

### Activity coordinator, factory and model-owned reactions — 2026-09-13

- Rechecked Record's Search, Settings and Download Settings models: input reactions
  and replacement work belong in model property observers. Activity binds directly
  to guarded `@Observable` category/errors/search properties; opening and copying
  emit typed callbacks handled by its new owning coordinator.
- The Activity factory injects navigation and clipboard dependencies. Current-row,
  ownership and presentation checks reject stale callbacks. Navigation failures stay
  separate from snapshot feedback, and filters/navigation/dialogs cancel late opens.
- Clear confirmation captures the reviewed category, model and backend connection.
  Failed clears retain their request and error for retry; refreshes cannot erase that
  feedback. Cancelled, foreign and reconnected requests cannot write. Duplicate
  confirms coalesce, and an already started write cannot clear a new connection's
  rows. Generation checks reject pre-clear reads and obsolete stop cleanup.
- The root includes Activity confirmation/busy state in presentation and deeplink
  gating. Cancelling or completing the confirmation resumes queued navigation.
- Twenty-eight focused tests pass in
  `swift_package_test_2026-09-13T17-53-18-498Z_pid77095_92b6a53e.log`, covering property
  guards, navigation cancellation, confirmation identity/retry, held reads/writes,
  reconnect, ownership and deferred deeplinks. The initial build found the request
  label needed a nonisolated pure formatter; that was corrected before validation.
- Native Activity filtering, cancel/confirm, captured category/warning text and
  disabled New Project while confirming pass in
  `test_macos_2026-09-13T17-53-47-602Z_pid77393_e990b56d.log`.
- Settings/document/platform factories, remaining view-input adapters and runtime
  extraction continue, along with terminal and release acceptance gates.

### Document activation through model property observers — 2026-09-13

- Removed activation, appearance and font change handlers from Diff, Git History
  and Editor rendering views. Workspace/context state now supplies a typed
  `DocumentPresentation`; guarded model `didSet` reactions own load/suspend and
  surface updates. History forwards presentation to new immutable patches itself.
- Pane, selected file, workspace activity, restoration and backend state drive
  presentation without a mounted view. Replaced models deactivate. Shell theme and
  document-font observers update current and retained models directly; style-only
  changes preserve surfaces, buffers, selection and pagination. Duplicate inputs
  do not reload. A selected file resumes after its service is connected.
- Thirty-four focused tests pass in
  `swift_package_test_2026-09-13T17-59-50-276Z_pid79416_a29fed68.log`. New workspace
  tests exercise activation, dirty buffer retention, history patch/selection/page
  retention, repeated/style-only input, restoration, replacement and reconnect
  without rendering any SwiftUI document view.
- Native editor save/cancel/discard/reopen and the added dirty-buffer navigation
  check pass in `test_macos_2026-09-13T18-00-47-954Z_pid79893_54dcdd05.log`.
  Working diff collapse, failed/successful refresh and tracked/untracked file opening
  pass in `test_macos_2026-09-13T18-01-47-259Z_pid80393_727698be.log`.
  History error recovery, paging, return with selection/search and read-only patches
  pass in `test_macos_2026-09-13T18-02-51-000Z_pid80774_3106005a.log`.
  The existing WebKit QoS warning remains open.
- Remaining settings/document factories and action/presentation ownership,
  terminal/platform adapters and runtime extraction continue. M1–M6 acceptance
  requirements remain open wherever evidence is missing.

### Settings factory and completion coordinator — 2026-09-13

- The Settings feature factory injects desktop, clipboard, login-item and font
  catalog dependencies and assembles child models. The root owns Settings through
  its coordinator; `AppStore` no longer constructs or separately retains the model.
- Saves emit typed callbacks to the coordinator, which serializes application
  completion effects. Navigation away preserves accepted saves. Replacement retires
  the old model and rejects queued or late completion callbacks; released root
  ownership also prevents delivery.
- Settings draft observers clear stale saved state while preserving newer edits
  across a write. Read and connection generations reject obsolete values and task
  cleanup. Saving invalidates pre-save reads; save errors survive background
  refreshes. Shutdown disconnects before waiting. CLI reads now have equivalent
  connection/cleanup protection, so an old stop cannot clear a replacement probe.
- Twenty-two focused tests pass in
  `swift_package_test_2026-09-13T18-11-00-524Z_pid83246_7b1e58c5.log`, including
  injected dependencies, draft/error preservation, held reads/writes, duplicate
  saves, reconnect/stop, navigation, queued completion ordering and replacement.
- Native validation/save/revert and retained draft/menu navigation pass in
  `test_macos_2026-09-13T18-11-21-354Z_pid83476_6f39f124.log`.
  CLI status and hook installation failure/recovery pass in
  `test_macos_2026-09-13T18-12-07-672Z_pid83892_e3fc054c.log`.
  The existing WebKit QoS warning appeared in the Settings test and remains open.
- Document factories, child action/presentation ownership, platform adapters and
  application runtime extraction continue, along with the remaining M1–M6 gates.

### Injected document feature assembly — 2026-09-13

- Added one document factory for editor models/surfaces, working diffs, git actions,
  history models and immutable patches. App, viewer and workspace context assembly
  carry the injected factory through new files, backend snapshots, legacy import,
  snapshot replacement and reopening. Existing standardized paths reuse their model.
- Context promotion moves existing documents and dirty buffers without construction.
  History and working diff retain the selected factory for nested patch/action
  creation. Historical patches keep mutation and working-file opening disabled.
  Editor surfaces remain lazy and use the current backend origin.
- All production constructors for those document models and surfaces now live in
  `DocumentFeatureFactory.swift`. Backend service lifetime and remaining child
  navigation/presentation handling continue in their existing owners for now.
- Twenty-two focused tests pass in
  `swift_package_test_2026-09-13T18-17-03-553Z_pid85385_2928956b.log`. The three factory
  integration tests, extended with explicit legacy import, pass in
  `swift_package_test_2026-09-13T18-17-56-276Z_pid85843_6ebd8150.log`. They cover
  injected HTTP/editor surfaces, restoration, path deduplication, reopen, dirty
  promotion, snapshot replacement, nested read-only patches and commit-driven diff
  refresh through the injected git-action factory.
- Native editor restoration/save/cancel/discard/reopen and dirty navigation pass in
  `test_macos_2026-09-13T18-18-17-999Z_pid86030_afc3b521.log`.
  History paging/recovery/return and immutable patch rendering pass in
  `test_macos_2026-09-13T18-19-16-639Z_pid86492_6a548c8e.log`.
  The existing WebKit QoS warning remains open.
- Child callbacks/confirmation ownership, platform dependencies and application
  runtime extraction continue alongside outstanding M1–M6 acceptance gates.

### Settings section observers and CLI action callbacks — 2026-09-13

- Root navigation now activates the Settings model. Guarded active/section
  observers own config/CLI/login/font reads, diagnostics visibility and resource
  sampling. Settings rendering sections no longer launch work on appearance.
  Application foreground events are forwarded as model inputs; hidden/background
  resource polling and late font results are cancelled or rejected in the model.
- CLI copy-login, installation-guide and hook actions emit typed callbacks through
  the parent callback's `didSet` forwarding. The coordinator checks ownership,
  selected section, activation and competing presentations. Retired CLI models
  reject callbacks, reconnect and refresh. Guide failures remain separate from
  probe errors and survive status refreshes.
- Hook writes coalesce in a model-owned task and can finish after navigation.
  Leaving a section cancels reads without invalidating an accepted write;
  disconnect/retirement still reject obsolete write results. Shutdown captures
  mutations before awaiting and cannot clear replacement readers.
- Thirty-two focused tests pass in
  `swift_package_test_2026-09-13T18-27-46-656Z_pid88792_131c4ff3.log`, covering
  view-free section activation, foreground/hidden resource sampling, stale font
  results, repeated inputs, callback gates, error isolation and accepted writes
  across navigation, alongside existing Settings/lifecycle checks.
- Native CLI status and hook recovery pass in
  `test_macos_2026-09-13T18-28-26-914Z_pid89161_d1740587.log`.
  Resources show app/backend samples and resume after navigation in
  `test_macos_2026-09-13T18-29-31-540Z_pid89636_7f5288c7.log`.
  Diagnostics snapshot loading/return pass in
  `test_macos_2026-09-13T18-30-09-407Z_pid89985_d86b7c56.log`.
  Settings save/revert and retained draft/menu navigation pass in
  `test_macos_2026-09-13T18-31-01-721Z_pid90294_d85e26a2.log`.
  The existing WebKit QoS warning remains open.
- Remaining document confirmations, platform actions and runtime ownership continue,
  along with M1–M6 acceptance requirements that lack evidence.

### Board and terminal model state observers — 2026-09-13

- Following Record's guarded `didSet` pattern, root/project state now owns Board
  activation and theme. Leaving the project or Board section cancels navigation
  and releases its surface; equal selection and appearance updates retain it.
  The web Board rendering view no longer handles appearance/change lifecycle work.
- Workspace state supplies terminal activation and fonts. Inventory replacement
  deactivates the old presentation, and shell font observers update retained
  models. Terminal presentation observers keep deferred, coalesced display work
  and latest-state focus checks. Mounting/startup/occlusion remain UI events;
  terminal activation and fonts no longer depend on view `.onChange` handlers.
- Twenty-nine focused model/coordinator tests pass in
  `swift_package_test_2026-09-13T18-40-55-931Z_pid93147_683ac12c.log`, including
  view-free Board navigation/theme, cancelled pending links, terminal replacement,
  hidden font updates, duplicate-input coalescing and existing workspace/deeplink
  coverage. The feature-source audit leaves only three focus-related `.onChange`
  handlers, with no `.task(id:)` handlers or `ObservableObject` wrappers.
- Native Board move/assign/open passes in
  `test_macos_2026-09-13T18-41-31-009Z_pid93509_5de014ed.log`.
  Terminal navigation retention, hide/show keyboard input, restart Cancel/Confirm
  and explicit Quit pass in
  `test_macos_2026-09-13T18-42-26-691Z_pid94047_ccb09647.log`.
  The existing terminal mount publication warning remains unresolved; this phase
  does not close terminal fidelity/performance or other M1–M6 acceptance gates.

### Document close view model and shared coordinator — 2026-09-13

- `EditorCloseViewModel` owns batch buffer freezing, save/discard decisions,
  retry state and rollback. Typed identified callbacks request confirmation from
  a coordinator with an injected AppKit presenter; the document factory creates
  each model. Old or duplicate prompt replies cannot resolve a later request.
- Root and viewer share one close coordinator for individual tabs, session/worktree
  removal and Quit. Presentation ownership is reserved synchronously. Overlapping
  close attempts are rejected, competing root presentations are gated, and queued
  external routes resume after close completion. Workspace tab select/close buttons
  emit typed callbacks resolved against the current owned context.
- Every target freezes before prompting. Cancellation rolls back the locks acquired
  by that attempt, preserving prior locks and buffers. Cleanup is independent of
  caller cancellation, including cancellation-aware editor bridges. Ownership is
  rechecked before synchronous removal; a viewer batch still rescans for files
  opened by a picker while confirmation awaited.
- Thirty-six focused editor/factory/workspace/coordinator/deeplink tests pass in
  `swift_package_test_2026-09-13T18-55-30-137Z_pid98490_deb21308.log`. Coverage includes
  save failure/retry, latest unreported input, duplicate and stale replies, batch
  cancellation, preexisting locks, cancelled callers, ownership loss, overlapping
  tab/Quit requests, newly opened files and queued routes.
- Native editor Save/Cancel/Discard/History passes on the final implementation in
  `test_macos_2026-09-13T18-55-59-094Z_pid98713_0dbdb5fc.log`.
  An earlier run failed after XCTest found the History item and reactivated the app,
  losing its open menu (`test_macos_2026-09-13T18-51-21-760Z_pid96879_fc2f7cdd.log`);
  the unchanged rerun passed (`test_macos_2026-09-13T18-53-05-414Z_pid97552_6e7a97a2.log`).
  Browser find/navigation/close and session-sheet integration pass in
  `test_macos_2026-09-13T18-53-55-954Z_pid97867_80b5f8dd.log`; its existing WebKit QoS
  warning remains open. Remaining platform/runtime extraction and M1–M6 acceptance
  requirements continue separately.

### Tray view model, coordinator and host injection — 2026-09-13

- The tray now renders a factory-created `@Observable` model. Refresh, review,
  saved-tab, window and Quit actions use typed callbacks. The root owns the tray
  coordinator, which calls injected browser/window/popover/Quit dependencies;
  `AppDelegate` forwards popover lifecycle events instead of starting refreshes.
- Guarded model activation refreshes once per open transition. Hidden, unowned or
  retired models reject actions; replacement retires old callbacks and retains no
  runtime/root cycle. Review actions re-resolve current pending rows, acknowledge
  only after browser success and keep failure feedback through refresh. Rendering
  each review row avoids rescanning the full review list.
- Tab resolution uses current inventory and prefers an existing matching session.
  Competing root/AppKit presentations prevent internal tray navigation. Successful
  presentation actions deactivate before invoking the host. Explicit Quit continues
  through the existing termination/document/PTY ownership path.
- Twenty-seven focused tray/workspace/deeplink tests pass in
  `swift_package_test_2026-09-13T19-08-26-137Z_pid3026_b7703701.log`, including factory
  replacement, released owners, stale rows, invalid URLs, browser failures,
  acknowledgment guards, current session resolution and retained tray data.
- Native quiet startup and opening the main window pass in
  `test_macos_2026-09-13T19-07-37-813Z_pid2593_10f54a2f.log` (existing WebKit QoS warning).
  Native session-tab selection, disabled navigation during a project draft, draft
  retention and subsequent plain-tab opening pass in
  `test_macos_2026-09-13T19-08-58-111Z_pid3268_f923dba6.log`.
  Offline Escape dismissal/reopen passes in
  `test_macos_2026-09-13T19-10-01-230Z_pid3693_3a688559.log`; this test now requires
  temporary fixture storage explicitly. Terminal retention, keyboard focus,
  confirmed restart and explicit tray Quit pass in
  `test_macos_2026-09-13T19-10-42-017Z_pid3994_469a0fb7.log`, with the existing terminal
  mount publication warning still open.
- Settings/platform child callbacks, shared notification actions and runtime
  extraction continue, along with the remaining M1–M6 acceptance gates.

### Architecture — login-item callbacks and operation lifetime — 2026-09-13

- Login-item controls emit typed actions through the Settings model's callback
  forwarding. The coordinator requires current ownership, a live runtime, the
  active General section and available presentation before dispatching an action.
- Guarded model activation owns status reads and cancellation of pending System
  Settings opens. Root dialogs cancel pending opens; generations prevent stale
  completion from clearing a newer operation. The platform adapter checks
  cancellation immediately before opening System Settings.
- Accepted registration writes coalesce and drain across navigation and shutdown.
  A replacement Settings model inherits the pending operation, disables its toggle,
  then reads OS status and preserves any registration failure without a second
  write. Retired and unwired models reject new actions.
- Rechecked Record's Search and Profile Settings models: state-driven work belongs
  in model property observers. The TaskHub Swift audit found only three remaining
  view `.onChange` handlers, all adapting keyboard focus, and no `.task(id:)`.
- Verification: 34 focused Swift tests passed in
  `swift_package_test_2026-09-13T19-23-48-244Z_pid8437_54c8983e.log`.
  Native quiet startup/read-only login status passed in
  `test_macos_2026-09-13T19-22-33-156Z_pid7956_8e918b64.log`; Settings save/revert,
  draft retention and menu navigation passed in
  `test_macos_2026-09-13T19-24-47-118Z_pid8818_cd07ac1e.log`.
  The latter emitted XCTest DisplayManager diagnostics but had no test failures.
- These checks use service fixtures and read-only debug UI. Actual packaged login
  registration, approval and logout/login remain M6 acceptance work.

### Notification coordinator, delivery lifetime and native toast — 2026-09-13

- The shared `@Observable` notification model is assembled through an injected
  factory and bound to a root-owned coordinator. Enable, preview and open actions
  use typed callbacks. Permission/preview actions require active General Settings
  or tray and available presentation; retired, unowned and released-runtime
  callbacks cannot act. AppDelegate supplies focus/window presentation only.
- In-app clicks re-resolve current notice IDs; OS clicks remain usable after
  bounded history eviction. Validated browser opens acknowledge reviews only on
  success. Failures retain the toast and show an action error; opening an older
  notice preserves a newer toast. Non-URL activity uses the existing typed deferred
  route queue, including startup readiness and open-draft protection.
- The model owns foreground presentation policy, coalesced permission reads,
  explicit authorization and batch delivery. Generations reject late permission,
  delivery-error and sound continuations. Stop invalidates synchronously and drains
  captured tasks without clearing newer work. Announcement markers survive
  reconnect; old native delegate instances cannot route through new delivery.
- Forty-four focused notification, deeplink, Settings and tray tests passed in
  `swift_package_test_2026-09-13T19-41-14-870Z_pid14177_05410a26.log`. Node fixture
  and shell harness syntax checks pass.
- Native toast click-to-Activity and dismiss-without-navigation pass in
  `test_macos_2026-09-13T19-45-15-126Z_pid15896_f9e8389b.log`. The test exercises
  synthetic SSE through a fixture-only HTTP route and does not request permission.
  It exposed and verified a fix for the full-width plain button's empty-area hit
  testing. The toast now also exposes an accessibility container and distinct
  action/dismiss controls.
- Earlier UI attempts revealed test assumptions about restored selection, runner
  access to temporary files and combined accessible labels. The harness now selects
  Overview explicitly, injects through its test server and queries the button label.
  The failed click before the hit-area correction is recorded in
  `test_macos_2026-09-13T19-43-51-822Z_pid15360_c0e6ea4b.log`.
- Quiet startup, tray opening and read-only native Settings pass in
  `test_macos_2026-09-13T19-46-04-526Z_pid16213_40ade75e.log`.
- Real background OS banner/click and audible sound acceptance remain open, along
  with the terminal and release gates. This phase adds no new permission prompts
  on startup, snapshot refresh or foreground activity.

### Terminal mount appearance publication fixed — 2026-09-13

- A focused failing regression captured AppKit's `setContentView` → appearance
  callback → Ghostty `adopt` → `objectWillChange.send` stack in
  `swift_package_test_2026-09-13T19-49-55-904Z_pid17581_7f62eb85.log`. Fixing that
  path exposed the second stack: SwiftUI's appearance callback publishing inside
  `Update.dispatchActions`, recorded in
  `swift_package_test_2026-09-13T19-53-01-947Z_pid18783_218f4728.log`.
- Added managed wrapper patch `0004-appkit-appearance-publication.patch`. AppKit
  coalesces appearance updates after the view update pass and reads current
  appearance/ownership. SwiftUI forwards deferred requests to wrapper state with
  latest-request and attached view/controller guards. The public imperative adopt
  API stays synchronous. No input, resize, focus or PTY operation is deferred.
- The maintained build applies and fingerprints the new patch; generated dependency
  checkouts were not edited manually. Final input fingerprint:
  `9e9d259cd8ec502ce6995e281e86d133395235e236111e839c4aff5fd3bfbcd3`.
  Native archive SHA-256 remains
  `3f026176322b0295197e27b9c993347fb8b9e219c13ea415c22e909f4ddd509b`.
- Nine focused terminal tests pass in
  `swift_package_test_2026-09-13T19-55-05-043Z_pid19777_963720c3.log`. The new test
  covers both direct AppKit and SwiftUI mounting, rapid light/dark changes,
  detached-view cancellation and reattachment without replacing the surface.
  Existing tests cover hidden parsing, marked text, key/paste encoding, printed
  links, output ordering and presentation/focus policy.
- Native PID retention, navigation, hide/show with keyboard input, cancelled and
  confirmed restart, and explicit Quit pass in
  `test_macos_2026-09-13T19-55-33-838Z_pid20099_bdc8389b.log`. The log contains zero
  publication-during-update warnings, compared with one in the earlier identical
  scenario (`test_macos_2026-09-13T19-10-42-017Z_pid3994_469a0fb7.log`). Existing
  compiler warnings about weak test variables remain unrelated.
- This resolves the previously recorded terminal appearance mount warning. The
  broader M1 hardware/input/fidelity/performance acceptance and M2–M6 release and
  runtime work remain open.

### Native hidden-render measurement — 2026-09-13

- Added maintained native/Swift patches `0005`/`0006` exposing a read-only atomic
  submitted-frame counter. It covers actual encoded-frame submissions from native
  renderer-thread and embedded host draws; reads do not schedule rendering.
- The stress harness excludes mount/occlusion warmup, records ten counters with
  each resource sample, rejects hidden frame submissions and checks visible rendering
  alongside existing output progress, bounded queues and PID/surface identity.
- Nine focused native terminal tests passed, including a real visible-frame positive
  control followed by zero additional frames while hidden input/output continued.
  Log: `swift_package_test_2026-09-13T20-08-48-588Z_pid24595_e7982d5b.log`.
  The final managed rebuild also passed all nine tests:
  `swift_package_test_2026-09-13T20-23-36-817Z_pid29269_14bdecda.log`.
- The release ten-session workload completed **600.50 seconds / 292 samples**.
  All nine hidden counters remained zero; the visible count advanced 14 → 1,664.
  Every ticker progressed, all window samples were visible, and fixture cleanup
  completed. Peak queued output was 60,672 bytes; parser latency p95 was 19.55 ms.
  [Measurement and limits](measurements/native-terminal-render-stress-2026-09-13.md)
  includes the raw samples and build provenance.
- Host RSS grew 128.94 → 174.78 MiB and daemon-tree RSS grew 32.66 → 73.95 MiB.
  No memory plateau or cause is established. This measures hidden native frame
  submissions; it does not complete full-app/Tauri CPU/GPU/RSS comparison, physical
  key-to-display latency, hardware/agent fidelity or the full M1 acceptance gate.

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
