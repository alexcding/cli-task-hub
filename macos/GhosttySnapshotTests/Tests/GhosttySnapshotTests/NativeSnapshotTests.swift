import AppKit
import Foundation
import GhosttyKit
@testable import GhosttyTerminal
import Testing

private final class Writes: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    func append(_ bytes: Data) { lock.lock(); data.append(bytes); lock.unlock() }
    var bytes: Data { lock.lock(); defer { lock.unlock() }; return data }
}

@MainActor
private final class SurfaceHarness {
    let writes = Writes()
    let session: InMemoryTerminalSession
    let coordinator = TerminalSurfaceCoordinator()
    private let view = NSView(frame: NSRect(x: 0, y: 0, width: 800, height: 500))

    init() {
        let writes = self.writes
        session = InMemoryTerminalSession(write: { writes.append($0) }, resize: { _ in })
        view.wantsLayer = true
        coordinator.isAttached = { true }
        coordinator.scaleFactor = { 1 }
        coordinator.viewSize = { (800, 500) }
        coordinator.platformSetup = { [view] config in
            config.platform_tag = GHOSTTY_PLATFORM_MACOS
            config.platform = ghostty_platform_u(macos: ghostty_platform_macos_s(
                nsview: Unmanaged.passUnretained(view).toOpaque()))
        }
        coordinator.configuration = TerminalSurfaceOptions(backend: .inMemory(session))
        coordinator.controller = TerminalController()
        precondition(coordinator.surface != nil)
    }
    func close() { coordinator.freeSurface() }
    func feed(_ bytes: Data) { session.receive(bytes); session.waitForPendingOutput() }
    var text: String { session.readViewportText() ?? "" }

    func snapshot(_ input: Data, extraColumn: Bool = false) throws -> Data {
        let size = try #require(coordinator.surface?.size())
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let process = Process()
        process.executableURL = root.appendingPathComponent("crates/taskhub-vt/target/debug/examples/snapshot")
        process.arguments = [String(Int(size.columns) + (extraColumn ? 1 : 0)), String(size.rows)]
        let stdin = Pipe(), stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        try process.run()
        try stdin.fileHandleForWriting.write(contentsOf: input)
        try stdin.fileHandleForWriting.close()
        let result = try stdout.fileHandleForReading.readToEnd() ?? Data()
        process.waitUntilExit()
        try #require(process.terminationStatus == 0)
        return result
    }
}

