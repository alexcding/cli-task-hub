import Foundation

struct WorkspaceSession: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let projectId: String
    let workspace: String
    let worktree: String
    let title: String
    let branch: String
    let url: String
    let createdAt: String?
    var pinned: Bool
    var kind: String? = nil
    var jiraKey: String? = nil
    var cli: String? = nil
    var sessionId: String? = nil

    var label: String {
        let folder = (worktree as NSString).lastPathComponent
        return folder.isEmpty ? (title.isEmpty ? id : title) : folder
    }
}

struct SavedTabContent: Codable, Equatable, Sendable {
    var kind: String? = nil
    var url: String? = nil
    var title: String? = nil
    var path: String? = nil
    var active: Bool? = nil

    var filePath: String? {
        guard kind == "file" else { return nil }
        if let path, path.hasPrefix("/"), !path.contains("\0") { return (path as NSString).standardizingPath }
        guard let url, let value = URL(string: url), value.isFileURL,
              value.host == nil || value.host == "" || value.host == "localhost",
              !value.path.contains("\0") else { return nil }
        return value.path
    }
}

struct SavedTab: Codable, Identifiable, Equatable, Sendable {
    let kind: String
    let title: String
    let url: String
    var category: String? = nil
    var cur: String? = nil
    var paneView: String? = nil
    var reviewView: String? = nil
    var pageClosed: Bool? = nil
    var links: [SavedTabContent]? = nil
    var history: [SavedTabContent]? = nil
    var id: String { url }
}

struct SavedTabs: Decodable, Sendable {
    let tabs: [SavedTab]
    let active: String?
}

enum SidebarDestination: Hashable, Codable {
    case overview, terminal, activity, settings, project(String), session(String), tab(String)
}

struct SidebarEntry: Equatable {
    let id: String // placement identity: a pinned mirror differs from its original
    let title: String
    let symbol: String
    var detail = ""
    var destination: SidebarDestination?
    var children: [SidebarEntry] = []

    var isGroup: Bool { destination == nil }

    static func make(projects: [Project], sessions: [WorkspaceSession], tabs: [SavedTab], workflowProgress: [String: String] = [:]) -> [Self] {
        let ordered = sessions.sorted {
            if ($0.createdAt ?? "") != ($1.createdAt ?? "") { return ($0.createdAt ?? "") < ($1.createdAt ?? "") }
            if $0.label != $1.label { return $0.label.localizedStandardCompare($1.label) == .orderedAscending }
            return $0.id < $1.id
        }
        func row(_ session: WorkspaceSession, pinned: Bool = false) -> Self {
            Self(id: "\(pinned ? "pin" : "session"):\(session.id)", title: session.label + (workflowProgress[session.id].map { " · \($0)" } ?? ""),
                 symbol: pinned ? "pin" : "terminal", detail: session.worktree,
                 destination: .session(session.id))
        }
        var result: [Self] = [
            .init(id: "overview", title: "Dashboard", symbol: "custom:dashboard", destination: .overview)
        ]
        if !projects.isEmpty {
            result.append(.init(id: "projects", title: "Projects", symbol: "folder", children: projects.map { project in
                .init(id: "project:\(project.id)", title: project.name, symbol: "folder", detail: project.workspace,
                      destination: .project(project.id), children: ordered.filter { $0.projectId == project.id }.map { row($0) })
            }))
        }
        let pinned = ordered.filter(\.pinned)
        if !pinned.isEmpty {
            result.append(.init(id: "pinned", title: "Pinned", symbol: "pin", children: pinned.map { row($0, pinned: true) }))
        }
        let projectIDs = Set(projects.map(\.id))
        let orphans = ordered.filter { !projectIDs.contains($0.projectId) }
        if !orphans.isEmpty {
            result.append(.init(id: "orphans", title: "Sessions", symbol: "terminal", children: orphans.map { row($0) }))
        }
        let taskURLs = Set(sessions.map(\.url).filter { !$0.isEmpty })
        let unownedTabs = tabs.filter { !taskURLs.contains($0.url) }
        if !unownedTabs.isEmpty {
            result.append(.init(id: "tabs", title: "Tabs", symbol: "globe", children: unownedTabs.map {
                .init(id: "tab:\($0.url)", title: $0.title.isEmpty ? $0.url : $0.title,
                      symbol: "globe", detail: $0.url, destination: .tab($0.url))
            }))
        }
        return result
    }

    var descendants: [Self] { [self] + children.flatMap(\.descendants) }
}
