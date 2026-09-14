import Foundation

extension AppViewModel: TrayCoordinating {
    func trayState() -> TrayState {
        .init(connection: connection, tabs: tabs, sessions: sessions, reviews: shell.prs,
              acknowledging: shell.acknowledging, canNavigate: coordinator.canPresent && coordinator.canOpenExternalRoute())
    }
    func refreshTray() {
        shell.notifications.refreshAuthorization()
        refresh(); shell.refreshUsage(); shell.loadSettings()
    }
    func acknowledgeTrayReview(_ review: TrayPR) { shell.acknowledge(review) }
    func selectTrayDestination(_ destination: SidebarDestination) { select(destination) }
}
