import Darwin
import Foundation
import Testing
@testable import TaskHubFeature

@Test(.timeLimit(.minutes(3))) func packagedBackendCheckpointsBeforeReadinessAndCancellationStopsPreflight() async throws {
    var checkout = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { checkout.deleteLastPathComponent() }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("taskhub-startup-\(UUID().uuidString)")
    let backend = root.appendingPathComponent("backend"), data = root.appendingPathComponent("data")
    let server = backend.appendingPathComponent("src/server"), database = server.appendingPathComponent("database")
    try FileManager.default.createDirectory(at: database, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    for name in ["native-launcher.js", "database/native-checkpoint.js", "database/data-snapshot.js"] {
        try FileManager.default.copyItem(at: checkout.appendingPathComponent("src/server/\(name)"), to: server.appendingPathComponent(name))
    }
    try "{\"format\":1,\"id\":\"\(String(repeating: "a", count: 64))\"}".write(to: backend.appendingPathComponent("release.json"), atomically: true, encoding: .utf8)
    let nodePaths = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":")
        .map { URL(fileURLWithPath: String($0)).appendingPathComponent("node") }
    let node = try #require(nodePaths.first { FileManager.default.isExecutableFile(atPath: $0.path) })
    let seed = Process()
    seed.executableURL = node
    seed.arguments = ["-e", "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec('CREATE TABLE fixture (value TEXT)'); db.close();", data.appendingPathComponent("taskhub.db").path]
    seed.standardOutput = FileHandle.nullDevice; seed.standardError = FileHandle.nullDevice
    try seed.run(); seed.waitUntilExit(); try #require(seed.terminationStatus == 0)
    let app = server.appendingPathComponent("app.js")
    try """
    const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
    fs.writeFileSync(path.join(process.env.TASKHUB_DATA_DIR, 'schema-loaded'), 'loaded');
    let server;
    module.exports = {
      start: () => new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({service:'taskhub', protocol:1, pid:process.pid, instanceId:process.env.TASKHUB_INSTANCE_ID}));
        });
        server.once('error', reject); server.listen(Number(process.env.PORT), '127.0.0.1', resolve);
      }), stop: () => server?.close()
    };
    """.write(to: app, atomically: true, encoding: .utf8)
    let descriptor = socket(AF_INET, SOCK_STREAM, 0)
    try #require(descriptor >= 0)
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let bound = withUnsafeMutablePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(descriptor, $0, length) == 0 && getsockname(descriptor, $0, &length) == 0
        }
    }
    close(descriptor); try #require(bound)
    let base = try #require(URL(string: "http://127.0.0.1:\(UInt16(bigEndian: address.sin_port))"))
    let owner = BackendProcess(configuration: .init(baseURL: base, mode: .owned(node: node, script: app, dataDirectory: data), packaged: true))
    do {
        let api = try await owner.start(), health = try await api.health()
        let checkpointDirectory = data.appendingPathComponent("native-backups")
        let names = try FileManager.default.contentsOfDirectory(atPath: checkpointDirectory.path)
        let checkpoint = try #require(names.first { $0.hasPrefix("checkpoint-") })
        #expect(FileManager.default.fileExists(atPath: checkpointDirectory.appendingPathComponent("\(checkpoint)/manifest.json").path))
        #expect(FileManager.default.fileExists(atPath: data.appendingPathComponent("schema-loaded").path))
        await owner.stop()
        #expect(kill(health.pid, 0) == -1)

        try FileManager.default.removeItem(at: data.appendingPathComponent("schema-loaded"))
        let service = database.appendingPathComponent("native-checkpoint.js")
        let source = try String(contentsOf: service, encoding: .utf8)
        // The real launcher awaits this injected slow checkpoint. Cancellation
        // must kill that owned child before it loads even the fixture app module.
        try (source + """
        \nconst originalPrepare = module.exports.prepareNativeData;
        module.exports.prepareNativeData = async (...args) => {
          fs.writeFileSync(path.join(args[0], 'checkpoint-waiting'), String(process.pid));
          await new Promise(resolve => setTimeout(resolve, 30000));
          return originalPrepare(...args);
        };
        """).write(to: service, atomically: true, encoding: .utf8)
        let starting = Task { try await owner.start() }
        let waiting = data.appendingPathComponent("checkpoint-waiting")
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath: waiting.path) { break }
            try await Task.sleep(for: .milliseconds(30))
        }
        starting.cancel()
        do { _ = try await starting.value; Issue.record("Cancelled checkpoint startup became ready") }
        catch { #expect(error is CancellationError) }
        await owner.stop()
        let pid = try #require(Int32(String(contentsOf: waiting, encoding: .utf8)))
        #expect(kill(pid, 0) == -1)
        #expect(!FileManager.default.fileExists(atPath: data.appendingPathComponent("schema-loaded").path))
        #expect(try FileManager.default.contentsOfDirectory(atPath: checkpointDirectory.path).filter { $0.hasPrefix("checkpoint-") }.count == 1)
    } catch { await owner.stop(); throw error }
}
