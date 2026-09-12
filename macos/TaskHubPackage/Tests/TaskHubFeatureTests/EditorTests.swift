import AppKit
import Foundation
import Testing
import WebKit
@testable import TaskHubFeature

private actor FileFixture: FileDocumentService {
    var writes: [String] = []
    var fails = false
    func fail(_ value: Bool) { fails = value }
    func load(path: String) async throws -> FileDocumentSnapshot {
        .init(content: "original", readOnly: false, revision: String(repeating: "a", count: 64))
    }
    func save(path: String, content: String, revision: String) async throws -> String {
        writes.append(content)
        try await Task.sleep(for: .milliseconds(70))
        if fails { throw BackendError.operation("File changed on disk") }
        return String(repeating: "b", count: 64)
    }
}

@MainActor private final class BufferFixture: EditorSurface {
    var webView: WKWebView? { nil }
    var changed: (Bool) -> Void = { _ in }
    var failed: (String) -> Void = { _ in }
    var saveRequested: () -> Void = {}
    var content = "original", version = 1, saved = 1
    var frozen = false, disposed = false
    func edit(_ text: String, notify: Bool = true) {
        guard !frozen else { return }
        content = text; version += 1
        if notify { changed(version != saved) }
    }
    func load(_ value: FileDocumentSnapshot, path: String) async throws {}
    func snapshot(freeze: Bool) async throws -> EditorBuffer {
        frozen = frozen || freeze
        return .init(content: content, version: version, dirty: version != saved)
    }
    func acknowledge(version: Int) async throws -> Bool { saved = version; return self.version != saved }
    func unfreeze() async throws { frozen = false }
    func setAppearance(_ value: AppAppearance) {}
    func focus(line: Int) {}
    func find() {}
    func dispose() { disposed = true }
}

@MainActor @Test func nativeEditorSaveCoalescesAndAcknowledgesOnlySubmittedBuffer() async throws {
    let service = FileFixture(), surface = BufferFixture()
    let model = EditorDocumentViewModel(record: .init(path: "/tmp/test.swift"), service: service, makeSurface: { surface })
    model.show(appearance: .system); await model.waitForLoad()
    #expect(model.loaded && model.error == nil)
    surface.edit("first")
    let first = Task { await model.save() }
    for _ in 0..<100 {
        if await service.writes.count == 1 { break }
        try await Task.sleep(for: .milliseconds(5))
    }
    surface.edit("new edit during save")
    let second = Task { await model.save() }
    #expect(await first.value)
    #expect(await second.value)
    #expect(await service.writes == ["first"])
    #expect(model.dirty && surface.content == "new edit during save")
    await service.fail(true)
    #expect(await model.save() == false)
    #expect(model.dirty && model.error == "File changed on disk")
    await service.fail(false)
    #expect(await model.save())
    #expect(!model.dirty)
}

@MainActor @Test func nativeEditorCloseFreezesQueriesLatestBufferAndCancelKeepsEveryDocument() async throws {
    let service = FileFixture(), surface = BufferFixture()
    let model = EditorDocumentViewModel(record: .init(path: "/tmp/close.swift"), service: service, makeSurface: { surface })
    model.show(appearance: .system); await model.waitForLoad()
    surface.edit("last keystroke", notify: false)
    #expect(!model.dirty) // The async WebKit notification has not arrived.
    var prompts = 0
    let approved = await EditorCloseCoordinator.confirm([model]) { document in
        prompts += 1
        #expect(document.dirty && surface.frozen)
        surface.edit("must not be accepted")
        return .cancel
    }
    #expect(!approved && prompts == 1 && !surface.frozen && !model.closing)
    #expect(surface.content == "last keystroke" && !surface.disposed)
    await service.fail(true)
    prompts = 0
    #expect(await EditorCloseCoordinator.confirm([model]) { _ in
        prompts += 1
        return prompts == 1 ? .save : .cancel
    } == false)
    #expect(prompts == 2 && model.dirty && !surface.disposed)
    #expect(await EditorCloseCoordinator.confirm([model]) { _ in .discard })
    model.dispose()
    #expect(surface.disposed)
}

@MainActor @Test func nativeEditorHiddenCleanBuffersEvictAndDirtyBuffersSurvive() async throws {
    let service = FileFixture(), surface = BufferFixture()
    let model = EditorDocumentViewModel(record: .init(path: "/tmp/cache.swift"), service: service, makeSurface: { surface })
    model.show(appearance: .system); await model.waitForLoad()
    surface.edit("unsaved", notify: false)
    model.hide()
    for _ in 0..<10 { await Task.yield() }
    #expect(model.loaded && model.dirty && !surface.disposed && !surface.frozen)
    model.show(appearance: .system)
    #expect(await model.save())
    model.hide()
    for _ in 0..<10 { await Task.yield() }
    #expect(!model.loaded && surface.disposed)
}

