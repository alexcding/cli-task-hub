import Foundation
import Observation
import Testing
@testable import TaskHubFeature

@MainActor @Observable private final class WorkspaceFixture: WorkspaceServing {
    var state = SessionWorkspaceState()
    var actions: [SessionWorkspaceViewModel.Action] = []
    var contextIDs: [String] = []
    func workspaceState(in context: WorkspaceContext) -> SessionWorkspaceState { state }
    func record(_ action: SessionWorkspaceViewModel.Action, in context: WorkspaceContext) {
        actions.append(action); contextIDs.append(context.id)
    }
}

@MainActor private final class CountingWorkspaceFactory: WorkspaceFeatureFactory {
    let native = NativeWorkspaceFeatureFactory()
    var creations = 0
    func workspace(context: WorkspaceContext, service: any WorkspaceServing) -> SessionWorkspaceViewModel {
        creations += 1; return native.workspace(context: context, service: service)
    }
    func removal(service: SessionRemovalService, record: WorkspaceSession, projects: [Project], sessions: [WorkspaceSession],
                 didRemove: @escaping ([WorkspaceSession]) async -> Void, finished: @escaping () -> Void) -> SessionRemovalViewModel {
        native.removal(service: service, record: record, projects: projects, sessions: sessions, didRemove: didRemove, finished: finished)
    }
    func build(api: APIClient, project: Project, session: WorkspaceSession,
               terminalFactory: @escaping () throws -> any BuildTerminal, reveal: @escaping () -> Void) -> BuildWorkspaceViewModel {
        native.build(api: api, project: project, session: session, terminalFactory: terminalFactory, reveal: reveal)
    }
}

@MainActor @Test func workspaceModelComputesPaneVisibilityAndGatesOperationsAgainstCurrentState() throws {
    let context = WorkspaceContext(id: "task:one", sourceURL: "", title: "")
    let service = WorkspaceFixture(), model = SessionWorkspaceViewModel(context: context, service: service)
    model.onAction = { [weak service, weak context] action in
        if let context { service?.record(action, in: context) }
    }
    #expect(!model.showsTerminal && model.showsPage && !model.canRemove)
    service.state.session = WorkspaceSession(id: "one", projectId: "p", workspace: "/tmp", worktree: "/tmp/one", title: "One",
                                             branch: "one", url: "", createdAt: nil, pinned: false)
    service.state.project = Project(id: "p", name: "Project", repo: "", color: nil, workspace: "/tmp", ide: "xcode")
    #expect(model.showsTerminal && !model.showsPage && !model.showsBuild && !model.canRun)
    _ = try #require(context.open("https://example.test/context"))
    #expect(model.showsPage && model.canToggleContext)
    model.toggleContext(); #expect(context.pane == .off && !model.showsPage)
    model.toggleContext(); #expect(context.pane == .term && model.showsPage)
    context.setPane(.diff)
    #expect(model.showsTerminal && model.showsChanges && model.showsPage && !model.showsBuild)
    context.setPane(.build)
    #expect(model.showsTerminal && model.showsBuild && !model.showsPage)
    service.state.connected = true; service.state.canPresent = true
    service.state.editorLabel = "Open Xcode"; service.state.gitClientLabel = "Open Fork"
    #expect(model.canRun && model.canRemove && model.canRestart && model.canOpenExternal)
    model.openEditor(); model.openGitClient(); model.run(); model.remove(); model.restart()
    #expect(service.actions == [.operation(.openEditor), .operation(.openGitClient), .run, .remove, .restart])
    service.state.changingSession = true
    model.openEditor(); model.openGitClient(); model.run(); model.remove(); model.restart()
    #expect(service.actions.count == 5 && !model.canRun && !model.canRemove)
    service.state.changingSession = false; service.state.canPresent = false
    model.run(); model.remove(); model.restart(); model.addPage()
    #expect(service.actions.count == 5)
    service.state.connected = false
    #expect(!model.canShowChanges)
}

@MainActor @Test func workspaceModelRefreshesOnlyVisibleReviewsAndRetainsIdentityThroughPromotion() throws {
    let service = WorkspaceFixture(), factory = CountingWorkspaceFactory(), viewer = ViewerStore()
    viewer.prepareContext = { [service] context in
        context.configureWorkspace(factory: factory, service: service)
        context.workspaceViewModel?.onAction = { [weak service, weak context] action in
            if let context { service?.record(action, in: context) }
        }
    }
    let context = viewer.select(id: "page", url: "", title: "Page")
    let model = try #require(context.workspaceViewModel)
    let document = try #require(context.openFile("/tmp/Workspace.swift"))
    _ = viewer.select(id: "page", url: "", title: "Page")
    #expect(context.workspaceViewModel === model && factory.creations == 1)
    try viewer.promoteContext(from: "page", to: "task:prepared")
    _ = viewer.select(id: "task:prepared", url: "", title: "Prepared")
    #expect(viewer.active === context && context.workspaceViewModel === model && factory.creations == 1)
    #expect(context.activeDocument === document)
    service.state.session = WorkspaceSession(id: "prepared", projectId: "p", workspace: "/tmp", worktree: "/tmp/prepared",
                                             title: "Prepared", branch: "prepared", url: "", createdAt: nil, pinned: false)
    context.setPane(.diff)
    #expect(model.active && service.actions == [.operation(.prepareChanges)] && service.contextIDs == ["task:prepared"])
    context.setReviewSection(.history)
    #expect(service.actions.count == 2)
    context.setReviewSection(.history); model.setActive(true)
    #expect(service.actions.count == 2)
    let inputs = model.reviewInputs
    service.state.reviewBase = "main"
    #expect(model.reviewInputs != inputs)
    model.reviewStateChanged(); #expect(service.actions.count == 3)
    model.reviewStateChanged(); #expect(service.actions.count == 3)
    viewer.deactivate(); model.prepareChanges(); #expect(!model.active && service.actions.count == 3)
    context.setPane(.term)
    _ = viewer.select(id: "task:prepared", url: "", title: "Prepared")
    #expect(model.active && service.actions.count == 3)
    model.reconnectTerminal(); model.reconnectBuild()
    #expect(service.actions.suffix(2) == [.operation(.reconnectTerminal), .operation(.reconnectBuild)])
    #expect(service.contextIDs.suffix(2) == ["task:prepared", "task:prepared"])
}

@MainActor @Test func workspaceModelDoesNotRetainItsContextOrRuntime() {
    var context: WorkspaceContext? = WorkspaceContext(id: "scratch", sourceURL: "", title: "")
    var service: WorkspaceFixture? = WorkspaceFixture()
    let model = SessionWorkspaceViewModel(context: context!, service: service!)
    #expect(model.workspaceTitle == "Terminal" && model.showsTerminal)
    context = nil; service = nil
    #expect(!model.showsTerminal && !model.canRestart)
    model.openTerminal(); model.reconnectBuild(); model.setActive(true)
}
