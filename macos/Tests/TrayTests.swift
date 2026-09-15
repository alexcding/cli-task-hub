import AppKit
import Foundation
import Testing

@Test func trayReviewClassificationUsesDifferentRulesForRequestsAndTabs() throws {
    let data = Data(#"[{"url":"https://example.com/1","repo":"o/r","number":1,"title":"Requested","state":"OPEN","category":"review","awaitingMyReview":true,"reviewPending":true},{"url":"https://example.com/2","repo":"o/r","number":2,"title":"Already reviewed","state":"OPEN","category":"other","awaitingMyReview":true},{"url":"https://example.com/3","repo":"o/r","number":3,"title":"Mine","state":"OPEN","category":"mine","awaitingMyReview":false}]"#.utf8)
    let prs = try JSONDecoder().decode([TrayPR].self, from: data)
    #expect(prs.filter(\.pendingReview).map(\.number) == [1])
    let tabs = prs.map { SavedTab(kind: "github", title: $0.title, url: $0.url, category: $0.category) }
        + [SavedTab(kind: "web", title: "Docs", url: "https://example.com/docs")]
    let groups = TrayTabGroup.make(tabs: tabs, prs: prs)
    #expect(groups.map(\.title) == ["Mine", "Review"]) // no web tabs in the tray
    #expect(groups.first { $0.title == "Review" }?.tabs.map(\.url) == [prs[0].url, prs[1].url])
    #expect(groups.first { $0.title == "Mine" }?.tabs.map(\.url) == [prs[2].url])
    #expect(safeWebURL("file:///tmp/a") == nil)
    #expect(safeWebURL("https://user:secret@example.com") == nil)
    #expect(backendTimestamp("2026-09-12T00:00:00.123Z") != nil)
    #expect(backendTimestamp("2026-09-12T00:00:00Z") != nil)
    let limit = UsageSnapshot.Window(usedPct: 120, resetsAt: nil, label: nil)
    #expect(limit.remaining == 0)
    let now = try #require(backendTimestamp("2026-09-12T00:00:00Z"))
    let half = UsageSnapshot.Window(usedPct: 30, resetsAt: "2026-09-12T02:30:00Z", label: nil)
    #expect(half.paceRemaining(duration: 5 * 3600, now: now) == 50)
    #expect(half.paceRemaining(duration: 5 * 3600, now: now.addingTimeInterval(86400)) == 0)
    #expect(limit.paceRemaining(duration: 5 * 3600, now: now) == nil)
}

@MainActor @Test(.timeLimit(.minutes(1))) func trayLoadsIndependentlyPreservesUsageAndPersistsPreferences() async throws {
    _ = NSApplication.shared
    let oldAppearance = NSApp.appearance
    defer { NSApp.appearance = oldAppearance }
    let root = TestPaths.checkout
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
    let resourceSample = try await NativeResourceUsageService(api: api, pty: nil).sample()
    #expect(resourceSample.processes.contains { $0.pid == process.processIdentifier && $0.group == .backend && $0.residentBytes > 0 })
    #expect(resourceSample.processes.filter { $0.pid == process.processIdentifier }.count == 1)
    let shell = ShellStore(preferences: preferences)
    shell.setAppearance(.dark) // Offline edit must survive the first server snapshot.
    shell.setActivityNotify(false)
    shell.setReviewSound("off")
    shell.setGitClient("custom")
    shell.gitClientCommandDraft = #"open -a "Fork" {path}"#
    shell.saveGitClientCommand()
    shell.setFont(.term, family: "Menlo", size: 16)
    shell.setFont(.diff, family: "Monaco", size: 14)
    var appliedLimits: [Int] = []
    shell.remotePageLimitChanged = { appliedLimits.append($0) }
    shell.setRemotePageLimit(3)
    shell.connect(APIShellDataService(api: api))
    shell.refreshUsage()
    for _ in 0..<100 {
        if shell.prs.count == 3 { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(shell.prs.count == 3)
    #expect(shell.pendingReviewCount == 1)
    #expect(shell.appearance == .dark)
    #expect(!shell.activityNotify && shell.reviewSound == "off")
    #expect(shell.gitClient == "custom" && shell.gitClientCommand == #"open -a "Fork" {path}"#)
    #expect(shell.font(.term) == CodeFont(family: "Menlo", size: 16))
    #expect(shell.font(.diff) == CodeFont(family: "Monaco", size: 14))
    #expect(shell.remotePageLimit == 3 && appliedLimits.last == 3)
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
    await shell.stop()
    // A notification body click may precede backend readiness after launch.
    shell.acknowledgeReview(repo: review.repo, number: review.number)
    shell.connect(APIShellDataService(api: api))
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
    shell.setDefaultAgent(.codex)
    shell.setDefaultAgent(.shell)
    shell.gitClientCommandDraft = "open 'unfinished"
    shell.saveGitClientCommand()
    #expect(shell.gitClientCommandError != nil && shell.gitClientCommandDirty)
    shell.revertGitClientCommand()
    #expect(!shell.gitClientCommandDirty && shell.gitClientCommandError == nil)
    shell.setGitClient("tower")
    for size in 17...24 { shell.setFont(.term, size: size) }
    shell.setFont(.diff, family: "Menlo", size: 18)
    shell.setRemotePageLimit(99)
    shell.setRemotePageLimit(4)
    await shell.stop() // Drains preference writes in order before disconnecting.
    let settings: [String: String] = try await api.get(Routes.SETTINGS)
    #expect(settings["theme"] == "auto")
    #expect(settings["usageAgent"] == "codex")
    #expect(settings["defaultCli"] == "")
    #expect(settings["activityNotify"] == "off" && settings["reviewSound"] == "off")
    #expect(settings["gitClient"] == "tower" && settings["gitClientCmd"] == #"open -a "Fork" {path}"#)
    #expect(settings["term_font_size"] == "24" && settings["term_font_family"] == "Menlo")
    #expect(settings["diff_font_size"] == "18" && settings["diff_font_family"] == "Menlo")
    #expect(settings["native.remotePageLimit"] == "4" && appliedLimits.suffix(2) == [12, 4])
    let reopened = ShellStore(preferences: preferences)
    #expect(reopened.appearance == .system && reopened.usageAgent == "codex")
    #expect(!reopened.activityNotify && reopened.reviewSound == "off")
    #expect(reopened.defaultAgent == .shell)
    #expect(reopened.gitClient == "tower" && reopened.gitClientCommand == #"open -a "Fork" {path}"#)
    #expect(reopened.font(.term) == CodeFont(family: "Menlo", size: 24))
    #expect(reopened.font(.diff) == CodeFont(family: "Menlo", size: 18))
    #expect(reopened.remotePageLimit == 4)
}

private actor TodayLogService: LogService {
    let body: String
    init(_ body: String) { self.body = body }
    func entries(category: String, errorsOnly: Bool) throws -> [LogEntry] {
        #expect(category == "event" && !errorsOnly)
        return try JSONDecoder().decode([LogEntry].self, from: Data(body.utf8))
    }
    func categories() -> [String] { [] }
    func clear(category: String) {}
}

@MainActor @Test(.timeLimit(.minutes(1))) func todayActivityShowsOnlyTodaysEventsAndLoadsWhenOpened() async throws {
    // Local noon, so "today" and "yesterday" are the same days in every time zone.
    let now = try #require(Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: Date(timeIntervalSince1970: 1_789_000_000)))
    let stamp = ISO8601DateFormatter()
    let today = stamp.string(from: now.addingTimeInterval(-600))
    let yesterday = stamp.string(from: now.addingTimeInterval(-86400))
    let service = TodayLogService(#"[{"seq":2,"category":"event","level":"info","type":"pr_merged","payload":"{\"pr\":{\"number\":4,\"url\":\"https://github.com/o/r/pull/4\"}}","created_at":"\#(today)"},{"seq":3,"category":"event","level":"error","type":"sync_failed","payload":"{}","created_at":"\#(today)"},{"seq":1,"category":"event","level":"info","type":"pr_opened","payload":"{}","created_at":"\#(yesterday)"}]"#)
    let model = TodayActivityViewModel(now: { now })
    model.connect(service)
    #expect(!model.loaded && !model.loading) // nothing is fetched until the bell opens it
    model.setVisible(true)
    while !model.loaded { try await Task.sleep(for: .milliseconds(5)) }
    #expect(model.entries.map(\.seq) == [2, 3])

    var opened: [Int] = []
    model.openPage = { opened.append($0.seq) }
    let merged = try #require(model.entries.first { $0.seq == 2 }), failed = try #require(model.entries.first { $0.seq == 3 })
    #expect(model.canOpen(merged) && !model.canOpen(failed))
    let openedMerged = await model.open(merged), openedFailed = await model.open(failed)
    #expect(openedMerged && !openedFailed)
    #expect(opened == [2])
    model.openPage = { _ in throw BackendError.operation("offline") }
    let openedOffline = await model.open(merged)
    #expect(!openedOffline)
    #expect(model.error?.contains("offline") == true)

    model.setVisible(false)
    model.setVisible(true) // reopening starts from "Loading…", never the previous rows
    #expect(model.entries.isEmpty && !model.loaded && model.error == nil)
    while !model.loaded { try await Task.sleep(for: .milliseconds(5)) }
    model.setVisible(false)
}
