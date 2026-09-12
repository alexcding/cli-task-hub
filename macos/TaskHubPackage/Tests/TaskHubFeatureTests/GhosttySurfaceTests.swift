import AppKit
import Foundation
import GhosttyTerminal
import Testing

private final class InputBytes: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()
    func append(_ data: Data) { lock.lock(); bytes.append(data); lock.unlock() }
    func take() -> Data { lock.lock(); defer { lock.unlock() }; let result = bytes; bytes.removeAll(); return result }
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
