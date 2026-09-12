import AppKit
import Foundation
import GhosttyTerminal
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

@MainActor @Test(.timeLimit(.minutes(1))) func terminalAttachDeduplicatesBufferedOutputAndDrainsBeforeExit() async throws {
    _ = NSApplication.shared
    let events = PipeEvents()
    let pipe = TerminalPipe(onError: { events.append("error: \($0)") }, onExit: { events.append("exit: \($0)") })
    let client = PtydClient(onEvent: { _ in })
    pipe.bind(client: client, id: "attach-test")
    let state = TerminalViewState()
    let view = AppTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 320))
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
    let view = AppTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 320))
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
}
