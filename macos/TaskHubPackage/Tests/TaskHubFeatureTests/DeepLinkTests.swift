import Foundation
import Testing
@testable import TaskHubFeature

@Test func deepLinksRoundTripSupportedRoutesAndProjectChains() throws {
    let router = TaskHubRouter()
    let roots: [SidebarDestination] = [.overview, .activity, .settings, .terminal, .project("p-123"), .session("s_123")]
    let links = roots.map { DeepLink(.destination($0)) }
        + ProjectSection.allCases.map { DeepLink([.destination(.project("p-123")), .projectSection($0)]) }
    for link in links {
        let url = try #require(router.url(for: link))
        #expect(router.deepLink(for: url) == link)
    }
    let chain = try #require(router.deepLink(for: URL(string: "taskhub://app/projects/p-123/board")!))
    #expect(chain.first == .destination(.project("p-123")))
    #expect(chain.droppingFirst() == DeepLink(.projectSection(.board)))
    #expect(chain.droppingFirst().droppingFirst().routes.isEmpty)
    #expect(router.url(for: DeepLink(.destination(.tab("https://example.test")))) == nil)
    #expect(router.url(for: DeepLink([.destination(.settings), .projectSection(.board)])) == nil)
    #expect(router.url(for: DeepLink(.destination(.session("../s")))) == nil)
}

@Test(arguments: [
    "https://app/settings", "taskhub://other/settings", "taskhub://user@app/settings",
    "taskhub://app:42/settings", "taskhub://app/settings?command=run", "taskhub://app/settings#fragment",
    "taskhub://app/settings?", "taskhub://app/settings#", "taskhub://app/", "taskhub://app",
    "taskhub://app//settings", "taskhub://app/settings/", "taskhub://app/settings/extra",
    "taskhub://app/projects", "taskhub://app/projects/id/unknown", "taskhub://app/projects/id/board/extra",
    "taskhub://app/sessions/one/two", "taskhub://app/sessions/%2Fetc", "taskhub://app/sessions/%252Fetc",
    "taskhub://app/sessions/..", "taskhub://app/sessions/%00", "taskhub://app/sessions/hello%20world",
    "taskhub://app/terminal/run", "taskhub://app/sessions/" + String(repeating: "x", count: 257)
]) func deepLinksRejectUnsupportedOrAmbiguousURLs(_ value: String) throws {
    #expect(TaskHubRouter().deepLink(for: try #require(URL(string: value))) == nil)
}

private struct TestRouteHandler: DeepLinkRouteHandling {
    let destination: SidebarDestination
    func parse(_ components: [String]) -> DeepLink? { components == ["fixture"] ? DeepLink(.destination(destination)) : nil }
    func print(_ deepLink: DeepLink) -> [String]? { deepLink == DeepLink(.destination(destination)) ? ["fixture"] : nil }
}

@Test func deepLinkRouterUsesInjectedHandlersInOrder() throws {
    let router = TaskHubRouter(handlers: [TestRouteHandler(destination: .activity), TestRouteHandler(destination: .settings)])
    let url = try #require(URL(string: "taskhub://app/fixture"))
    #expect(router.deepLink(for: url) == DeepLink(.destination(.activity)))
    #expect(router.url(for: DeepLink(.destination(.activity))) == url)
    #expect(router.deepLink(for: URL(string: "taskhub://app/settings")!) == nil)
}

@MainActor private final class DeepLinkRuntime: RootCoordinating {
    var state = RootState()
    var selections: [SidebarDestination] = []
    var terminals = 0
    var didNavigate: (() -> Void)?
    weak var coordinator: AppCoordinator?
    func rootState() -> RootState { state }
    func activateRootDestination() {
        if let coordinator { state.selection = coordinator.selection; selections.append(coordinator.selection) }
        didNavigate?()
    }
    func performRootCommand(_ command: ShellCommand) {}
    func reconnect() async {}
    func togglePin(_ id: String) {}
    func openTerminal() { terminals += 1 }
    func openRootBrowser(_ url: URL) {}
}

