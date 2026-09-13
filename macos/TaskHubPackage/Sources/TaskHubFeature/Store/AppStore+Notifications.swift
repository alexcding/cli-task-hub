import Foundation

extension AppStore: NotificationCoordinating {
    func acknowledgeNotificationReview(repo: String, number: Int) {
        shell.acknowledgeReview(repo: repo, number: number)
    }

    public func configureNativeNotifications(isMainWindowFocused: @escaping () -> Bool,
                                            showWindow: @escaping () -> Void) {
        shell.notifications.isMainWindowFocused = isMainWindowFocused
        coordinator.notificationCoordinator?.showWindow = showWindow
        shell.notifications.configure(MacNotificationDelivery(store: shell.notifications))
    }
}
