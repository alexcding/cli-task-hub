import Foundation
import Observation

/// The window's coordinator. Owns the sidebar selection, the current `root` destination
/// it maps to, the child coordinators behind each screen, and app-wide presentations.
/// Follows record-ios: route -> model-bearing destination -> `Destination.view()`.
@MainActor @Observable final class AppCoordinator: Coordinatable {
    var root: Destination = .none
    var path: [Destination] = []
    @ObservationIgnored var action: ((Action) -> Void)?

    struct Sheet: Identifiable {
        enum Destination {
            case newProject(ProjectEditorViewModel)
            case newSession(NewSessionViewModel)
            case removal(SessionRemovalViewModel)
            case build(BuildDestinationViewModel)
        }
        let id: UUID
        let destination: Destination

        @MainActor func retire() {
            switch destination {
            case .newProject(let model): model.retire()
            case .newSession(let model): model.retire()
            case .removal(let model): model.retire()
            case .build(let model): model.retire()
            }
        }

        @MainActor var canDismiss: Bool {
            switch destination {
            case .newProject(let model): !model.busy
            case .newSession(let model): !model.creating
            case .removal(let model): !model.removing
            case .build(let model): !model.starting
            }
        }
    }

    private(set) var sheet: Sheet?
    struct RestartConfirmation: Identifiable {
        let id = UUID()
        let perform: () -> Void
    }
    private(set) var restartConfirmation: RestartConfirmation?
    var canPresent: Bool {
        sheet == nil && restartConfirmation == nil && !browserDialogCoordinator.isPresenting && !documentCloseCoordinator.isPresenting && !fileOpenCoordinator.isPresenting && !hasDocumentPresentation() && logsCoordinator?.isPresenting != true && !projectCoordinators.values.contains { $0.isPresenting }
    }
    @ObservationIgnored var hasDocumentPresentation: () -> Bool = { false }
    @ObservationIgnored private let factory: any CreationFlowFactory
    @ObservationIgnored private let workspaceFactory: any WorkspaceFeatureFactory
    private(set) var selection: SidebarDestination
    @ObservationIgnored let selectionStore: any SidebarSelectionPersisting
    @ObservationIgnored weak var rootRuntime: (any RootCoordinating)?
    @ObservationIgnored var rootBindingID = UUID()
    @ObservationIgnored let router: any DeepLinkRouting
    @ObservationIgnored let projectCoordinatorFactory: any ProjectCoordinatorFactory
    @ObservationIgnored let canOpenExternalRoute: () -> Bool
    var projectCoordinators: [String: ProjectCoordinator] = [:]
    /// One per live workspace context, matched by the context object: ids change on promotion.
    var workspaceCoordinators: [SessionWorkspaceCoordinator] = []
    @ObservationIgnored weak var workspaceRuntime: (any WorkspaceCoordinating)?
    struct WeakProjectRuntime { weak var runtime: (any ProjectCoordinating)? }
    @ObservationIgnored var projectRuntimes: [String: WeakProjectRuntime] = [:]
    /// The sidebar and root placeholders bind to this; `makeRoot` installs it.
    var rootModel: RootViewModel?
    var appearance = AppAppearance.system {
        didSet { if oldValue != appearance { projectModels.values.forEach { $0.appearance = appearance } } }
    }
    var dashboardCoordinator: DashboardCoordinator?
    var logsCoordinator: LogsCoordinator?
    var settingsCoordinator: SettingsCoordinator?
    var trayCoordinator: TrayCoordinator?
    var notificationCoordinator: NotificationCoordinator?
    let browserDialogCoordinator: BrowserDialogCoordinator
    let documentCloseCoordinator: EditorCloseCoordinator
    let fileOpenCoordinator: FileOpenCoordinator
    @ObservationIgnored var pendingDeepLink: DeepLink?
    @ObservationIgnored var routingReady = false
    var routingError: String?

