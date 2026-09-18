import Foundation

extension AppViewModel: RootCoordinating, ProjectCoordinating {
    func rootState() -> RootState {
        RootState(selection: selection, entries: sidebarEntries, projects: projects, sessions: sessions, tabs: visibleTabs,
                  projectModels: projectModels, dashboard: dashboard, logs: logs, todayActivity: todayActivity, settings: settings, error: coordinator.routingError ?? error,
                  hasTerminal: terminal != nil, canCreateProject: canPerform(.newProject),
                  canCreateSession: canPerform(.newSession), canRefresh: canPerform(.refresh))
    }
    func performRootCommand(_ command: ShellCommand) { perform(command) }
    func newSession(in projectID: String) { presentNewSession(in: projectID, pageURL: nil) }

    /// Sidebar right-click Remove Session. Same sheet the workspace toolbar opens, so a session
    /// can be removed without first opening it.
    func makeSessionRemoval(_ id: String) -> SessionRemovalViewModel? {
        guard let session = sessions.first(where: { $0.id == id }), !changingSessions.contains(id) else { return nil }
        return removalModel(for: session)
    }

    /// The AppKit delegate forwards delivery here; parsing and navigation stay in the coordinator.
    @discardableResult public func handleOpenURL(_ url: URL) -> Bool { coordinator.handle(url: url) }
    public func resumePendingDeepLink() { coordinator.schedulePendingDeepLink() }
}
