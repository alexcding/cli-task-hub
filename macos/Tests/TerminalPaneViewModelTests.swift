import AppKit
import Testing

@MainActor private final class TerminalPresentationFixture: TerminalPaneServing {
    var showsSurface = true
    var ready = true
    var updates: [(active: Bool, focus: Bool)] = []
    var style: TerminalStyle?
    var starts = 0
    func setStyle(_ value: TerminalStyle) { style = value }
    func start() async { starts += 1 }
    func ownsPresentationWindow(_ window: NSWindow) -> Bool { false }
    func applyPresentation(active: Bool, focus: Bool) { updates.append((active, focus)) }
}

@MainActor private func flushPresentation() async {
    await withCheckedContinuation { continuation in
        DispatchQueue.main.async { continuation.resume() }
    }
}

@MainActor @Test func terminalPresentationDefersDisplayAndUsesLatestVisibilityWithoutLateFocus() async {
    let session = TerminalPresentationFixture(), model = TerminalPaneViewModel(session: session)
    model.presentation.active = true; model.appear()
    #expect(session.updates.isEmpty)
    model.presentation.style = TerminalStyle(font: CodeFont(size: 14))
    model.presentation.style = TerminalStyle(font: CodeFont(size: 18))
    #expect(session.style == nil)
    model.visible = false; model.visibilityChanged(false)
    model.visible = true; model.visibilityChanged(true)
    model.presentation.active = false
    #expect(session.updates.isEmpty)
    await flushPresentation()
    #expect(session.updates.count == 1)
    #expect(session.updates[0].active == false && session.updates[0].focus == false)
    #expect(session.style == TerminalStyle(font: CodeFont(size: 18)))
    model.presentation = .init(active: false, style: TerminalStyle(font: CodeFont(size: 18)))
    await flushPresentation()
    #expect(session.updates.count == 1) // Equal input does not enqueue display work.

    model.presentation.active = true
    model.visibilityChanged(true)
    await flushPresentation()
    #expect(session.updates.count == 2)
    #expect(session.updates[1].active && session.updates[1].focus)
    model.disappear()
    await flushPresentation()
    #expect(session.updates.count == 3 && !session.updates[2].active && !session.updates[2].focus)
    #expect(session.starts == 0) // Presentation never starts or restarts a shell.
}

@MainActor @Test func terminalPresentationDoesNotFocusHiddenOrUnreadySurfaces() async {
    let session = TerminalPresentationFixture(), model = TerminalPaneViewModel(session: session)
    model.presentation.active = true; model.appear()
    session.ready = false
    model.visibilityChanged(true)
    await flushPresentation()
    #expect(session.updates.count == 1 && !session.updates[0].focus)
    session.ready = true
    model.becameReady()
    model.visible = false
    model.surfaceChanged()
    await flushPresentation()
    #expect(session.updates.count == 2 && !session.updates[1].focus)
    model.windowOcclusionChanged(Notification(name: NSWindow.didChangeOcclusionStateNotification, object: NSObject()))
    await flushPresentation()
    #expect(session.updates.count == 2)
}

@MainActor @Test func terminalPresentationForwardsStartupAndDoesNotRetainClosedRuntime() async {
    var session: TerminalPresentationFixture? = TerminalPresentationFixture()
    weak var retained = session
    let model = TerminalPaneViewModel(session: session!)
    let style = TerminalStyle(font: CodeFont(size: 16))
    model.presentation.style = style; await model.start()
    #expect(session?.style == style && session?.starts == 1)
    model.presentation.active = true; model.appear()
    session = nil
    #expect(retained == nil)
    await flushPresentation()
    #expect(!model.visible)
    model.presentation.active = false
    model.presentation.style = style; await model.start()
}
