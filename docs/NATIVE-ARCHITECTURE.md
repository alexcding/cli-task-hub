# Native coordinator, ViewModel and injection boundaries

The macOS port uses the separation requested from `elevate-ios`: a coordinator owns
navigation and model lifetime, a ViewModel owns feature state and operations, and a
view renders those models and forwards user or lifecycle events. The native
Dashboard, Cocoa sidebar and native terminal remain; Sprint Board, diff and editor
remain focused web surfaces.

Application ViewModels and coordinators use Swift Observation (`@Observable`),
with `@Bindable` where a rendering view needs bindings. Do not introduce
`ObservableObject`, `@Published`, `@StateObject` or `@ObservedObject` into TaskHub's
application layer. The pinned third-party Ghostty wrapper internally uses the older
Combine observation API; that dependency implementation is not the application's
ViewModel pattern. An audit of `TaskHubPackage/Sources` and `TaskHub` on 2026-09-13
found no legacy observation declarations in TaskHub-owned Swift code.

State-driven work belongs in the owning ViewModel's guarded `didSet` observers or
explicit model methods. Views must not use `.onChange` (or `.task(id:)`) to drive
filter requests, dependent data loading or synchronization of model state.
`record-ios/Record/Scenes/Search/SearchViewModel.swift` demonstrates this with
`query.didSet` starting search and `searchTask.didSet` cancelling the old task.
View-only focus, environment and AppKit lifecycle events may still be forwarded
to models/adapters; the rendering layer must not decide their business behavior.

## Reference inspected

The reference checkout is `/Users/accedo/Workspace/elevate-ios`. These files informed
the first implementation:

- `Assemble/Multiplatform/Sources/Components/Coordinator/Coordinatable.swift` defines
  typed routes, destinations and navigation state.
- `Coordinators/Search/SearchCoordinator.swift` creates model-bearing destinations;
  `SearchCoordinatorView.swift` only maps those destinations to rendering views.
- `Scenes/Search/SearchViewModel.swift` receives services through dependency
  injection and implements feature behavior.
- `DI/Container.swift` registers service factories; `Coordinators/App/AppCoordinator.swift`
  coordinates application-level flows.

TaskHub uses explicit initializer injection and protocol-based factories for the
first extraction. It does not need the reference application's global container,
navigation-stack library or iOS-specific dependencies to preserve these boundaries.

The additional reference `/Users/accedo/Workspace/record-ios` was inspected for
action callbacks and deeplinks:

- `Record/Coordinators/Abstractions/Action.swift` separates ViewModel intent from
  navigation routes. `Record/Coordinators/Search/SearchCoordinator.swift` installs
  `viewModel.action = { [weak self] in self?.handle($0) }`, handles owned actions and
  forwards other domains to its parent.
- `Record/Coordinators/Abstractions/Route.swift` is the shared typed route model.
  `Coordinators/Abstractions/Router/DeepLink.swift` carries an ordered route chain with `first` and
  `droppingFirst()`; coordinators consume their segment and forward the remainder.
- `Coordinators/Abstractions/Router/Router.swift` uses injected handlers for URL parsing and printing.
  Its adjacent `Routable.swift` assembles the default handlers. URL handling does not
  live in rendering views or content ViewModels.
- `Record/Coordinators/App/AppCoordinator+Routing.swift` is the common entry for
  resolved external links and queues protected links until startup/profile state
  allows navigation. Its platform app only forwards incoming URLs.
- `Record/Services/DeepLinking/RecordDeepLinkRouter.swift` and
  `RecordDeepLinkResolver.swift` validate external destinations, bound resolution
  and deduplication, and suppress stale asynchronous resolutions. The OneLink and
  authentication details are specific to Record and are not TaskHub dependencies.
- `Record/Scenes/Search/SearchViewModel.swift` guards `query.didSet`, starts
  debounced work in the model and cancels a replaced task through `didSet`.
  `Scenes/Profile/Settings/SettingsViewModel.swift` and its `DownloadSettings`
  model persist selection/preferences in property observers; the latter also
  updates its injected download scheduler there.
