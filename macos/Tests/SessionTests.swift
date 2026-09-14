import Foundation
import Testing

@Test func sessionURLsAndJiraBranchNamesMatchExistingConventions() {
    #expect(SessionPage.parse("https://github.com/owner/repo/pull/42/files")?.kind == "github")
    #expect(SessionPage.parse("https://other.test/owner/repo/pull/42") == nil)
    #expect(SessionPage.parse("https://github.com/owner/repo/pull/-1") == nil)
    #expect(SessionPage.parse("https://jira.test/browse/record-123")?.key == "RECORD-123")
    #expect(SessionPage.parse("https://user:secret@jira.test/browse/RECORD-123") == nil)
    #expect(SessionPage.jiraBranch(key: "RECORD-123", summary: "Fix iOS: Sidebar / navigation") == "RECORD-123-fix-ios-sidebar-navigation")
    #expect(SessionPage.jiraBranch(key: "RECORD-123", summary: "") == "RECORD-123")
}

private final class SessionHTTPFixture: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        let body: String
        switch path {
        case Routes.GIT_REFS: body = #"{"branches":[{"name":"main"}],"defaultBranch":"main"}"#
        case Routes.PR_LOOKUP: body = #"{"repo":"fixture/repo","title":"Native sidebar","headRefName":"feature/native"}"#
        case Routes.JIRA_SEARCH: body = #"{"items":[{"summary":"Native sidebar"}]}"#
        case Routes.WORKTREE:
            let query = request.url!.query ?? ""
            if request.httpMethod == "POST" { body = #"{"path":"/tmp/fixture.worktrees/native"}"# }
            else if query.contains("RECORD-12") { body = #"{"matched":true,"isWorktree":true,"branch":"RECORD-12-existing","path":"/tmp/existing"}"# }
            else if let branch = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "branch" })?.value {
                body = String(decoding: try! JSONSerialization.data(withJSONObject: ["matched": true, "isWorktree": true, "branch": branch, "path": "/tmp/fixture.worktrees/native"]), as: UTF8.self)
            }
            else { body = #"{"matched":false,"isWorktree":false,"branch":"","path":""}"# }
        default: body = #"{"ok":true}"#
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor @Test func sessionModelResolvesPRBeforeCreationAndReusesTicketWorktrees() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SessionHTTPFixture.self]
    let api = try APIClient(baseURL: URL(string: "http://127.0.0.1:12345")!, session: URLSession(configuration: configuration))
    let project = Project(id: "fixture", name: "Fixture", repo: "fixture/repo", color: nil, workspace: "/tmp/fixture")
    let operations = SessionOperations(api: api)
    var created: WorkspaceSession?
    let model = NewSessionViewModel(projects: [project], selectedProject: project.id, operations: operations)
    model.onAction = { if case .created(let session) = $0 { created = session } }
    await model.loadReferences()
    #expect(model.draft.branch == "worktree1" && model.draft.base == "main")
    model.draft.agent = .shell
    model.editBranch("https://github.com/fixture/repo/pull/42")
    await model.create()
    #expect(model.completed)
    #expect(created?.branch == "feature/native" && created?.kind == "github")
    #expect(created?.url == "https://github.com/fixture/repo/pull/42")
    let jira = try await operations.resolvePage("https://jira.test/browse/RECORD-12", project: project, draft: SessionDraft())
    #expect(jira.branch == "RECORD-12-existing" && jira.reuseWorktree == "/tmp/existing" && !jira.createBranch)
    #expect(jira.jiraKey == "RECORD-12" && jira.title == "RECORD-12 Native sidebar")
}

@MainActor @Test(.timeLimit(.minutes(1))) func sessionProjectChangesLoadReferencesWithoutViewObservers() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SessionHTTPFixture.self]
    let api = try APIClient(baseURL: URL(string: "http://127.0.0.1:12345")!, session: URLSession(configuration: configuration))
    let project = Project(id: "fixture", name: "Fixture", repo: "fixture/repo", color: nil, workspace: "/tmp/fixture")
    let model = NewSessionViewModel(projects: [project], selectedProject: "", operations: SessionOperations(api: api))
    model.draft.branch = "Keep my branch"
    model.draft.base = "old-base"; model.draft.reuseWorktree = "/tmp/old-worktree"
    model.projectID = project.id
    #expect(model.loading && model.draft.base.isEmpty && model.draft.reuseWorktree == nil)
    while model.loading { try await Task.sleep(for: .milliseconds(5)) }
    #expect(model.branches == ["main"] && model.draft.base == "main" && model.draft.branch == "Keep my branch")
    model.draft.base = "chosen-base"
    model.projectID = project.id // Reassigning the same selection must not reset its draft.
    await Task.yield()
    #expect(model.draft.base == "chosen-base" && !model.loading)
    model.projectID = "missing"
    model.projectID = project.id
    model.cancelReferenceLoading()
    await Task.yield()
    #expect(!model.loading && model.branches.isEmpty && model.draft.base.isEmpty)
}

