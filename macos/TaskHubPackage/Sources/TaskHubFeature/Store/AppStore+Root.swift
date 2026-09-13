import Foundation

extension AppStore: RootCoordinating {
    func rootState() -> RootState {
        RootState(selection: selection, entries: sidebarEntries, projects: projects, sessions: sessions, tabs: tabs,
                  projectModels: projectModels, dashboard: dashboard, logs: logs, settings: settings, error: error,
                  hasTerminal: terminal != nil, canCreateProject: canPerform(.newProject),
                  canCreateSession: canPerform(.newSession), canRefresh: canPerform(.refresh))
    }
    func performRootCommand(_ command: ShellCommand) { perform(command) }
}
