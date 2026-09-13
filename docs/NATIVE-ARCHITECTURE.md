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
cleanup callbacks. Their separate presentation lifetimes are described below.

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
lifecycle events. Document activation, appearance and fonts now come from workspace
models rather than rendering `.onChange` handlers (see document presentation below).
Remaining view change handlers bridge focus and terminal/board presentation inputs.
Application observation remains exclusively `@Observable`.

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

## Implemented: build and removal presentation lifetimes

`WorkspaceFeatureFactory` supplies a fresh `BuildDestinationViewModel` for every
build sheet, while `AppStore` retains the existing `BuildWorkspaceViewModel` and
terminal. The destination forwards rendering state and guarded commands through
an identified presentation. Cancelled or completed destinations cannot load, run,
change selection or complete a replacement sheet. Retiring a destination leaves
the build monitor and PTY alive, so Stop still addresses the running build.

Build data access is injected through `BuildServing`. Loads validate presentation
identity and request generation before applying results. Preparation captures
scheme/simulator values and rechecks lifetime before persisting preferences or
submitting a command, including after the asynchronous shell-state check.
Disconnect invalidates requests, clears the terminal reference and cancels the
monitor without interrupting the detached shell. Monitor replacement uses guarded
generation checks and task cancellation in `didSet`.

Removal models use `SessionRemoving` and retire on cancellation or completion.
Duplicate previews are coalesced; late responses cannot restore a retired plan.
Completed models cannot repeat removal. A failure retains its preview for retry,
and an operation that already started retains runtime cleanup and lock release
even if its presentation is retired. Retirement is not a rollback mechanism.

Both destinations emit typed `onAction` completions handled by the coordinator.
Removal cleanup no longer navigates from `AppStore`; the coordinator returns to
Overview only if the selected session was removed. An unrelated selection is
preserved. Views render these models without adding state-driven view observers.

Twenty-eight focused tests pass, including held requests during dismissal,
replacement and disconnect, no command submission after a stale shell check,
running-build retention, retries, single-use removal and cleanup after retirement.
Native UI checks pass for build selection/cancel/reopen/failure recovery, removal
cancel/reopen/confirmation, and actual shell input/navigation/restart/Quit.
Evidence is recorded in `SWIFTUI-PORT.md`; actual Xcode build/run/stop and terminal
fidelity/performance acceptance remain separate requirements. Existing terminal
mount publication and WebKit QoS warnings remain open.

## Implemented: project deletion confirmation in the child coordinator

`ProjectEditorView` emits a typed deletion request. The request carries its project
ID, displayed name and backend-connection generation. The editor validates that
request before persistence; it rejects tokens from another model, a disconnected
backend or a retired project. The view no longer stores confirmation state or
calls deletion directly.

`ProjectCoordinator` owns the identified confirmation and in-flight state.
`ProjectCoordinatorView` renders the project's content and confirmation sheet.
Cancellation and duplicate/stale confirmations cannot start a write. Busy deletion
blocks dismissal; failure keeps the same sheet available for retry. Leaving the
screen ends the presentation while an already started operation finishes against
its original project. Completion preserves an unrelated selected screen.

The root's presentation gate includes child confirmations and active deletions.
Competing creation/restart flows and external deeplinks wait until the project
presentation ends. Parent inventory and runtime ownership are checked before a
child can act; removed or replaced coordinators retire their editor and clear
callbacks. Queued links are retried after cancellation, completion or removal.
No view state observers or legacy observation APIs are introduced.

Twenty-five focused tests pass for cancellation, request replacement, held deletion
failure/retry, stale connections, removed/recreated IDs, released runtime owners,
unrelated navigation and deferred links. Native project create/edit/delete and
warm deeplink deferral through deletion confirmation also pass. Evidence is
recorded in `SWIFTUI-PORT.md`; broader migration acceptance remains open.

## Implemented: project PR action ownership

Project PR rendering no longer receives `DashboardViewModel`, and the root project
destination no longer depends on a Dashboard model being available. The project
model owns its opening state, errors and replaceable operation task. It emits
typed open/browser/copy actions; the child coordinator checks ownership and
presentation availability before delegating those operations to the model's
injected `PageActionServing` service. The native factory supplies page opening,
desktop and clipboard dependencies.