@Test func agentCommandsResumeExactIDsAndQuoteShellMetacharacters() {
    #expect(SessionAgent.shell.command(sessionID: nil) == nil)
    #expect(SessionAgent.claude.command(sessionID: "saved") == "claude --resume 'saved'")
    #expect(SessionAgent.claude.command(sessionID: "new", fresh: true) == "claude --session-id 'new'")
    #expect(SessionAgent.codex.command(sessionID: "saved") == "codex resume 'saved'")
    #expect(SessionAgent.codex.command(sessionID: "") == "codex")
    #expect(SessionAgent.quote("a'$(touch /tmp/no);b") == "'a'\"'\"'$(touch /tmp/no);b'")
}

@Test func workflowPagePreparationUsesWorkflowBranchAndReusesResolvedWorktrees() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SessionHTTPFixture.self]
    let api = try APIClient(baseURL: URL(string: "http://127.0.0.1:12345")!, session: URLSession(configuration: configuration))
    var project = Project(id: "fixture", name: "Fixture", repo: "fixture/repo", color: nil, workspace: "/tmp/fixture")
    project.jiraProjectKey = "RECORD"
    let service = APIWorkflowPagePreparation(operations: SessionOperations(api: api))
    let fresh = try #require(WorkflowPageTarget.resolve(url: "https://jira.test/browse/RECORD-13", projects: [project]))
    let created = try await service.prepare(fresh, project: project)
    #expect(created.branch == "feature/record-13-native-sidebar")
    #expect(created.cli == "" && created.sessionId == "")
    #expect(created.jiraKey == "RECORD-13" && fresh.matches(created))
    let existing = try #require(WorkflowPageTarget.resolve(url: "https://jira.test/browse/RECORD-12", projects: [project]))
    let reused = try await service.prepare(existing, project: project)
    #expect(reused.branch == "RECORD-12-existing" && reused.worktree == "/tmp/existing")
    let pull = try #require(WorkflowPageTarget.resolve(url: "https://github.com/fixture/repo/pull/42/files", projects: [project]))
    let pr = try await service.prepare(pull, project: project)
    #expect(pr.branch == "feature/native" && pr.kind == "github")
    #expect(pull.matches(pr))
    let canonical = try #require(WorkflowPageTarget.resolve(url: "https://github.com/FIXTURE/repo/pull/42?diff=split", projects: [project]))
    #expect(canonical.identity == pull.identity && canonical.matches(pr))
    #expect(WorkflowPageTarget.resolve(url: "https://github.com/elsewhere/repo/pull/42", projects: [project]) == nil)
    #expect(WorkflowPageTarget.resolve(url: fresh.page.url, projects: [project, project]) == nil)
}

@MainActor @Test func workflowPagePromotionRetainsLiveContextObjectsAndMergesExistingContext() throws {
    let viewer = ViewerStore()
    let pageID = "tab:https://jira.test/browse/REC-1"
    let context = viewer.select(id: pageID, url: "", title: "Issue")
    let document = try #require(context.openFile("/tmp/Workflow.swift"))
    let selection = context.activeID
    try viewer.promoteContext(from: pageID, to: "task:prepared")
    #expect(viewer.contexts[pageID] == nil)
    #expect(viewer.active === context && context.id == "task:prepared")
    #expect(context.documents.first === document && context.activeID == selection)
    let other = viewer.select(id: "task:other", url: "", title: "Other")
    let otherDocument = try #require(other.openFile("/tmp/Other.swift"))
    _ = viewer.select(id: "task:prepared", url: "", title: "")
    try viewer.promoteContext(from: "task:prepared", to: "task:other")
    #expect(viewer.contexts["task:prepared"] == nil && viewer.active === other)
    #expect(other.documents.first === otherDocument && other.documents.last === document)
    #expect(other.activeDocument === document && context.documents.isEmpty)
}
