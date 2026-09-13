import Foundation
import Observation

@MainActor protocol DashboardFeatureFactory {
    func dashboard(pageActions: any PageActionServing) -> DashboardViewModel
}

@MainActor struct NativeDashboardFeatureFactory: DashboardFeatureFactory {
    func dashboard(pageActions: any PageActionServing) -> DashboardViewModel { DashboardViewModel(pageActions: pageActions) }
}

@MainActor @Observable final class DashboardCoordinator {
    let model: DashboardViewModel
    private(set) var retired = false
    @ObservationIgnored var isOwned: () -> Bool = { true }
    @ObservationIgnored var canPresent: () -> Bool = { true }

    init(model: DashboardViewModel) {
        self.model = model
        model.onAction = { [weak self] in self?.handle($0) }
    }
    func handle(_ action: DashboardViewModel.Action) {
        guard !retired, isOwned(), canPresent() else { return }
        model.perform(action)
    }
    func retire() { retired = true; isOwned = { false }; canPresent = { false }; model.retire() }
}

extension AppCoordinator {
    @discardableResult func installDashboard(_ model: DashboardViewModel) -> DashboardCoordinator {
        if let existing = dashboardCoordinator, existing.model === model { return existing }
        dashboardCoordinator?.retire()
        let child = DashboardCoordinator(model: model)
        child.isOwned = { [weak self, weak model] in
            guard let self, let model else { return false }
            return dashboardCoordinator?.model === model
        }
        child.canPresent = { [weak self] in
            self?.selection == .overview && self?.canPresent == true && self?.canOpenExternalRoute() == true
        }
        dashboardCoordinator = child
        return child
    }

    func makeDashboard(factory: any DashboardFeatureFactory, pageActions: any PageActionServing) -> DashboardViewModel {
        installDashboard(factory.dashboard(pageActions: pageActions)).model
    }
}
