import Foundation
import Observation

@MainActor @Observable final class NewSessionViewModel {
    let projects: [Project]
    var projectID: String
    var draft = SessionDraft()
    private(set) var branches: [String] = []
    private(set) var loading = false
    private(set) var creating = false
    private(set) var resolving = false
    private(set) var completed = false
    private(set) var error: String?
    private let operations: SessionOperations?
    private let didCreate: (WorkspaceSession) -> Void
    private var generation = UUID()
    init(projects: [Project], selectedProject: String, operations: SessionOperations?, didCreate: @escaping (WorkspaceSession) -> Void) {
        self.projects = projects; self.projectID = selectedProject; self.operations = operations; self.didCreate = didCreate
    }
    var busy: Bool { loading || creating || resolving }
    var project: Project? { projects.first { $0.id == projectID } }
    var canCreate: Bool { !busy && project != nil && !draft.branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var canResolve: Bool { !busy && project != nil && (SessionPage.parse(draft.branch) != nil || SessionPage.parse(draft.url) != nil) }
    func editBranch(_ value: String) { draft.branch = value; draft.reuseWorktree = nil }
    func loadReferences() async {
        let generation = UUID(); self.generation = generation
        branches = []; draft.base = ""; draft.reuseWorktree = nil; error = nil
        guard let project, let operations else { return }
        loading = true
        defer { if self.generation == generation { loading = false } }
        do {
            let refs = try await operations.references(project)
            try Task.checkCancellation()
            guard self.generation == generation else { return }
            branches = refs.branches.map(\.name)
            draft.base = branches.contains("develop") ? "develop" : refs.defaultBranch
            if !draft.base.isEmpty && !branches.contains(draft.base) { branches.append(draft.base) }
            if draft.branch.isEmpty {
                var index = 1
                while branches.contains("worktree\(index)") { index += 1 }
                draft.branch = "worktree\(index)"
            }
        } catch { if !Task.isCancelled && self.generation == generation { self.error = error.localizedDescription } }
    }
    func resolve() async {
        guard let project, let operations, !resolving else { return }
        let raw = safeWebURL(draft.branch) != nil ? draft.branch : draft.url
        resolving = true; error = nil
        draft.url = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        defer { resolving = false }
        do {
            let resolved = try await operations.resolvePage(raw, project: project, draft: draft)
            guard projectID == project.id else { return }
            draft = resolved
        } catch { self.error = error.localizedDescription }
    }
    func create() async {
        guard canCreate, let project, let operations else { return }
        creating = true; error = nil
        defer { creating = false }
        if safeWebURL(draft.branch) != nil {
            await resolve()
            if error != nil { return }
        }
        do {
            let session = try await operations.create(project: project, draft: draft)
            didCreate(session); completed = true
        } catch { self.error = error.localizedDescription }
    }
}
