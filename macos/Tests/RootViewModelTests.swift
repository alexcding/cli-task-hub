import Foundation
import Observation
import Testing

@MainActor @Observable private final class RootRuntimeFixture: RootCoordinating, WorkspaceServing {
    var state = RootState()
    var commands: [ShellCommand] = []
    var pins: [String] = []
    var closedTabs: [String] = []
    var selections: [SidebarDestination] = []
    var opens: [URL] = []
    var terminals = 0
    var reconnects = 0
    weak var coordinator: AppCoordinator?
    func rootState() -> RootState { state }
    func workspaceState(in context: WorkspaceContext) -> SessionWorkspaceState { SessionWorkspaceState() }
    func activateRootDestination() {
        if let coordinator { state.selection = coordinator.selection; selections.append(coordinator.selection) }
    }
    func performRootCommand(_ command: ShellCommand) { commands.append(command) }
    func reconnect() async { reconnects += 1 }
    func togglePin(_ id: String) { pins.append(id) }
    func closeTab(_ url: String) { closedTabs.append(url) }
    func openTerminal() { terminals += 1 }
    func openRootBrowser(_ url: URL) { opens.append(url) }
}

@MainActor private final class RecordingRootFactory: RootFeatureFactory {
    var creations = 0
    func root(service: any RootServing, shell: ShellStore, viewer: ViewerStore) -> RootViewModel {
        creations += 1
        return RootViewModel(service: service, shell: shell, viewer: viewer)
    }
}

@MainActor @Test func rootActionsReachCoordinatorAndObsoleteRootCannotNavigate() async throws {
    let preferences = try #require(UserDefaults(suiteName: "TaskHubRootTests-\(UUID().uuidString)"))
    let shell = ShellStore(preferences: preferences), viewer = ViewerStore(), factory = RecordingRootFactory()
    let store = TransientSidebarSelectionStore(.settings)
    let coordinator = AppCoordinator(factory: NativeCreationFlowFactory(chooseFolder: { nil }), selectionStore: store)
    let runtime = RootRuntimeFixture(); runtime.coordinator = coordinator
    let model = coordinator.makeRoot(factory: factory, runtime: runtime, shell: shell, viewer: viewer)
    #expect(coordinator.selection == .settings && factory.creations == 1)
    model.newProject(); model.newSession(); model.refresh()
    #expect(runtime.commands.isEmpty)
    runtime.state.canCreateProject = true; runtime.state.canCreateSession = true; runtime.state.canRefresh = true
    model.newProject(); model.newSession(); model.refresh()
    #expect(runtime.commands == [.newProject, .newSession, .refresh])
    model.select(.session("session"))
    #expect(coordinator.selection == .session("session") && store.load() == .session("session"))
    #expect(runtime.selections == [.session("session")])
    model.togglePin("session"); model.closeTab("https://example.test/tab"); model.openTerminal(); model.reconnect()
    let url = try #require(URL(string: "https://example.test/page"))
    model.openBrowser(url)
    await Task.yield()
    #expect(runtime.pins == ["session"] && runtime.closedTabs == ["https://example.test/tab"] && runtime.terminals == 1 && runtime.reconnects == 1 && runtime.opens == [url])
    let replacement = coordinator.makeRoot(factory: factory, runtime: runtime, shell: shell, viewer: viewer)
    model.select(.overview)
    #expect(coordinator.selection == .session("session") && factory.creations == 2)
    replacement.select(.activity)
    #expect(coordinator.selection == .activity && store.load() == .activity)
}

