import AppKit
import Foundation
import Testing
@testable import TaskHubFeature

@Test func trayReviewClassificationUsesDifferentRulesForRequestsAndTabs() throws {
    let data = Data(#"[{"url":"https://example.com/1","repo":"o/r","number":1,"title":"Requested","state":"OPEN","category":"review","awaitingMyReview":true,"reviewPending":true},{"url":"https://example.com/2","repo":"o/r","number":2,"title":"Already reviewed","state":"OPEN","category":"other","awaitingMyReview":true},{"url":"https://example.com/3","repo":"o/r","number":3,"title":"Mine","state":"OPEN","category":"mine","awaitingMyReview":false}]"#.utf8)
    let prs = try JSONDecoder().decode([TrayPR].self, from: data)
    #expect(prs.filter(\.pendingReview).map(\.number) == [1])
    let tabs = prs.map { SavedTab(kind: "github", title: $0.title, url: $0.url, category: $0.category) }
    let groups = TrayTabGroup.make(tabs: tabs, prs: prs)
    #expect(groups.first { $0.title == "Review" }?.tabs.map(\.url) == [prs[0].url, prs[1].url])
    #expect(groups.first { $0.title == "Mine" }?.tabs.map(\.url) == [prs[2].url])
    #expect(safeWebURL("file:///tmp/a") == nil)
    #expect(safeWebURL("https://user:secret@example.com") == nil)
    #expect(backendTimestamp("2026-09-12T00:00:00.123Z") != nil)
    #expect(backendTimestamp("2026-09-12T00:00:00Z") != nil)
    let limit = UsageSnapshot.Window(usedPct: 120, resetsAt: nil, label: nil)
    #expect(limit.remaining == 0)
}

@MainActor @Test(.timeLimit(.minutes(1))) func trayLoadsIndependentlyPreservesUsageAndPersistsPreferences() async throws {
    _ = NSApplication.shared
    let oldAppearance = NSApp.appearance
    defer { NSApp.appearance = oldAppearance }
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tray-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let suite = "tray-test-\(UUID().uuidString)"
    let preferences = try #require(UserDefaults(suiteName: suite))
    defer { preferences.removePersistentDomain(forName: suite) }
    let ready = directory.appendingPathComponent("ready")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", root.appendingPathComponent("macos/scripts/backend-fixture.cjs").path]
    var env = ProcessInfo.processInfo.environment
    env["TASKHUB_DATA_DIR"] = directory.path
    env["TASKHUB_READY_FILE"] = ready.path
    env["TASKHUB_TRAY_FIXTURE"] = "1"
    env["TASKHUB_HOLD_USAGE"] = "1"
    env["PORT"] = "0"
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
    let shell = ShellStore(preferences: preferences)
    shell.setAppearance(.dark) // Offline edit must survive the first server snapshot.
    shell.connect(api)
    shell.refreshUsage()
    for _ in 0..<100 {
        if shell.prs.count == 3 { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(shell.prs.count == 3)
    #expect(shell.pendingReviewCount == 1)
    #expect(shell.appearance == .dark)
    #expect(shell.usageLoading && shell.usage == nil) // A blocked usage source cannot block reviews.
    try Data().write(to: directory.appendingPathComponent("release-usage"))
    for _ in 0..<100 {
        if !shell.usageLoading { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    let previousUsage = try #require(shell.usage)
    try Data().write(to: directory.appendingPathComponent("fail-usage"))
    shell.refreshUsage()
    for _ in 0..<100 {
        if !shell.usageLoading { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(shell.usageError != nil)
    #expect(shell.usage == previousUsage)

    let review = try #require(shell.pendingReviews.first)
    shell.acknowledge(review)
    for _ in 0..<100 {
        if shell.pendingReviewCount == 0 { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(shell.pendingReviewCount == 0)
    let refreshed: [TrayPR] = try await api.get(Routes.PRS_TRAY)
    #expect(refreshed.filter(\.pendingReview).isEmpty)

    shell.setAppearance(.dark)
    shell.setAppearance(.light)
    shell.setAppearance(.system)
    shell.setUsageAgent("codex")
    await shell.stop() // Drains preference writes in order before disconnecting.
    let settings: [String: String] = try await api.get(Routes.SETTINGS)
    #expect(settings["theme"] == "auto")
    #expect(settings["usageAgent"] == "codex")
    let reopened = ShellStore(preferences: preferences)
    #expect(reopened.appearance == .system && reopened.usageAgent == "codex")
}
