import AppKit
import SwiftUI
import Observation

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSPopoverDelegate {
    private let model = AppViewModel()
    private var window: NSWindow?
    private var statusItem: NSStatusItem?
    private let popover = NSPopover()
    private var tray: TrayCoordinator?
    private var updater: AppUpdater?
    private lazy var termination = AppTerminationCoordinator(prepare: { [weak self] reason in
        guard let self else { throw CancellationError() }
        switch reason {
        case .quit: try await self.model.quit()
        case .update: try await self.model.prepareForUpdate()
        }
    }, finished: { reason, approved in
        if reason == .update { NSApp.reply(toApplicationShouldTerminate: approved) }
        else if approved { NSApp.terminate(nil) }
    }, failed: { [weak self] error in
        self?.showTerminationError(error)
    })
    private var menus: NativeMenus?
    private var receivedLaunchURL = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let quiet = AppLaunchContext.startsQuietly
        model.shell.applyAppearance()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 680),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "TaskHub Native"
        window.titleVisibility = .hidden
        window.toolbarStyle = .unifiedCompact
        let content = NSHostingView(rootView: ContentView(model: model, showTray: { [weak self] in self?.toggleTray() }))
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
        NotificationCenter.default.addObserver(self, selector: #selector(sheetDidEnd),
            name: NSWindow.didEndSheetNotification, object: nil)
        model.configureNativeNotifications(isMainWindowFocused: { [weak self] in self?.window?.isKeyWindow == true },
            showWindow: { [weak self] in self?.showWindow() })
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "square.stack.3d.up", accessibilityDescription: "TaskHub Native")
        item.button?.image?.isTemplate = true
        item.button?.setAccessibilityIdentifier("taskhub-status-item")
        item.button?.target = self
        item.button?.action = #selector(toggleTray)
        statusItem = item
        popover.behavior = .transient
        popover.delegate = self
        popover.contentSize = NSSize(width: 380, height: 580)
        let tray = model.makeTray(openWindow: { [weak self] in self?.showWindow() },
            dismiss: { [weak self] in self?.popover.performClose(nil) })
        self.tray = tray
        popover.contentViewController = NSHostingController(rootView: NativeTrayView(model: tray.model))
        observeStatus()
        updater = AppUpdater()
        menus = NativeMenus(perform: { [weak self] command in self?.perform(command) },
                            enabled: { [weak self] command in
            guard let self else { return false }
            if command == .checkForUpdates { return self.termination.pending == nil && self.updater?.canCheckForUpdates == true }
            return self.model.canPerform(command)
        })
        menus?.install()
        Task { await model.start() }
        if !quiet || receivedLaunchURL { showWindow() }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        var handled = false
        for url in urls { if model.handleOpenURL(url) { handled = true } }
        guard handled else { return }
        receivedLaunchURL = true
        if window != nil { showWindow() }
    }

    @objc private func sheetDidEnd(_ notification: Notification) { model.resumePendingDeepLink() }

    private func perform(_ command: ShellCommand) {
        switch command {
        case .checkForUpdates: updater?.checkForUpdates()
        case .closePage:
            if model.hasActivePage { model.perform(command) } else { window?.performClose(nil) }
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
            model.perform(command)
        }
    }

    @objc private func toggleTray() {
        if popover.isShown { popover.performClose(nil); return }
        guard let button = statusItem?.button else { return }
        tray?.setActive(true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    func popoverDidClose(_ notification: Notification) { tray?.setActive(false) }

    private func observeStatus() {
        withObservationTracking {
            let reviews = model.shell.pendingReviewCount
            statusItem?.button?.contentTintColor = reviews > 0
                ? NSColor(srgbRed: 0.596, green: 0.443, blue: 0.173, alpha: 1)
                : (model.hasOpenWork ? .systemBlue : .labelColor)
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
        NSApp.terminate(sender)
        return false
    }

    func windowDidMiniaturize(_ notification: Notification) { model.cancelBrowserPresentation() }
    func applicationDidHide(_ notification: Notification) { model.cancelBrowserPresentation() }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        switch termination.systemTermination(updateRequested: updater?.restartRequested == true) {
        case .now: return .terminateNow
        case .later: return .terminateLater
        }
    }

    private func showTerminationError(_ error: Error) {
        showWindow()
        if error is CancellationError { return }
        Task {
            let alert = NSAlert()
            alert.messageText = "TaskHub could not quit"
            alert.informativeText = error.localizedDescription
            alert.addButton(withTitle: "OK")
            if let window { _ = await alert.beginSheetModal(for: window) }
        }
    }
}