private struct DeepLinkProjectService: ProjectService {
    func load(_ id: String) async throws -> Project { throw CancellationError() }
    func save(_ draft: ProjectDraft, id: String?) async throws -> Project { throw CancellationError() }
    func delete(_ id: String) async throws {}
    func detectRepository(_ path: String) async throws -> String { "" }
    func pullRequests(_ id: String, state: String, force: Bool) async throws -> ProjectPRSnapshot { .init() }
}

private struct DeepLinkLogsService: LogService {
    func categories() -> [String] { ["event"] }
    func entries(category: String, errorsOnly: Bool) -> [LogEntry] { [] }
    func clear(category: String) {}
}

@MainActor @Test(.timeLimit(.minutes(1)), arguments: [false, true])
func deepLinksWaitForActivityClearConfirmationToFinish(confirm: Bool) async throws {
    let coordinator = AppCoordinator(factory: NativeCreationFlowFactory(chooseFolder: { nil }))
    let runtime = DeepLinkRuntime(); runtime.coordinator = coordinator; coordinator.rootRuntime = runtime
    let model = coordinator.makeLogs(factory: NativeLogsFeatureFactory(), pageActions: ProjectPageActions(), copy: { _ in })
    model.connect(DeepLinkLogsService())
    coordinator.navigate(to: .activity); coordinator.setRoutingReady(true)
    model.requestClear()
    let child = try #require(coordinator.logsCoordinator), request = try #require(child.confirmation)
    coordinator.handle(url: URL(string: "taskhub://app/settings")!)
    #expect(coordinator.selection == .activity && coordinator.pendingDeepLink != nil)
    if confirm { await child.confirm(id: request.id) } else { child.cancel(id: request.id) }
    while coordinator.pendingDeepLink != nil { await Task.yield() }
    #expect(coordinator.selection == .settings && coordinator.canPresent)
    child.retire()
}

@MainActor private final class DeepLinkProjectFactory: ProjectCoordinatorFactory {
    var creations = 0
    func project(model: ProjectPageViewModel) -> ProjectCoordinator { creations += 1; return ProjectCoordinator(model: model) }
}

@MainActor @Test func deepLinkCoordinatorDefersUntilSnapshotAndForwardsProjectRemainder() throws {
    let factory = DeepLinkProjectFactory()
    let coordinator = AppCoordinator(factory: NativeCreationFlowFactory(chooseFolder: { nil }), projectCoordinatorFactory: factory)
    let runtime = DeepLinkRuntime(); runtime.coordinator = coordinator; coordinator.rootRuntime = runtime
    #expect(coordinator.handle(url: URL(string: "taskhub://app/projects/p/board")!))
    #expect(runtime.selections.isEmpty && coordinator.pendingDeepLink != nil)
    let project = Project(id: "p", name: "Fixture", repo: "", color: nil, workspace: "/tmp")
    let service = DeepLinkProjectService()
    let editor = ProjectEditorViewModel(project: project, service: service, chooseFolder: { nil })
    let model = ProjectPageViewModel(project: project, service: service, editor: editor)
    runtime.state.projects = [project]; runtime.state.projectModels[project.id] = model
    coordinator.setRoutingReady(true)
    #expect(coordinator.selection == .project("p") && model.section == .board)
    #expect(factory.creations == 1 && coordinator.projectCoordinator?.model === model && coordinator.pendingDeepLink == nil)
    coordinator.handle(url: URL(string: "taskhub://app/projects/p/tickets")!)
    #expect(model.section == .tickets && factory.creations == 1)
    #expect(coordinator.projectCoordinator?.navigate(to: DeepLink(.destination(.settings))) == false)
    coordinator.handle(url: URL(string: "taskhub://app/sessions/missing")!)
    #expect(coordinator.selection == .project("p") && coordinator.routingError != nil && runtime.terminals == 0)
    coordinator.handle(url: URL(string: "taskhub://app/terminal")!)
    #expect(coordinator.selection == .terminal && coordinator.routingError == nil && runtime.terminals == 0)
    #expect(coordinator.projectCoordinator == nil)
}

