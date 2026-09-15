import SwiftUI

@main
struct TaskHubApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Window("TaskHub Native", id: "main") {
            ContentView(model: delegate.model)
                .modifier(TaskHubWindowChrome())
                .frame(minWidth: 760, minHeight: 480)
                .environment(\.terminalFont, delegate.model.shell.font(.term))
                .environment(\.documentFont, delegate.model.shell.font(.diff))
                .overlay(alignment: .topTrailing) {
                    ActivityToastView(notifications: delegate.model.shell.notifications)
                        .frame(maxWidth: 420).padding(16)
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

private struct TaskHubWindowChrome: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content.toolbar(removing: .sidebarToggle).toolbar(removing: .title)
        } else {
            content
        }
    }
}
