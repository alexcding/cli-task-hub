import Foundation

struct ProjectDraft: Encodable, Equatable, Sendable {
    var name = ""
    var workspace = ""
    var repo = ""
    var jiraProjectKey = ""
    var jql = ""
    var ide = ""
    var ideCmd = ""
    var ideTarget = ""

    init(_ project: Project? = nil) {
        guard let project else { return }
        name = project.name; workspace = project.workspace; repo = project.repo
        jiraProjectKey = project.jiraProjectKey ?? ""; jql = project.jql ?? ""
        ide = project.ide ?? ""; ideCmd = project.ideCmd ?? ""; ideTarget = project.ideTarget ?? ""
    }
    var validationError: String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Enter a project name." }
        if !workspace.isEmpty && !workspace.hasPrefix("/") { return "Choose an absolute workspace folder path." }
        if ideTarget.hasPrefix("/") || ideTarget.split(separator: "/").contains("..") { return "The IDE target must be a relative path inside the workspace." }
        return nil
    }
}

protocol ProjectService: Sendable {
    func load(_ id: String) async throws -> Project
    func save(_ draft: ProjectDraft, id: String?) async throws -> Project
    func delete(_ id: String) async throws
    func detectRepository(_ path: String) async throws -> String
    func pullRequests(_ id: String, state: String) async throws -> [DashboardPR]
}

struct APIProjectService: ProjectService {
    let api: APIClient
    func load(_ id: String) async throws -> Project { try await api.get(Routes.project(id)) }
    func save(_ draft: ProjectDraft, id: String?) async throws -> Project {
        try await api.request(id.map(Routes.project) ?? Routes.PROJECTS, method: id == nil ? "POST" : "PUT", body: draft)
    }
    func delete(_ id: String) async throws {
        let _: OperationOK = try await api.request(Routes.project(id), method: "DELETE", body: [String: String]())
    }
    func detectRepository(_ path: String) async throws -> String {
        struct Result: Decodable, Sendable { let repo: String }
        let result: Result = try await api.get(APIClient.query(Routes.DETECT_REPO, ["path": path]), timeout: 30)
        return result.repo
    }
    func pullRequests(_ id: String, state: String) async throws -> [DashboardPR] {
        try await api.get(APIClient.query(Routes.projectPrs(id), ["state": state]), timeout: 100)
    }
}

enum ProjectSection: String, CaseIterable, Identifiable {
    case prs = "Pull Requests", tickets = "Tickets", board = "Sprint Board", workflows = "Workflows", automation = "Automation", settings = "Settings"
    var id: String { rawValue }
}

struct IDEChoice: Identifiable {
    let id: String
    let title: String
    static let all: [Self] = [.init(id: "", title: "None")]
        + ExternalTool.editors.map { .init(id: $0.id, title: $0.name) }
        + [.init(id: "custom", title: "Custom")]
}