@MainActor @Test func fileAndWebTabsShareOrderHistoryAndRestoreActiveFiles() throws {
    let legacy = SavedTab(kind: "web", title: "Root", url: "https://example.com", links: [
        .init(kind: "file", path: "/tmp/one.swift"), .init(url: "https://example.com/two", title: "Two"),
        .init(kind: "file", path: "/tmp/three.swift", active: true)])
    #expect(SavedTabContent(kind: "file", url: "file:///tmp/file%20name.swift").filePath == "/tmp/file name.swift")
    #expect(SavedTabContent(kind: "file", url: "https://example.com/secret").filePath == nil)
    let snapshot = ContextSnapshot.importing(legacy)
    let context = WorkspaceContext(id: "files", sourceURL: legacy.url, title: "", snapshot: snapshot)
    #expect(context.tabs.map(\.title) == ["Root", "one.swift", "Two", "three.swift"])
    #expect(context.activeDocument?.record.path == "/tmp/three.swift")
    let first = try #require(context.documents.first)
    context.select(.file(first))
    let fourth = try #require(context.open("https://example.com/four", title: "Four"))
    #expect(context.tabs.map(\.title) == ["Root", "one.swift", "Four", "Two", "three.swift"])
    context.close(fourth)
    context.remove(first)
    #expect(context.visits.suffix(2).map(\.title) == ["Four", "/tmp/one.swift"])
    let data = try JSONEncoder().encode(context.snapshot)
    let restored = WorkspaceContext(id: "files", sourceURL: legacy.url, title: "", snapshot: try JSONDecoder().decode(ContextSnapshot.self, from: data))
    #expect(restored.tabOrder == context.tabOrder)
    #expect(restored.documents.count == 1) // Legacy metadata must not resurrect the closed file.
    #expect(restored.visits.map(\.title) == context.visits.map(\.title))
}

@MainActor @Test(.timeLimit(.minutes(1))) func nativeEditorWebKitLoadsSavesAndRejectsRemoteNavigation() async throws {
    _ = NSApplication.shared
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("editor-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let ready = directory.appendingPathComponent("ready")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", root.appendingPathComponent("macos/scripts/backend-fixture.cjs").path]
    var env = ProcessInfo.processInfo.environment
    env["TASKHUB_DATA_DIR"] = directory.path; env["TASKHUB_READY_FILE"] = ready.path; env["PORT"] = "0"
    process.environment = env
    process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
    try process.run()
    defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
    for _ in 0..<100 {
        if FileManager.default.fileExists(atPath: ready.path) { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    let base = try #require(URL(string: String(contentsOf: ready, encoding: .utf8)))
    let api = try APIClient(baseURL: base)
    let file = directory.appendingPathComponent("Fixture.swift")
    let original = "\u{feff}let title = \"Unicode 🦊\"\r\n"
    try Data(original.utf8).write(to: file)
    let model = EditorDocumentViewModel(record: .init(path: file.path), service: APIFileDocumentService(api: api),
        makeSurface: { WebEditorSurface(baseURL: base) })
    defer { model.dispose() }
    model.show(appearance: .dark)
    await model.waitForLoad()
    #expect(model.error == nil)
    #expect(model.loaded)
    let view = try #require(model.webView)
    let surface = try #require(model.surface)
    #expect(try await surface.snapshot(freeze: false).content == original)
    _ = try await view.evaluateJavaScript(#"window.monaco.editor.getModels()[0].applyEdits([{range:{startLineNumber:2,startColumn:1,endLineNumber:2,endColumn:1},text:'// edited\r\n'}]); true"#)
    #expect(await model.save())
    let savedBytes = try Data(contentsOf: file)
    #expect(savedBytes == Data((original + "// edited\r\n").utf8))
    #expect(!model.dirty)
    // The focused page cannot navigate to a remote origin and retain the bridge.
    _ = try await view.evaluateJavaScript("window.location.href = 'https://example.com'; true")
    try await Task.sleep(for: .milliseconds(100))
    #expect(view.url == base.appendingPathComponent("native/editor.html"))
    // A remote edit is a conflict, and the native buffer remains available.
    try Data("external change".utf8).write(to: file)
    _ = try await view.evaluateJavaScript(#"window.monaco.editor.getModels()[0].setValue('my unsaved content'); true"#)
    #expect(await model.save() == false)
    #expect(try await surface.snapshot(freeze: false).content == "my unsaved content")
    #expect(try String(contentsOf: file, encoding: .utf8) == "external change")
    #expect(model.error != nil)
}