@MainActor @Test func rootPresentationUsesCurrentModelsAndKeepsAllPreparedWorkspacesMounted() throws {
    let preferences = try #require(UserDefaults(suiteName: "TaskHubRootTests-\(UUID().uuidString)"))
    let runtime = RootRuntimeFixture(), viewer = ViewerStore()
    viewer.prepareContext = { [runtime] in $0.configureWorkspace(factory: NativeWorkspaceFeatureFactory(), service: runtime) }
    let model = RootViewModel(service: runtime, shell: ShellStore(preferences: preferences), viewer: viewer)
    let first = viewer.select(id: "task:first", url: "", title: "First")
    let document = try #require(first.openFile("/tmp/Retained.swift"))
    let second = viewer.select(id: "task:second", url: "", title: "Second")
    #expect(model.workspaces.map(\.id) == ["task:first", "task:second"])
    #expect(model.workspaces.map(\.active) == [false, true] && model.hasWorkspace && !model.showsDestination)
    viewer.deactivate()
    #expect(model.workspaces.count == 2 && model.workspaces.allSatisfy { !$0.active })
    #expect(model.showsDestination && !model.hasWorkspace)
    _ = viewer.select(id: "task:first", url: "", title: "First")
    #expect(model.workspaces[0].context === first && first.activeDocument === document)
    #expect(model.workspaces[1].context === second)
    viewer.deactivate()
    runtime.state.projects = [Project(id: "p", name: "Native Project", repo: "", color: nil, workspace: "/tmp")]
    runtime.state.selection = .project("p")
    #expect(model.title == "Native Project")
    guard case .unavailable = model.destination else { Issue.record("Missing project unexpectedly rendered a model"); return }
    runtime.state.sessions = [WorkspaceSession(id: "s", projectId: "p", workspace: "/tmp", worktree: "/tmp/worktree", title: "Title",
        branch: "feature", url: "", createdAt: nil, pinned: true)]
    runtime.state.selection = .session("s")
    #expect(model.title == "worktree" && model.pinnedIDs == ["s"])
    guard case .session(let record) = model.destination else { Issue.record("Missing session destination"); return }
    #expect(record.id == "s")
    runtime.state.sessions = []
    guard case .unavailable = model.destination else { Issue.record("Removed session still displayed"); return }
    runtime.state.selection = .tab("file:///tmp/private")
    guard case .tab(_, let address) = model.destination else { Issue.record("Missing tab fallback"); return }
    #expect(address == nil)
}

@MainActor @Test func sidebarSelectionPreservesExistingJSONFormatAndIgnoresCorruption() throws {
    let suite = "TaskHubSelectionTests-\(UUID().uuidString)"
    let preferences = try #require(UserDefaults(suiteName: suite))
    defer { preferences.removePersistentDomain(forName: suite) }
    let selection = SidebarDestination.tab("https://example.test/a?q=one%20two")
    preferences.set(try JSONEncoder().encode(selection), forKey: "sidebar.selection")
    let storage = UserDefaultsSidebarSelectionStore(preferences: preferences)
    let coordinator = AppCoordinator(factory: NativeCreationFlowFactory(chooseFolder: { nil }), selectionStore: storage)
    #expect(coordinator.selection == selection)
    coordinator.navigate(to: .project("p"))
    #expect(storage.load() == .project("p"))
    preferences.set(Data("corrupt".utf8), forKey: "sidebar.selection")
    let restored = AppCoordinator(factory: NativeCreationFlowFactory(chooseFolder: { nil }), selectionStore: storage)
    #expect(restored.selection == .overview)
}

@MainActor @Test func closingTheTabInViewSelectsItsSidebarNeighbour() {
    let tabs = ["a", "b", "c"]
    #expect(AppViewModel.destination(closing: "a", among: tabs) == .tab("b"))
    #expect(AppViewModel.destination(closing: "b", among: tabs) == .tab("c"))
    #expect(AppViewModel.destination(closing: "c", among: tabs) == .tab("b"))
    #expect(AppViewModel.destination(closing: "a", among: ["a"]) == .overview)
    // A tab the sidebar does not list (its URL belongs to a session) is never the neighbour.
    #expect(AppViewModel.destination(closing: "a", among: ["a", "c"]) == .tab("c"))
    #expect(AppViewModel.destination(closing: "missing", among: tabs) == .overview)
}
