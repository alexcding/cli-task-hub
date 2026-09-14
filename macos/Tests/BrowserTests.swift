import AppKit
import Foundation
import Testing
import WebKit

@Test func oldTabImportPreservesOrderActivePageClosedRootAndFileEntries() throws {
    let tab = SavedTab(kind: "github", title: "PR", url: "https://github.com/fixture/repo/pull/1", cur: "https://example.com/current",
        paneView: "off", pageClosed: false,
        links: [.init(kind: "web", url: "https://example.com/one", title: "One"),
                .init(kind: "file", url: "file:///tmp/file.swift", title: "File", path: "/tmp/file.swift"),
                .init(kind: "web", url: "https://example.com/two", title: "Two", active: true)],
        history: [.init(kind: "file", path: "/tmp/old.swift"), .init(kind: "web", url: "https://example.com/history", title: "History")])
    let snapshot = ContextSnapshot.importing(tab)
    #expect(snapshot.pages.map(\.url) == ["https://example.com/current", "https://example.com/one", "https://example.com/two"])
    #expect(snapshot.activeID == snapshot.pages.last?.id)
    #expect(snapshot.pane == "off")
    #expect(snapshot.legacyDocuments?.first?.path == "/tmp/file.swift")
    #expect(snapshot.legacyFileHistory?.first?.path == "/tmp/old.swift")
    #expect(snapshot.history.first?.title == "History")
    var closed = tab; closed.pageClosed = true
    #expect(ContextSnapshot.importing(closed).pages.count == 2)
    let older = try JSONDecoder().decode(ContextSnapshot.self, from: Data(#"{"pages":[],"history":[],"pane":"term"}"#.utf8))
    #expect(older.legacyDocuments == nil)
}

@MainActor @Test func contextTabsKeepOneOrderReopenHistoryAndDoNotPersistBuildMode() throws {
    let context = WorkspaceContext(id: "task:one", sourceURL: "session:one", title: "Bare session")
    #expect(context.pages.isEmpty)
    let first = try #require(context.open("https://example.com/a", title: "A"))
    let second = try #require(context.open("https://example.com/b", title: "B"))
    context.select(first)
    let third = try #require(context.open("https://example.com/c", title: "C"))
    #expect(context.pages.map(\.title) == ["A", "C", "B"])
    #expect(context.open("https://example.com/c") === third)
    context.close(third)
    #expect(context.activeID == second.id)
    #expect(context.history.contains { $0.url == third.url })
    context.setPane(.build)
    #expect(context.snapshot.pane == "term")
    let restored = WorkspaceContext(id: context.id, sourceURL: "session:one", title: "", snapshot: context.snapshot)
    #expect(restored.pages.map(\.record) == context.pages.map(\.record))
    #expect(restored.activeID == second.id)
    #expect(restored.open("file:///tmp/secret") == nil)
    #expect(restored.open("javascript:alert(1)") == nil)
    #expect(restored.open("https://user:password@example.com") == nil)
}

@MainActor @Test(.timeLimit(.minutes(1))) func browserNavigatesFindsPersistsTabsAndBoundsLiveViews() async throws {
    _ = NSApplication.shared
    let root = TestPaths.checkout
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("browser-test-\(UUID().uuidString)")
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
    let pressure = FixtureMemoryPressureMonitor()
    let viewer = ViewerStore(limit: 2, memoryPressure: pressure)
    viewer.connect(api)
    let context = viewer.select(id: "test", url: base.appendingPathComponent("fixture/page").absoluteString, title: "Fixture")
    let page = try #require(context.activePage)
    for _ in 0..<200 {
        if page.title == "Native Browser Fixture" && !page.loading { break }
        try await Task.sleep(for: .milliseconds(25))
    }
    #expect(page.error == nil)
    #expect(page.title == "Native Browser Fixture")
    let controls = page.controls
    #expect(controls.address == page.url)
    page.find("quokka")
    for _ in 0..<100 {
        if page.found != nil { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(page.found == true)
    controls.setEditingAddress(true)
    controls.address = "https://example.test/unsaved-draft"
    page.navigate(base.appendingPathComponent("fixture/next").absoluteString)
    for _ in 0..<200 {
        if page.title == "Next Fixture Page" && !page.loading { break }
        try await Task.sleep(for: .milliseconds(25))
    }
    #expect(page.canGoBack)
    #expect(controls.address == "https://example.test/unsaved-draft")
    controls.setEditingAddress(false)
    #expect(controls.address == page.url)
    let cookie = try await page.webView?.evaluateJavaScript("document.cookie.includes('taskhub_native_fixture=retained')")
    #expect(cookie as? Bool == true)
    page.back()
    for _ in 0..<200 {
        if page.title == "Native Browser Fixture" && !page.loading { break }
        try await Task.sleep(for: .milliseconds(25))
    }
    #expect(page.canGoForward)
    #expect(controls.address == page.url, "Back navigation updates the address without a mounted view observer")
    let second = try #require(context.open(base.appendingPathComponent("fixture/next").absoluteString))
    let third = try #require(context.open(base.appendingPathComponent("fixture/page").absoluteString + "?third=1"))
    #expect(viewer.livePageCount == 2 && page.webView == nil)
    context.select(page)
    #expect(viewer.livePageCount == 2 && second.webView == nil && page.webView != nil)
    let retainedSurface = page.webView
    viewer.setPageLimit(1)
    #expect(viewer.livePageCount == 1 && page.webView === retainedSurface && third.webView == nil)
    viewer.setPageLimit(3)
    context.select(second)
    context.select(third)
    let protectedSurface = third.webView
    pressure.emit()
    #expect(viewer.pressureCleanupCount == 1)
    #expect(viewer.livePageCount == 1 && third.webView === protectedSurface)
    #expect(page.webView == nil && second.webView == nil && context.pages.count == 3)
    context.select(page)
    #expect(page.webView != nil) // Suspended identity rehydrates on selection.
    viewer.deactivate()
    pressure.emit()
    #expect(viewer.livePageCount == 0)
    _ = viewer.select(id: "test", url: context.sourceURL, title: "Fixture")
    context.close(third)
    await viewer.stop() // Drains serialized SQLite settings writes.
    #expect(pressure.stopped)
    viewer.connect(api)
    #expect(!pressure.stopped)
    pressure.emit()
    #expect(viewer.pressureCleanupCount == 3)
    await viewer.stop()
    let settings: [String: String] = try await api.get(Routes.SETTINGS)
    let json = try #require(settings["native.context.test"])
    let snapshot = try JSONDecoder().decode(ContextSnapshot.self, from: Data(json.utf8))
    #expect(snapshot.pages.count == 2)
    #expect(snapshot.history.contains { $0.url.hasSuffix("?third=1") })
    context.pages.forEach { $0.evict() }

    let cache = directory.appendingPathComponent("offline-tabs.json")
    let offline = ViewerStore(cacheURL: cache)
    let pending = offline.select(id: "offline", url: "session:offline", title: "Offline")
    pending.setPane(.off)
    await offline.stop()
    let relaunched = ViewerStore(cacheURL: cache)
    let recovered = relaunched.select(id: "offline", url: "session:offline", title: "Offline")
    #expect(recovered.pane == .off)
    relaunched.connect(api)
    for _ in 0..<100 {
        let values: [String: String] = try await api.get(Routes.SETTINGS)
        if values["native.context.offline"] != nil { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    await relaunched.stop()
    let recoveredSettings: [String: String] = try await api.get(Routes.SETTINGS)
    #expect(recoveredSettings["native.context.offline"]?.contains("off") == true)
}
