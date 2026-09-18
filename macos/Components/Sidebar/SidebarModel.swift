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
    /// The backend's identity for the tab. Several tabs may show the same URL.
    let id: String
    let kind: String
    var title: String
    let url: String
    var category: String? = nil
    var cur: String? = nil
    var paneView: String? = nil
    var reviewView: String? = nil
    var pageClosed: Bool? = nil
    var login: String? = nil
    var avatar: String? = nil
    var links: [SavedTabContent]? = nil
    var history: [SavedTabContent]? = nil
    /// A pinned tab leaves the Tabs list for the favourites grid under Dashboard.
    var pinned: Bool = false

    init(id: String? = nil, kind: String, title: String, url: String, category: String? = nil, cur: String? = nil,
         paneView: String? = nil, reviewView: String? = nil, pageClosed: Bool? = nil, login: String? = nil,
         avatar: String? = nil, links: [SavedTabContent]? = nil, history: [SavedTabContent]? = nil, pinned: Bool = false) {
        self.id = id ?? url; self.kind = kind; self.title = title; self.url = url
        self.category = category; self.cur = cur; self.paneView = paneView; self.reviewView = reviewView
        self.pageClosed = pageClosed; self.login = login; self.avatar = avatar; self.links = links; self.history = history
        self.pinned = pinned
    }

    init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        url = try values.decode(String.self, forKey: .url)
        id = try values.decodeIfPresent(String.self, forKey: .id) ?? url // Records saved before tabs had ids.
        kind = try values.decode(String.self, forKey: .kind)
        title = try values.decodeIfPresent(String.self, forKey: .title) ?? ""
        category = try values.decodeIfPresent(String.self, forKey: .category)
        cur = try values.decodeIfPresent(String.self, forKey: .cur)
        paneView = try values.decodeIfPresent(String.self, forKey: .paneView)
        reviewView = try values.decodeIfPresent(String.self, forKey: .reviewView)
        pageClosed = try values.decodeIfPresent(Bool.self, forKey: .pageClosed)
        login = try values.decodeIfPresent(String.self, forKey: .login)
        avatar = try values.decodeIfPresent(String.self, forKey: .avatar)
        links = try values.decodeIfPresent([SavedTabContent].self, forKey: .links)
        history = try values.decodeIfPresent([SavedTabContent].self, forKey: .history)
        pinned = try values.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
    }
}



struct SavedTabs: Decodable, Sendable {
    let tabs: [SavedTab]
    let active: String?
}

enum SidebarDestination: Hashable, Codable {
    case overview, terminal, activity, settings, project(String), session(String), tab(String)

    var tabID: String? { if case .tab(let id) = self { id } else { nil } }
}

/// What the sidebar knows about a session's agent at render time — the
/// `.busy` / `.stopped` row states. Busy spins the CLI's glyph; live-but-idle holds it still
/// in grey; stopped dims the row.
struct SidebarSessionStatus: Equatable {
    var live = false
    var busy = false
    var cli: String?
}

/// A task-less tab row's leading mark: the PR author's avatar with its CI badge, the Jira
/// mark, or a globe.
struct SidebarTabIcon: Equatable {
    enum CI: Equatable { case none, running, success, failure }
    var kind = "web"
    var login: String?
    var avatar: String?
    var ci: CI = .none
    /// The page address, for the domain favicon on web rows.
    var url: String?
}

/// One tile in the pinned-tabs grid under Dashboard: a saved tab that was pinned.
struct SidebarPinnedTab: Equatable, Identifiable {
    let id: String
    let title: String
    let url: String
    var icon = SidebarTabIcon()
}

struct SidebarEntry: Equatable {
    var isHeading: Bool { role == .label || role == .tabsHeader }
    enum Role: Equatable {
        case nav                                  // Dashboard
        case label                                // "Pinned" / "Projects" heading
        case tabsHeader                           // "Tabs" heading with a hover "+" for a new tab
        case project(canCreateSession: Bool)
        case session(SidebarSessionStatus, pinned: Bool)
        case tab(SidebarTabIcon)
        case pinnedTabs([SidebarPinnedTab])       // Arc-style favourites grid right under Dashboard
    }

    let id: String // placement identity: a pinned mirror differs from its original
    let title: String
    let symbol: String
    var detail = ""
    var destination: SidebarDestination?
    var children: [SidebarEntry] = []
    var role: Role = .nav
    var tooltip: String?

