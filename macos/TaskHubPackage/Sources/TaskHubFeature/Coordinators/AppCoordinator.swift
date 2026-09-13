import Foundation
import Observation

/// Owns presentation identity and model lifetime, following elevate-ios's
/// route -> model-bearing destination -> rendering view separation.
@MainActor @Observable final class AppCoordinator {
    struct Sheet: Identifiable {
        enum Destination {
            case newProject(ProjectEditorViewModel)
            case newSession(NewSessionViewModel)
            case addPage(AddPageViewModel)
            case removal(SessionRemovalViewModel)
            case build(BuildDestinationViewModel)
        }
        let id: UUID
        let destination: Destination

        @MainActor func retire() {
            switch destination {
            case .newProject(let model): model.retire()
            case .newSession(let model): model.retire()
            case .addPage(let model): model.retire()
            case .removal(let model): model.retire()
            case .build(let model): model.retire()
            }
        }

        @MainActor var canDismiss: Bool {
            switch destination {
            case .newProject(let model): !model.busy
            case .newSession(let model): !model.creating
            case .addPage: true
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
        sheet == nil && restartConfirmation == nil && logsCoordinator?.isPresenting != true && !projectCoordinators.values.contains { $0.isPresenting }
    }
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
    var dashboardCoordinator: DashboardCoordinator?
    var logsCoordinator: LogsCoordinator?
    @ObservationIgnored var pendingDeepLink: DeepLink?
    @ObservationIgnored var routingReady = false
    var routingError: String?

    init(factory: any CreationFlowFactory, selectionStore: any SidebarSelectionPersisting = TransientSidebarSelectionStore(),
         workspaceFactory: any WorkspaceFeatureFactory = NativeWorkspaceFeatureFactory(),
         router: any DeepLinkRouting = TaskHubRouter(),
         projectCoordinatorFactory: any ProjectCoordinatorFactory = NativeProjectCoordinatorFactory(),
         canOpenExternalRoute: @escaping () -> Bool = { true }) {
        self.factory = factory; self.selectionStore = selectionStore
        self.workspaceFactory = workspaceFactory
        self.router = router; self.projectCoordinatorFactory = projectCoordinatorFactory
        self.canOpenExternalRoute = canOpenExternalRoute
        selection = selectionStore.load() ?? .overview
    }

    func navigate(to destination: SidebarDestination) {
        if selection != destination {
            projectCoordinator?.endPresentation(); dashboardCoordinator?.model.cancelActions(); logsCoordinator?.endPresentation()
        }
        routingError = nil
        selection = destination
        selectionStore.save(destination)
        rootRuntime?.activateRootDestination()
    }

    private func cancelPageActions() {
        projectCoordinator?.model.cancelActions(); dashboardCoordinator?.model.cancelActions()
        logsCoordinator?.model.cancelActions()
    }

    func presentAddPage(openPage: @escaping (String) -> Bool) {
        guard canPresent else { return }
        cancelPageActions()
        let id = UUID()
        let model = factory.addPage(openPage: { [weak self] address in
            guard self?.sheet?.id == id else { return false }
            return openPage(address)
        })
        model.onAction = { [weak self] action in
            switch action { case .opened: _ = self?.complete(id) }
        }
        sheet = Sheet(id: id, destination: .addPage(model))
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
