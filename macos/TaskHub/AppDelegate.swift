import AppKit
import SwiftUI
import TaskHubFeature
import Observation

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let store = AppStore()
    private var window: NSWindow?
    private var statusItem: NSStatusItem?
    private let popover = NSPopover()
    private var quitting = false
    private var terminationApproved = false
    private var menus: NativeMenus?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let quiet = AppLaunchContext.startsQuietly
        store.shell.applyAppearance()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 680),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "TaskHub Native"
        let content = NSHostingView(rootView: ContentView(store: store, showTray: { [weak self] in self?.toggleTray() }))
        // The window owns its size. Deriving constraints from nested browser and
        // split-view ideal sizes can feed changes back into the same layout pass.
        content.sizingOptions = []
        window.contentMinSize = NSSize(width: 760, height: 480)
        window.contentView = content
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("TaskHubNativeMain")
        window.center()
        self.window = window
        store.shell.notifications.isMainWindowFocused = { [weak self] in self?.window?.isKeyWindow == true }
        store.shell.notifications.configureNativeDelivery(openURL: { [weak self] url, repo, number in
            guard NSWorkspace.shared.open(url) else { return }
            if let repo, let number { self?.store.shell.acknowledgeReview(repo: repo, number: number) }
        }, openActivity: { [weak self] in
            self?.showWindow()
            self?.store.perform(.activity)
        })
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "square.stack.3d.up", accessibilityDescription: "TaskHub Native")
        item.button?.image?.isTemplate = true
        item.button?.setAccessibilityIdentifier("taskhub-status-item")
        item.button?.target = self
        item.button?.action = #selector(toggleTray)
        statusItem = item
        popover.behavior = .transient
        popover.contentSize = NSSize(width: 380, height: 580)
        popover.contentViewController = NSHostingController(rootView: NativeTrayView(
            store: store, openWindow: { [weak self] in self?.showWindow() },
            dismiss: { [weak self] in self?.popover.performClose(nil) },
            quit: { [weak self] in self?.quitFromTray() }))
        observeStatus()
        menus = NativeMenus(perform: { [weak self] command in self?.perform(command) },
                            enabled: { [weak self] command in self?.store.canPerform(command) == true })
        menus?.install()
        Task { await store.start() }
        if !quiet { showWindow() }
    }

    private func perform(_ command: ShellCommand) {
        switch command {
        case .closePage:
            if store.hasActivePage { store.perform(command) } else { window?.orderOut(nil) }
        case .hide: window?.orderOut(nil)
        case .tray: toggleTray()
        case .sidebar:
            showWindow()
            func findOutline(_ view: NSView) -> NSView? {
                if view.identifier?.rawValue == "workspace-sidebar" { return view }
                return view.subviews.lazy.compactMap(findOutline).first
            }
            if let root = window?.contentView, let outline = findOutline(root) { window?.makeFirstResponder(outline) }
        default:
            showWindow()
            store.perform(command)
        }
    }

    @objc private func toggleTray() {
        if popover.isShown { popover.performClose(nil); return }
        guard let button = statusItem?.button else { return }
        store.trayWillOpen()
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    private func observeStatus() {
        withObservationTracking {
            let reviews = store.shell.pendingReviewCount
            statusItem?.button?.contentTintColor = reviews > 0
                ? NSColor(srgbRed: 0.596, green: 0.443, blue: 0.173, alpha: 1)
                : (store.hasOpenWork ? .systemBlue : .labelColor)
            statusItem?.button?.toolTip = reviews > 0 ? "TaskHub: \(reviews) pending reviews" : "TaskHub Native"
        } onChange: { [weak self] in
            Task { @MainActor in self?.observeStatus() }
        }
    }

    @objc private func showWindow() {
        NSApp.setActivationPolicy(.regular)
        popover.performClose(nil)
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
        if terminationApproved { return .terminateNow }
        window?.orderOut(nil)
        return .terminateCancel
    }

    @objc private func quitFromTray() {
        guard !quitting else { return }
        quitting = true
        popover.performClose(nil)
        Task {
            do {
                try await store.quit()
                terminationApproved = true
                NSApp.terminate(nil)
            } catch {
                quitting = false
                showWindow()
                let alert = NSAlert()
                if error is CancellationError { return }
                alert.messageText = "TaskHub could not quit"
                alert.informativeText = error.localizedDescription
                alert.addButton(withTitle: "OK")
                if let window { _ = await alert.beginSheetModal(for: window) }
            }
        }
    }
}
