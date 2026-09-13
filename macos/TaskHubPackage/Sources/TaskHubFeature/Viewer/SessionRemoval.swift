import Foundation
import Observation
import SwiftUI

struct SessionRemovalPlan: Sendable {
    let record: WorkspaceSession
    let sessions: [WorkspaceSession]
    let removesWorktree: Bool
    let holders: [String]
    var pairKeys: Set<String> {
        Set(sessions.flatMap { [$0.id, "build:\($0.url)"] })
    }
    static func path(_ value: String) -> String { URL(fileURLWithPath: value).standardizedFileURL.resolvingSymlinksInPath().path }
}

struct SessionRemovalService: Sendable {
    let api: APIClient
    let stopTerminals: @Sendable (Set<String>) async throws -> Void

    func prepare(record: WorkspaceSession, projects: [Project], sessions: [WorkspaceSession]) async throws -> SessionRemovalPlan {
        struct Worktree: Decodable, Sendable { let path: String }
        struct Holder: Decodable, Sendable { let command: String; let pid: Int }
        struct Holders: Decodable, Sendable { let holders: [Holder] }
        let hasProject = projects.contains { $0.id == record.projectId }
        let trees: [Worktree] = hasProject
            ? try await api.get(APIClient.query(Routes.WORKTREES, ["path": record.workspace])) : []
        let linked = trees.contains { SessionRemovalPlan.path($0.path) == SessionRemovalPlan.path(record.worktree) }
        let affected = linked ? sessions.filter { SessionRemovalPlan.path($0.worktree) == SessionRemovalPlan.path(record.worktree) } : [record]
        let holders: Holders = linked
            ? try await api.get(APIClient.query(Routes.WORKTREE_HOLDERS, ["path": record.worktree])) : Holders(holders: [])
        return .init(record: record, sessions: affected, removesWorktree: linked,
                     holders: holders.holders.map { "\($0.command) (PID \($0.pid))" })
    }

    func remove(_ plan: SessionRemovalPlan, discardChanges: Bool) async throws {
        // A new session may have attached to this checkout while confirmation was
        // open. Require a fresh preview so it is never stopped without disclosure.
        let current: [WorkspaceSession] = try await api.get(Routes.TASKS)
        if plan.removesWorktree {
            let related = current.filter { SessionRemovalPlan.path($0.worktree) == SessionRemovalPlan.path(plan.record.worktree) }
            guard Set(related.map(\.id)) == Set(plan.sessions.map(\.id)) else {
                throw BackendError.operation("Sessions using this worktree changed. Close this dialog and review removal again.")
            }
        }
        try await stopTerminals(plan.pairKeys)
        if plan.removesWorktree {
            struct Payload: Encodable, Sendable { let path: String; let worktree: String; let force: Bool }
            let _: OperationOK = try await api.request(Routes.WORKTREE_REMOVE, method: "POST", body:
                Payload(path: plan.record.workspace, worktree: plan.record.worktree, force: discardChanges))
        }
        for session in plan.sessions {
            let _: OperationOK = try await api.request(APIClient.query(Routes.TASKS, ["id": session.id]),
                                                      method: "DELETE", body: [String: String]())
        }
    }
}

@MainActor @Observable final class SessionRemovalViewModel {
    private(set) var plan: SessionRemovalPlan?
    private(set) var loading = true
    private(set) var removing = false
    private(set) var completed = false
    private(set) var error: String?
    var discardChanges = false
    private let service: SessionRemovalService
    private let record: WorkspaceSession
    private let projects: [Project]
    private let sessions: [WorkspaceSession]
    private let didRemove: ([WorkspaceSession]) async -> Void
    private let finished: () -> Void
    @ObservationIgnored var didComplete: () -> Void = {}
    init(service: SessionRemovalService, record: WorkspaceSession, projects: [Project], sessions: [WorkspaceSession],
         didRemove: @escaping ([WorkspaceSession]) async -> Void, finished: @escaping () -> Void) {
        self.service = service; self.record = record; self.projects = projects; self.sessions = sessions; self.didRemove = didRemove
        self.finished = finished
    }
    func load() async {
        defer { loading = false }
        do { plan = try await service.prepare(record: record, projects: projects, sessions: sessions) }
        catch { self.error = error.localizedDescription }
    }
    func remove() async {
        guard let plan, !removing else { return }
        removing = true; error = nil
        defer { removing = false; finished() }
        do {
            try await service.remove(plan, discardChanges: discardChanges)
            await didRemove(plan.sessions)
            completed = true
            didComplete()
        } catch { self.error = error.localizedDescription }
    }
}

struct SessionRemovalView: View {
    @Bindable var model: SessionRemovalViewModel
    let cancel: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.plan?.removesWorktree == true ? "Remove Worktree and Sessions" : "Forget Session").font(.title2.weight(.semibold))
            if model.loading { ProgressView("Checking worktree…") }
            if let plan = model.plan {
                Text(plan.record.worktree).font(.callout).textSelection(.enabled)
                if plan.removesWorktree {
                    Text("This stops every listed session and build terminal, then removes the worktree folder. The Git branch is kept.")
                    ForEach(plan.sessions) { Text("• \($0.title.isEmpty ? $0.label : $0.title)") }
                    if !plan.holders.isEmpty {
                        Text("Open files: " + plan.holders.joined(separator: ", ")).foregroundStyle(.orange)
                    }
                    Toggle("Discard uncommitted changes and untracked files", isOn: $model.discardChanges)
                    if model.discardChanges { Text("Changes in this worktree will be permanently lost. An open Xcode project in this folder will be closed without saving.").foregroundStyle(.orange) }
                } else {
                    Text("This is not a linked worktree of an available project. Only this session record and its terminals are removed; its folder is kept.")
                }
            }
            if let error = model.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
            HStack {
                Button("Cancel", role: .cancel, action: cancel).keyboardShortcut(.cancelAction)
                Spacer()
                if model.removing { ProgressView().controlSize(.small) }
                Button(model.plan?.removesWorktree == true ? "Remove Worktree" : "Forget Session", role: .destructive) {
                    Task { await model.remove() }
                }.disabled(model.plan == nil || model.loading)
            }.disabled(model.removing)
        }.padding(24).frame(width: 520)
        .interactiveDismissDisabled(model.removing)
        .task { await model.load() }
    }
}
