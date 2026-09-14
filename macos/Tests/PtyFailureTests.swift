import Darwin
import AppKit
import Foundation
import GhosttyTerminal
import Testing

private struct ProtocolFixture {
    let process: Process
    let directory: URL
    var socket: String { directory.appendingPathComponent("pty.sock").path }

    static func start(mode: String = "normal") async throws -> Self {
        let root = TestPaths.checkout
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

@MainActor @Test(.timeLimit(.minutes(1))) func measuredResizeRejectionStopsTheNativePipeline() async throws {
    _ = NSApplication.shared
    let fixture = try await ProtocolFixture.start(mode: "resize-reject")
    defer { fixture.stop() }
    let messages = FailureMessages()
    let pipe = TerminalPipe(onError: messages.append, onExit: { _ in })
    let state = TerminalViewState()
    let view = WorkspaceTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 320))
    view.delegate = state; view.controller = state.controller
    view.configuration = .init(backend: .inMemory(pipe.memory), fontSize: 13)
    let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = view
    defer { pipe.close(); window.contentView = nil; window.close() }
    view.layoutSubtreeIfNeeded()
    try #require(pipe.memory.enableGeometryCallbacks())
    _ = try await pipe.measuredGeometry()
    let client = PtydClient(onEvent: { pipe.receive($0) })
    _ = try await client.connect(path: fixture.socket)
    defer { client.close() }
    pipe.bind(client: client, id: "fixture", geometryOwned: true)
    window.setContentSize(NSSize(width: 900, height: 320))
    view.layoutSubtreeIfNeeded()
    for _ in 0..<100 {
        if pipe.isClosed { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(pipe.isClosed)
    #expect(messages.all.contains { $0.contains("Terminal resize failed") && $0.contains("fixture resize rejected") })
    let lines = try String(contentsOf: fixture.directory.appendingPathComponent("ready.resizes"), encoding: .utf8)
    let first = try #require(lines.split(separator: "\n").first)
    let frame = try #require(JSONSerialization.jsonObject(with: Data(first.utf8)) as? [String: Any])
    #expect(frame["id"] != nil, "resizes require acknowledgement")
    let geometry = try #require(frame["geometry"] as? [String: Any])
    #expect((geometry["cellWidthPixels"] as? Int ?? 0) > 0)
    #expect((geometry["cellHeightPixels"] as? Int ?? 0) > 0)
}

@Test func geometryContractsRejectUnknownOwnersAndInconsistentSnapshots() throws {
    let fields: [String: Any] = ["cols": 80, "rows": 24, "cellWidthPixels": 9, "cellHeightPixels": 18]
    func geometry(_ updates: [String: Any]) throws -> PtyGeometry {
        let data = try JSONSerialization.data(withJSONObject: fields.merging(updates) { _, new in new })
        return try JSONDecoder().decode(PtyGeometry.self, from: data)
    }
    try geometry([:]).validate()
    for updates in [["cols": 0], ["rows": 4097], ["cellWidthPixels": 0], ["cellHeightPixels": 2731], ["cellWidthPixels": Int(UInt32.max)]] {
        #expect(throws: PtyError.self) { try geometry(updates).validate() }
    }
    var header = PtySnapshot.Header(token: 1, size: 10, chunkBytes: PtySnapshot.chunkBytes,
        seq: 0, stateSeq: 0, cols: 80, rows: 24, revision: PtySnapshot.revision, geometry: try geometry([:]))
    try header.validate()
    header.geometry = try geometry(["cols": 81])
    #expect(throws: PtyError.self) { try header.validate() }
    let json = "{\"id\":\"x\",\"cwd\":\"/tmp\",\"title\":\"x\",\"paired\":false,\"pairKey\":\"x\",\"hasContext\":false,\"pid\":1,\"created\":0,\"stateResponseOwner\":\"daemon-state-v1\",\"geometryResponseOwner\":\"daemon-geometry-v1\"}"
    let info = try JSONDecoder().decode(PtyInfo.self, from: Data(json.utf8))
    #expect(throws: PtyError.self) { try info.validateStateResponseOwner() }
    var hello = PtyHello(protocol: 2, pid: 1, dataEncoding: "base64", acknowledgedInput: true)
    #expect(throws: PtyError.self) { try hello.validateGeometryResponseOwner() }
    hello.geometryResponseOwner = "future-owner"
    #expect(throws: PtyError.self) { try hello.validateGeometryResponseOwner() }
    hello.geometryResponseOwner = PtyHello.geometryResponseOwnerVersion
    try hello.validateGeometryResponseOwner()
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

@Test(.timeLimit(.minutes(1))) func snapshotDownloaderValidatesChunksAndReleasesEveryCapture() async throws {
    for mode in ["snapshot-valid", "snapshot-oversize", "snapshot-token", "snapshot-offset", "snapshot-short", "snapshot-early", "snapshot-cancel"] {
        let fixture = try await ProtocolFixture.start(mode: mode)
        defer { fixture.stop() }
        let client = PtydClient(onEvent: { _ in })
        defer { client.close() }
        _ = try await client.connect(path: fixture.socket)
        let download = Task { try await PtySnapshotDownloader(client: client).fetch(term: "fixture") }
        if mode == "snapshot-cancel" {
            for _ in 0..<100 {
                if FileManager.default.fileExists(atPath: fixture.directory.appendingPathComponent("ready.reads").path) { break }
                try await Task.sleep(for: .milliseconds(5))
            }
            download.cancel()
        }
        do {
            let result = try await download.value
            #expect(mode == "snapshot-valid")
            #expect(result.bytes == Data(repeating: 120, count: 131075))
            #expect(result.header.seq == 7 && result.header.stateSeq == 9)
        } catch {
            #expect(mode != "snapshot-valid")
            if mode == "snapshot-cancel" { #expect(error is CancellationError) }
        }
        let released = try String(contentsOf: fixture.directory.appendingPathComponent("ready.released"), encoding: .utf8)
        #expect(released == "1\n")
        if mode == "snapshot-oversize" {
            #expect(!FileManager.default.fileExists(atPath: fixture.directory.appendingPathComponent("ready.reads").path))
        }
        if mode == "snapshot-valid" {
            let reads = try String(contentsOf: fixture.directory.appendingPathComponent("ready.reads"), encoding: .utf8)
            #expect(reads == "0\n131072\n")
        }
    }
}

@Test func resizeOnlyFloodCannotGrowTheAttachmentBufferWithoutBound() {
    let messages = FailureMessages()
    let pipe = TerminalPipe(onError: messages.append, onExit: { _ in })
    let client = PtydClient(onEvent: { _ in })
    pipe.bind(client: client, id: "flood")
    defer { pipe.close() }
    for sequence in 1...16385 {
        pipe.receive(.init(ev: "resize", id: "flood", bytes: nil, seq: 0,
                           exitCode: nil, signal: nil, stateSeq: UInt64(sequence), cols: 80, rows: 24))
    }
    #expect(messages.all.count == 1)
    #expect(messages.all.first?.contains("event limit") == true)
}