    init(factory: any CreationFlowFactory, selectionStore: any SidebarSelectionPersisting = TransientSidebarSelectionStore(),
         workspaceFactory: any WorkspaceFeatureFactory = NativeWorkspaceFeatureFactory(),
         router: any DeepLinkRouting = TaskHubRouter(),
         projectCoordinatorFactory: any ProjectCoordinatorFactory = NativeProjectCoordinatorFactory(),
         documentCloseCoordinator: EditorCloseCoordinator = EditorCloseCoordinator(),
         browserDialogCoordinator: BrowserDialogCoordinator = BrowserDialogCoordinator(),
         fileOpenCoordinator: FileOpenCoordinator = FileOpenCoordinator(),
         canOpenExternalRoute: @escaping () -> Bool = { true }) {
        self.factory = factory; self.selectionStore = selectionStore
        self.workspaceFactory = workspaceFactory
        self.router = router; self.projectCoordinatorFactory = projectCoordinatorFactory
        self.canOpenExternalRoute = canOpenExternalRoute
        self.documentCloseCoordinator = documentCloseCoordinator
        self.browserDialogCoordinator = browserDialogCoordinator
        self.fileOpenCoordinator = fileOpenCoordinator
        selection = selectionStore.load() ?? .overview
        documentCloseCoordinator.presentationEnded = { [weak self] in self?.schedulePendingDeepLink() }
        browserDialogCoordinator.canPresent = { [weak self] in
            guard let self else { return false }
            return canPresent && canOpenExternalRoute()
        }
        browserDialogCoordinator.presentationEnded = { [weak self] in self?.schedulePendingDeepLink() }
        fileOpenCoordinator.canPresent = { [weak self] in
            guard let self else { return false }
            return canPresent && canOpenExternalRoute()
        }
        fileOpenCoordinator.presentationEnded = { [weak self] in self?.schedulePendingDeepLink() }
        // Removal sheets may legitimately ask to save documents. Only the file
        // picker reservation blocks this nested document-close operation.
        documentCloseCoordinator.canPresent = { [weak fileOpenCoordinator] in fileOpenCoordinator?.isPresenting == false }
    }

    func navigate(to destination: SidebarDestination) {
        if selection != destination {
            projectCoordinator?.endPresentation(); dashboardCoordinator?.model.cancelActions(); logsCoordinator?.endPresentation()
        }
        routingError = nil
        selection = destination
        for (id, child) in projectCoordinators { child.model.active = destination == .project(id) }
        settingsCoordinator?.setActive(destination == .settings)
        selectionStore.save(destination)
        rootRuntime?.activateRootDestination()
        refreshRoot()
    }

    func navigate(to route: Route) {
        switch route {
        case .destination(let destination): navigate(to: destination)
        case .projectSection: projectCoordinator?.navigate(to: route)
        }
    }

    /// The selection's destination, built from whichever child coordinator serves it.
    func makeDestination(for route: Route) -> Destination {
        guard case .destination(let destination) = route else { return .none }
        switch destination {
        case .overview:
            return dashboardCoordinator.map(Destination.dashboardCoordinator) ?? .unavailable("Connect to load the dashboard.")
        case .activity:
            return logsCoordinator.map(Destination.logsCoordinator) ?? .unavailable("Connect to load activity.")
        case .settings:
            return settingsCoordinator.map(Destination.settingsCoordinator) ?? .unavailable("Connect to load settings.")
        case .terminal:
            return rootModel.map(Destination.terminal) ?? .none
        case .project(let id):
            return projectCoordinators[id].map(Destination.projectCoordinator) ?? .unavailable("Connect to load this project.")
        case .session(let id):
            return rootModel.map { .session(id: id, $0) } ?? .none
        case .tab(let id):
            return rootModel.map { .tab(id: id, $0) } ?? .none
        }
    }

