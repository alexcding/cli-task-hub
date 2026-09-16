import SwiftUI

@main
struct TaskHubApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Window("TaskHub Native", id: "main") {
            ContentView(model: delegate.model)
                .frame(minWidth: 760, minHeight: 480)
                .environment(\.terminalFont, delegate.model.shell.font(.term))
                .environment(\.documentFont, delegate.model.shell.font(.diff))
                .overlay(alignment: .topTrailing) {
                    // #activity-toasts: 20pt in from the right, just under the toolbar.
                    ActivityToastView(notifications: delegate.model.shell.notifications)
                        .padding(.top, 6).padding(.trailing, 20)
                }
                .background {
                    TaskHubWindowLifecycle(onAttach: delegate.attachWindow,
                        onClose: { NSApp.terminate(nil) },
                        onMiniaturize: delegate.model.cancelBrowserPresentation)
                }
        }
        .defaultSize(width: 1000, height: 680)
        .defaultPosition(.center)
        .commands {
            TaskHubCommands(model: delegate.model, perform: delegate.perform,
                            canCheckForUpdates: delegate.canCheckForUpdates)
        }
    }
}