Concurrent opens of one row coalesce; a newer row supersedes the earlier request.
Changing section/state, leaving the project, opening a dialog, disconnecting or
retiring cancels pending PR navigation. Late failures cannot replace a newer
action's error. Retired project models cannot reconnect or resume operations.
`AppStore.openPage` checks cancellation before selecting an existing session and
after an awaited tab save. A cancelled save may have persisted its tab; it cannot
subsequently navigate or overwrite the current inventory with that response.

Dashboard and project requests share the row's metadata conversion. Authored PRs
remain Mine, review-orbit PRs remain Review, and unrelated project PRs use Other.
An explicit `awaitingMyReview: false` overrides a raw review category. The strict
tray notification classification is unchanged.

Focused tests cover local errors, retry, injected dependencies, coalescing,
supersession, ownership, lifecycle cancellation and classification. A native UI
test holds the real tab-save response, opens a project draft, releases the response,
and verifies the draft and original navigation survive before retrying the PR.
Twenty-six focused tests and native project, Dashboard and web Sprint Board
opening checks pass. Current evidence is recorded in `SWIFTUI-PORT.md`.

## Implemented: ticket and board navigation callbacks

Native Jira tickets and the web Sprint Board emit typed actions through the project
model's callback to its coordinator. Ownership, the active section and presentation
availability are checked before operations reach the injected page-action service.
Ticket actions resolve the current visible key; board messages retain their frame,
document and URL checks and must come from the currently mounted webview.

Each surface has its own `PageActionViewModel` for opening, cancellation and error
feedback. Duplicate opens coalesce and newer opens supersede earlier tasks. Leaving,
changing sections, opening a dialog, disconnecting or retiring cancels navigation.
Board suspension and ticket filter/site changes also cancel it. Ticket mutations and
search/project drafts remain independent. Retired children cannot reconnect or open
pages; stopped ticket discovery cannot later clear a replacement connection.

The native factory injects page, browser and clipboard operations into all project
surfaces. Views render navigation feedback and emit synchronous open actions; they
do not create page-opening tasks. Focused model/coordinator tests and held-response
native acceptance are recorded in `SWIFTUI-PORT.md`.

Project PR lists now use snapshots for every state, with background revalidation
and explicit status metadata. Merged/Closed/All remain a latest-30 history cache
separate from complete open snapshots and merge automation.

## Implemented: Dashboard coordinator and factory

`DashboardFeatureFactory` assembles the observable model with its injected page
action service. `AppCoordinator` installs and owns its child coordinator, and
`AppStore` reads the current model through that coordinator. Replacing the child
retires the old model and clears its callbacks and pending operations.

Dashboard open/browser/copy callbacks resolve current visible rows after ownership,
active-destination and presentation checks. Per-surface navigation uses the shared
action model; failures remain separate from snapshot errors. Selection changes and
accepted creation/build/removal/restart presentations cancel pending page opens.
Search/project/filter setters cancel them too, and a removed row is invalidated by
the incoming snapshot. Repeated values and rejected presentations preserve the
current intent. Views render feedback and invoke synchronous model actions.

Connection generations protect snapshot state and task cleanup during reconnect.
An older asynchronous stop cannot clear a replacement connection. Cached browser
and clipboard actions remain available offline; native opens show connection feedback.
Focused tests
and native Dashboard acceptance are recorded in `SWIFTUI-PORT.md`.

## Implemented: Activity coordinator and confirmed clear lifetime

`NativeLogsFeatureFactory` injects page actions and clipboard access. The root
coordinator owns `LogsCoordinator` and its `@Observable` model. Activity emits typed
open/copy/clear callbacks; the coordinator checks ownership, selected destination
and presentation availability before dispatching them. Opening resolves current
visible rows and uses the shared cancellable navigation model. Navigation failures
remain separate from snapshot and clear failures.

Category, error level and search changes react in guarded model `didSet` observers.
Views bind directly and render state. Unchanged assignments preserve pending work;
changed inputs, root navigation, accepted dialogs and retirement cancel stale opens.

