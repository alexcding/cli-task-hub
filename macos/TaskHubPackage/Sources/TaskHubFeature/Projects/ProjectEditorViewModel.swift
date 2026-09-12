import Foundation
import Observation

@MainActor @Observable final class ProjectEditorViewModel {
    let id: String?
    var draft: ProjectDraft
    private(set) var baseline: ProjectDraft
    private(set) var busy = false
    private(set) var error: String?
    private(set) var saved = false
    var confirmingDelete = false
    private var service: (any ProjectService)?
    private let chooseFolder: () async -> String?
    private let didSave: (Project) -> Void
    private let didDelete: (String) -> Void

    init(project: Project?, service: any ProjectService, chooseFolder: @escaping () async -> String?,
         didSave: @escaping (Project) -> Void, didDelete: @escaping (String) -> Void = { _ in }) {
        id = project?.id; draft = ProjectDraft(project); baseline = ProjectDraft(project)
        self.service = service; self.chooseFolder = chooseFolder; self.didSave = didSave; self.didDelete = didDelete
    }
    var dirty: Bool { draft != baseline }
    var canSave: Bool { service != nil && !busy && draft.validationError == nil && (id == nil || dirty) }
    func connect(_ service: (any ProjectService)?) { self.service = service }
    var ideChoices: [IDEChoice] {
        IDEChoice.all.contains(where: { $0.id == draft.ide }) ? IDEChoice.all : IDEChoice.all + [.init(id: draft.ide, title: draft.ide)]
    }
    func update(_ project: Project) {
        guard !dirty && !busy else { return }
        draft = ProjectDraft(project); baseline = draft
    }
    func revert() { guard !busy else { return }; draft = baseline; error = nil }
    func pickFolder() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        if let path = await chooseFolder() { draft.workspace = path; saved = false }
    }
    func detectRepository() async {
        guard !busy && !draft.workspace.isEmpty, let service else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let repo = try await service.detectRepository(draft.workspace)
            if repo.isEmpty { error = "No GitHub remote found in this workspace." }
            else { draft.repo = repo }
        } catch { self.error = error.localizedDescription }
    }
    func save() async {
        guard !busy, let service else { return }
        if let message = draft.validationError { error = message; return }
        busy = true; error = nil; saved = false
        defer { busy = false }
        do {
            let project = try await service.save(draft, id: id)
            draft = ProjectDraft(project); baseline = draft; saved = true
            didSave(project)
        } catch { self.error = error.localizedDescription }
    }
    func delete(confirmed: Bool) async {
        guard let id, !busy, confirmed, let service else { return }
        busy = true; error = nil
        defer { busy = false; confirmingDelete = false }
        do { try await service.delete(id); didDelete(id) }
        catch { self.error = error.localizedDescription }
    }
}
