# Native coordinator, ViewModel and injection boundaries

The macOS port uses the separation requested from `elevate-ios`: a coordinator owns
navigation and model lifetime, a ViewModel owns feature state and operations, and a
view renders those models and forwards user or lifecycle events. The native
Dashboard, Cocoa sidebar and native terminal remain; Sprint Board, diff and editor
remain focused web surfaces.

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

## Remaining extraction

The architecture extraction remains in progress:

- Move sidebar/root destinations and titles out of root rendering code. Preserve
  stable session/context IDs and mounted terminal surfaces across navigation.
- Extract the remaining session workspace toolbar state, dialog routing,
  editor actions and removal/build presentation from views into
  feature ViewModels and coordinators.
- Finish tray navigation/window coordination and move any remaining platform
  actions behind injected dependencies.
- Expand factories to project, settings, document and workspace feature assembly;
  `AppStore` still constructs several concrete services and models.
- Separate application runtime/backend lifecycle from feature navigation without
  changing ownership, cancellation, detached-shell retention or update shutdown.
- Audit every rendering view and web/AppKit adapter for remaining business rules.
  AppKit representable coordinators remain UI adapters; they are distinct from
  application navigation coordinators.

The migration's outstanding release, hardware and interactive terminal acceptance
gates remain tracked in `SWIFTUI-PORT.md`. Starting this extraction does not mark
those gates passed or change the web Sprint Board decision.
