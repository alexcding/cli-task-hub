import Foundation
import Observation

protocol GitChangesService: Sendable {
    func load(worktree: String) async throws -> DiffSnapshot
    func commit(worktree: String, message: String, includeUntracked: Bool) async throws -> String
    func push(worktree: String) async throws
}

struct APIGitChangesService: GitChangesService {
    let api: APIClient
    func load(worktree: String) async throws -> DiffSnapshot {
        try await APIDiffService(api: api).load(worktree: worktree)
    }
    func commit(worktree: String, message: String, includeUntracked: Bool) async throws -> String {
        struct Request: Encodable, Sendable { let path: String; let message: String; let includeUntracked: Bool }
        struct Response: Decodable, Sendable { let ok: Bool; let hash: String }
        let value: Response = try await api.request(Routes.GIT_COMMIT, method: "POST",
            body: Request(path: worktree, message: message, includeUntracked: includeUntracked))
        guard value.ok, !value.hash.isEmpty else { throw BackendError.operation("The backend did not confirm the commit. Refresh before retrying.") }
        return value.hash
    }
    func push(worktree: String) async throws {
        let value: OperationOK = try await api.request(Routes.GIT_PUSH, method: "POST", body: ["path": worktree], timeout: 130)
        guard value.ok == true else { throw BackendError.operation("The backend did not confirm the push. Refresh before retrying.") }
    }
}

@MainActor @Observable final class GitChangesActions {
    enum Action { case commit, commitAndPush, push }
    let worktree: String
    var message = ""
    var includeUntracked = true
    private(set) var snapshot: DiffSnapshot?
    private(set) var loading = false
    private(set) var busy = false
    private(set) var error: String?
    private(set) var status: String?
    private(set) var committedHash: String?
    @ObservationIgnored private var service: any GitChangesService
    @ObservationIgnored private let didChange: () -> Void
    @ObservationIgnored private var generation = UUID()
    private var fresh = false
    private var suspended = false
    @ObservationIgnored private var waiters: [CheckedContinuation<Void, Never>] = []

    init(worktree: String, service: any GitChangesService, didChange: @escaping () -> Void = {}) {
        self.worktree = worktree; self.service = service; self.didChange = didChange
    }
    var trackedChanges: Bool { snapshot?.diff.isEmpty == false }
    var canCommit: Bool {
        fresh && !suspended && !loading && !busy && committedHash == nil
            && (trackedChanges || (includeUntracked && snapshot?.untracked.isEmpty == false))
    }
    var canPush: Bool { fresh && !suspended && !loading && !busy && (snapshot?.ahead == nil || (snapshot?.ahead ?? 0) > 0) }
    var summary: String {
        guard let snapshot else { return "Loading working changes…" }
        let tracked = trackedChanges ? "Tracked changes" : "No tracked changes"
        return "\(tracked) · \(snapshot.untracked.count) untracked files"
    }
    func connect(_ service: any GitChangesService) {
        self.service = service; generation = UUID(); loading = false; fresh = false
    }
    func load() async {
        guard !busy else { return }
        let generation = UUID(); self.generation = generation
        loading = true; fresh = false; error = nil
        defer { if self.generation == generation { loading = false } }
        do {
            let value = try await service.load(worktree: worktree)
            guard self.generation == generation else { return }
            snapshot = value; fresh = true
        } catch { if self.generation == generation { self.error = error.localizedDescription } }
    }
    func perform(_ action: Action) async {
        guard action == .push ? canPush : canCommit else { return }
        busy = true; error = nil; status = nil
        let service = service
        let submitted = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let commitMessage = submitted.isEmpty ? "Update working changes" : submitted
        let includeUntracked = includeUntracked
        // One service and one captured draft own the complete operation. A push
        // failure never causes a successful commit to be submitted again.
        do {
            if action != .push {
                committedHash = try await service.commit(worktree: worktree, message: commitMessage, includeUntracked: includeUntracked)
                status = "Committed \(committedHash!)."
                if message.trimmingCharacters(in: .whitespacesAndNewlines) == submitted { message = "" }
            }
            if action != .commit {
                try await service.push(worktree: worktree)
                status = committedHash.map { "Committed \($0) and pushed." } ?? "Pushed."
            }
        } catch {
            self.error = committedHash.map { "Commit \($0) is saved locally. \(error.localizedDescription)" } ?? error.localizedDescription
        }
        // Even a failed commit may have staged files or a hook may have edited
        // the worktree. Always reconcile. Do not cancel an in-flight mutation
        // when the sheet or workspace becomes hidden.
        fresh = false
        let reconciliation = generation
        do {
            let value = try await self.service.load(worktree: worktree)
            if generation == reconciliation { snapshot = value; fresh = true }
        }
        catch { self.error = [self.error, "Could not refresh changes: \(error.localizedDescription)"].compactMap { $0 }.joined(separator: "\n") }
        busy = false; didChange()
        let pending = waiters; waiters.removeAll(); pending.forEach { $0.resume() }
    }
    func suspendAndWait() async {
        suspended = true
        if busy { await withCheckedContinuation { waiters.append($0) } }
    }
    func resume() { suspended = false }

    func beginNextCommit() {
        guard !busy else { return }
        committedHash = nil; status = nil
    }
}
