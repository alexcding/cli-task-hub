import AppKit
import Observation

@MainActor protocol TerminalPaneServing: AnyObject {
    var showsSurface: Bool { get set }
    var ready: Bool { get }
    func setStyle(_ value: TerminalStyle)
    func start() async
    func ownsPresentationWindow(_ window: NSWindow) -> Bool
    func applyPresentation(active: Bool, focus: Bool)
}

/// Owns presentation policy without owning or stopping the detached shell.
@MainActor @Observable final class TerminalPaneViewModel {
    struct Presentation: Equatable {
        var active = false
        var style = TerminalStyle()
    }
    var presentation = Presentation() {
        didSet {
            guard oldValue != presentation else { return }
            if oldValue.style != presentation.style { pendingStyle = presentation.style }
            refreshVisibility()
        }
    }
    @ObservationIgnored private weak var session: (any TerminalPaneServing)?
    @ObservationIgnored private var mounted = false
    @ObservationIgnored private var scheduled = false
    @ObservationIgnored private var pendingFocus = false
    @ObservationIgnored private var pendingStyle: TerminalStyle?

    init(session: any TerminalPaneServing) { self.session = session }

    var visible: Bool {
        get { session?.showsSurface ?? false }
        set { session?.showsSurface = newValue }
    }

    func appear() {
        mounted = true
        refreshVisibility()
    }

    func disappear() {
        mounted = false
        refreshVisibility()
    }

    func visibilityChanged(_ shown: Bool) { refreshVisibility(focus: shown) }
    func surfaceChanged() { refreshVisibility() }
    func becameReady() { refreshVisibility(focus: true) }
    func start() async {
        pendingStyle = presentation.style; refreshVisibility()
        // SwiftUI tasks may execute synchronously up to their first suspension.
        // Apply the queued style after the update pass, before attaching output.
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
        await session?.start()
    }

    func windowOcclusionChanged(_ notification: Notification) {
        guard let window = notification.object as? NSWindow,
              session?.ownsPresentationWindow(window) == true else { return }
        refreshVisibility()
    }

    private func refreshVisibility(focus: Bool = false) {
        // Display/focus updates can originate in AppKit layout notifications;
        // publish them after SwiftUI's update pass, using the latest state.
        pendingFocus = pendingFocus || focus
        guard !scheduled else { return }
        scheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            scheduled = false
            let focus = pendingFocus
            pendingFocus = false
            let style = pendingStyle
            pendingStyle = nil
            guard let session else { return }
            if let style { session.setStyle(style) }
            let presentationActive = mounted && presentation.active
            session.applyPresentation(active: presentationActive, focus: focus && presentationActive && session.showsSurface && session.ready)
        }
    }
}

extension TerminalSession: TerminalPaneServing {
    func ownsPresentationWindow(_ window: NSWindow) -> Bool {
        window === surface.attachedPlatformView?.window
    }

    func applyPresentation(active: Bool, focus: Bool) {
        let view = surface.attachedPlatformView
        let window = view?.window
        let visible = active && showsSurface && (window?.occlusionState.contains(.visible) ?? true)
        if surface.isSurfaceVisible != visible { surface.isSurfaceVisible = visible }
        if !visible, let view, window?.firstResponder === view {
            window?.makeFirstResponder(nil)
        } else if visible && focus {
            // Already outside the update pass. Avoid queuing a focus request
            // that could later steal focus after this workspace is hidden.
            _ = view?.acquireProgrammaticFocus()
        }
    }
}
