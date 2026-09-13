import Foundation

struct OperationOK: Decodable, Sendable { let ok: Bool? }

enum SessionAgent: String, CaseIterable, Identifiable, Sendable {
    case shell = "", claude, codex
    var id: String { rawValue }
    var label: String { switch self { case .shell: "Shell only"; case .claude: "Claude Code"; case .codex: "Codex" } }

    func command(sessionID: String?, fresh: Bool = false) -> String? {
        let id = sessionID.flatMap { $0.isEmpty ? nil : $0 }
        switch self {
        case .shell: return nil
        case .claude:
            guard let id else { return "claude" }
            return "claude \(fresh ? "--session-id" : "--resume") \(Self.quote(id))"
        case .codex: return id.map { "codex resume \(Self.quote($0))" } ?? "codex"
        }
    }
    static func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'" }
}

struct GitReferences: Decodable, Sendable {
    struct Branch: Decodable, Sendable { let name: String }
    let branches: [Branch]
    let defaultBranch: String
}

struct SessionDraft: Equatable, Sendable {
    var branch = ""
    var base = ""
    var createBranch = true
    var title = ""
    var url = ""
    var agent: SessionAgent = .claude
    var kind = "session"
    var jiraKey = ""
    var reuseWorktree: String?
}

// Local git operations and durable records stay in the existing backend. A failed
// record write reports the created checkout so it is recoverable, never deleted.
protocol SessionCreating: Sendable {
    func references(_ project: Project) async throws -> GitReferences
    func resolvePage(_ raw: String, project: Project, draft: SessionDraft, workflow: Bool) async throws -> SessionDraft
    func create(project: Project, draft: SessionDraft, requireExactBranch: Bool) async throws -> WorkspaceSession
}

struct SessionOperations: SessionCreating {
    let api: APIClient
    func references(_ project: Project) async throws -> GitReferences {
        try await api.get(APIClient.query(Routes.GIT_REFS, ["path": project.workspace]))
    }
    func create(project: Project, draft: SessionDraft, requireExactBranch: Bool = false) async throws -> WorkspaceSession {
        let branch = draft.branch.trimmingCharacters(in: .whitespacesAndNewlines)
        let sourceURL = draft.url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !branch.isEmpty, !project.workspace.isEmpty else { throw BackendError.operation("Choose a project workspace and branch.") }
        guard sourceURL.isEmpty || safeSessionURL(sourceURL) else { throw BackendError.operation("The page address must use HTTP or HTTPS.") }
        struct WorktreeRequest: Encodable, Sendable {
            let path: String; let branch: String; let create: Bool; let base: String
        }
        struct WorktreeResult: Decodable, Sendable { let path: String }
        let worktree: WorktreeResult
        if let reused = draft.reuseWorktree {
            let found: ResolvedWorktree = try await api.get(APIClient.query(Routes.WORKTREE,
                ["path": project.workspace, "branch": branch, "strict": "1"]))
            guard found.matched, found.isWorktree, SessionRemovalPlan.path(found.path) == SessionRemovalPlan.path(reused) else {
                throw BackendError.operation("The existing worktree changed. Resolve the page again before creating the session.")
            }
            worktree = .init(path: found.path)
        } else {
            worktree = try await api.request(Routes.WORKTREE, method: "POST", body:
                WorktreeRequest(path: project.workspace, branch: branch, create: draft.createBranch, base: draft.base))
        }
        guard !worktree.path.isEmpty else { throw BackendError.operation("Git did not return a worktree.") }
        if requireExactBranch {
            let verified: ResolvedWorktree = try await api.get(APIClient.query(Routes.WORKTREE,
                ["path": project.workspace, "branch": branch, "strict": "1"]))
            guard verified.matched, verified.isWorktree, verified.branch == branch,
                  SessionRemovalPlan.path(verified.path) == SessionRemovalPlan.path(worktree.path) else {
                throw BackendError.operation("The checkout at \(worktree.path) does not match branch \(branch). It has been kept; resolve the branch or folder conflict before running this workflow.")
            }
        }
        let id = UUID().uuidString.lowercased()
        let session = WorkspaceSession(id: id, projectId: project.id, workspace: project.workspace, worktree: worktree.path,
            title: draft.title.isEmpty ? branch : draft.title, branch: branch,
            url: sourceURL.isEmpty ? "session:\(id)" : sourceURL, createdAt: ISO8601DateFormatter().string(from: Date()),
            pinned: false, kind: draft.kind, jiraKey: draft.jiraKey, cli: draft.agent.rawValue,
            sessionId: draft.agent == .claude ? UUID().uuidString.lowercased() : "")
        do { let _: OperationOK = try await api.request(Routes.TASKS, method: "POST", body: session) }
        catch { throw BackendError.operation("Worktree created at \(worktree.path), but the session could not be saved: \(error.localizedDescription). Use this branch again to recover it.") }
        return session
    }

