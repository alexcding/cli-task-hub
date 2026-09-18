import SwiftUI

@main
struct TaskHubApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Window("TaskHub Native", id: "main") {
            AppCoordinatorView(coordinator: delegate.model.coordinator)
                .frame(minWidth: 760, minHeight: 480)
                .environment(\.documentFont, delegate.model.shell.font(.diff))
                .overlay(alignment: .topTrailing) {
                    ActivityToastView(notifications: delegate.model.shell.notifications)
                        .padding(.top, 6).padding(.trailing, 20)
                }
        }
        .windowToolbarStyle(.unified(showsTitle: false))
        .defaultSize(width: 1000, height: 680)
        .defaultPosition(.center)
        .commands {
            TaskHubCommands(model: delegate.model, perform: delegate.perform,
                            canCheckForUpdates: delegate.canCheckForUpdates)
        }
    }
}
