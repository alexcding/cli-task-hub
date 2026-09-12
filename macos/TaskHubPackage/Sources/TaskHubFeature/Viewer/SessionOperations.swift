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

struct SessionDraft: Sendable {
    var branch = ""
    var base = ""
    var createBranch = true
    var title = ""
    var url = ""
    var agent: SessionAgent = .claude
}

// Local git operations and durable records stay in the existing backend. A failed
// record write reports the created checkout so it is recoverable, never deleted.
struct SessionOperations: Sendable {
    let api: APIClient
    func references(_ project: Project) async throws -> GitReferences {
        try await api.get(APIClient.query(Routes.GIT_REFS, ["path": project.workspace]))
    }
    func create(project: Project, draft: SessionDraft) async throws -> WorkspaceSession {
        let branch = draft.branch.trimmingCharacters(in: .whitespacesAndNewlines)
        let sourceURL = draft.url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !branch.isEmpty, !project.workspace.isEmpty else { throw BackendError.operation("Choose a project workspace and branch.") }
        guard sourceURL.isEmpty || safeSessionURL(sourceURL) else { throw BackendError.operation("The page address must use HTTP or HTTPS.") }
        struct WorktreeRequest: Encodable, Sendable {
            let path: String; let branch: String; let create: Bool; let base: String
        }
        struct WorktreeResult: Decodable, Sendable { let path: String }
        let worktree: WorktreeResult = try await api.request(Routes.WORKTREE, method: "POST", body:
            WorktreeRequest(path: project.workspace, branch: branch, create: draft.createBranch, base: draft.base))
        guard !worktree.path.isEmpty else { throw BackendError.operation("Git did not return a worktree.") }
        let id = UUID().uuidString.lowercased()
        let session = WorkspaceSession(id: id, projectId: project.id, workspace: project.workspace, worktree: worktree.path,
            title: draft.title.isEmpty ? branch : draft.title, branch: branch,
            url: sourceURL.isEmpty ? "session:\(id)" : sourceURL, createdAt: ISO8601DateFormatter().string(from: Date()),
            pinned: false, kind: "session", cli: draft.agent.rawValue,
            sessionId: draft.agent == .claude ? UUID().uuidString.lowercased() : "")
        do { let _: OperationOK = try await api.request(Routes.TASKS, method: "POST", body: session) }
        catch { throw BackendError.operation("Worktree created at \(worktree.path), but the session could not be saved: \(error.localizedDescription). Use this branch again to recover it.") }
        return session
    }
    func saveAgentID(_ id: String, session: WorkspaceSession) async throws {
        struct Payload: Encodable, Sendable { let sessionId: String }
        let _: OperationOK = try await api.request(Routes.task(session.id), method: "PATCH", body: Payload(sessionId: id))
    }
    private func safeSessionURL(_ value: String) -> Bool {
        guard let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.user == nil, url.password == nil else { return false }
        return true
    }
}