- `Record/Scenes/Auth/SignInViewModel.swift` forwards a newly assigned action
  callback to its child session controller through `action.didSet`, keeping the
  coordinator callback chain synchronized without a view observer.

TaskHub's root and workspace ViewModels emit typed action callbacks, bound to
the coordinator before rendering. External links resolve through injected parsers
to typed navigation routes, queue while backend state is not ready, and preserve
operation dialogs and terminal identity. Implementation details follow below.

## Implemented: creation flows

`AppCoordinator` owns one identified sheet destination containing its ViewModel.
`CreationFlowFactory` supplies project editors, new-session models and Add Page models. The live
`NativeCreationFlowFactory` receives its folder-picker dependency; tests inject a
recording factory and fixture services. `AppStore` supplies the current backend,
project/session context and successful-operation callbacks.

Toolbar and menu commands enter the same coordinator. Repeated commands cannot
replace a draft or start a second presentation. Dismissal checks the model's busy
state; completion is tied to the presentation ID, so an old or duplicate callback
cannot dismiss a newer sheet or repeat navigation. Cancelling and reopening creates
a new model. Save failure retains the original model and draft for retry.

`AppCoordinatorSheetView`, `NewProjectSheet`, `NewSessionView` and `AddPageSheet` render the supplied
models. They do not construct models, resolve services or navigate after observing
a completion flag. Their button/task closures forward events to model/coordinator
methods. Project validation, persistence, session preparation and error state stay
in their existing ViewModels and services.

Factories construct creation models; the coordinator installs typed `onAction`
handlers for project saves, session creation and page opening. Closing or completing
an identified creation sheet permanently retires its model, clears its callback
and disables future operations. A retained editor cannot be revived by reconnecting
its service. Successful creation is also single-use without a coordinator; ordinary
existing-project editing remains reusable until deletion or snapshot removal.

Session preparation uses an injected `SessionCreating` service. A guarded
`projectID.didSet` invalidates pending resolution, and a response must match both
its generation and draft before creation may proceed. Dismissed models reject
late lookup results and cannot restart reference loading. Failure preserves an
active draft for retry. These checks prevent new obsolete operations; they do not
roll back a backend write that already started. Busy writes still block dismissal.
Build models are cached runtime features, while removal models carry operation
cleanup callbacks. Their presentation lifetimes are a separate extraction; this
phase does not retire either when its sheet closes.

The lifetime follow-up passes 24 focused tests and native UI checks for project
create/edit/delete, browser/session creation and removal, and cold/warm deeplinks
with an open draft. Current evidence is recorded in `SWIFTUI-PORT.md`.

Five focused Swift tests passed in the first phase. The Debug app and UI target compiled. The initial project UI
test and its retry stopped before assertions with XCTest's “Timed out while
enabling automation mode” initialization error. The added project/session
cancel-and-reopen UI assertions were initially pending. Diagnostic logs from that attempt
are `test_macos_2026-09-13T11-36-34-916Z_pid60871_2d93edb4.log` and
`test_macos_2026-09-13T11-38-30-176Z_pid61538_ffb4d5a3.log` in the workspace's
XcodeBuildMCP log directory; this is not recorded as a passing UI check.

## Implemented: browser controls and desktop actions

Each `BrowserPage` owns one `BrowserControlsViewModel`. The controls weakly reference
the page, so a retained action cannot keep a closed WebKit page alive. Address
drafts, URL validation, Stop/Reload selection, find actions, external-browser
opening and failure-specific retry are implemented in the model. The view retains
focus state and forwards focus, appearance and URL-change events. Redirects do not
overwrite the address while the user is editing it; external opening uses the
committed page URL, not the address draft.

`BrowserPageFactory` carries injected `DesktopActions` through `ViewerStore`, new
contexts, saved-snapshot restoration, newly opened pages and popup creation.
`NativeDesktopActions` implements browser opening and Finder reveal. The app's
Dashboard, CLI/Jira/board links, terminal external links, tray reviews and worktree
reveal share this dependency. Tray opening/acknowledgment ordering and tab grouping
now live outside the rendering view.

