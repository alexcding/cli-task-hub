import Foundation
import Testing
@testable import TaskHubFeature

private actor ProjectFixture: ProjectService {
    var project = Project(id: "p", name: "Native", repo: "o/r", color: nil, workspace: "/tmp/repo")
    var fails = false
    var deleted: [String] = []
    var requestedStates: [String] = []
    var cancelledStates: [String] = []
    func fail(_ value: Bool) { fails = value }
    func load(_ id: String) -> Project { project }
    func save(_ draft: ProjectDraft, id: String?) throws -> Project {
        if fails { throw BackendError.operation("Save unavailable") }
        project = Project(id: id ?? "created", name: draft.name, repo: draft.repo, color: nil,
                          workspace: draft.workspace, ide: draft.ide, ideTarget: draft.ideTarget,
                          jiraProjectKey: draft.jiraProjectKey, jql: draft.jql, ideCmd: draft.ideCmd)
        return project
    }
    func delete(_ id: String) throws {
        if fails { throw BackendError.operation("Delete unavailable") }
        deleted.append(id)
    }
    func detectRepository(_ path: String) -> String { "detected/repo" }
    func pullRequests(_ id: String, state: String) async throws -> [DashboardPR] {
        requestedStates.append(state)
        if state == "merged" {
            do { try await Task.sleep(for: .milliseconds(100)) }
            catch { cancelledStates.append(state); throw error }
        }
        if fails { throw BackendError.operation("PRs unavailable") }
        return try JSONDecoder().decode([DashboardPR].self, from: Data("[{\"number\":1,\"title\":\"\(state) result\",\"url\":\"https://github.com/o/r/pull/1\",\"state\":\"\(state.uppercased())\",\"category\":\"other\"}]".utf8))
    }
}

@MainActor @Test func projectEditorRetainsEditsOnRefreshAndFailureAndDeletesOnlyAfterConfirmation() async throws {
    let service = ProjectFixture()
    let initial = await service.load("p")
    var saved: Project?
    var removed: String?
    var deletion: ProjectEditorViewModel.DeletionRequest?
    let editor = ProjectEditorViewModel(project: initial, service: service, chooseFolder: { "/tmp/picked" })
    editor.onAction = { action in
        switch action {
        case .saved(let value): saved = value
        case .deleted(let id): removed = id
        case .requestDeletion(let request): deletion = request
        }
    }
    await editor.pickFolder()
    await editor.detectRepository()
    #expect(editor.draft.workspace == "/tmp/picked" && editor.draft.repo == "detected/repo")
    editor.draft.name = "Unsaved name"
    editor.update(initial)
    #expect(editor.draft.name == "Unsaved name" && editor.dirty)
    await service.fail(true)
    await editor.save()
    #expect(saved == nil && editor.error == "Save unavailable" && editor.dirty)
    await service.fail(false)
    await editor.save()
    #expect(saved?.name == "Unsaved name" && !editor.dirty && editor.saved)
    editor.requestDeletion()
    #expect(await service.deleted.isEmpty)
    let request = try #require(deletion)
    await service.fail(true)
    await editor.delete(request)
    #expect(removed == nil && editor.error == "Delete unavailable")
    await service.fail(false)
    await editor.delete(request)
    #expect(removed == "p")
}

@MainActor @Test(.timeLimit(.minutes(1))) func projectPRStateChangesRejectLateResponsesAndKeepOtherAuthors() async throws {
    let service = ProjectFixture()
    let project = await service.load("p")
    let editor = ProjectEditorViewModel(project: project, service: service, chooseFolder: { nil })
    let model = ProjectPageViewModel(project: project, service: service, editor: editor)
    model.state = "merged"
    while await service.requestedStates.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
    model.state = "open"
    while model.loading { try await Task.sleep(for: .milliseconds(5)) }
    #expect(model.rows.first?.title == "open result")
    #expect(model.rows.count == 1 && model.loadedState == "open")
    #expect(await service.requestedStates == ["merged", "open"])
    #expect(await service.cancelledStates == ["merged"])
    model.state = "open"
    await Task.yield()
    #expect(await service.requestedStates == ["merged", "open"])
    await service.fail(true)
    await model.refresh()
    #expect(model.rows.count == 1 && model.error == "PRs unavailable")
    model.state = "merged"
    #expect(model.rows.isEmpty)
    model.cancelRefresh()
    #expect(!model.loading)
}

@Test func projectDraftValidatesPathsWithoutSerializingAutomationOrRunDestinations() throws {
    var draft = ProjectDraft()
    #expect(draft.validationError != nil)
    draft.name = "Native"; draft.workspace = "relative/path"
    #expect(draft.validationError != nil)
    draft.workspace = "/tmp/repo"; draft.ideTarget = "../another/App.xcodeproj"
    #expect(draft.validationError != nil)
    draft.ideTarget = "App/App.xcworkspace"
    #expect(draft.validationError == nil)
    let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any])
    #expect(body["runScheme"] == nil && body["workflows"] == nil && body["forwardWebhooks"] == nil)
}