    var isGroup: Bool { destination == nil }
    var sessionID: String? { if case .session(let id) = destination { id } else { nil } }
    var projectID: String? { if case .project(let id) = destination { id } else { nil } }

    /// Mirrors src/renderer/components/sidebar.js: Dashboard, the pinned-tabs grid, the Pinned
    /// session mirrors, the Projects heading with each folder's sessions nested under it, sessions
    /// whose project is gone (unlabeled), then every unpinned task-less tab under "Tabs". Headings
    /// are flat rows, not collapsible groups — only a project folder collapses.
    static func make(projects: [Project], sessions: [WorkspaceSession], tabs: [SavedTab],
                     status: [String: SidebarSessionStatus] = [:], workflowProgress: [String: String] = [:],
                     tabIcons: [String: SidebarTabIcon] = [:]) -> [Self] {
        let ordered = sessions.sorted {
            if ($0.createdAt ?? "") != ($1.createdAt ?? "") { return ($0.createdAt ?? "") < ($1.createdAt ?? "") }
            if $0.label != $1.label { return $0.label.localizedStandardCompare($1.label) == .orderedAscending }
            return $0.id < $1.id
        }
        func row(_ session: WorkspaceSession, pinned: Bool = false) -> Self {
            let state = status[session.id] ?? SidebarSessionStatus(cli: session.cli)
            var tip = session.worktree
            if let step = workflowProgress[session.id] { tip = "\(session.label)\nWorkflow step \(step)" }
            else if !state.live { tip += "\nStopped — click to resume" }
            return Self(id: "\(pinned ? "pin" : "session"):\(session.id)", title: session.label,
                        symbol: "", detail: session.worktree, destination: .session(session.id),
                        role: .session(state, pinned: session.pinned)).withTip(tip)
        }
        func label(_ id: String, _ title: String) -> Self { Self(id: id, title: title, symbol: "", role: .label) }
        var result: [Self] = [
            .init(id: "overview", title: "Dashboard", symbol: "dashboard", destination: .overview)
        ]
        let taskURLs = Set(sessions.map(\.url).filter { !$0.isEmpty })
        let unownedTabs = tabs.filter { !taskURLs.contains($0.url) }
        func icon(_ tab: SavedTab) -> SidebarTabIcon {
            tabIcons[tab.url] ?? SidebarTabIcon(kind: tab.kind, login: tab.login, avatar: tab.avatar, url: tab.url)
        }
        func tabTitle(_ tab: SavedTab) -> String { tab.title.isEmpty ? (tab.url.isEmpty ? "New Tab" : tab.url) : tab.title }
        let pinnedTabs = unownedTabs.filter(\.pinned)
        if !pinnedTabs.isEmpty {
            result.append(Self(id: "pinned-tabs", title: "Pinned Tabs", symbol: "",
                               role: .pinnedTabs(pinnedTabs.map { .init(id: $0.id, title: tabTitle($0), url: $0.url, icon: icon($0)) })))
        }
        let pinned = ordered.filter(\.pinned)
        if !pinned.isEmpty {
            result.append(label("label:pinned", "Pinned"))
            result += pinned.map { row($0, pinned: true) }
        }
        result.append(label("label:projects", "Projects"))
        result += projects.map { project in
            .init(id: "project:\(project.id)", title: project.name, symbol: "folder", detail: project.workspace,
                  destination: .project(project.id), children: ordered.filter { $0.projectId == project.id }.map { row($0) },
                  role: .project(canCreateSession: !project.workspace.isEmpty))
        }
        let projectIDs = Set(projects.map(\.id))
        result += ordered.filter { !projectIDs.contains($0.projectId) }.map { row($0) }
        result.append(Self(id: "label:tabs", title: "Tabs", symbol: "", role: .tabsHeader))
        result += unownedTabs.filter { !$0.pinned }.map {
            .init(id: "tab:\($0.id)", title: tabTitle($0), symbol: "", detail: $0.url, destination: .tab($0.id), role: .tab(icon($0)))
        }
        return result
    }

    private func withTip(_ value: String) -> Self { var copy = self; copy.tooltip = value; return copy }

    var descendants: [Self] { [self] + children.flatMap(\.descendants) }
}
