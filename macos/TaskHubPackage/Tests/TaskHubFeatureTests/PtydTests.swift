import Foundation
import Testing
@testable import TaskHubFeature

private final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [PtyEvent] = []
    func append(_ event: PtyEvent) { lock.lock(); storage.append(event); lock.unlock() }
    var events: [PtyEvent] { lock.lock(); defer { lock.unlock() }; return storage }
    var text: String { events.compactMap(\.chunk).joined() }
}

@Test func ptyFramesPreserveSplitUTF8AndBoundMemory() throws {
    var framer = PtyFramer()
    var frames: [Data] = []
    for byte in "{\"ev\":\"data\",\"id\":\"pty1\",\"chunk\":\"日本語🦀\",\"seq\":1}\n\n{\"id\":2,\"ok\":null}\n".utf8 {
        frames += try framer.append(Data([byte]))
    }
    #expect(frames.count == 2)
    #expect(try JSONDecoder().decode(PtyEvent.self, from: frames[0]).chunk == "日本語🦀")
    framer.limit = 8
    #expect(throws: PtyError.self) { _ = try framer.append(Data(repeating: 65, count: 9)) }
}

@Test(.timeLimit(.minutes(1))) func nativeClientTalksToRealPTYAndReattachesSameProcess() async throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let directory = URL(fileURLWithPath: "/tmp/th-pty-\(UUID().uuidString.prefix(12))")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }
    let shell = directory.appendingPathComponent("echo-shell")
    try "#!/bin/sh\n/usr/bin/stty raw -echo\nprintf 'PTY_READY\\n'\nexec /bin/cat\n".write(to: shell, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: shell.path)
    let config = PtydConfiguration(executable: root.appendingPathComponent("crates/taskhub-ptyd/target/debug/taskhub-ptyd"),
                                   directory: directory, socketPath: directory.appendingPathComponent("pty.sock").path)
    let host = PtydHost(configuration: config)
    let log = EventLog()
    let client = PtydClient(onEvent: { log.append($0) })
    let hello = try await host.connect(client: client)
    defer { client.close(); _ = kill(hello.pid, SIGTERM) }
    #expect(hello.protocol == 2)
    let terminal: PtyInfo = try await client.request(.init(op: "create", opts: .init(cwd: directory.path, shell: shell.path, pairKey: "fixture")))
    for _ in 0..<100 {
        if log.text.contains("PTY_READY") { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(log.text.contains("PTY_READY"))
    let _: String? = try await client.request(.init(op: "write", term: terminal.id, data: "UNICODE_é_日本語_🦀\n"))
    let _: String? = try await client.request(.init(op: "resize", term: terminal.id, cols: 101, rows: 31))
    for _ in 0..<100 {
        if log.text.contains("UNICODE_é_日本語_🦀") { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(log.text.contains("UNICODE_é_日本語_🦀"))
    let snapshot: PtyAttachment = try await client.request(.init(op: "attach", term: terminal.id))
    #expect(snapshot.live && snapshot.buf.contains("UNICODE_é_日本語_🦀"))
    #expect(snapshot.truncated == false)
    let sequences = log.events.compactMap(\.seq)
    #expect(sequences == sequences.sorted())
    #expect(Set(sequences).count == sequences.count)
    let _: String? = try await client.request(.init(op: "flow", term: terminal.id, pause: true))
    let secondLog = EventLog()
    let second = PtydClient(onEvent: { secondLog.append($0) })
    defer { second.close() }
    let secondHello = try await second.connect(path: config.socketPath)
    #expect(secondHello.pid == hello.pid)
    let terms: [PtyInfo] = try await second.request(.init(op: "list"))
    #expect(terms.first?.pid == terminal.pid)
    let restored: PtyAttachment = try await second.request(.init(op: "attach", term: terminal.id))
    #expect(restored.buf == snapshot.buf)
    // Another client attaching, resuming, or disconnecting must not release the
    // first client's pause. Allow the daemon's in-flight batch to finish first.
    let _: String? = try await second.request(.init(op: "flow", term: terminal.id, pause: false))
    let third = PtydClient(onEvent: { _ in })
    _ = try await third.connect(path: config.socketPath)
    third.close()
    try await Task.sleep(for: .milliseconds(100))
    let _: String? = try await second.request(.init(op: "write", term: terminal.id, data: "PAUSE_OWNERSHIP\n"))
    try await Task.sleep(for: .milliseconds(150))
    #expect(!secondLog.text.contains("PAUSE_OWNERSHIP"))

    let _: String? = try await second.request(.init(op: "flow", term: terminal.id, pause: true))
    client.close() // Release this client's pause, but preserve the second's.
    try await Task.sleep(for: .milliseconds(150))
    #expect(!secondLog.text.contains("PAUSE_OWNERSHIP"))
    let _: String? = try await second.request(.init(op: "flow", term: terminal.id, pause: false))
    let _: String? = try await second.request(.init(op: "write", term: terminal.id, data: "AFTER_RECONNECT\n"))
    for _ in 0..<100 {
        if secondLog.text.contains("AFTER_RECONNECT") { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(secondLog.text.contains("AFTER_RECONNECT"))
    #expect(secondLog.text.contains("PAUSE_OWNERSHIP"))
    // Exceed the output ring with real PTY output. A fresh renderer must reject
    // this tail, while the live shell and connected client continue progressing.
    let large = String(repeating: "history_line\n", count: 30_000) + "HISTORY_END\n"
    let _: String? = try await second.request(.init(op: "write", term: terminal.id, data: large))
    for _ in 0..<200 {
        if secondLog.text.contains("HISTORY_END") { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(secondLog.text.contains("HISTORY_END"))
    let truncated: PtyAttachment = try await second.request(.init(op: "attach", term: terminal.id))
    #expect(truncated.live && truncated.truncated == true)
    #expect(truncated.buf.contains("HISTORY_END"))
    #expect(truncated.buf.utf8.count <= 256 * 1024)
    #expect(throws: PtyError.self) { try truncated.validateReplay() }
    let killed: Bool = try await second.request(.init(op: "kill", term: terminal.id))
    #expect(killed)
    for _ in 0..<100 {
        if secondLog.events.contains(where: { $0.ev == "exit" }) { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(secondLog.events.contains(where: { $0.ev == "exit" && $0.id == terminal.id }))
    let survivor: PtyInfo = try await second.request(.init(op: "create", opts: .init(
        cwd: directory.path, shell: shell.path, pairKey: "quit-after-relaunch")))
    second.close()
    // A freshly launched host has no stored connection or terminal view. Explicit
    // Quit must still stop its daemon and wait for the live shell to be reaped.
    let relaunchedHost = PtydHost(configuration: config)
    try await relaunchedHost.stopExisting()
    for _ in 0..<100 {
        if kill(secondHello.pid, 0) == -1 { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(kill(Int32(survivor.pid), 0) == -1)
    #expect(kill(secondHello.pid, 0) == -1)
    // A second Quit with only the stale socket must not start a replacement.
    try await relaunchedHost.stopExisting()
}
