import Darwin
import AppKit
import Foundation
import GhosttyTerminal
import Testing
@testable import TaskHubFeature

private struct ProtocolFixture {
    let process: Process
    let directory: URL
    var socket: String { directory.appendingPathComponent("pty.sock").path }

    static func start(mode: String = "normal") async throws -> Self {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let directory = URL(fileURLWithPath: "/tmp/th-peer-\(UUID().uuidString.prefix(12))")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let ready = directory.appendingPathComponent("ready")
        let process = Process()
        let fixture = Self(process: process, directory: directory)
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", root.appendingPathComponent("macos/scripts/pty-protocol-fixture.cjs").path,
                             fixture.socket, ready.path, mode]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            for _ in 0..<100 {
                if FileManager.default.fileExists(atPath: ready.path) { return fixture }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw PtyError.timeout
        } catch { fixture.stop(); throw error }
    }

    func stop() {
        if process.isRunning { process.terminate(); process.waitUntilExit() }
        try? FileManager.default.removeItem(at: directory)
    }
}

private final class FailureMessages: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []
    func append(_ value: String) { lock.lock(); values.append(value); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return values }
}

@MainActor @Test(.timeLimit(.minutes(1))) func ghosttyEncodedInputReportsSocketRejectionAndStopsLaterKeystrokes() async throws {
    _ = NSApplication.shared
    let fixture = try await ProtocolFixture.start()
    defer { fixture.stop() }
    let messages = FailureMessages()
    let pipe = TerminalPipe(onError: messages.append, onExit: { _ in })
    let client = PtydClient(onEvent: { pipe.receive($0) })
    _ = try await client.connect(path: fixture.socket)
    defer { pipe.close(); client.close() }
    pipe.bind(client: client, id: "fixture")
    let state = TerminalViewState()
    let view = WorkspaceTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 320))
    view.delegate = state; view.controller = state.controller
    view.configuration = .init(backend: .inMemory(pipe.memory), fontSize: 13)
    let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = view
    defer { window.contentView = nil; window.close() }
    view.layoutSubtreeIfNeeded()
    for _ in 0..<100 {
        if state.surface != nil { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    _ = try #require(state.surface)
    pipe.attach(.init(bytes: Data(), seq: 0, live: true, truncated: false)) { messages.append("ready") }
    for _ in 0..<100 {
        if messages.all.contains("ready") { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(messages.all == ["ready"])
    #expect(view.sendKey(.enter))
    for _ in 0..<100 {
        if messages.all.count > 1 { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(messages.all.last?.contains("fixture input queue is full") == true)
    #expect(messages.all.last?.contains("Earlier input may have been sent") == true)
    #expect(view.sendKey(.enter))
    try await Task.sleep(for: .milliseconds(30))
    let written = try String(contentsOf: fixture.directory.appendingPathComponent("ready.writes"), encoding: .utf8)
    #expect(written == Data([13]).base64EncodedString() + "\n")
    #expect(messages.all.count == 2)
}

@Test func incompleteReplayIsRejectedAndOldHelpersAreDetected() throws {
    func decode(_ fields: String) throws -> PtyAttachment {
        try JSONDecoder().decode(PtyAttachment.self, from: Data("{\"bytes\":\"aGlzdG9yeQ==\",\"seq\":9,\(fields)}".utf8))
    }
    try decode("\"live\":true,\"truncated\":false").validateReplay()
    #expect(throws: PtyError.self) { try decode("\"live\":true,\"truncated\":true").validateReplay() }
    #expect(throws: PtyError.self) { try decode("\"live\":true").validateReplay() }
    #expect(throws: PtyError.self) { try decode("\"live\":false,\"truncated\":false").validateReplay() }
}

@Test func legacyHelperCannotSilentlyDowngradeNativeTerminalBytes() throws {
    let hello = try JSONDecoder().decode(PtyHello.self, from: Data(#"{"protocol":2,"pid":123}"#.utf8))
    #expect(throws: PtyError.self) { try hello.validateByteTransport() }
}

@Test func onlyAbsentOrRefusedSocketsPermitDaemonStartup() {
    #expect(PtydHost.mayStartDaemon(after: PtyError.socket(ENOENT)))
    #expect(PtydHost.mayStartDaemon(after: PtyError.socket(ECONNREFUSED)))
    #expect(!PtydHost.mayStartDaemon(after: PtyError.socket(EACCES)))
    #expect(!PtydHost.mayStartDaemon(after: PtyError.timeout))
    #expect(!PtydHost.mayStartDaemon(after: PtyError.protocolMismatch(999)))
    #expect(!PtydHost.mayStartDaemon(after: PtyError.closed))
}

@Test(.timeLimit(.minutes(1))) func protocolMismatchDoesNotLaunchReplacementHelper() async throws {
    let fixture = try await ProtocolFixture.start(mode: "mismatch")
    defer { fixture.stop() }
    let client = PtydClient(onEvent: { _ in })
    defer { client.close() }
    let host = PtydHost(configuration: .init(executable: URL(fileURLWithPath: "/missing-helper"),
                                            directory: fixture.directory, socketPath: fixture.socket))
    do { _ = try await host.connect(client: client); Issue.record("Accepted incompatible daemon") }
    catch PtyError.protocolMismatch(let version) { #expect(version == 999) }
    #expect(fixture.process.isRunning)
    #expect(!FileManager.default.fileExists(atPath: fixture.directory.appendingPathComponent("ptyd.log").path))
    do { try await host.stopExisting(); Issue.record("Quit accepted incompatible daemon") }
    catch PtyError.protocolMismatch(let version) { #expect(version == 999) }
    #expect(fixture.process.isRunning)
}

@Test(.timeLimit(.minutes(1))) func timedOutRepliesCannotResolveLaterRequestsAndDisconnectResumesWaiters() async throws {
    let fixture = try await ProtocolFixture.start()
    defer { fixture.stop() }
    let client = PtydClient(onEvent: { _ in })
    defer { client.close() }
    _ = try await client.connect(path: fixture.socket)
    do {
        let _: String = try await client.request(.init(op: "slow"), timeout: 0.02)
        Issue.record("Request did not time out")
    } catch PtyError.timeout { }
    // The stale String response arrives while this [PtyInfo] request is pending.
    let list: [PtyInfo] = try await client.request(.init(op: "list"))
    #expect(list.isEmpty)
    do {
        let _: String = try await client.request(.init(op: "drop"))
        Issue.record("Disconnected request succeeded")
    } catch PtyError.closed { }
    do { _ = try await client.connect(path: fixture.socket); Issue.record("Reused a connection generation") }
    catch PtyError.connection { }

    let replacement = PtydClient(onEvent: { _ in })
    defer { replacement.close() }
    _ = try await replacement.connect(path: fixture.socket)
    let fresh: [PtyInfo] = try await replacement.request(.init(op: "list"))
    #expect(fresh.isEmpty)
    do {
        let _: String = try await replacement.request(.init(op: "malformed"))
        Issue.record("Malformed peer response accepted")
    } catch { #expect(!(error is CancellationError)) }
}
