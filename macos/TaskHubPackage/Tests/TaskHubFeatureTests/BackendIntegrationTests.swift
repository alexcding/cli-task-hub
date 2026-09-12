import Foundation
import Testing
@testable import TaskHubFeature

private actor Events {
    var connected = false
    var sync = false
    func connect() { connected = true }
    func receive(_ event: ServerEvent) { if event.type == "sync" { sync = true } }
}

// Starts the real Express routes against temporary data, without the poller or any
// GitHub/Jira calls. No production database or running TaskHub daemon is touched.
@Test(.timeLimit(.minutes(1))) func realBackendSnapshotStreamAndOwnership() async throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("taskhub-native-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let ready = directory.appendingPathComponent("ready")
    let fixture = Process()
    fixture.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    let script = root.appendingPathComponent("macos/scripts/backend-fixture.cjs")
    fixture.arguments = ["node", script.path]
    var env = ProcessInfo.processInfo.environment
    env["TASKHUB_DATA_DIR"] = directory.path
    env["TASKHUB_READY_FILE"] = ready.path
    env["TASKHUB_INSTANCE_ID"] = "external-fixture"
    env["PORT"] = "0"
    fixture.environment = env
    fixture.standardOutput = FileHandle.nullDevice
    fixture.standardError = FileHandle.nullDevice
    try fixture.run()
    defer { if fixture.isRunning { fixture.terminate() } }
    for _ in 0..<100 {
        if FileManager.default.fileExists(atPath: ready.path) { break }
        try await Task.sleep(for: .milliseconds(50))
    }
    let base = try #require(URL(string: String(contentsOf: ready, encoding: .utf8)))
    let external = BackendProcess(configuration: .init(baseURL: base, mode: .external))
    let api = try await external.start()
    let projects: [Project] = try await api.get(Routes.PROJECTS)
    #expect(projects.count == 1)
    #expect(projects.first?.name == "Native integration fixture")
    let checkout = directory.appendingPathComponent("repo")
    try FileManager.default.createDirectory(at: checkout, withIntermediateDirectories: true)
    func git(_ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", checkout.path] + arguments
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run(); process.waitUntilExit()
        #expect(process.terminationStatus == 0)
    }
    try git(["init", "-b", "main"])
    try git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Initial"])
    let project = Project(id: projects[0].id, name: "Fixture", repo: "", color: nil, workspace: checkout.path)
    let operations = SessionOperations(api: api)
    let refs = try await operations.references(project)
    #expect(refs.branches.map(\.name).contains("main"))
    let record = try await operations.create(project: project,
        draft: SessionDraft(branch: "feature/native", base: "main", title: "Native session", agent: .shell))
    #expect(FileManager.default.fileExists(atPath: record.worktree + "/.git"))
    #expect(record.url == "session:\(record.id)")
    try await api.setPinned(true, for: record.id)
    try await operations.saveAgentID("persisted-agent", session: record)
    let saved: [WorkspaceSession] = try await api.get(Routes.TASKS)
    #expect(saved.first?.pinned == true && saved.first?.sessionId == "persisted-agent")
    #expect(saved.first?.worktree == record.worktree)
    do {
        _ = try await operations.create(project: project, draft: SessionDraft(branch: "../escape", agent: .shell))
        Issue.record("Accepted an unsafe worktree branch")
    } catch { #expect((error as? BackendError) != nil) }
    let events = Events()
    let consumer = Task {
        try await SSEClient().consume(from: base, onConnect: { await events.connect() },
                                      onEvent: { await events.receive($0) })
    }
    defer { consumer.cancel() }
    for _ in 0..<60 {
        if await events.sync { break }
        try await Task.sleep(for: .milliseconds(50))
    }
    #expect(await events.connected)
    #expect(await events.sync)
    consumer.cancel()
    _ = await consumer.result
    await external.stop()
    #expect(fixture.isRunning)
    #expect(try await api.health().instanceId == "external-fixture")

    // A new owner must reject the occupied port, never adopt or kill the external server.
    let nodePaths = (env["PATH"] ?? "").split(separator: ":").map { URL(fileURLWithPath: String($0)).appendingPathComponent("node") }
    let node = try #require(nodePaths.first { FileManager.default.isExecutableFile(atPath: $0.path) })
    let occupied = BackendProcess(configuration: .init(baseURL: base, mode: .owned(node: node, script: script, dataDirectory: directory)))
    do { _ = try await occupied.start(); Issue.record("Accepted a port owned by another server") }
    catch { #expect(fixture.isRunning) }
    #expect(try await api.health().instanceId == "external-fixture")

    fixture.terminate()
    for _ in 0..<60 {
        if !fixture.isRunning { break }
        try await Task.sleep(for: .milliseconds(50))
    }
    #expect(!fixture.isRunning)
    let owned = BackendProcess(configuration: .init(baseURL: base, mode: .owned(node: node, script: script, dataDirectory: directory)))
    let ownAPI = try await owned.start()
    let health = try await ownAPI.health()
    #expect(health.instanceId != nil && health.instanceId != "external-fixture")
    await owned.stop()
    #expect(kill(health.pid, 0) == -1)
}
