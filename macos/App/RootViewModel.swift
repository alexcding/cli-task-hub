import Foundation
import Observation

@MainActor struct RootState {
    var selection: SidebarDestination = .overview
    var entries: [SidebarEntry] = []
    var projects: [Project] = []
    var sessions: [WorkspaceSession] = []
    var tabs: [SavedTab] = []
    var projectModels: [String: ProjectPageViewModel] = [:]
    var dashboard: DashboardViewModel?
    var logs: LogsViewModel?
    var todayActivity: TodayActivityViewModel?
    var settings: SettingsViewModel?
    var error: String?
    var hasTerminal = false
    var canCreateProject = false
    var canOpenLink = false
    var canCreateSession = false
    var canRefresh = false
}

@MainActor protocol RootServing: AnyObject { func rootState() -> RootState }

@MainActor @Observable final class RootViewModel {
    enum Action: Equatable {
        case select(SidebarDestination), command(ShellCommand), togglePin(String), newSession(projectID: String)
        case closeTab(String)
        case reconnect, openTerminal, openBrowser(URL)
    }
    enum Destination {
        case dashboard(DashboardViewModel), activity(LogsViewModel), settings(SettingsViewModel)
        case project(ProjectPageViewModel)
        case terminal, session(WorkspaceSession), tab(String, URL?), unavailable(String)
    }
    struct Workspace: Identifiable {
        let id: String
        let context: WorkspaceContext
        let model: SessionWorkspaceViewModel
        let active: Bool
    }
    let shell: ShellStore
    let viewer: ViewerStore
    @ObservationIgnored private weak var service: (any RootServing)?
    @ObservationIgnored var onAction: (Action) -> Void = { _ in }

    init(service: any RootServing, shell: ShellStore, viewer: ViewerStore) {
        self.service = service; self.shell = shell; self.viewer = viewer
    }
    private var state: RootState { service?.rootState() ?? RootState() }
    var selection: SidebarDestination { state.selection }
    var entries: [SidebarEntry] { state.entries }
    var pinnedIDs: Set<String> { Set(state.sessions.filter(\.pinned).map(\.id)) }
    var error: String? {
        let state = self.state
        switch state.selection {
        case .overview, .project: return state.error
        default: return nil
        }
    }
    var canCreateProject: Bool { state.canCreateProject }
    var canOpenLink: Bool { state.canOpenLink }
    var todayActivity: TodayActivityViewModel? { state.todayActivity }
    var canCreateSession: Bool { state.canCreateSession }
    var canRefresh: Bool { state.canRefresh }
    var hasWorkspace: Bool { viewer.active != nil }
    var showsDestination: Bool { !state.hasTerminal && !hasWorkspace }
    var showsDashboard: Bool {
        if case .overview = state.selection { return true }
        return false
    }
    var workspaces: [Workspace] {
        viewer.contexts.keys.sorted().compactMap { id in
            guard let context = viewer.contexts[id], let model = context.workspaceViewModel else { return nil }
            return Workspace(id: id, context: context, model: model, active: viewer.activeContextID == id)
        }
    }
    var activeWorkspace: Workspace? { workspaces.first(where: \.active) }
    var title: String {
        let state = self.state
        switch state.selection {
        case .overview: return "Overview"
        case .terminal: return "Terminal"
        case .activity: return "Activity"
        case .settings: return "Settings"
        case .project(let id): return state.projects.first { $0.id == id }?.name ?? "Project"
        case .session(let id): return state.sessions.first { $0.id == id }?.label ?? "Session"
        case .tab(let url): return state.tabs.first { $0.url == url }?.title ?? "Tab"
        }
    }
    var destination: Destination {
        let state = self.state
        switch state.selection {
        case .overview:
            return state.dashboard.map(Destination.dashboard) ?? .unavailable("Connect to load the dashboard.")
        case .activity:
            return state.logs.map(Destination.activity) ?? .unavailable("Connect to load activity.")
        case .settings:
            return state.settings.map(Destination.settings) ?? .unavailable("Connect to load settings.")
        case .terminal: return .terminal
        case .project(let id):
            guard let project = state.projectModels[id] else {
                return .unavailable("Connect to load this project.")
            }
            return .project(project)
        case .session(let id):
            return state.sessions.first { $0.id == id }.map(Destination.session) ?? .unavailable("Session is not available.")
        case .tab(let url):
            let address = URL(string: url)
            let valid = address.map { ["http", "https"].contains($0.scheme?.lowercased() ?? "") } ?? false
            return .tab(url, valid ? address : nil)
        }
    }
    func select(_ destination: SidebarDestination) { onAction(.select(destination)) }
    func togglePin(_ id: String) { onAction(.togglePin(id)) }
    func closeTab(_ url: String) { onAction(.closeTab(url)) }
    func reconnect() { onAction(.reconnect) }
    func newProject() { if canCreateProject { onAction(.command(.newProject)) } }
    func openLink() { if canOpenLink { onAction(.command(.openLink)) } }
    func newSession() { if canCreateSession { onAction(.command(.newSession)) } }
    /// A project folder's hover "+": New Session on that project, wherever the window is.
    func newSession(in projectID: String) { onAction(.newSession(projectID: projectID)) }
    func refresh() { if canRefresh { onAction(.command(.refresh)) } }
    func openTerminal() { onAction(.openTerminal) }
    func openBrowser(_ url: URL) { onAction(.openBrowser(url)) }
}
