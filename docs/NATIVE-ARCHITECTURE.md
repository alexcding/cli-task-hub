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

TaskHub's root and workspace ViewModels now emit typed action callbacks, bound to
the coordinator before rendering. Future external links should resolve through
injected parsers to the same navigation routes, queue while backend state is not
ready, and preserve busy operation dialogs and terminal identity. Native inbound
URL handling and route-chain consumption have not yet been implemented.

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

## Remaining extraction

The architecture extraction remains in progress:

- Add typed URL parsing and route-chain dispatch using the inspected `record-ios`
  pattern, including backend-readiness deferral and native AppKit URL delivery.
- Extend the typed action-callback pattern to the remaining feature/completion
  flows and child coordinators as their runtime dependencies are extracted.
- Complete the remaining terminal/UI-adapter audit, including the mount warning,
  while retaining native input and emulator ownership.
- Finish tray navigation/window coordination and move any remaining platform
  actions behind injected dependencies.
- Expand factories to project, settings and document feature assembly;
  `AppStore` still constructs several concrete services and models.
- Separate application runtime/backend lifecycle from feature navigation without
  changing ownership, cancellation, detached-shell retention or update shutdown.
- Audit every rendering view and web/AppKit adapter for remaining business rules.
  AppKit representable coordinators remain UI adapters; they are distinct from
  application navigation coordinators.

The migration's outstanding release, hardware and interactive terminal acceptance
gates remain tracked in `SWIFTUI-PORT.md`. Starting this extraction does not mark
those gates passed or change the web Sprint Board decision.
