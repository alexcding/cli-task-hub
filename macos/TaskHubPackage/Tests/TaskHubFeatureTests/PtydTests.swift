import AppKit
import SwiftUI
import GhosttyTerminal
import Foundation
import Testing
@testable import TaskHubFeature

private final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [PtyEvent] = []
    func append(_ event: PtyEvent) { lock.lock(); storage.append(event); lock.unlock() }
    var events: [PtyEvent] { lock.lock(); defer { lock.unlock() }; return storage }
    var bytes: Data { events.compactMap(\.bytes).reduce(into: Data()) { $0.append($1) } }
    var text: String { String(decoding: bytes, as: UTF8.self) }
}

@Test func ptyFramesPreserveSplitUTF8AndBoundMemory() throws {
    var framer = PtyFramer()
    var frames: [Data] = []
    let payload = Data("日本語🦀".utf8)
    for byte in "{\"ev\":\"data\",\"id\":\"pty1\",\"bytes\":\"\(payload.base64EncodedString())\",\"seq\":1}\n\n{\"id\":2,\"ok\":null}\n".utf8 {
        frames += try framer.append(Data([byte]))
    }
    #expect(frames.count == 2)
    #expect(try JSONDecoder().decode(PtyEvent.self, from: frames[0]).bytes == payload)
    #expect(throws: (any Error).self) {
        try JSONDecoder().decode(PtyEvent.self, from: Data(#"{"ev":"data","id":"pty1","bytes":"?invalid","seq":1}"#.utf8))
    }
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
    try "#!/bin/sh\n/bin/stty raw -echo || exit 1\nprintf 'PTY_READY\\n'\nexec /bin/cat\n".write(to: shell, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: shell.path)
    let config = PtydConfiguration(executable: root.appendingPathComponent("crates/taskhub-ptyd/target/debug/taskhub-ptyd"),
                                   directory: directory, socketPath: directory.appendingPathComponent("pty.sock").path)
    let host = PtydHost(configuration: config)
    let log = EventLog()
    let client = PtydClient(onEvent: { log.append($0) })
    let hello = try await host.connect(client: client)
    defer { client.close(); _ = kill(hello.pid, SIGTERM) }
    #expect(hello.protocol == 2)
    try hello.validateByteTransport()
    try hello.validateInputAcknowledgements()
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
    // Every byte must survive both input and output. No decoder may replace
    // invalid UTF-8, interpret C1 bytes, or hold an incomplete codepoint back.
    let binaryStart = log.bytes.count
    let binary = Data((0...255).map(UInt8.init))
    let _: String? = try await client.request(.init(op: "write", term: terminal.id, bytes: binary))
    for _ in 0..<100 {
        if log.bytes.count >= binaryStart + binary.count { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(log.bytes.dropFirst(binaryStart) == binary)
    let splitStart = log.bytes.count
    let _: String? = try await client.request(.init(op: "write", term: terminal.id, bytes: Data([0xf0, 0x9f])))
    for _ in 0..<100 {
        if log.bytes.count >= splitStart + 2 { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(log.bytes.dropFirst(splitStart) == Data([0xf0, 0x9f]))
    let splitSnapshot: PtyAttachment = try await client.request(.init(op: "attach", term: terminal.id))
    #expect(splitSnapshot.bytes.suffix(2) == Data([0xf0, 0x9f]))
    let _: String? = try await client.request(.init(op: "write", term: terminal.id, bytes: Data([0xa6, 0x80])))
    for _ in 0..<100 {
        if log.bytes.count >= splitStart + 4 { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(log.bytes.dropFirst(splitStart) == Data("🦀".utf8))
    let snapshot: PtyAttachment = try await client.request(.init(op: "attach", term: terminal.id))
    #expect(snapshot.live && snapshot.bytes == log.bytes)
    #expect(snapshot.truncated == false)
    let events = log.events
    let sequences = events.filter { $0.ev == "data" }.compactMap(\.seq)
    #expect(sequences == sequences.sorted())
    #expect(Set(sequences).count == sequences.count)
    let states = events.compactMap(\.stateSeq)
    #expect(states == Array(UInt64(1)...UInt64(states.count)))
    let resized = try #require(events.first { $0.ev == "resize" })
    #expect(resized.cols == 101 && resized.rows == 31)
    let _: String? = try await client.request(.init(op: "flow", term: terminal.id, pause: true))
    let secondLog = EventLog()
    let second = PtydClient(onEvent: { secondLog.append($0) })
    defer { second.close() }
    let secondHello = try await second.connect(path: config.socketPath)
    #expect(secondHello.pid == hello.pid)
    let terms: [PtyInfo] = try await second.request(.init(op: "list"))
    #expect(terms.first?.pid == terminal.pid)
    let restored: PtyAttachment = try await second.request(.init(op: "attach", term: terminal.id))
    #expect(restored.bytes == snapshot.bytes)
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
    #expect(String(decoding: truncated.bytes, as: UTF8.self).contains("HISTORY_END"))
    #expect(truncated.bytes.count <= 256 * 1024)
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
    let owned: PtyInfo = try await second.request(.init(op: "create", opts: .init(
        cwd: directory.path, shell: shell.path, paired: true, pairKey: "restart-one")))
    let unrelated: PtyInfo = try await second.request(.init(op: "create", opts: .init(
        cwd: directory.path, shell: shell.path, paired: true, pairKey: "keep-other")))
    try await host.stopPaired(keys: ["restart-one"])
    let afterRestart: [PtyInfo] = try await second.request(.init(op: "list"))
    #expect(!afterRestart.contains { $0.id == owned.id })
    #expect(kill(Int32(owned.pid), 0) == -1)
    #expect(afterRestart.contains { $0.id == unrelated.id })
    #expect(afterRestart.contains { $0.id == survivor.id })
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

@Test(.timeLimit(.minutes(1))) func realDaemonRejectsInputOverflowAndMissingTerminalInsteadOfAcknowledgingDroppedBytes() async throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let directory = URL(fileURLWithPath: "/tmp/th-input-\(UUID().uuidString.prefix(12))")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }
    let shell = directory.appendingPathComponent("blocked-reader")
    try "#!/bin/sh\n/bin/stty raw -echo || exit 1\nprintf 'INPUT_READY\\n'\nexec /bin/sleep 30\n".write(to: shell, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: shell.path)
    let config = PtydConfiguration(executable: root.appendingPathComponent("crates/taskhub-ptyd/target/debug/taskhub-ptyd"),
                                   directory: directory, socketPath: directory.appendingPathComponent("pty.sock").path)
    let host = PtydHost(configuration: config), log = EventLog()
    let client = PtydClient(onEvent: log.append)
    let hello = try await host.connect(client: client)
    defer { client.close(); _ = kill(hello.pid, SIGTERM) }
    try hello.validateInputAcknowledgements()
    let terminal: PtyInfo = try await client.request(.init(op: "create", opts: .init(cwd: directory.path, shell: shell.path, pairKey: "blocked-input")))
    for _ in 0..<100 {
        if log.text.contains("INPUT_READY") { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(log.text.contains("INPUT_READY"))
    let _: Bool? = try await client.request(.init(op: "write", term: terminal.id, bytes: Data(repeating: 97, count: 1024 * 1024)))
    do {
        let _: Bool? = try await client.request(.init(op: "write", term: terminal.id, bytes: Data(repeating: 98, count: 64 * 1024)))
        Issue.record("Overflow was falsely acknowledged")
    } catch { #expect(error.localizedDescription.contains("queue is full")) }
    do {
        let _: Bool? = try await client.request(.init(op: "write", term: "missing-terminal", data: "never accepted"))
        Issue.record("Missing terminal write was falsely acknowledged")
    } catch { #expect(error.localizedDescription.contains("no longer exists")) }
    let terms: [PtyInfo] = try await client.request(.init(op: "list"))
    #expect(terms.first?.pid == terminal.pid)
    await host.quit(client: client, hello: hello)
}


@MainActor @Test(.timeLimit(.minutes(1))) func appSessionRestoresLargeHistoryAndParserStateIntoFreshNativeSurfaces() async throws {
    _ = NSApplication.shared
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let directory = URL(fileURLWithPath: "/tmp/th-state-\(UUID().uuidString.prefix(12))")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }
    let shell = directory.appendingPathComponent("fixture-shell")
    try "#!/bin/sh\n/bin/stty raw -echo || exit 1\nprintf '%s\\n' \"$TERM\" \"$TERM_PROGRAM\" \"$TERM_PROGRAM_VERSION\" \"$TERMINFO\" > environment\n/usr/bin/tput colors > colors\n/bin/cat '\(directory.path)/startup'\nexec /bin/cat\n".write(to: shell, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: shell.path)
    var text = ""
    for line in 0..<8000 { text += "history \(line) styled \u{1B}[32m日本語🦀\u{1B}[0m line\r\n" }
    let restoredDirectory = directory.appendingPathComponent("restored worktree")
    try FileManager.default.createDirectory(at: restoredDirectory, withIntermediateDirectories: true)
    var uri = URLComponents(url: restoredDirectory, resolvingAgainstBaseURL: false)!
    uri.host = "localhost"
    text += "\u{1B}]0;Restored fixture title\u{07}\u{1B}]7;\(uri.string!)\u{07}"
    text += "PRIMARY_MARKER\u{1B}[5;9H\u{1B}7\u{1B}[?1049hALT_MARKER\r\nSPLIT_"
    let startup = Data(text.utf8) + Data([0xf0, 0x9f])
    try startup.write(to: directory.appendingPathComponent("startup"))
    let config = PtydConfiguration(executable: root.appendingPathComponent("crates/taskhub-ptyd/target/debug/taskhub-ptyd"),
                                   directory: directory, socketPath: directory.appendingPathComponent("pty.sock").path)
    let host = PtydHost(configuration: config)
    let log = EventLog()
    let control = PtydClient(onEvent: log.append)
    let hello = try await host.connect(client: control)
    defer { control.close(); _ = kill(hello.pid, SIGTERM) }
    try hello.validateSnapshots()
    try hello.validateIdentityResponseOwner()
    let originalProfile = try PtyTerminalProfile.current()
    let movedBundle = directory.appendingPathComponent("temporary-bundle-terminfo")
    try FileManager.default.copyItem(at: URL(fileURLWithPath: originalProfile.terminfoDirectory), to: movedBundle)
    let profile = PtyTerminalProfile(version: originalProfile.version, terminfoDirectory: movedBundle.path)
    let term: PtyInfo = try await control.request(.init(op: "create", opts: .init(
        cwd: directory.path, shell: shell.path, pairKey: "app-snapshot",
        stateResponseOwner: PtyHello.identityResponseOwnerVersion, terminalProfile: profile)))
    let durableProfile = try #require(term.terminalProfile)
    #expect(durableProfile.version == profile.version)
    #expect(durableProfile.terminfoDirectory != profile.terminfoDirectory)
    #expect(try Data(contentsOf: URL(fileURLWithPath: durableProfile.terminfoDirectory).appendingPathComponent("78/xterm-ghostty"))
        == Data(contentsOf: movedBundle.appendingPathComponent("78/xterm-ghostty")))
    try FileManager.default.removeItem(at: movedBundle)
    defer { _ = kill(Int32(term.pid), SIGTERM) }
    for _ in 0..<200 {
        if log.bytes.count >= startup.count { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(log.bytes == startup)
    #expect(try String(contentsOf: directory.appendingPathComponent("environment"), encoding: .utf8)
        == "xterm-ghostty\nghostty\n\(profile.version)\n\(durableProfile.terminfoDirectory)\n")
    #expect(try String(contentsOf: directory.appendingPathComponent("colors"), encoding: .utf8) == "256\n")
    let tail: PtyAttachment = try await control.request(.init(op: "attach", term: term.id))
    #expect(tail.truncated == true)

    func mount(_ session: TerminalSession, width: CGFloat) -> NSWindow {
        let view = WorkspaceTerminalView(frame: NSRect(x: 0, y: 0, width: width, height: 420))
        view.delegate = session.surface; view.controller = session.surface.controller
        view.configuration = session.surface.configuration
        let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view
        view.layoutSubtreeIfNeeded()
        view.setSurfaceVisible(false)
        return window
    }
    let first = TerminalSession(pairKey: "app-snapshot", cwd: directory.path, configuration: config)
    let firstWindow = mount(first, width: 800)
    defer { first.disconnect(); firstWindow.contentView = nil; firstWindow.close() }
    await first.start()
    try await first.waitUntilReady()
    #expect(first.shellPID == term.pid && first.termID == term.id)
    for _ in 0..<100 {
        if first.surface.title == "Restored fixture title" && first.surface.workingDirectory == restoredDirectory.path { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(first.surface.title == "Restored fixture title")
    #expect(first.surface.workingDirectory == restoredDirectory.path)
    #expect((firstWindow.contentView as? WorkspaceTerminalView)?.directory == restoredDirectory.path)
    #expect(await first.viewportText()?.contains("ALT_MARKER") == true)
    let _: Bool? = try await control.request(.init(op: "write", term: term.id, bytes: Data([0xa6, 0x80])))
    for _ in 0..<100 {
        if await first.viewportText()?.contains("SPLIT_🦀") == true { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(await first.viewportText()?.contains("SPLIT_🦀") == true)
    await first.stopConnecting()
    firstWindow.contentView = nil

    let identityQuery = "\u{1B}[c\u{1B}[>c\u{1B}[=c\u{1B}[>q\u{1B}P+q544e\u{1B}\\"
    let identityReply = "\u{1B}[?62;22;52c\u{1B}[>1;10;0c\u{1B}P>|ghostty \(profile.version)\u{1B}\\\u{1B}P1+r544E=787465726D2D67686F73747479\u{1B}\\"
    let offlineStart = log.bytes.count
    let _: Bool? = try await control.request(.init(op: "write", term: term.id, data: identityQuery))
    for _ in 0..<100 {
        if log.bytes.count >= offlineStart + identityQuery.utf8.count + identityReply.utf8.count { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(String(decoding: log.bytes.dropFirst(offlineStart), as: UTF8.self) == identityQuery + identityReply)

    let second = TerminalSession(pairKey: "app-snapshot", cwd: directory.path, configuration: config)
    let secondWindow = mount(second, width: 960)
    defer { second.disconnect(); secondWindow.contentView = nil; secondWindow.close() }
    await second.start()
    try await second.waitUntilReady()
    #expect(second.shellPID == term.pid && second.termID == term.id)
    for _ in 0..<100 {
        if second.surface.title == "Restored fixture title" && second.surface.workingDirectory == restoredDirectory.path { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(second.surface.title == "Restored fixture title")
    #expect(second.surface.workingDirectory == restoredDirectory.path)
    #expect((secondWindow.contentView as? WorkspaceTerminalView)?.directory == restoredDirectory.path)
    #expect(await second.viewportText()?.contains("SPLIT_🦀") == true)
    let _: Bool? = try await control.request(.init(op: "write", term: term.id,
        data: "\u{1B}[?1049l\u{1B}8AFTER_SAVED_CURSOR"))
    for _ in 0..<100 {
        if await second.viewportText()?.contains("AFTER_SAVED_CURSOR") == true { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(await second.viewportText()?.contains("PRIMARY_MARKER") == true)
    #expect(await second.viewportText()?.contains("AFTER_SAVED_CURSOR") == true)
    #expect(second.surface.surface?.performBindingAction("scroll_to_top") == true)
    for _ in 0..<100 {
        if await second.viewportText()?.hasPrefix("history 0 ") == true { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(await second.viewportText()?.hasPrefix("history 0 ") == true)
    // The view keeps its physical size while the daemon changes the logical
    // grid. Subsequent output and its cursor query must observe the ordered grid.
    let observer = TerminalSession(pairKey: "app-snapshot", cwd: directory.path, configuration: config)
    let observerWindow = mount(observer, width: 800)
    defer { observer.disconnect(); observerWindow.contentView = nil; observerWindow.close() }
    await observer.start()
    try await observer.waitUntilReady()
    #expect(observer.shellPID == term.pid)
    let identityStart = log.bytes.count
    let _: Bool? = try await control.request(.init(op: "write", term: term.id, data: identityQuery))
    for _ in 0..<100 {
        if log.bytes.count >= identityStart + identityQuery.utf8.count + identityReply.utf8.count { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    try await Task.sleep(for: .milliseconds(200))
    #expect(String(decoding: log.bytes.dropFirst(identityStart), as: UTF8.self) == identityQuery + identityReply)
    let beforeResize = log.bytes.count
    let _: Bool? = try await control.request(.init(op: "resize", term: term.id, cols: 37, rows: 19))
    let _: Bool? = try await control.request(.init(op: "write", term: term.id,
        data: "\u{1B}[2J\u{1B}[H" + String(repeating: "x", count: 40) + "\u{1B}[6n"))
    for _ in 0..<100 {
        if String(decoding: log.bytes.dropFirst(beforeResize), as: UTF8.self).contains("\u{1B}[2;4R") { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(String(decoding: log.bytes.dropFirst(beforeResize), as: UTF8.self).contains("\u{1B}[2;4R"))
    // Let both renderers consume the query and its echoed response. Exactly
    // one response must reach the program even with two native surfaces.
    try await Task.sleep(for: .milliseconds(200))
    #expect(String(decoding: log.bytes.dropFirst(beforeResize), as: UTF8.self)
        .components(separatedBy: "\u{1B}[2;4R").count == 2)
    await observer.stopConnecting()
    observerWindow.contentView = nil
    let _: Bool? = try await control.request(.init(op: "write", term: term.id, data: "\u{1B}]7;\u{07}"))
    let restoredView = try #require(secondWindow.contentView as? WorkspaceTerminalView)
    for _ in 0..<100 {
        if restoredView.directory == nil { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(restoredView.directory == nil)
    await second.stopConnecting()
    try await host.stopExisting()
    #expect(!FileManager.default.fileExists(atPath: durableProfile.terminfoDirectory))
}


@MainActor @Test(.timeLimit(.minutes(1))) func appReconnectsTheSameShellButNeverRetriesUnacknowledgedInput() async throws {
    _ = NSApplication.shared
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    for mode in ["idle", "keyboard", "interrupt", "missing"] {
        let uncertainInput = mode == "keyboard" || mode == "interrupt"
        let directory = URL(fileURLWithPath: "/tmp/th-reconn-\(UUID().uuidString.prefix(10))")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let shell = directory.appendingPathComponent("fixture-shell")
        try "#!/bin/sh\n/bin/stty raw -echo || exit 1\nprintf 'RECONNECT_MARKER\\r\\n'\nexec /bin/cat\n".write(to: shell, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: shell.path)
        let config = PtydConfiguration(executable: root.appendingPathComponent("crates/taskhub-ptyd/target/debug/taskhub-ptyd"),
                                       directory: directory, socketPath: directory.appendingPathComponent("daemon.sock").path)
        let host = PtydHost(configuration: config)
        let log = EventLog()
        let control = PtydClient(onEvent: log.append)
        let hello = try await host.connect(client: control)
        defer { control.close(); _ = kill(hello.pid, SIGTERM) }
        let term: PtyInfo = try await control.request(.init(op: "create", opts: .init(
            cwd: directory.path, shell: shell.path, pairKey: "reconnect", stateResponseOwner: PtyHello.stateResponseOwnerVersion)))
        defer { _ = kill(Int32(term.pid), SIGTERM) }
        // Ctrl-C is data only after this fixture has disabled terminal signals.
        // Surface readiness is independent of shell startup completion.
        for _ in 0..<100 {
            if log.text.contains("RECONNECT_MARKER") { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        try #require(log.text.contains("RECONNECT_MARKER"))
        let proxyPath = directory.appendingPathComponent("proxy.sock").path
        let proxy = Process()
        proxy.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proxy.arguments = ["node", root.appendingPathComponent("macos/scripts/pty-reconnect-proxy.cjs").path,
                           proxyPath, config.socketPath, directory.path]
        proxy.standardOutput = FileHandle.nullDevice; proxy.standardError = FileHandle.nullDevice
        try proxy.run()
        defer { if proxy.isRunning { proxy.terminate(); proxy.waitUntilExit() } }
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath: directory.appendingPathComponent("proxy-ready").path) { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let session = TerminalSession(pairKey: "reconnect", cwd: directory.path, configuration:
            .init(executable: config.executable, directory: directory, socketPath: proxyPath))
        let hosting = NSHostingView(rootView: TerminalPane(session: session, reconnect: {}))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 500),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = hosting
        defer { session.disconnect(); window.contentView = nil; window.close() }
        hosting.layoutSubtreeIfNeeded()
        await session.start()
        try await session.waitUntilReady()
        let generation = session.surfaceGeneration
        let previousSurface = session.surface
        #expect(session.shellPID == term.pid)
        if mode == "idle" { session.showsSurface = false }
        var interrupt: Task<Void, Error>?
        if uncertainInput {
            try Data().write(to: directory.appendingPathComponent("hold-write-reply"))
            if mode == "interrupt" { interrupt = Task { try await session.interrupt() } }
            else {
                let view = try #require(session.surface.attachedPlatformView)
                #expect(view.sendKey(.enter))
            }
            for _ in 0..<100 {
                if FileManager.default.fileExists(atPath: directory.appendingPathComponent("write-seen").path) { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent("write-seen").path))
        }
        try Data().write(to: directory.appendingPathComponent("drop"))
        for _ in 0..<100 {
            if !FileManager.default.fileExists(atPath: directory.appendingPathComponent("drop").path) { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        if mode == "missing" {
            let _: Bool = try await control.request(.init(op: "kill", term: term.id))
            for _ in 0..<300 {
                if session.error?.contains("original terminal is no longer running") == true { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            #expect(!session.ready)
            #expect(session.error?.contains("original terminal is no longer running") == true)
            #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("creates").path))
        } else if uncertainInput {
            if let interrupt {
                do { try await interrupt.value; Issue.record("Lost acknowledgement unexpectedly succeeded") }
                catch { }
            }
            for _ in 0..<100 {
                if session.error != nil { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            try await Task.sleep(for: .milliseconds(600))
            #expect(!session.ready && session.surfaceGeneration == generation)
            #expect(session.error?.contains("Earlier input may have been sent") == true)
            #expect(try String(contentsOf: directory.appendingPathComponent("connections"), encoding: .utf8) == "connected\n")
            #expect(try String(contentsOf: directory.appendingPathComponent("write-seen"), encoding: .utf8) == (mode == "interrupt" ? "\u{03}\n" : "DQ==\n"))
        } else {
            let _: Bool? = try await control.request(.init(op: "write", term: term.id, data: "OUTPUT_DURING_RECONNECT\r\n"))
            for _ in 0..<300 {
                if session.surfaceGeneration != generation && session.ready { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            #expect(session.ready && session.error == nil)
            #expect(session.surfaceGeneration != generation)
            #expect(session.surface !== previousSurface)
            previousSurface.onClose?(true)
            #expect(session.ready && session.status == "Connected")
            #expect(!session.surface.isSurfaceVisible)
            #expect(session.shellPID == term.pid && session.termID == term.id)
            #expect(await session.viewportText()?.contains("RECONNECT_MARKER") == true)
            #expect(await session.viewportText()?.contains("OUTPUT_DURING_RECONNECT") == true)
            #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("creates").path))
            #expect(try String(contentsOf: directory.appendingPathComponent("connections"), encoding: .utf8) == "connected\nconnected\n")
            // Cancel the next reconnect during backoff. Removing the session must
            // not recreate a surface or enable input through a delayed callback.
            let beforeStop = session.surfaceGeneration
            try Data().write(to: directory.appendingPathComponent("drop"))
            for _ in 0..<100 {
                if session.status == "Reconnecting" { break }
                try await Task.sleep(for: .milliseconds(5))
            }
            await session.stopConnecting()
            try await Task.sleep(for: .milliseconds(400))
            #expect(!session.ready && session.surfaceGeneration == beforeStop)
        }
        await session.stopConnecting()
        let remaining: [PtyInfo] = try await control.request(.init(op: "list"))
        if mode == "missing" { #expect(remaining.isEmpty) }
        else {
            #expect(remaining.map(\.id) == [term.id], "Mode: \(mode)")
            #expect(remaining.map(\.pid) == [term.pid], "Mode: \(mode)")
        }
        try await host.stopExisting()
    }
}

@MainActor @Test(.timeLimit(.minutes(1))) func nativeZshIntegrationPreservesStartupFilesAndRestoresChangedWorkingDirectory() async throws {
    _ = NSApplication.shared
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let directory = URL(fileURLWithPath: "/private/tmp/th-zsh-\(UUID().uuidString.prefix(12))")
    let home = directory.appendingPathComponent("home")
    let originalStartup = directory.appendingPathComponent("original config")
    let startup = directory.appendingPathComponent("relocated config")
    let workspace = directory.appendingPathComponent("workspace")
    let changed = workspace.appendingPathComponent("next folder 日本語")
    for path in [home, originalStartup, startup, changed] {
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    defer { try? FileManager.default.removeItem(at: directory) }
    let files: [URL: String] = [
        originalStartup.appendingPathComponent(".zshenv"): "print -r -- env >> \"$HOME/startup.log\"\nexport ZDOTDIR='\(startup.path)'\n",
        startup.appendingPathComponent(".zprofile"): "print -r -- profile >> \"$HOME/startup.log\"\n",
        startup.appendingPathComponent(".zshrc"): "print -r -- rc >> \"$HOME/startup.log\"\nPROMPT='USER_PROMPT> '\nprecmd() { print -r -- user-hook >> \"$HOME/hooks.log\"; }\n",
        startup.appendingPathComponent(".zlogin"): "print -r -- login >> \"$HOME/startup.log\"\n",
    ]
    for (path, text) in files { try text.write(to: path, atomically: true, encoding: .utf8) }
    let config = PtydConfiguration(executable: root.appendingPathComponent("crates/taskhub-ptyd/target/debug/taskhub-ptyd"),
                                   directory: directory, socketPath: directory.appendingPathComponent("pty.sock").path)
    // Isolate only this daemon's child environment; no user shell configuration
    // or history is read or modified by the integration test.
    let process = Process()
    process.executableURL = config.executable
    process.arguments = [directory.path]
    var environment = ProcessInfo.processInfo.environment
    environment["TASKHUB_PTYD_SOCK"] = config.socketPath
    environment["HOME"] = home.path
    environment["ZDOTDIR"] = originalStartup.path
    environment["SHELL"] = "/bin/zsh"
    environment["HISTFILE"] = "/dev/null"
    process.environment = environment
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    for _ in 0..<100 {
        if FileManager.default.fileExists(atPath: config.socketPath) { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    let log = EventLog()
    let control = PtydClient(onEvent: log.append)
    let hello = try await control.connect(path: config.socketPath)
    defer { control.close(); _ = kill(hello.pid, SIGTERM) }
    try hello.validateShellIntegration()
    func mount(_ session: TerminalSession) -> NSWindow {
        let view = WorkspaceTerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 420))
        view.delegate = session.surface; view.controller = session.surface.controller
        view.configuration = session.surface.configuration
        let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view
        view.layoutSubtreeIfNeeded(); view.setSurfaceVisible(false)
        return window
    }
    let first = TerminalSession(pairKey: "native-zsh", cwd: workspace.path, configuration: config)
    let firstWindow = mount(first)
    defer { first.disconnect(); firstWindow.contentView = nil; firstWindow.close() }
    await first.start()
    try await first.waitUntilReady()
    for _ in 0..<200 {
        if first.surface.workingDirectory == workspace.path { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    try #require(first.surface.workingDirectory == workspace.path)
    #expect(await first.viewportText()?.contains("USER_PROMPT>") == true)
    #expect(try String(contentsOf: home.appendingPathComponent("startup.log"), encoding: .utf8) == "env\nprofile\nrc\nlogin\n")
    let terms: [PtyInfo] = try await control.request(.init(op: "list"))
    let term = try #require(terms.first)
    let resources = try #require(term.terminalProfile?.resourcesDirectory)
    #expect(resources.hasPrefix(directory.path))
    #expect(FileManager.default.isReadableFile(atPath: resources + "/shell-integration/zsh/.zshenv"))
    try await first.submit("cd -- '\(changed.path)'; false")
    for _ in 0..<200 {
        if first.surface.workingDirectory == changed.path { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(first.surface.workingDirectory == changed.path)
    #expect((firstWindow.contentView as? WorkspaceTerminalView)?.directory == changed.path)
    #expect(log.text.contains("\u{1B}]133;A") && log.text.contains("\u{1B}]133;B") && log.text.contains("\u{1B}]133;C"))
    #expect(log.text.contains("\u{1B}]133;D;1"))
    await first.stopConnecting()
    firstWindow.contentView = nil
    let second = TerminalSession(pairKey: "native-zsh", cwd: workspace.path, configuration: config)
    let secondWindow = mount(second)
    defer { second.disconnect(); secondWindow.contentView = nil; secondWindow.close() }
    await second.start()
    try await second.waitUntilReady()
    #expect(second.shellPID == term.pid && second.termID == term.id)
    #expect(second.surface.workingDirectory == changed.path)
    #expect((secondWindow.contentView as? WorkspaceTerminalView)?.directory == changed.path)
    #expect(try String(contentsOf: home.appendingPathComponent("startup.log"), encoding: .utf8) == "env\nprofile\nrc\nlogin\n")
    #expect(try String(contentsOf: home.appendingPathComponent("hooks.log"), encoding: .utf8).components(separatedBy: "user-hook").count >= 3)
    for (path, text) in files { #expect(try String(contentsOf: path, encoding: .utf8) == text) }
    await second.stopConnecting()
    try await PtydHost(configuration: config).stopExisting()
    #expect(!FileManager.default.fileExists(atPath: resources))
}
