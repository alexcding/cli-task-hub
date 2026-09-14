import Foundation

@MainActor protocol ProjectCoordinating: AnyObject {
    func ownsProject(_ id: String) -> Bool
    func applyProjectSave(_ project: Project, source: ProjectSaveSource)
    func applyProjectDeletion(_ id: String, model: ProjectPageViewModel)
}

extension AppCoordinator {
    var projectModels: [String: ProjectPageViewModel] { projectCoordinators.mapValues(\.model) }
    var projectCoordinator: ProjectCoordinator? {
        guard case .project(let id) = selection else { return nil }
        return projectCoordinators[id]
    }

    func removeMissingProjects(_ ids: Set<String>) -> [ProjectPageViewModel] {
        let removed = projectCoordinators.filter { !ids.contains($0.key) }
        for id in removed.keys { projectCoordinators.removeValue(forKey: id)?.retire() }
        if !removed.isEmpty { schedulePendingDeepLink() }
        return removed.values.map(\.model)
    }

    func prepareProject(_ project: Project, services: ProjectFeatureServices, factory: any ProjectFeatureFactory,
                        runtime: any ProjectCoordinating,
                        openPage: @escaping (OpenPageRequest) async throws -> Void) {
        if let existing = projectCoordinators[project.id] { existing.model.update(project); return }
        let model = factory.project(project, services: services, openPage: openPage)
        installProject(model, runtime: runtime)
    }

    @discardableResult func installProject(_ model: ProjectPageViewModel, runtime: (any ProjectCoordinating)?) -> ProjectCoordinator {
        let id = model.project.id
        if let existing = projectCoordinators[id], existing.model === model { return existing }
        projectCoordinators[id]?.retire()
        let child = projectCoordinatorFactory.project(model: model)
        let requiresRuntime = runtime != nil
        child.isOwned = { [weak self, weak runtime, weak model] in
            guard let self, let model else { return false }
            return projectCoordinators[id]?.model === model && (!requiresRuntime || runtime?.ownsProject(id) == true)
        }
        child.canPresent = { [weak self, weak runtime] in
            runtime?.ownsProject(id) == true && self?.selection == .project(id) && self?.canPresent == true
        }
        child.onAction = { [weak self, weak runtime, weak model] action in
            guard let self, let model, projectCoordinators[id]?.model === model else { return }
            if case .presentationEnded = action { schedulePendingDeepLink(); return }
            guard let runtime, runtime.ownsProject(id) else { return }
            switch action {
            case .saved(let project, let source):
                guard project.id == id else { return }
                runtime.applyProjectSave(project, source: source)
            case .deleted(let deletedID):
                guard deletedID == id else { return }
                projectCoordinators.removeValue(forKey: id)?.retire()
                runtime.applyProjectDeletion(id, model: model)
                if selection == .project(id) { navigate(to: .overview) }
                schedulePendingDeepLink()
            case .presentationEnded: break
            }
        }
        projectCoordinators[id] = child
        model.appearance = appearance
        model.active = selection == .project(id)
        schedulePendingDeepLink()
        return child
    }
}
