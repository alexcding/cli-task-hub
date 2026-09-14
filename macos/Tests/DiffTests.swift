import Foundation
import Testing

actor DiffFixture: DiffService {
    var calls = 0
    var fails = false
    func fail(_ value: Bool) { fails = value }
    func load(worktree: String) async throws -> DiffSnapshot {
        calls += 1
        // Deliberately finish even after cancellation to exercise stale responses.
        try? await Task.sleep(for: .milliseconds(60))
        if fails { throw BackendError.operation("Repository unavailable") }
        return .init(diff: "diff for \(worktree)", untracked: ["new.swift"], branch: "feature")
    }
}

@MainActor @Test func diffRefreshCoalescesRetainsLastSuccessAndRejectsHiddenReplies() async throws {
    let service = DiffFixture()
    let model = DiffViewModel(worktree: "/tmp/diff-test", baseURL: URL(string: "http://127.0.0.1:3000")!, service: service)
    model.refresh(); model.refresh()
    await model.waitForRefresh()
    #expect(await service.calls == 1)
    #expect(model.snapshot?.diff == "diff for /tmp/diff-test")
    await service.fail(true)
    model.refresh(); await model.waitForRefresh()
    #expect(model.error == "Repository unavailable")
    #expect(model.snapshot?.branch == "feature")
    await service.fail(false)
    model.refresh()
    model.hide()
    try await Task.sleep(for: .milliseconds(100))
    #expect(model.snapshot == nil && !model.loading)
    model.refresh(); await model.waitForRefresh()
    #expect(model.snapshot != nil && model.error == nil)
    model.disconnect(); model.refresh()
    #expect(model.error == "Connect to the backend to load changes.")
}