Add Page uses the same identified sheet coordinator as project/session creation.
Its ViewModel validates and trims the address before requesting an open. A failed
open keeps the draft visible, and actions retained from a dismissed sheet cannot
open a page or dismiss a later presentation. Cancelling and reopening begins with
a fresh address. The request checks that its originating workspace is still owned
by the viewer before opening a page.

Eleven focused tests pass, including actual WebKit navigation, find, cookie
retention, cache eviction/restoration, model lifetime, factory injection and sheet
completion. After correcting a runtime framework search-path defect found during
direct launch, native UI execution is working again. Add Page validation/open/close,
browser find/navigation, session cancel/reopen and session removal passed in
`test_macos_2026-09-13T13-57-27-853Z_pid96134_85541037.log`. The session title now has
a stable accessibility identifier after the first UI run could not locate it by
its display label. Project creation also passes cancel/reopen, save, edit and
confirmed deletion in `test_macos_2026-09-13T13-59-03-171Z_pid97035_153685ef.log`.
These runs close the first creation phase's pending UI checks. Further validation
and the packaging correction are recorded in `SWIFTUI-PORT.md`.

## Implemented: workspace presentation and operation dialogs

`SessionWorkspaceViewModel` computes pane visibility, toolbar availability,
workspace titles, review refresh inputs and history reopening. It receives a
`WorkspaceServing` dependency; the live `AppStore` adapter supplies current session,
project and feature models. The model emits typed actions through `onAction`.
`AppCoordinator` handles build/removal/restart presentations and delegates operations
to the runtime service. Retained actions are checked against the viewer's current
context before they can act.

`WorkspaceFeatureFactory` creates workspace, build and removal models. The viewer
configures each context once, before rendering, and the context owns its workspace
model. The model weakly references the context and service. Moving a page context
into a session retains that model and all live documents/pages; no terminal or
WebKit surface is reconstructed by this extraction.

Restart confirmations, build destinations and session-removal sheets now belong
to `AppCoordinator`. Competing presentations are blocked, stale confirmation IDs
cannot act, and busy build/removal operations cannot be dismissed. Success callbacks
close the identified presentation; failed operations leave it available for retry.
Build terminal factories may throw, so a runtime disappearing during preparation
produces an error rather than an unowned-reference crash.

`SessionWorkspaceView`, `BuildDestinationView` and `SessionRemovalView` render models
and forward actions/lifecycle events. The workspace view no longer reads `AppStore`,
constructs feature models, decides which project/session an action uses or owns
operation dialogs. Terminal surfaces remain in the same retained split hierarchy.

Twelve focused Swift tests pass for command gating, factory/model lifetime, context
promotion with a retained document, stale restart confirmations, busy sheets and
build success/failure. Native UI tests pass for browser navigation and session
creation/removal, editor save/cancel/discard/history, and a real fixture shell:
navigation and cancelled restart preserve its PID, confirmed restart replaces it,
and explicit Quit exits the app. The UI script now supplies the helper path to
XCTest's copied app and cleans up only its verified fixture daemon after failures.
The shell run emitted a SwiftUI publication-during-update warning; its source still
needs investigation in the terminal adapter pass. This is not a complete terminal
fidelity or performance acceptance result.

## Implemented: terminal presentation model

Each `TerminalSession` creates and retains a `TerminalPaneViewModel` before the view
renders. The model uses `@Observable` and an injected `TerminalPaneServing` protocol,
weakly referencing its session. The view forwards visibility, activity, appearance,
font and window-occlusion events. The model coalesces display/font updates after
the current update pass and evaluates focus against the latest mounted, active,
visible and ready state. The native adapter resolves the owning window and changes
focus/visibility without replacing the emulator or touching PTY ownership.

The connection's ready callback uses the same presentation model. A queued focus
request cannot acquire the terminal after the model has been deactivated. Removing
the rendering view suspends its drawing; it does not disconnect or kill its shell.

Seven focused Swift tests pass, including the real-daemon reconnect suite's idle,
unacknowledged keyboard input, unacknowledged interrupt and missing-shell cases.
The native UI check verifies hide/show and actual keyboard input into the same
fixture shell in addition to navigation, cancellation, restart and Quit.
The mount-time publication warning remains reproducible. Experiments deferring
the wrapper's theme adoption and nested hosting updates did not remove it and were
reverted; neither Ghostty's patch set nor split geometry changes in this phase.
The warning's origin and terminal hardware/performance acceptance remain open.