@MainActor @Test func deepLinkCoordinatorKeepsLatestValidIntentAndRevalidatesAfterReconnect() throws {
    var presentationOpen = false
    let coordinator = AppCoordinator(factory: NativeCreationFlowFactory(chooseFolder: { nil }), canOpenExternalRoute: { !presentationOpen })
    let runtime = DeepLinkRuntime(); runtime.coordinator = coordinator; coordinator.rootRuntime = runtime
    coordinator.handle(url: URL(string: "taskhub://app/settings")!)
    coordinator.handle(url: URL(string: "taskhub://app/activity")!)
    #expect(!coordinator.handle(url: URL(string: "https://example.test/terminal")!))
    coordinator.setRoutingReady(true)
    #expect(runtime.selections == [.activity])
    presentationOpen = true
    coordinator.handle(url: URL(string: "taskhub://app/settings")!)
    #expect(coordinator.selection == .activity)
    presentationOpen = false
    coordinator.processPendingDeepLink()
    #expect(coordinator.selection == .settings)
    coordinator.setRoutingReady(false)
    coordinator.handle(url: URL(string: "taskhub://app/sessions/removed")!)
    coordinator.setRoutingReady(true)
    #expect(coordinator.selection == .settings && coordinator.routingError == "The linked session is no longer available.")
    coordinator.setRoutingReady(false)
    coordinator.handle(url: URL(string: "taskhub://app/terminal")!)
    coordinator.handle(RootViewModel.Action.select(.overview))
    coordinator.setRoutingReady(true)
    #expect(coordinator.selection == .overview && coordinator.pendingDeepLink == nil && coordinator.routingError == nil)
}

@MainActor @Test(.timeLimit(.minutes(1))) func deepLinksPreserveDraftAndRestartOriginUntilPresentationFinishes() async throws {
    let coordinator = AppCoordinator(factory: NativeCreationFlowFactory(chooseFolder: { nil }))
    let runtime = DeepLinkRuntime(); runtime.coordinator = coordinator; coordinator.rootRuntime = runtime
    coordinator.setRoutingReady(true)
    coordinator.presentNewProject(service: DeepLinkProjectService(), didSave: { _ in })
    let sheet = try #require(coordinator.sheet)
    guard case .newProject(let model) = sheet.destination else { Issue.record("Missing draft"); return }
    model.draft.name = "Keep this draft"
    coordinator.handle(url: URL(string: "taskhub://app/activity")!)
    #expect(coordinator.sheet?.id == sheet.id && model.draft.name == "Keep this draft" && runtime.selections.isEmpty)
    await withCheckedContinuation { continuation in
        runtime.didNavigate = { continuation.resume(); runtime.didNavigate = nil }
        coordinator.dismissSheet(id: sheet.id)
    }
    #expect(coordinator.selection == .activity && coordinator.sheet == nil)
    var restartedAt: SidebarDestination?
    coordinator.presentRestart { restartedAt = coordinator.selection }
    let confirmation = try #require(coordinator.restartConfirmation)
    coordinator.handle(url: URL(string: "taskhub://app/settings")!)
    coordinator.dismissRestart(id: UUID())
    #expect(coordinator.restartConfirmation?.id == confirmation.id && coordinator.selection == .activity)
    await withCheckedContinuation { continuation in
        runtime.didNavigate = { continuation.resume(); runtime.didNavigate = nil }
        coordinator.confirmRestart(id: confirmation.id)
    }
    #expect(restartedAt == .activity && coordinator.selection == .settings && coordinator.pendingDeepLink == nil)
}
