import Foundation
import Testing
@testable import TaskHubFeature

private actor GitActionFixture: GitChangesService {
    var commits: [(String, Bool)] = []
    var pushes = 0
    var commitFails = false, pushFails = true, loadFails = false
    var dirty = true, ahead = 0
    func setCommitFailure(_ value: Bool) { commitFails = value }
    func setPushFailure(_ value: Bool) { pushFails = value }
    func setLoadFailure(_ value: Bool) { loadFails = value }
    func load(worktree: String) async throws -> DiffSnapshot {
        if loadFails { throw BackendError.operation("Repository unavailable") }
        return .init(diff: dirty ? "tracked changes" : "", untracked: dirty ? ["new.swift"] : [], branch: "feature", ahead: ahead, behind: 0)
    }
    func commit(worktree: String, message: String, includeUntracked: Bool) async throws -> String {
        commits.append((message, includeUntracked))
        try await Task.sleep(for: .milliseconds(50))
        if commitFails { throw BackendError.operation("Signing failed") }
        dirty = false; ahead += 1
        return "abc1234"
    }
    func push(worktree: String) async throws {
        pushes += 1
        try await Task.sleep(for: .milliseconds(30))
        if pushFails { throw BackendError.operation("Push rejected") }
        ahead = 0
    }
}

@MainActor @Test func nativeCommitCoalescesAndPushFailureCannotRepeatCommit() async throws {
    let service = GitActionFixture()
    var refreshes = 0
    let model = GitChangesActions(worktree: "/fixture", service: service, didChange: { refreshes += 1 })
    await model.load()
    model.message = " Preserve this message "
    model.includeUntracked = false
    let operation = Task { await model.perform(.commitAndPush) }
    for _ in 0..<50 { if model.busy { break }; await Task.yield() }
    await model.perform(.commitAndPush)
    await operation.value
    #expect(await service.commits.count == 1)
    #expect(await service.commits.first?.0 == "Preserve this message")
    #expect(await service.commits.first?.1 == false)
    #expect(await service.pushes == 1)
    #expect(model.committedHash == "abc1234" && !model.canCommit && model.canPush)
    #expect(model.error == "Commit abc1234 is saved locally. Push rejected")
    #expect(model.snapshot?.diff == "" && refreshes == 1)
    await model.perform(.commitAndPush)
    #expect(await service.commits.count == 1)
    await service.setPushFailure(false)
    await model.perform(.push)
    #expect(await service.commits.count == 1)
    #expect(await service.pushes == 2)
    #expect(!model.canPush)
    #expect(model.status == "Committed abc1234 and pushed." && model.error == nil)
}

@MainActor @Test func nativeCommitFailureRetainsDraftAndRefreshFailureDisablesMutations() async {
    let service = GitActionFixture()
    let model = GitChangesActions(worktree: "/fixture", service: service)
    await model.load()
    model.message = "My draft"; model.includeUntracked = false
    await service.setCommitFailure(true)
    await model.perform(.commit)
    #expect(model.message == "My draft" && model.committedHash == nil && model.canCommit)
    #expect(model.error == "Signing failed")
    await service.setLoadFailure(true)
    await model.perform(.commit)
    #expect(!model.canCommit && !model.canPush && model.message == "My draft")
    #expect(model.error?.contains("Could not refresh changes") == true)
    await service.setLoadFailure(false)
    await model.load()
    #expect(model.canCommit)
    await service.setCommitFailure(false)
    await model.perform(.commit)
    #expect(model.committedHash == "abc1234" && !model.canCommit)
    model.beginNextCommit()
    #expect(model.committedHash == nil && !model.canCommit) // The fresh snapshot is clean.
}


@MainActor @Test func shutdownWaitsForGitMutationAndPreventsNewOperations() async throws {
    let service = GitActionFixture()
    let model = GitChangesActions(worktree: "/fixture", service: service)
    await model.load()
    let operation = Task { await model.perform(.commitAndPush) }
    for _ in 0..<100 { if model.busy { break }; await Task.yield() }
    #expect(model.busy)
    await model.suspendAndWait()
    #expect(!model.busy && !model.canPush && model.committedHash == "abc1234")
    await operation.value
    await model.perform(.push)
    #expect(await service.pushes == 1)
    model.resume()
    #expect(model.canPush)
}
