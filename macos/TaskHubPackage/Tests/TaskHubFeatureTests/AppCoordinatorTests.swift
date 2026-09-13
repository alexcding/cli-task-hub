import Foundation
import Testing
@testable import TaskHubFeature

private actor CreationProjectService: ProjectService {
    private var pending: CheckedContinuation<Project, any Error>?
    private var waiting: CheckedContinuation<Void, Never>?
    func load(_ id: String) -> Project { Self.project }
    func save(_ draft: ProjectDraft, id: String?) async throws -> Project {
        try await withCheckedThrowingContinuation {
            pending = $0
            waiting?.resume(); waiting = nil
        }
    }
    func waitForSave() async {
        if pending != nil { return }
        await withCheckedContinuation { waiting = $0 }
    }
    func finish(failing: Bool) {
        let current = pending; pending = nil
        if failing { current?.resume(throwing: BackendError.operation("Fixture save failed")) }
        else { current?.resume(returning: Self.project) }
    }
    func delete(_ id: String) {}
    func detectRepository(_ path: String) -> String { "fixture/repo" }
    func pullRequests(_ id: String, state: String) -> [DashboardPR] { [] }
    static let project = Project(id: "created", name: "Fixture", repo: "fixture/repo", color: nil, workspace: "/tmp/fixture")
}

@MainActor private final class RecordingCreationFactory: CreationFlowFactory {
    let native = NativeCreationFlowFactory(chooseFolder: { "/tmp/injected-folder" })
    var projectCompletions: [(Project) -> Void] = []
    var sessionCompletions: [(WorkspaceSession) -> Void] = []
    func addPage(openPage: @escaping (String) -> Bool, didOpen: @escaping () -> Void) -> AddPageViewModel {
        native.addPage(openPage: openPage, didOpen: didOpen)
    }
    func projectEditor(project: Project?, service: any ProjectService, didSave: @escaping (Project) -> Void,
                       didDelete: @escaping (String) -> Void) -> ProjectEditorViewModel {
        projectCompletions.append(didSave)
        return native.projectEditor(project: project, service: service, didSave: didSave, didDelete: didDelete)
    }
    func newSession(request: SessionCreationRequest, operations: SessionOperations?,
                    didCreate: @escaping (WorkspaceSession) -> Void) -> NewSessionViewModel {
        sessionCompletions.append(didCreate)
        return native.newSession(request: request, operations: operations, didCreate: didCreate)
    }
}

@MainActor @Test func creationCoordinatorValidatesPageAddressesAndRejectsActionsFromDismissedSheets() throws {
    let coordinator = AppCoordinator(factory: NativeCreationFlowFactory(chooseFolder: { nil }))
    var accepts = false
    var opened: [String] = []
    let present = { coordinator.presentAddPage { opened.append($0); return accepts } }
    present()
    let first = try #require(coordinator.sheet)
    guard case .addPage(let model) = first.destination else { Issue.record("Wrong destination"); return }
    #expect(!model.canOpen)
    model.address = "file:///tmp/private"
    model.open()
    #expect(opened.isEmpty && model.error != nil && coordinator.sheet?.id == first.id)
    model.address = "  https://example.test/new-page\n"
    model.open()
    #expect(opened == ["https://example.test/new-page"] && model.error != nil)
    #expect(coordinator.sheet?.id == first.id && model.address.hasPrefix("  "))
    accepts = true
    model.open()
    #expect(coordinator.sheet == nil && model.error == nil)
    present()
    let second = try #require(coordinator.sheet)
    guard case .addPage(let fresh) = second.destination else { Issue.record("Wrong destination"); return }
    #expect(fresh.address == "https://" && model !== fresh)
    model.open()
    #expect(opened.count == 2 && coordinator.sheet?.id == second.id)
    coordinator.dismissSheet(id: second.id)
    fresh.address = "https://example.test/late"
    fresh.open()
    #expect(opened.count == 2 && coordinator.sheet == nil)
}

