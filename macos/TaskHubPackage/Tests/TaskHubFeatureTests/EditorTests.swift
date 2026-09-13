import AppKit
import Foundation
import Testing
import WebKit
@testable import TaskHubFeature

private struct FontDiffFixture: DiffService {
    func load(worktree: String) async throws -> DiffSnapshot {
        .init(diff: "diff --git a/Example.swift b/Example.swift\n--- a/Example.swift\n+++ b/Example.swift\n@@ -1 +1 @@\n-let value = 1\n+let value = 2\n", untracked: [], branch: "font-test")
    }
}

actor FileFixture: FileDocumentService {
    var writes: [String] = []
    var reads = 0
    var fails = false
    func fail(_ value: Bool) { fails = value }
    func load(path: String) async throws -> FileDocumentSnapshot {
        reads += 1
        return .init(content: "original", readOnly: false, revision: String(repeating: "a", count: 64))
    }
    func save(path: String, content: String, revision: String) async throws -> String {
        writes.append(content)
        try await Task.sleep(for: .milliseconds(70))
        if fails { throw BackendError.operation("File changed on disk") }
        return String(repeating: "b", count: 64)
    }
}

@MainActor final class BufferFixture: EditorSurface {
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
    var appearances: [AppAppearance] = []
    var fonts: [CodeFont] = []
    func setAppearance(_ value: AppAppearance) { appearances.append(value) }
    func setFont(_ value: CodeFont) { fonts.append(value) }
    var location: (Int, Int)?
    func focus(line: Int, column: Int) { location = (line, column) }
    func find() {}
    func dispose() { disposed = true }
}

@MainActor @Test func nativeMemoryPressurePreservesHiddenDirtyEditor() async throws {
    let pressure = FixtureMemoryPressureMonitor()
    let viewer = ViewerStore(memoryPressure: pressure)
    let context = viewer.select(id: "files", url: "session:files", title: "Files")
    let model = try #require(context.openFile("/tmp/unsaved.swift"))
    let surface = BufferFixture()
    model.connect(service: FileFixture(), makeSurface: { surface })
    model.show(appearance: .system); await model.waitForLoad()
    surface.edit("unsaved work")
    viewer.deactivate()
    viewer.setPageLimit(1)
    pressure.emit()
    viewer.suspendBackgroundPages()
    #expect(context.documents.first === model && model.loaded && model.dirty)
    #expect(surface.content == "unsaved work" && !surface.disposed && !surface.frozen)
    await viewer.stop()
    model.dispose()
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

@MainActor @Test func workflowPagePromotionPreservesUnsavedEditorBuffer() async throws {
    let viewer = ViewerStore()
    let context = viewer.select(id: "tab:workflow", url: "session:fixture", title: "Workflow")
    let model = try #require(context.openFile("/tmp/workflow-unsaved.swift"))
    let surface = BufferFixture()
    model.connect(service: FileFixture(), makeSurface: { surface })
    model.show(appearance: .system); await model.waitForLoad()
    surface.edit("Unsaved before preparation")
    try viewer.promoteContext(from: "tab:workflow", to: "task:workflow")
    #expect(viewer.active === context && context.activeDocument === model)
    #expect(model.loaded && model.dirty && surface.content == "Unsaved before preparation")
    #expect(!surface.disposed && !surface.frozen)
    let existing = viewer.select(id: "task:existing", url: "session:existing", title: "Existing")
    let existingModel = try #require(existing.openFile("/tmp/existing-unsaved.swift"))
    let existingSurface = BufferFixture()
    existingModel.connect(service: FileFixture(), makeSurface: { existingSurface })
    existingModel.show(appearance: .system); await existingModel.waitForLoad()
    existingSurface.edit("Existing session edits")
    _ = viewer.select(id: "task:workflow", url: "session:fixture", title: "Workflow")
    try viewer.promoteContext(from: "task:workflow", to: "task:existing")
    #expect(viewer.active === existing && existing.activeDocument === model)
    #expect(existing.documents.count == 2 && existingModel.dirty && model.dirty)
    #expect(existingSurface.content == "Existing session edits" && surface.content == "Unsaved before preparation")
    #expect(!existingSurface.disposed && !surface.disposed)
    await viewer.stop(); model.dispose(); existingModel.dispose()
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
    let beforeFont = try await surface.snapshot(freeze: false)
    model.setFont(CodeFont(family: "Menlo", size: 19))
    let info = try await view.evaluateJavaScript("window.monaco.editor.getEditors()[0].getOption(window.monaco.editor.EditorOption.fontInfo).fontSize")
    #expect(info as? Int == 19)
    let afterFont = try await surface.snapshot(freeze: false)
    #expect(afterFont.content == beforeFont.content && afterFont.version == beforeFont.version && afterFont.dirty)
    #expect(model.webView === view)
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

    let diff = DiffViewModel(worktree: directory.path, baseURL: base, service: FontDiffFixture())
    defer { diff.disconnect() }
    diff.setFont(CodeFont(family: "Menlo", size: 20))
    diff.show(appearance: .dark)
    let diffView = try #require(diff.webView)
    var rendered = false
    for _ in 0..<200 {
        rendered = (try? await diffView.evaluateJavaScript("document.querySelector('.diff-root') !== null && document.documentElement.style.getPropertyValue('--diff-font-size') === '20px'")) as? Bool == true
        if rendered { break }
        try await Task.sleep(for: .milliseconds(25))
    }
    #expect(rendered && diff.error == nil)
    _ = try await diffView.evaluateJavaScript("window.savedDiffRoot = document.querySelector('.diff-root'); true")
    diff.setFont(CodeFont(family: "Monaco", size: 16))
    let retained = try await diffView.evaluateJavaScript("window.savedDiffRoot === document.querySelector('.diff-root') && document.documentElement.style.getPropertyValue('--diff-font-size') === '16px'")
    #expect(retained as? Bool == true)
}


@MainActor @Test func editorLocationSurvivesLoadingAndReopeningExistingDocument() async {
    let surface = BufferFixture()
    let model = EditorDocumentViewModel(record: .init(path: "/tmp/location.swift"), service: FileFixture(), makeSurface: { surface })
    model.focus(line: 20, column: 7)
    model.show(appearance: .system)
    await model.waitForLoad()
    #expect(surface.location?.0 == 20 && surface.location?.1 == 7)
    model.focus(line: 30, column: 2)
    #expect(surface.location?.0 == 30 && surface.location?.1 == 2)
    model.dispose()
}
