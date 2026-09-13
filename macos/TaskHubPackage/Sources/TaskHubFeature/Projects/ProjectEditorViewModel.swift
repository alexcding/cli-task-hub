import Foundation
import Observation

@MainActor @Observable final class ProjectEditorViewModel {
    enum Action: Equatable { case saved(Project), deleted(String) }
    @ObservationIgnored var onAction: (Action) -> Void = { _ in }
    let id: String?
    var draft: ProjectDraft
    private(set) var baseline: ProjectDraft
    private(set) var busy = false
    private(set) var error: String?
    private(set) var saved = false
    private(set) var retired = false
    private var completedCreation = false
    private var generation = UUID()
    var confirmingDelete = false
    private var service: (any ProjectService)?
    private let chooseFolder: () async -> String?

    init(project: Project?, service: any ProjectService, chooseFolder: @escaping () async -> String?) {
        id = project?.id; draft = ProjectDraft(project); baseline = ProjectDraft(project)
        self.service = service; self.chooseFolder = chooseFolder
    }
    var dirty: Bool { draft != baseline }
    private var active: Bool { !retired && !completedCreation }
    var canSave: Bool { active && service != nil && !busy && draft.validationError == nil && (id == nil || dirty) }
    func connect(_ service: (any ProjectService)?) {
        guard !retired else { return }
        if service == nil { generation = UUID() }
        self.service = service
    }
    func retire() {
        retired = true; service = nil; generation = UUID()
        onAction = { _ in }; confirmingDelete = false
    }
    var ideChoices: [IDEChoice] {
        IDEChoice.all.contains(where: { $0.id == draft.ide }) ? IDEChoice.all : IDEChoice.all + [.init(id: draft.ide, title: draft.ide)]
    }
    func update(_ project: Project) {
        guard active && !dirty && !busy else { return }
        draft = ProjectDraft(project); baseline = draft
    }
    func revert() { guard active && !busy else { return }; draft = baseline; error = nil }
    func pickFolder() async {
        guard active, !Task.isCancelled, !busy else { return }
        let generation = generation
        busy = true
        defer { busy = false }
        if let path = await chooseFolder(), active, !Task.isCancelled, self.generation == generation {
            draft.workspace = path; saved = false
        }
    }
    func detectRepository() async {
        guard active, !Task.isCancelled, !busy && !draft.workspace.isEmpty, let service else { return }
        let generation = generation, workspace = draft.workspace
        busy = true; error = nil
        defer { busy = false }
        do {
            let repo = try await service.detectRepository(workspace)
            guard active, !Task.isCancelled, self.generation == generation, draft.workspace == workspace else { return }
            if repo.isEmpty { error = "No GitHub remote found in this workspace." }
            else { draft.repo = repo }
        } catch {
            if active && !Task.isCancelled && self.generation == generation && draft.workspace == workspace {
                self.error = error.localizedDescription
            }
        }
    }
    func save() async {
        guard active, !Task.isCancelled, !busy, let service else { return }
        let generation = generation
        if let message = draft.validationError { error = message; return }
        busy = true; error = nil; saved = false
        defer { busy = false }
        do {
            let project = try await service.save(draft, id: id)
            guard active, self.generation == generation else { return }
            draft = ProjectDraft(project); baseline = draft; saved = true
            completedCreation = id == nil
            onAction(.saved(project))
        } catch { if active && self.generation == generation { self.error = error.localizedDescription } }
    }
    func delete(confirmed: Bool) async {
        guard active, !Task.isCancelled, let id, !busy, confirmed, let service else { return }
        let generation = generation
        busy = true; error = nil
        defer { busy = false; confirmingDelete = false }
        do {
            try await service.delete(id)
            guard active, self.generation == generation else { return }
            let action = onAction
            retire()
            action(.deleted(id))
        } catch { if active && self.generation == generation { self.error = error.localizedDescription } }
    }
}