    /// True when `root` is a screen without a child coordinator to own its toolbar.
    var rootIsPlaceholder: Bool {
        switch root {
        case .terminal, .session, .tab, .unavailable, .none: true
        default: false
        }
    }

    /// Child coordinators arrive after the selection is restored, so `root` is rebuilt
    /// whenever the selection or the set of children changes.
    func refreshRoot() {
        pruneWorkspaces()
        root = makeDestination(for: .destination(selection))
    }

    func handle(_ action: Action) {
        switch action {
        case .root(let action): handle(action)
        case .workspace(let action, let context): handleWorkspace(action, in: context)
        case .projectEvent(let event, let id): handleProjectEvent(event, projectID: id)
        case .dashboard, .logs, .settings, .project:
            self.action?(action) // Screen actions belong to their child coordinators.
        }
    }

    private func cancelPageActions() {
        settingsCoordinator?.cancelNavigation()
        projectCoordinator?.model.cancelActions(); dashboardCoordinator?.model.cancelActions()
        logsCoordinator?.model.cancelActions()
    }

    func presentNewProject(service: any ProjectService, didSave: @escaping (Project) -> Void) {
        guard canPresent else { return }
        cancelPageActions()
        let id = UUID()
        let model = factory.projectEditor(project: nil, service: service)
        model.onAction = { [weak self] action in
            guard case .saved(let project) = action, self?.complete(id) == true else { return }
            didSave(project)
        }
        sheet = Sheet(id: id, destination: .newProject(model))
    }

    func presentNewSession(request: SessionCreationRequest, operations: (any SessionCreating)?,
                           didCreate: @escaping (WorkspaceSession) -> Void) {
        guard canPresent else { return }
        cancelPageActions()
        let id = UUID()
        let model = factory.newSession(request: request, operations: operations)
        model.onAction = { [weak self] action in
            guard case .created(let session) = action, self?.complete(id) == true else { return }
            didCreate(session)
        }
        sheet = Sheet(id: id, destination: .newSession(model))
    }

    func dismissSheet(id: UUID) {
        guard sheet?.id == id, sheet?.canDismiss == true else { return }
        _ = complete(id)
    }

    func presentRemoval(_ makeModel: () -> SessionRemovalViewModel?) {
        guard canPresent, let model = makeModel(), !model.retired, !model.completed else { return }
        cancelPageActions()
        let id = UUID()
        model.onAction = { [weak self] action in
            guard let self, case .removed(let sessions) = action, complete(id) else { return }
            if case .session(let selected) = selection, sessions.contains(where: { $0.id == selected }) {
                navigate(to: .overview)
            }
        }
        sheet = Sheet(id: id, destination: .removal(model))
    }

    func presentBuild(_ makeModel: () -> BuildWorkspaceViewModel?) {
        guard canPresent, let runtime = makeModel() else { return }
        let model = workspaceFactory.buildDestination(runtime: runtime)
        guard !model.retired else { return }
        cancelPageActions()
        let id = UUID()
        model.onAction = { [weak self] action in
            switch action { case .started: _ = self?.complete(id) }
        }
        sheet = Sheet(id: id, destination: .build(model))
    }

    func presentRestart(perform: @escaping () -> Void) {
        guard canPresent else { return }
        cancelPageActions()
        restartConfirmation = RestartConfirmation(perform: perform)
    }

    func dismissRestart(id: UUID) {
        if restartConfirmation?.id == id { restartConfirmation = nil; schedulePendingDeepLink() }
    }

    func confirmRestart(id: UUID) {
        guard let confirmation = restartConfirmation, confirmation.id == id else { return }
        restartConfirmation = nil
        confirmation.perform()
        schedulePendingDeepLink()
    }

    private func complete(_ id: UUID) -> Bool {
        guard let sheet, sheet.id == id else { return false }
        self.sheet = nil
        sheet.retire()
        schedulePendingDeepLink()
        return true
    }
}