@MainActor @Test func creationCoordinatorRetainsDraftRejectsDuplicateRoutesAndIgnoresStaleCompletion() async throws {
    let factory = RecordingCreationFactory(), service = CreationProjectService()
    let coordinator = AppCoordinator(factory: factory)
    var saved: [String] = []
    let open = { coordinator.presentNewProject(service: service, didSave: { saved.append($0.id) }) }
    open()
    let first = try #require(coordinator.sheet)
    guard case .newProject(let model) = first.destination else { Issue.record("Wrong destination"); return }
    model.draft.name = "Unsaved draft"
    await model.pickFolder()
    open()
    #expect(factory.projectCompletions.count == 1 && coordinator.sheet?.id == first.id)
    #expect(model.draft.name == "Unsaved draft" && model.draft.workspace == "/tmp/injected-folder")
    coordinator.dismissSheet(id: first.id)
    open()
    let second = try #require(coordinator.sheet)
    guard case .newProject(let fresh) = second.destination else { Issue.record("Wrong destination"); return }
    #expect(first.id != second.id && model !== fresh && fresh.draft.name.isEmpty)
    coordinator.dismissSheet(id: first.id)
    factory.projectCompletions[0](CreationProjectService.project)
    #expect(coordinator.sheet?.id == second.id && saved.isEmpty)
    factory.projectCompletions[1](CreationProjectService.project)
    factory.projectCompletions[1](CreationProjectService.project)
    #expect(coordinator.sheet == nil && saved == ["created"])
}

@MainActor @Test(.timeLimit(.minutes(1))) func creationCoordinatorBlocksDismissalDuringSaveAndPreservesFailureForRetry() async throws {
    let service = CreationProjectService()
    let coordinator = AppCoordinator(factory: NativeCreationFlowFactory(chooseFolder: { nil }))
    var saved: Project?
    coordinator.presentNewProject(service: service, didSave: { saved = $0 })
    let sheet = try #require(coordinator.sheet)
    guard case .newProject(let model) = sheet.destination else { Issue.record("Wrong destination"); return }
    model.draft.name = "Keep this draft"
    let failing = Task { await model.save() }
    await service.waitForSave()
    coordinator.dismissSheet(id: sheet.id)
    #expect(coordinator.sheet?.id == sheet.id && model.busy && !sheet.canDismiss)
    await service.finish(failing: true)
    await failing.value
    #expect(coordinator.sheet?.id == sheet.id && saved == nil)
    #expect(model.error == "Fixture save failed" && model.draft.name == "Keep this draft" && sheet.canDismiss)
    let retry = Task { await model.save() }
    await service.waitForSave()
    await service.finish(failing: false)
    await retry.value
    #expect(coordinator.sheet == nil && saved?.id == "created")
}

@MainActor @Test func creationCoordinatorInjectsSessionContextAndCompletesOnlyItsOwnPresentation() throws {
    let factory = RecordingCreationFactory(), coordinator = AppCoordinator(factory: factory)
    let project = CreationProjectService.project
    let url = "https://github.com/fixture/repo/pull/42"
    let request = SessionCreationRequest(projects: [project], selectedProject: project.id, agent: .codex, pageURL: url)
    var created = 0
    let open = { coordinator.presentNewSession(request: request, operations: nil, didCreate: { _ in created += 1 }) }
    open()
    let first = try #require(coordinator.sheet)
    guard case .newSession(let model) = first.destination else { Issue.record("Wrong destination"); return }
    #expect(model.projectID == project.id && model.draft.agent == .codex)
    #expect(model.draft.branch == url && model.draft.url == url)
    model.draft.title = "Draft title"
    coordinator.presentNewProject(service: CreationProjectService(), didSave: { _ in })
    open()
    #expect(factory.projectCompletions.isEmpty && factory.sessionCompletions.count == 1)
    #expect(coordinator.sheet?.id == first.id && model.draft.title == "Draft title")
    coordinator.dismissSheet(id: first.id)
    open()
    let second = try #require(coordinator.sheet)
    let session = WorkspaceSession(id: "session", projectId: project.id, workspace: project.workspace, worktree: "/tmp/worktree",
                                   title: "Session", branch: "feature", url: url, createdAt: nil, pinned: false)
    factory.sessionCompletions[0](session)
    #expect(coordinator.sheet?.id == second.id && created == 0)
    factory.sessionCompletions[1](session)
    factory.sessionCompletions[1](session)
    #expect(coordinator.sheet == nil && created == 1)
}