@Suite(.serialized)
@MainActor
struct NativeSnapshotTests {
    @Test func capturedGridIsRestoredIndependentlyOfTheCurrentViewGrid() async throws {
        let harness = SurfaceHarness()
        defer { harness.close() }
        try await Task.sleep(for: .milliseconds(50))
        let original = try #require(harness.coordinator.surface?.size())
        let snapshot = try harness.snapshot(Data(repeating: 120, count: Int(original.columns) + 5), extraColumn: true)
        try #require(harness.session.restoreSnapshot(snapshot))
        harness.feed(Data("\u{1B}[6n".utf8))
        let expected = Data("\u{1B}[2;5R".utf8)
        for _ in 0..<100 {
            if harness.writes.bytes.count >= expected.count { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(harness.writes.bytes == expected)
    }

    @Test func viewResizeWaitsForTheOrderedHostGridEventBeforeReflowingOutput() async throws {
        let harness = SurfaceHarness()
        defer { harness.close() }
        try await Task.sleep(for: .milliseconds(50))
        let surface = try #require(harness.coordinator.surface)
        let original = try #require(surface.size())
        let snapshot = try harness.snapshot(Data(repeating: 120, count: Int(original.columns) + 5))
        try #require(harness.session.restoreSnapshot(snapshot))
        surface.setSize(width: original.widthPixels + original.cellWidthPixels * 10, height: original.heightPixels)
        try await Task.sleep(for: .milliseconds(50))
        let changed = try #require(surface.size())
        #expect(changed.columns >= original.columns + 5)
        harness.feed(Data("\u{1B}[6n".utf8))
        let before = Data("\u{1B}[2;6R".utf8)
        for _ in 0..<100 {
            if harness.writes.bytes.count >= before.count { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(harness.writes.bytes == before)
        try #require(harness.session.applyHostGridSize(columns: changed.columns, rows: changed.rows))
        harness.feed(Data("\u{1B}[6n".utf8))
        let after = before + Data("\u{1B}[1;\(Int(original.columns) + 6)R".utf8)
        for _ in 0..<100 {
            if harness.writes.bytes.count >= after.count { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(harness.writes.bytes == after)
    }

    @Test func importsHistoryBothScreensSavedCursorAndFutureOutputWithoutHistoricalReplies() async throws {
        let harness = SurfaceHarness()
        defer { harness.close() }
        // Surface creation queues its initial pixel/grid resize to the IO thread.
        try await Task.sleep(for: .milliseconds(50))
        var history = ""
        for line in 0..<8000 { history += "history \(line) styled \u{1B}[32m日本語🦀\u{1B}[0m line\r\n" }
        history += "PRIMARY_MARKER\u{1B}[5;9H\u{1B}7\u{1B}[?2004h\u{1B}[?1h\u{1B}[6n\u{1B}[?1049hALT_MARKER\u{1B}[31"
        let input = Data(history.utf8)
        #expect(input.count > 256 * 1024)
        let snapshot = try harness.snapshot(input)
        try #require(harness.session.restoreSnapshot(snapshot))
        #expect(harness.text.contains("ALT_MARKER"))
        #expect(harness.writes.bytes.isEmpty)
        #expect(!harness.session.restoreSnapshot(snapshot))
        harness.feed(Data("mRED\u{1B}[0m\u{1B}[?1049l\u{1B}8AFTER_SAVED_CURSOR\u{1B}[6n".utf8))
        #expect(harness.text.contains("PRIMARY_MARKER") && harness.text.contains("AFTER_SAVED_CURSOR"))
        for _ in 0..<100 {
            if !harness.writes.bytes.isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(String(decoding: harness.writes.bytes, as: UTF8.self) == "\u{1B}[5;27R")
        #expect(harness.coordinator.surface?.paste(text: "NATIVE_PASTE") == true)
        #expect(harness.coordinator.surface?.sendKey(.arrowUp) == true)
        let expectedInput = Data("\u{1B}[5;27R\u{1B}[200~NATIVE_PASTE\u{1B}[201~\u{1B}OA".utf8)
        for _ in 0..<100 {
            if harness.writes.bytes.count >= expectedInput.count { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(harness.writes.bytes == expectedInput)
        #expect(harness.coordinator.surface?.performBindingAction("scroll_to_top") == true)
        // The binding queues the viewport change on Ghostty's IO thread. Its
        // row-by-row text reader can otherwise observe the change mid-read.
        for _ in 0..<100 {
            if harness.text.hasPrefix("history 0 ") { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(harness.text.contains("history 0"))
    }

    @Test func resumesSplitUTF8OSCAndDCSAndRejectsInvalidImportsWithoutChangingSurface() async throws {
        for (prefix, suffix, expected) in [
            (Data([0xf0, 0x9f]), Data([0xa6, 0x80]), "🦀"),
            (Data("\u{1B}]8;;https://example.com".utf8), Data("\u{1B}\\LINK\u{1B}]8;;\u{1B}\\".utf8), "LINK"),
            (Data("\u{1B}P$q".utf8), Data("m\u{1B}\\AFTER_DCS".utf8), "AFTER_DCS"),
            (Data("\u{1B}_Gf=24,s=1,v=1;".utf8), Data("/wAA\u{1B}\\AFTER_APC".utf8), "AFTER_APC"),
        ] {
            let harness = SurfaceHarness()
            defer { harness.close() }
            try await Task.sleep(for: .milliseconds(50))
            let snapshot = try harness.snapshot(prefix)
            let original = harness.text
            #expect(!harness.session.restoreSnapshot(snapshot.dropLast()))
            var corrupted = snapshot
            corrupted[30] ^= 1
            #expect(!harness.session.restoreSnapshot(corrupted))
            var trailing = snapshot
            trailing.append(0)
            #expect(!harness.session.restoreSnapshot(trailing))
            #expect(harness.text == original)
            try #require(harness.session.restoreSnapshot(snapshot))
            #expect(harness.writes.bytes.isEmpty)
            harness.feed(suffix)
            #expect(harness.text.contains(expected))
            #expect(!harness.session.restoreSnapshot(snapshot))
        }
    }
}
