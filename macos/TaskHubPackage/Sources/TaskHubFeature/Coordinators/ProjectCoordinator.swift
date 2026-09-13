import Observation

@MainActor protocol ProjectCoordinatorFactory {
    func project(model: ProjectPageViewModel) -> ProjectCoordinator
}

@MainActor struct NativeProjectCoordinatorFactory: ProjectCoordinatorFactory {
    func project(model: ProjectPageViewModel) -> ProjectCoordinator { ProjectCoordinator(model: model) }
}

/// Consumes the project-owned remainder after the root has selected its project.
@MainActor @Observable final class ProjectCoordinator {
    let model: ProjectPageViewModel
    init(model: ProjectPageViewModel) { self.model = model }

    @discardableResult func navigate(to deepLink: DeepLink) -> Bool {
        guard deepLink.routes.count == 1, case .projectSection(let section) = deepLink.first else { return false }
        model.section = section
        return true
    }
}
