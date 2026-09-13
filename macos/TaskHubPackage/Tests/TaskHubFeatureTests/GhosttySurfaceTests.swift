import AppKit
import Foundation
import GhosttyTerminal
import GhosttyKit
import Testing
@testable import TaskHubFeature

private final class InputBytes: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()
    func append(_ data: Data) { lock.lock(); bytes.append(data); lock.unlock() }
    func take() -> Data { lock.lock(); defer { lock.unlock() }; let result = bytes; bytes.removeAll(); return result }
}

private final class PipeEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []
    func append(_ value: String) { lock.lock(); values.append(value); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return values }
}

private final class LinkMetrics: @unchecked Sendable {
    private let lock = NSLock()
    private var value: InMemoryTerminalViewport?
    func set(_ value: InMemoryTerminalViewport) { lock.lock(); self.value = value; lock.unlock() }
    func get() -> InMemoryTerminalViewport? { lock.lock(); defer { lock.unlock() }; return value }
}

@MainActor @Test(.timeLimit(.minutes(1))) func ghosttyDetectsPrintedFilesWithoutBreakingURLsOrMouseInput() async throws {
    _ = NSApplication.shared
    let input = InputBytes(), metrics = LinkMetrics()
    let memory = InMemoryTerminalSession(write: { input.append($0) }, resize: { metrics.set($0) })
    let configuration = CodeFont(size: 13).terminalConfiguration
        .custom("window-padding-x", "0").custom("window-padding-y", "0")
        .custom("click-repeat-interval", "1")
    let state = TerminalViewState(terminalConfiguration: configuration)
    let view = WorkspaceTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 320))
    view.delegate = state; view.controller = state.controller
    view.configuration = .init(backend: .inMemory(memory), fontSize: 13)
    let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = view
    defer { window.contentView = nil; window.close() }
    view.layoutSubtreeIfNeeded()
    for _ in 0..<100 {
        if state.surface != nil && metrics.get() != nil { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    let surface = try #require(state.surface)
    #expect(memory.enableGeometryCallbacks())
    // Allow the view's throttled initial layout to replace the core's default
    // dimensions, then use the engine's actual cell pixels for hit testing.
    try await Task.sleep(for: .milliseconds(150))
    let grid = try #require(metrics.get())
    try #require(grid.cellWidthPixels > 0 && grid.cellHeightPixels > 0)
    #expect(state.controller.lastConfigurationIssue == nil)
    view.setSurfaceVisible(false)
    let cellWidth = Double(grid.cellWidthPixels) / window.backingScaleFactor
    let cellHeight = Double(grid.cellHeightPixels) / window.backingScaleFactor
    var opened: String?
    var workingDirectory: String?
    view.openLink = { raw, directory, _ in opened = raw; workingDirectory = directory }
    func point(column: Int, row: Int = 0) -> (Double, Double) {
        ((Double(column) + 0.5) * cellWidth, (Double(row) + 0.5) * cellHeight)
    }
    func click(column: Int, row: Int = 0, modifiers: TerminalInputModifiers = .super_) {
        let (x, y) = point(column: column, row: row)
        surface.sendMousePos(x: -1, y: -1, modifiers: modifiers)
        surface.sendMousePos(x: x, y: y, modifiers: modifiers)
        surface.sendMouseButton(state: GHOSTTY_MOUSE_PRESS, button: GHOSTTY_MOUSE_LEFT, modifiers: modifiers)
        surface.sendMouseButton(state: GHOSTTY_MOUSE_RELEASE, button: GHOSTTY_MOUSE_LEFT, modifiers: modifiers)
    }
    let wrapped = String(repeating: "directory/", count: Int(grid.columns) / 5) + "file.swift:12:3"
    let cases: [(String, Int, Int, String?)] = [
        ("Sources/File.swift:12:3", 1, 0, "Sources/File.swift:12:3"),
        ("~/Sources/File.swift:9", 1, 0, "~/Sources/File.swift:9"),
        ("../src/file.swift", 1, 0, "../src/file.swift"),
        ("/tmp/file.swift", 1, 0, "/tmp/file.swift"),
        ("src/日本語.swift:4", 1, 0, "src/日本語.swift:4"),
        ("🦀 日本語 e\u{301}  Sources/File.swift:5", 14, 0, "Sources/File.swift:5"),
        ("(src/file.swift:4).", 3, 0, "src/file.swift:4"),
        (wrapped, 3, 1, wrapped),
        ("https://example.com/o/r/blob/main/file.swift:7", 33, 0, "https://example.com/o/r/blob/main/file.swift:7"),
        ("\u{1b}]8;;https://example.com/original\u{1b}\\src/file.swift\u{1b}]8;;\u{1b}\\", 3, 0, "https://example.com/original"),
        ("bare.swift", 2, 0, nil),
        ("src/README", 2, 0, nil),
        ("ssh://host/src/file.swift", 15, 0, "ssh://host/src/file.swift"),
    ]
    for (text, column, row, expected) in cases {
        opened = nil
        memory.receive("\u{1b}[2J\u{1b}[H\u{1b}]7;file://localhost/work/current\u{1b}\\" + text)
        memory.waitForPendingOutput()
        state.controller.tick()
        click(column: column, row: row)
        try await Task.sleep(for: .milliseconds(30))
        #expect(opened == expected, "Printed link: \(text)")
        if expected != nil { #expect(workingDirectory == "/work/current") }
    }

    // Ordinary clicks remain native TUI input. Ghostty requires Shift-Command
    // while mouse reporting is enabled; Command alone is still TUI input.
    opened = nil
    memory.receive("\u{1b}[2J\u{1b}[Hsrc/file.swift:12:3\u{1b}[?1000h\u{1b}[?1006h")
    memory.waitForPendingOutput(); _ = input.take()
    click(column: 3, modifiers: [])
    try await Task.sleep(for: .milliseconds(50))
    #expect(opened == nil)
    #expect(String(decoding: input.take(), as: UTF8.self).contains("\u{1b}[<0;"))
    click(column: 3)
    try await Task.sleep(for: .milliseconds(30))
    #expect(opened == nil)
    click(column: 3, modifiers: [.super_, .shift])
    try await Task.sleep(for: .milliseconds(30))
    #expect(opened == "src/file.swift:12:3")

    // AppKit Option-click must do the same capture-aware hit test, routing a
    // web link externally without forwarding a button press to the TUI.
    opened = nil
    var external = false
    view.openLink = { raw, _, outside in opened = raw; external = outside }
    memory.receive("\u{1b}[2J\u{1b}[Hhttps://example.com/code.swift")
    memory.waitForPendingOutput(); _ = input.take()
    let (x, y) = point(column: 3)
    let location = view.convert(NSPoint(x: x, y: view.bounds.height - y), to: nil)
    let down = try #require(NSEvent.mouseEvent(with: .leftMouseDown, location: location, modifierFlags: .option,
        timestamp: 1, windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
    let up = try #require(NSEvent.mouseEvent(with: .leftMouseUp, location: location, modifierFlags: .option,
        timestamp: 1.1, windowNumber: window.windowNumber, context: nil, eventNumber: 2, clickCount: 1, pressure: 0))
    view.mouseDown(with: down); view.mouseUp(with: up)
    try await Task.sleep(for: .milliseconds(30))
    #expect(opened == "https://example.com/code.swift" && external)
    #expect(input.take().isEmpty)
}

