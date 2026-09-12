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
        // Stay out of the Dock until the launch event tells us whether this is
        // a quiet login launch. Showing the window promotes the app to regular.
        application.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { application.run() }
    }
}
