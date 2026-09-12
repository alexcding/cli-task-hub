import Darwin
import Foundation
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

@Test func incompleteReplayIsRejectedAndOldHelpersAreDetected() throws {
    func decode(_ fields: String) throws -> PtyAttachment {
        try JSONDecoder().decode(PtyAttachment.self, from: Data("{\"buf\":\"history\",\"seq\":9,\(fields)}".utf8))
    }
    try decode("\"live\":true,\"truncated\":false").validateReplay()
    #expect(throws: PtyError.self) { try decode("\"live\":true,\"truncated\":true").validateReplay() }
    #expect(throws: PtyError.self) { try decode("\"live\":true").validateReplay() }
    #expect(throws: PtyError.self) { try decode("\"live\":false,\"truncated\":false").validateReplay() }
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
