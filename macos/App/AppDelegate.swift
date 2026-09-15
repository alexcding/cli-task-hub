import AppKit
import SwiftUI
import Observation

@MainActor @Observable
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    let model = AppViewModel()
    @ObservationIgnored private weak var window: NSWindow?
    @ObservationIgnored private var statusItem: NSStatusItem?
    private let popover = NSPopover()
    @ObservationIgnored private var tray: TrayCoordinator?
    private var updater: AppUpdater?
    @ObservationIgnored private lazy var termination = AppTerminationCoordinator(prepare: { [weak self] reason in
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
    @ObservationIgnored private var receivedLaunchURL = false
    @ObservationIgnored private var finishedLaunching = false
    @ObservationIgnored private var quietLaunch = false
    @ObservationIgnored private var windowRequested = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        quietLaunch = AppLaunchContext.startsQuietly
        finishedLaunching = true
        model.shell.applyAppearance()
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
            dismiss: { [weak self] in self?.popover.performClose(nil) },
            quit: { NSApp.terminate(nil) }) // through applicationShouldTerminate → the termination coordinator
        self.tray = tray
        popover.contentViewController = NSHostingController(rootView: NativeTrayView(model: tray.model))
        observeStatus()
        updater = AppUpdater()
        Task { await model.start() }
        if !quietLaunch || receivedLaunchURL || windowRequested { showWindow() }
        else { window?.orderOut(nil); NSApp.hide(nil) }
    }

    func attachWindow(_ window: NSWindow) {
        guard self.window !== window else { return }
        self.window = window
        window.titleVisibility = .hidden
        window.setFrameAutosaveName("TaskHubNativeMain")
        guard finishedLaunching else { return }
        if !quietLaunch || receivedLaunchURL || windowRequested { showWindow() }
        else { window.orderOut(nil) }
    }

    var canCheckForUpdates: Bool {
        termination.pending == nil && updater?.canCheckForUpdates == true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        var handled = false
        for url in urls { if model.handleOpenURL(url) { handled = true } }
        guard handled else { return }
        receivedLaunchURL = true
        if window != nil { showWindow() }
    }

    @objc private func sheetDidEnd(_ notification: Notification) { model.resumePendingDeepLink() }

    func perform(_ command: ShellCommand) {
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

    @objc func toggleTray() {
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
        windowRequested = true
        NSApp.setActivationPolicy(.regular)
        NSApp.unhide(nil)
        popover.performClose(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

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