## Implemented: root presentation and coordinator action callbacks

`AppCoordinator` owns sidebar selection and its injected persistence service, using
the existing `sidebar.selection` JSON format. Sidebar, menu and programmatic
navigation use the same selection entry point. A missing session deactivates the
previous workspace instead of leaving an unrelated terminal visible.

`RootFeatureFactory` supplies one `RootViewModel`. It computes titles, pin state,
model-bearing rendering destinations and the list of all prepared workspaces,
preserving the existing context IDs and mounted terminal hierarchy. Root actions
are emitted through `onAction` and handled by the coordinator; an obsolete root
callback cannot navigate a replacement root. Neither the root nor workspace
ViewModel references its coordinator. The injected runtime services own operations.

`ContentView` is the public scene entry and `AppCoordinatorView` renders the supplied
models and coordinator presentations. The rendering code no longer looks up
projects/sessions, computes sidebar pin membership, parses tab URLs, chooses an
operation's target or assembles feature models. It retains the Cocoa sidebar,
native Dashboard and focused web Sprint Board.

Twelve focused Swift tests pass for callback dispatch, stale root/context rejection,
factory injection, selection persistence and retained workspace identity. Native UI
tests pass for the Dashboard, web Sprint Board, Settings/menu navigation and actual
shell navigation, keyboard input, cancelled/confirmed restart and Quit. The existing
terminal mount publication warning and WebKit QoS warning remain unresolved.

## Implemented: native deeplink routing

`TaskHubRouter` parses and prints the `taskhub://app` origin using injected root,
project and session handlers. `DeepLink` is an immutable ordered chain. The root
coordinator selects an existing destination and forwards a project section to its
factory-created `ProjectCoordinator`, retaining the existing project model.

Supported paths are `/overview`, `/activity`, `/settings`, `/terminal`,
`/sessions/<id>` and `/projects/<id>` with an optional `/prs`, `/tickets`, `/board`,
`/workflows`, `/automation` or `/settings` section. IDs use ASCII unreserved
characters, up to 256 bytes. Credentials, ports, queries, fragments, escaped or
empty path segments, unknown sections and oversized URLs are rejected. URLs do
not accept commands, file paths, arbitrary web destinations or session creation.
Selecting a session/terminal does not itself open a shell.

The AppKit delegate forwards URL events and brings the window forward, including
quiet launches. `CFBundleURLTypes` registers the scheme. The coordinator retains
the latest valid link until a complete project/session/tab snapshot has loaded;
stop, reconnect and failed refresh suspend dispatch. It revalidates IDs against the
current snapshot and reports a missing target without replacing the current view.

External links wait for coordinator presentations and native sheets/modal windows.
They never dismiss a draft or redirect a confirmation's original operation.
Completion and AppKit sheet-end events retry dispatch after the originating
callbacks run. Explicit sidebar/main-menu navigation cancels an older queued link.

Twelve focused Swift tests pass, including URL round trips and malformed URLs,
handler/factory injection, readiness, removed targets, child lifetime, latest-link
replacement and presentation ordering. Native UI verification passes for actual
cold and warm URL delivery, a quiet launch opening its session, draft preservation,
deferred navigation after cancellation, project tickets and missing targets. The
test verifies warm delivery stays in the same process; selecting the session leaves
its shell unopened. Broader terminal and release acceptance remain separate gates.

## Implemented: state reactions in observable models

Following Record's guarded property-observer pattern, Activity category/error
filters refresh through `LogsViewModel.didSet`. Project PR state and new-session
project selection own their replacement tasks, cancelling the previous task and
rejecting obsolete responses. Changing a session's project immediately clears
dependent base/worktree values while retaining the entered branch. Reassigning an
unchanged value does not issue another request or reset the draft.