Clear confirmation is an identified request capturing category, model identity and
connection. Cancellation invalidates the request, duplicate confirmations cannot
start another write, and failed writes preserve the same request for retry. Snapshot
refreshes do not erase clear feedback. A reconnect invalidates confirmation; a write
already started may finish but cannot delete rows from the replacement connection.
Successful clearing invalidates pending reads before refreshing, without waiting for
an uncooperative old transport. Root presentations and deeplinks respect the child
confirmation and any outstanding write.

Focused model/coordinator tests and native UI evidence are recorded in
`SWIFTUI-PORT.md`.

## Implemented: model-owned document presentation

`SessionWorkspaceViewModel` derives each document's `DocumentPresentation` from
workspace activity, pane, review section, selected file, restoration and connection
state. Context property observers and runtime callbacks deliver those inputs even
without a mounted SwiftUI view. Replaced diff/history models are deactivated before
the replacement receives current state. Shell theme and document-font observers
update workspace models directly.

The diff, history and editor models react through guarded `presentation.didSet`.
Activation starts their existing loading paths; deactivation releases diff/history
surfaces and lets the editor retain dirty buffers under its existing close/save
rules. Reassigning identical inputs does nothing. Style-only updates keep the
surface, selection, pagination and buffer intact. History forwards current
presentation to newly loaded immutable patches in its own property observer.

The three rendering views no longer have activation/theme/font parameters or
change handlers. History retains only its focus adapter for the Find command.
Editor retry is a model action, and connecting a previously selected file resumes
loading without requiring another view appearance. Restoration suppresses loading
until the selected document is resolved.

Focused model tests and native acceptance evidence are recorded in
`SWIFTUI-PORT.md`.

## Implemented: Settings factory and save-completion coordinator

`NativeSettingsFeatureFactory` assembles Settings and its child models with injected
desktop, clipboard, login-item and font-catalog dependencies. `AppStore` reads the
Settings model through the root-owned `SettingsCoordinator`. Successful saves emit
typed callbacks; the coordinator serializes completion delivery to the application
runtime. Leaving Settings preserves an accepted save and its configuration effects.
Replacing the model retires it and rejects queued or late completions.

Settings read and connection generations protect draft/baseline state and task
cleanup. Saving invalidates older reads without waiting for an uncooperative
transport. Save errors are independent of refresh errors; a refresh cannot erase
retry feedback. Guarded draft observers invalidate the saved indicator on new edits,
while an edit during a write remains dirty against the submitted baseline.

Settings disconnects before awaiting shutdown. CLI probes/hooks also detach their
reads synchronously and guard result/cleanup by connection generation, preventing
an old stop from clearing a new service or in-flight probe. Child feature navigation
and platform action ownership remain part of the remaining extraction below.

## Implemented: document feature factory

The injected `DocumentFeatureFactory` assembles editors, editor surfaces, working
diffs, git actions, history models and immutable patches. `AppStore`, `ViewerStore`
and `WorkspaceContext` use the same factory. Snapshot replacement and legacy file
imports retain it; opening an existing standardized file path reuses its model.
Promotion moves the existing context/documents without invoking the factory again.

History retains its factory for asynchronously loaded patches, and working diff
assembly passes it through to git-action creation. This preserves overridden
dependencies for nested models. Historical patches have no mutation actions or
working-file opening capability. Editor surfaces are created lazily through the
factory with the connected backend origin, preserving the existing buffer/save
contract and clean-versus-dirty suspension behavior.

Tests cover backend restoration with an injected URLSession/editor surface, path
deduplication, reopen, dirty-buffer promotion, snapshot replacement, legacy import,
read-only nested patches and a working commit refreshing its owning diff. Native
acceptance evidence is recorded in `SWIFTUI-PORT.md`.

## Implemented: Settings section lifetime and CLI callbacks

The root coordinator delivers Settings activation. Guarded `active` and `section`
observers in `SettingsViewModel` own section reads, diagnostic visibility and
resource polling. Leaving a section cancels its reads without disconnecting the
service. Font requests have generation-protected cleanup so a late catalogue reply
cannot replace a newly selected section's result. Application-active events forward
one input into the model; resource foreground policy and login-status refresh remain
model decisions. Rendering Settings sections no longer start work on appearance.

