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

    /// The AppKit delegate forwards delivery here; parsing and navigation stay in the coordinator.
    @discardableResult public func handleOpenURL(_ url: URL) -> Bool { coordinator.handle(url: url) }
    public func resumePendingDeepLink() { coordinator.schedulePendingDeepLink() }
}