@MainActor @Test(.timeLimit(.minutes(1))) func terminalAttachDeduplicatesBufferedOutputAndDrainsBeforeExit() async throws {
    _ = NSApplication.shared
    let events = PipeEvents()
    let pipe = TerminalPipe(onError: { events.append("error: \($0)") }, onExit: { events.append("exit: \($0)") })
    let client = PtydClient(onEvent: { _ in })
    pipe.bind(client: client, id: "attach-test")
    let state = TerminalViewState()
    let view = WorkspaceTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 320))
    view.delegate = state
    view.controller = state.controller
    view.configuration = .init(backend: .inMemory(pipe.memory), fontSize: 13)
    let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = view
    defer { pipe.close(); window.contentView = nil; window.close() }
    view.layoutSubtreeIfNeeded()
    for _ in 0..<30 {
        if state.surface != nil { break }
        try await Task.sleep(for: .milliseconds(50))
    }
    #expect(state.surface != nil)
    view.setSurfaceVisible(false)
    func output(_ sequence: UInt64, _ bytes: Data) -> PtyEvent {
        PtyEvent(ev: "data", id: "attach-test", bytes: bytes, seq: sequence, exitCode: nil, signal: nil)
    }
    // Output races the attach reply: seq 1 is included in the atomic snapshot;
    // seq 2 arrives after its boundary. Both are buffered before attaching.
    let replay = Data("SNAPSHOT\r\nSPLIT_".utf8) + Data([0xf0, 0x9f])
    pipe.receive(output(1, replay))
    pipe.receive(output(2, Data([0xa6, 0x80]) + Data("\r\nDURING_ATTACH_日本語\r\n".utf8)))
    pipe.attach(PtyAttachment(bytes: replay, seq: 1, live: true, truncated: false)) { events.append("ready") }
    pipe.receive(output(2, Data("DUPLICATE_MUST_NOT_RENDER\r\n".utf8)))
    pipe.receive(output(3, Data("FINAL_BEFORE_EXIT\r\n".utf8)))
    pipe.receive(PtyEvent(ev: "exit", id: "attach-test", bytes: nil, seq: nil, exitCode: 7, signal: nil))
    for _ in 0..<100 {
        if events.all.contains("exit: 7") { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(events.all == ["ready", "exit: 7"])
    let screen = try #require(pipe.memory.readViewportText())
    #expect(screen.components(separatedBy: "SNAPSHOT").count == 2)
    #expect(screen.contains("DURING_ATTACH_日本語"))
    #expect(screen.contains("SPLIT_🦀"))
    #expect(screen.contains("FINAL_BEFORE_EXIT"))
    #expect(!screen.contains("DUPLICATE_MUST_NOT_RENDER"))
}

// A real Metal-backed terminal in an unshown window. No simulated text renderer and
// no shell/clipboard side effects: host callbacks collect the actual encoded input.
@MainActor @Test(.timeLimit(.minutes(1))) func ghosttyParsesHiddenOutputAndEncodesKeysAndPaste() async throws {
    _ = NSApplication.shared
    let input = InputBytes()
    let memory = InMemoryTerminalSession(write: { input.append($0) }, resize: { _ in })
    let state = TerminalViewState()
    let view = WorkspaceTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 320))
    view.delegate = state
    view.controller = state.controller
    view.configuration = .init(backend: .inMemory(memory), fontSize: 13)
    let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = view
    defer { window.contentView = nil; window.close() }
    view.layoutSubtreeIfNeeded()
    for _ in 0..<30 {
        if state.surface != nil { break }
        try await Task.sleep(for: .milliseconds(50))
    }
    #expect(state.surface != nil)
    view.setSurfaceVisible(false)
    memory.receive("\u{1b}[2J\u{1b}[HBASE_é_日本語_🦀")
    memory.waitForPendingOutput()
    #expect(memory.readViewportText()?.contains("BASE_é_日本語_🦀") == true)
    memory.receive("\u{1b}[?1049h\u{1b}[HALTERNATE_SCREEN")
    memory.waitForPendingOutput()
    #expect(memory.readViewportText()?.contains("ALTERNATE_SCREEN") == true)
    memory.receive("\u{1b}[?1049l")
    memory.waitForPendingOutput()
    #expect(memory.readViewportText()?.contains("BASE_é_日本語_🦀") == true)

    _ = input.take()
    #expect(view.sendKey(.enter))
    var keyBytes = Data()
    for _ in 0..<100 {
        keyBytes.append(input.take())
        if !keyBytes.isEmpty { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(keyBytes == Data([13]))
    memory.receive("\u{1b}[?2004h")
    memory.waitForPendingOutput()
    #expect(view.paste(text: "one\ntwo"))
    // Host input callbacks may arrive asynchronously. Yield the main actor until
    // the complete paste reaches the host, as with the key above.
    var pasteBytes = Data()
    for _ in 0..<100 {
        pasteBytes.append(input.take())
        if pasteBytes.suffix(6) == Data("\u{1b}[201~".utf8) { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    let pasted = String(decoding: pasteBytes, as: UTF8.self)
    #expect(pasted.hasPrefix("\u{1b}[200~"))
    #expect(pasted.hasSuffix("\u{1b}[201~"))
    #expect(pasted.contains("one") && pasted.contains("two"))

    // Exercise Ghostty's real OSC 8 hit testing and native action callback,
    // rather than calling the host delegate directly.
    var opened: String?
    var external = false
    view.openLink = { raw, _, outside in opened = raw; external = outside }
    memory.receive("\u{1b}[2J\u{1b}[H\u{1b}]8;;file:///tmp/fixture.swift#L5C2\u{1b}\\OPEN_FILE\u{1b}]8;;\u{1b}\\")
    memory.waitForPendingOutput()
    let surface = try #require(state.surface)
    surface.sendMousePos(x: 10, y: 10, modifiers: .super_)
    surface.sendMouseButton(state: GHOSTTY_MOUSE_PRESS, button: GHOSTTY_MOUSE_LEFT, modifiers: .super_)
    surface.sendMouseButton(state: GHOSTTY_MOUSE_RELEASE, button: GHOSTTY_MOUSE_LEFT, modifiers: .super_)
    for _ in 0..<30 {
        if opened != nil { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(opened == "file:///tmp/fixture.swift#L5C2" && !external)

    // Use AppKit mouse events to verify click modifiers survive real hit testing.
    for flags: NSEvent.ModifierFlags in [[.option], [.command, .option], [.command]] {
        opened = nil
        let point = view.convert(NSPoint(x: 10, y: view.bounds.height - 10), to: nil)
        let down = try #require(NSEvent.mouseEvent(with: .leftMouseDown, location: point, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
        let up = try #require(NSEvent.mouseEvent(with: .leftMouseUp, location: point, modifierFlags: flags, timestamp: 0.1, windowNumber: window.windowNumber, context: nil, eventNumber: 2, clickCount: 1, pressure: 0))
        view.mouseDown(with: down); view.mouseUp(with: up)
        #expect(opened == "file:///tmp/fixture.swift#L5C2")
        #expect(external == flags.contains(.option))
    }
    // An Option drag or a release away from the link must not open anything.
    for dragging in [false, true] {
        opened = nil
        let start = view.convert(NSPoint(x: 10, y: view.bounds.height - 10), to: nil)
        let end = view.convert(NSPoint(x: 300, y: view.bounds.height - 100), to: nil)
        let down = try #require(NSEvent.mouseEvent(with: .leftMouseDown, location: start, modifierFlags: .option, timestamp: 1, windowNumber: window.windowNumber, context: nil, eventNumber: 3, clickCount: 1, pressure: 1))
        let drag = try #require(NSEvent.mouseEvent(with: .leftMouseDragged, location: end, modifierFlags: .option, timestamp: 1.1, windowNumber: window.windowNumber, context: nil, eventNumber: 4, clickCount: 1, pressure: 1))
        let up = try #require(NSEvent.mouseEvent(with: .leftMouseUp, location: dragging ? start : end, modifierFlags: .option, timestamp: 1.2, windowNumber: window.windowNumber, context: nil, eventNumber: 5, clickCount: 1, pressure: 0))
        view.mouseDown(with: down)
        if dragging { view.mouseDragged(with: drag) }
        view.mouseUp(with: up)
        #expect(opened == nil)
    }


}
