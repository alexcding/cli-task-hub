import AppKit

@main
struct TaskHubApp {
    @MainActor static func main() {
        // AppKit owns the window, menus, status item, and quit contract. SwiftUI
        // remains the page renderer through NSHostingView; a dummy Settings scene
        // otherwise replaces the native menu after launch and on focus changes.
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}