CLI copy, guide and hook buttons emit typed callbacks. The parent forwards its
current callback through `onAction.didSet`; the Settings coordinator checks current
ownership, section, activity and presentation availability before dispatching an
action. CLI retirement rejects late requests and reconnect attempts. Navigation
feedback remains separate from probe errors, so refreshing status preserves it.

Hook writes coalesce in a model-owned task. Section changes cancel reads while
allowing an accepted write to finish; connection replacement invalidates old write
results. Shutdown waits for captured mutations and does not clear replacement
reads. Remaining platform and document confirmation ownership is tracked below.

## Implemented: Board and terminal state observers

Root project selection and appearance feed `ProjectPageViewModel`. Its guarded
active, section and appearance observers drive the web Board model. The Board owns
surface creation/release and cancels pending ticket navigation when hidden; equal
inputs and theme changes preserve the existing visible surface. `WebBoardView`
only renders the supplied model, with no appearance/change lifecycle handlers.

The workspace model supplies terminal activation and font state. Terminal inventory
replacement deactivates the old presentation, and shell font observers update
retained workspace models even while hidden. `TerminalPaneViewModel` reacts through
guarded `presentation.didSet`, retaining deferred, coalesced AppKit display/font
updates and focus checks against the latest mounted/visible state. View mounting,
startup and window occlusion remain explicit UI event forwarding; navigation and
font reactions no longer depend on view `.onChange` handlers. Presentation changes
do not start, stop or replace detached shells.

The remaining three feature-view `.onChange` handlers synchronize address editing
focus or request find-field focus. Feature sources contain no `.task(id:)`
handlers or `ObservableObject` wrappers. Runtime/platform extraction and terminal
acceptance still have separate outstanding work.

## Implemented: document close ownership

`EditorCloseViewModel` owns batch freezing, dirty-buffer decisions, save retries
and rollback. It emits typed, identified prompt requests through `onAction`; the
coordinator presents them using an injected `EditorClosePresenting` dependency and
returns the matching choice. Old or duplicate responses cannot resolve a later
prompt. `DocumentFeatureFactory` assembles a fresh model for each close attempt.

The root and viewer share one `EditorCloseCoordinator` across individual tabs,
session/worktree removal and Quit. Requests reserve presentation ownership before
starting asynchronous work. Concurrent attempts are rejected; root presentations
and external deep links wait until the owning close flow ends. Workspace tab
buttons emit typed select/close actions; the root resolves IDs against the current
owned context and checks presentation availability before acting.

Every target buffer is frozen before the first prompt. Cancellation or loss of
ownership rolls back locks acquired by that attempt; a lock owned by another
attempt is preserved. Caller cancellation cannot approve a late prompt response,
and rollback finishes in a cleanup task that is independent of that cancellation.
After all approvals, the coordinator rechecks ownership and removes the approved
documents synchronously before yielding. The viewer repeats its batch scan to
include a file picker that completed while confirmation awaited. A failed save
preserves the buffer and returns a fresh prompt with its error for retry.

## Remaining extraction

The architecture extraction remains in progress:

- Extend the typed action-callback pattern to the remaining feature/completion
  flows and child coordinators as their runtime dependencies are extracted.
- Complete the remaining terminal/UI-adapter audit, including the mount warning,
  while retaining native input and emulator ownership.
- Finish tray navigation/window coordination and move any remaining platform
  actions behind injected dependencies.
- `AppStore` still constructs several concrete backend/platform services. Complete
  child presentation ownership/model retirement as the remaining shared action
  services are extracted.
- Separate application runtime/backend lifecycle from feature navigation without
  changing ownership, cancellation, detached-shell retention or update shutdown.
- Audit every rendering view and web/AppKit adapter for remaining business rules.
  AppKit representable coordinators remain UI adapters; they are distinct from
  application navigation coordinators.

The migration's outstanding release, hardware and interactive terminal acceptance
gates remain tracked in `SWIFTUI-PORT.md`. Starting this extraction does not mark
those gates passed or change the web Sprint Board decision.