    struct ResolvedWorktree: Decodable, Sendable {
        let path: String; let branch: String; let matched: Bool; let isWorktree: Bool
    }
    func resolvePage(_ raw: String, project: Project, draft: SessionDraft, workflow: Bool = false) async throws -> SessionDraft {
        guard let page = SessionPage.parse(raw) else { throw BackendError.operation("Enter a GitHub pull request or Jira issue URL, or type a branch name.") }
        var result = draft
        result.url = page.url; result.kind = page.kind; result.jiraKey = page.key
        result.reuseWorktree = nil
        if page.kind == "github" {
            struct PR: Decodable, Sendable { let repo: String; let title: String; let headRefName: String }
            let pr: PR? = try await api.get(APIClient.query(Routes.PR_LOOKUP, ["url": page.url]), timeout: 30)
            guard let pr, !pr.headRefName.isEmpty else { throw BackendError.operation("Could not resolve this pull request. Enter its branch and keep the URL in Page URL.") }
            guard project.repo.isEmpty || project.repo.lowercased() == pr.repo.lowercased() else {
                throw BackendError.operation("This pull request belongs to \(pr.repo). Choose its project before creating the session.")
            }
            result.branch = pr.headRefName; result.title = pr.title; result.createBranch = false
        } else {
            struct Issue: Decodable, Sendable { let summary: String? }
            struct Search: Decodable, Sendable { let items: [Issue] }
            struct Query: Encodable, Sendable { let jql: String; let limit = 1 }
            let response: Search? = try? await api.request(Routes.JIRA_SEARCH, method: "POST", body: Query(jql: "key = \(page.key)"))
            let summary = response?.items.first?.summary ?? ""
            result.title = summary.isEmpty ? page.key : "\(page.key) \(summary)"
            result.branch = workflow ? WorkflowText.branch(key: page.key, summary: summary) : SessionPage.jiraBranch(key: page.key, summary: summary)
            result.createBranch = true
        }
        let match = page.kind == "jira" ? ["key": page.key] : ["branch": result.branch]
        let found: ResolvedWorktree = try await api.get(APIClient.query(Routes.WORKTREE,
            ["path": project.workspace, "strict": "1"].merging(match) { _, new in new }))
        if found.matched, found.isWorktree {
            result.reuseWorktree = found.path; result.branch = found.branch; result.createBranch = false
        }
        return result
    }
    func saveAgentID(_ id: String, session: WorkspaceSession) async throws {
        struct Payload: Encodable, Sendable { let sessionId: String }
        let _: OperationOK = try await api.request(Routes.task(session.id), method: "PATCH", body: Payload(sessionId: id))
    }
    func configureAgent(_ cli: WorkflowCLI, session: WorkspaceSession) async throws -> WorkspaceSession {
        var result = session
        if result.cli != cli.rawValue { result.cli = cli.rawValue; result.sessionId = "" }
        struct Payload: Encodable, Sendable { let cli: String; let sessionId: String }
        let _: OperationOK = try await api.request(Routes.task(session.id), method: "PATCH",
            body: Payload(cli: cli.rawValue, sessionId: result.sessionId ?? ""))
        return result
    }
    private func safeSessionURL(_ value: String) -> Bool {
        guard let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.user == nil, url.password == nil else { return false }
        return true
    }
}
