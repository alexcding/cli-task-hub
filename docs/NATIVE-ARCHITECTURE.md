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
`CreationFlowFactory` supplies project editors and new-session models. The live
`NativeCreationFlowFactory` receives its folder-picker dependency; tests inject a
recording factory and fixture services. `AppStore` supplies the current backend,
project/session context and successful-operation callbacks.

Toolbar and menu commands enter the same coordinator. Repeated commands cannot
replace a draft or start a second presentation. Dismissal checks the model's busy
state; completion is tied to the presentation ID, so an old or duplicate callback
cannot dismiss a newer sheet or repeat navigation. Cancelling and reopening creates
a new model. Save failure retains the original model and draft for retry.

`AppCoordinatorSheetView`, `NewProjectSheet` and `NewSessionView` render the supplied
models. They do not construct models, resolve services or navigate after observing
a completion flag. Their button/task closures forward events to model/coordinator
methods. Project validation, persistence, session preparation and error state stay
in their existing ViewModels and services.

Five focused Swift tests pass. The Debug app and UI target compile. The project UI
test and its retry both stop before assertions with XCTest's “Timed out while
enabling automation mode” initialization error. The added project/session
cancel-and-reopen UI assertions remain pending. Diagnostic logs from this attempt
are `test_macos_2026-09-13T11-36-34-916Z_pid60871_2d93edb4.log` and
`test_macos_2026-09-13T11-38-30-176Z_pid61538_ffb4d5a3.log` in the workspace's
XcodeBuildMCP log directory; this is not recorded as a passing UI check.

## Remaining extraction

This is the first architecture phase, not completion of the requested pass:

- Move sidebar/root destinations and titles out of root rendering code. Preserve
  stable session/context IDs and mounted terminal surfaces across navigation.
- Extract session workspace toolbar state, page-address validation, dialog routing,
  editor/Finder/browser actions and removal/build presentation from views into
  feature ViewModels and coordinators.
- Move remaining tray platform actions behind injected dependencies.
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
