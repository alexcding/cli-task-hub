import Foundation
import Observation

@MainActor @Observable final class NewSessionViewModel {
    enum Action { case created(WorkspaceSession) }
    @ObservationIgnored var onAction: (Action) -> Void = { _ in }
    let projects: [Project]
    var projectID: String { didSet { if oldValue != projectID { requestReferences() } } }
    var draft = SessionDraft()
    private(set) var branches: [String] = []
    private(set) var loading = false
    private(set) var creating = false
    private(set) var resolving = false
    private(set) var completed = false
    private(set) var error: String?
    private var operations: (any SessionCreating)?
    private(set) var retired = false
    private var generation = UUID()
    private var resolutionGeneration = UUID()
    private var projectGeneration = UUID()
    @ObservationIgnored private var referenceTask: Task<Void, Never>? { didSet { oldValue?.cancel() } }
    init(projects: [Project], selectedProject: String, operations: (any SessionCreating)?) {
        self.projects = projects; self.projectID = selectedProject; self.operations = operations
    }
    private var active: Bool { !retired && !completed }
    var busy: Bool { loading || creating || resolving }
    var project: Project? { projects.first { $0.id == projectID } }
    var canCreate: Bool { active && operations != nil && !busy && project != nil && !draft.branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var canResolve: Bool { active && operations != nil && !busy && project != nil && (SessionPage.parse(draft.branch) != nil || SessionPage.parse(draft.url) != nil) }
    func editBranch(_ value: String) { draft.branch = value; draft.reuseWorktree = nil }
    private func requestReferences() {
        guard active else { return }
        projectGeneration = UUID()
        resolutionGeneration = UUID(); resolving = false
        cancelReferenceLoading()
        branches = []; draft.base = ""; draft.reuseWorktree = nil; error = nil
        loading = project != nil && operations != nil
        referenceTask = Task { [weak self] in await self?.loadReferences() }
    }
    func retire() {
        retired = true; operations = nil; onAction = { _ in }
        cancelReferenceLoading()
        resolutionGeneration = UUID(); resolving = false
    }
    func cancelReferenceLoading() { referenceTask = nil; generation = UUID(); loading = false }
    func loadReferences() async {
        guard active, !Task.isCancelled else { return }
        let generation = UUID(); self.generation = generation
        branches = []; draft.base = ""; draft.reuseWorktree = nil; error = nil
        loading = false
        guard let project, let operations else { return }
        loading = true
        defer { if self.generation == generation { loading = false } }
        do {
            let refs = try await operations.references(project)
            try Task.checkCancellation()
            guard active, self.generation == generation else { return }
            branches = refs.branches.map(\.name)
            draft.base = branches.contains("develop") ? "develop" : refs.defaultBranch
            if !draft.base.isEmpty && !branches.contains(draft.base) { branches.append(draft.base) }
            if draft.branch.isEmpty {
                var index = 1
                while branches.contains("worktree\(index)") { index += 1 }
                draft.branch = "worktree\(index)"
            }
        } catch { if active && !Task.isCancelled && self.generation == generation { self.error = error.localizedDescription } }
    }
    @discardableResult func resolve() async -> Bool {
        guard canResolve else { return false }
        return await resolvePage() != nil
    }
    private func resolvePage() async -> SessionDraft? {
        guard active, !Task.isCancelled, let project, let operations, !resolving else { return nil }
        let generation = UUID(); resolutionGeneration = generation
        let raw = safeWebURL(draft.branch) != nil ? draft.branch : draft.url
        resolving = true; error = nil
        draft.url = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedDraft = draft
        defer { if resolutionGeneration == generation { resolving = false } }
        do {
            let resolved = try await operations.resolvePage(raw, project: project, draft: requestedDraft, workflow: false)
            guard active, !Task.isCancelled, resolutionGeneration == generation,
                  projectID == project.id, draft == requestedDraft else { return nil }
            draft = resolved
            return resolved
        } catch {
            if active && !Task.isCancelled && resolutionGeneration == generation && draft == requestedDraft {
                self.error = error.localizedDescription
            }
            return nil
        }
    }
    func create() async {
        guard canCreate, !Task.isCancelled, let project, let operations else { return }
        let projectGeneration = projectGeneration
        var creationDraft = draft
        creating = true; error = nil
        defer { creating = false }
        if safeWebURL(draft.branch) != nil {
            guard let resolved = await resolvePage() else { return }
            creationDraft = resolved
        }
        guard active, !Task.isCancelled, self.projectGeneration == projectGeneration,
              projectID == project.id, draft == creationDraft else { return }
        do {
            let session = try await operations.create(project: project, draft: creationDraft, requireExactBranch: false)
            guard active else { return }
            completed = true
            onAction(.created(session))
        } catch { if active { self.error = error.localizedDescription } }
    }
}
