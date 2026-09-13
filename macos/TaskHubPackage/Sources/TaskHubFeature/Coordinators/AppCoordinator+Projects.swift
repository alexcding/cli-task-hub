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
        for id in removed.keys { projectCoordinators.removeValue(forKey: id) }
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
        let child = projectCoordinatorFactory.project(model: model)
        child.onAction = { [weak self, weak runtime, weak model] action in
            guard let self, let runtime, let model, projectCoordinators[id]?.model === model,
                  runtime.ownsProject(id) else { return }
            switch action {
            case .saved(let project, let source):
                guard project.id == id else { return }
                runtime.applyProjectSave(project, source: source)
            case .deleted(let deletedID):
                guard deletedID == id else { return }
                projectCoordinators.removeValue(forKey: id)
                runtime.applyProjectDeletion(id, model: model)
                if selection == .project(id) { navigate(to: .overview) }
            case .selectSection: break // Consumed by the project coordinator.
            }
        }
        projectCoordinators[id] = child
        return child
    }
}
