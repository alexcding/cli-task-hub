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
    @ObservationIgnored var onAction: (ProjectPageViewModel.Action) -> Void = { _ in }
    init(model: ProjectPageViewModel) {
        self.model = model
        model.onAction = { [weak self] in self?.handle($0) }
    }

    func handle(_ action: ProjectPageViewModel.Action) {
        switch action {
        case .selectSection(let section): model.setSection(section)
        case .saved, .deleted: onAction(action)
        }
    }

    @discardableResult func navigate(to deepLink: DeepLink) -> Bool {
        guard deepLink.routes.count == 1, case .projectSection(let section) = deepLink.first else { return false }
        handle(.selectSection(section))
        return true
    }
}