`BrowserPage.url.didSet` synchronizes its controls without requiring a mounted view.
Controls preserve an address being edited and synchronize on blur. Terminal
visibility and surface-generation changes notify the retained presentation model
directly; deferred drawing/focus policy and detached-shell ownership are preserved.

The viewer store owns active workspace state. Context pane/review-section changes,
backend connection/session changes and Dashboard snapshot changes notify workspace
models, which deduplicate review inputs and prepare only active reviews. Views no
longer watch these model values to trigger business work. Context promotion retains
the model and its documents; removed/absorbed contexts lose activity.

No rendering `.task(id:)` remains. Initial appearance/cancellation still forwards
lifecycle events. Remaining `.onChange` handlers adapt SwiftUI focus, environment
appearance/fonts and mounted surface visibility; those are UI events, not data
request triggers. Application observation remains exclusively `@Observable`.

Twenty-two focused tests pass, including automatic model loading, cancellation,
repeated-value guards, stale responses, context promotion and real WebKit address
synchronization. Native UI checks pass for actual shell input/navigation/restart,
Activity filtering/confirmed clearing, browser/session creation and removal, and
history section changes/pagination/read-only patches. The existing terminal mount
publication warning and WebKit QoS warning remain open.

## Implemented: project feature factory and coordinator callbacks

`NativeProjectFeatureFactory` assembles project, editor, web board, tickets,
workflow and automation models from a protocol-based service bundle and injected
creation, desktop and clipboard dependencies. `AppStore` supplies live services
and runtime operations; it no longer assembles project feature models.

`AppCoordinator` owns the project-coordinator inventory. A project is constructed
once and retained across sidebar/menu/deeplink navigation, preserving section
selection and unsaved drafts. The project picker emits a typed ViewModel action;
the child coordinator consumes it through the same section handler used by
deeplinks. Views do not mutate section navigation directly.

Project editor, workflow and automation completions are typed `onAction` callbacks.
The parent model's `onAction.didSet` forwards the current callback to its children
by value, following Record's callback-rebinding pattern without retaining the
parent. The project coordinator forwards successful saves/deletions to its parent,
which validates the project ID and exact model identity before updating runtime
state. An obsolete coordinator or a callback for another project cannot act.

Saving an inactive project updates its data without redirecting the current screen.
Deletion navigates to Overview only when that project is selected. Removed snapshot
IDs retire their coordinator and feature services; recreating an ID creates fresh
models. A newer refresh request supersedes an older in-flight snapshot before its
inventory is applied, preventing a pre-save batch from retiring newly created
models. Snapshot reads still use the existing backend API and SWR sync ownership.

Twenty-three focused tests pass for factory reuse/injection, current-callback
forwarding, parent lifetime, stale completions, deleted/recreated IDs, creation
flows, workflow writes, automation and deeplinks. Native UI checks pass for project
create/edit/delete, workflow ordering/save/draft retention, automation recovery,
web board movement/assignment/native opening and cold/warm deeplink delivery.
The broader terminal and release gates remain open.

## Remaining extraction

The architecture extraction remains in progress:

- Extend the typed action-callback pattern to the remaining feature/completion
  flows and child coordinators as their runtime dependencies are extracted.
- Complete the remaining terminal/UI-adapter audit, including the mount warning,
  while retaining native input and emulator ownership.
- Finish tray navigation/window coordination and move any remaining platform
  actions behind injected dependencies.
- Expand factories to settings and document feature assembly;
  `AppStore` still constructs several concrete services and models. Complete
  child presentation ownership/model retirement and project PR/Jira/board action
  forwarding as the remaining shared action services are extracted. Add separate
  presentation lifetimes for cached build models and removal operations, and move
  project deletion confirmation into its child coordinator.
- Separate application runtime/backend lifecycle from feature navigation without
  changing ownership, cancellation, detached-shell retention or update shutdown.
- Audit every rendering view and web/AppKit adapter for remaining business rules.
  AppKit representable coordinators remain UI adapters; they are distinct from
  application navigation coordinators.

The migration's outstanding release, hardware and interactive terminal acceptance
gates remain tracked in `SWIFTUI-PORT.md`. Starting this extraction does not mark
those gates passed or change the web Sprint Board decision.
