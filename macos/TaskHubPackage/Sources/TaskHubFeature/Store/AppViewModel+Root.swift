import Foundation

extension AppViewModel: RootCoordinating, ProjectCoordinating {
    func rootState() -> RootState {
        RootState(selection: selection, entries: sidebarEntries, projects: projects, sessions: sessions, tabs: tabs,
                  projectModels: projectModels, dashboard: dashboard, logs: logs, settings: settings, error: coordinator.routingError ?? error,
                  hasTerminal: terminal != nil, canCreateProject: canPerform(.newProject),
                  canCreateSession: canPerform(.newSession), canRefresh: canPerform(.refresh))
    }
    func performRootCommand(_ command: ShellCommand) { perform(command) }

    /// The AppKit delegate forwards delivery here; parsing and navigation stay in the coordinator.
    @discardableResult public func handleOpenURL(_ url: URL) -> Bool { coordinator.handle(url: url) }
    public func resumePendingDeepLink() { coordinator.schedulePendingDeepLink() }
}
