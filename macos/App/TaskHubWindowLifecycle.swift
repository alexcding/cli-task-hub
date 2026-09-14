import AppKit
import SwiftUI

/// Attaches native lifecycle hooks to the window created and owned by SwiftUI.
struct TaskHubWindowLifecycle: NSViewRepresentable {
    let onAttach: (NSWindow) -> Void
    let onClose: () -> Void
    let onMiniaturize: () -> Void

    func makeNSView(context: Context) -> WindowObserver {
        WindowObserver(onAttach: onAttach, onClose: onClose, onMiniaturize: onMiniaturize)
    }

    func updateNSView(_ view: WindowObserver, context: Context) {}

    static func dismantleNSView(_ view: WindowObserver, coordinator: ()) {
        view.detach()
    }

    final class WindowObserver: NSView, NSWindowDelegate {
        private let onAttach: (NSWindow) -> Void
        private let onClose: () -> Void
        private let onMiniaturize: () -> Void
        private weak var observedWindow: NSWindow?
        // NSObject's forwarding entry points are nonisolated. AppKit accesses
        // this delegate on the main thread; the overrides enforce that boundary.
        nonisolated(unsafe) private weak var sceneDelegate: (any NSWindowDelegate)?

        init(onAttach: @escaping (NSWindow) -> Void, onClose: @escaping () -> Void,
             onMiniaturize: @escaping () -> Void) {
            self.onAttach = onAttach
            self.onClose = onClose
            self.onMiniaturize = onMiniaturize
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            // Let SwiftUI install its scene delegate before extending it.
            DispatchQueue.main.async { [weak self] in self?.attach() }
        }

        private func attach() {
            guard observedWindow !== window else { return }
            detach()
            observedWindow = window
            sceneDelegate = window?.delegate
            guard let window else { return }
            window.delegate = self
            onAttach(window)
        }

        func detach() {
            if let observedWindow, observedWindow.delegate === self {
                observedWindow.delegate = sceneDelegate
            }
            observedWindow = nil
            sceneDelegate = nil
        }

        override func responds(to selector: Selector!) -> Bool {
            if super.responds(to: selector) { return true }
            guard Thread.isMainThread else { return false }
            return sceneDelegate?.responds(to: selector) == true
        }

        override func forwardingTarget(for selector: Selector!) -> Any? {
            if Thread.isMainThread, sceneDelegate?.responds(to: selector) == true { return sceneDelegate }
            return super.forwardingTarget(for: selector)
        }

        func windowShouldClose(_ sender: NSWindow) -> Bool {
            // Retain editors while Quit awaits Save/Discard/Cancel and cleanup.
            onClose()
            return false
        }

        func windowDidMiniaturize(_ notification: Notification) {
            onMiniaturize()
            sceneDelegate?.windowDidMiniaturize?(notification)
        }
    }
}
