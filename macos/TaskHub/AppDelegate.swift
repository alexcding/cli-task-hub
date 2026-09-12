import AppKit
import SwiftUI
import TaskHubFeature

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let store = AppStore()
    private var window: NSWindow?
    private var statusItem: NSStatusItem?
    private var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 680),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "TaskHub Native"
        window.contentView = NSHostingView(rootView: ContentView(store: store))
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("TaskHubNativeMain")
        window.center()
        self.window = window
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "square.stack.3d.up", accessibilityDescription: "TaskHub Native")
        let menu = NSMenu()
        menu.addItem(withTitle: "Open TaskHub Native", action: #selector(showWindow), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit TaskHub Native", action: #selector(quitFromTray), keyEquivalent: "").target = self
        item.menu = menu
        statusItem = item
        showWindow()
    }

    @objc private func showWindow() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting { return .terminateNow }
        window?.orderOut(nil)
        return .terminateCancel
    }

    @objc private func quitFromTray() {
        guard !quitting else { return }
        quitting = true
        Task {
            await store.stop()
            NSApp.terminate(nil)
        }
    }
}
