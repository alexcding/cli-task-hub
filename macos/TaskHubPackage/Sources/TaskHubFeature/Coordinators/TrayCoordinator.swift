import Foundation
import Observation

@MainActor protocol TrayFeatureFactory {
    func tray(service: any TrayServing, shell: ShellStore) -> TrayViewModel
}

@MainActor struct NativeTrayFeatureFactory: TrayFeatureFactory {
    func tray(service: any TrayServing, shell: ShellStore) -> TrayViewModel {
        TrayViewModel(service: service, shell: shell)
    }
}

@MainActor protocol TrayCoordinating: TrayServing {
    func selectTrayDestination(_ destination: SidebarDestination)
}

@MainActor struct TrayPresentation {
    let openWindow: () -> Void
    let dismiss: () -> Void
    let quit: () -> Void
}

@MainActor @Observable public final class TrayCoordinator {
    public let model: TrayViewModel
    private(set) var retired = false
    @ObservationIgnored var isOwned: () -> Bool = { true }
    @ObservationIgnored private var presentation: TrayPresentation?
    @ObservationIgnored private weak var runtime: (any TrayCoordinating)?
    @ObservationIgnored private let desktop: any DesktopActions

    init(model: TrayViewModel, runtime: any TrayCoordinating, desktop: any DesktopActions, presentation: TrayPresentation) {
        self.model = model; self.runtime = runtime; self.desktop = desktop; self.presentation = presentation
        model.onAction = { [weak self] in self?.handle($0) }
    }
    public func setActive(_ value: Bool) {
        guard !retired, isOwned() else { return }
        model.setActive(value)
    }
    func handle(_ action: TrayViewModel.Action) {
        guard !retired, isOwned(), model.available, model.active, let runtime, let presentation else { return }
        switch action {
        case .refresh: model.performRefresh()
        case .openReview(let id):
            guard let review = model.review(for: id), let url = review.webURL else { return }
            let opened = desktop.openBrowser(url)
            model.reviewDidOpen(review, success: opened)
            guard opened else { return }
            model.setActive(false); presentation.dismiss()
        case .openTab(let id):
            guard let destination = model.destination(for: id) else { return }
            runtime.selectTrayDestination(destination)
            model.setActive(false); presentation.openWindow()
        case .openWindow: model.setActive(false); presentation.openWindow()
        case .quit: model.setActive(false); presentation.quit()
        }
    }
    func retire() {
        retired = true; isOwned = { false }; presentation = nil; runtime = nil; model.retire()
    }
}

extension AppCoordinator {
    func makeTray(factory: any TrayFeatureFactory, runtime: any TrayCoordinating, shell: ShellStore,
                  desktop: any DesktopActions, presentation: TrayPresentation) -> TrayCoordinator {
        trayCoordinator?.retire()
        let model = factory.tray(service: runtime, shell: shell)
        let child = TrayCoordinator(model: model, runtime: runtime, desktop: desktop, presentation: presentation)
        child.isOwned = { [weak self, weak model] in
            guard let self, let model else { return false }
            return trayCoordinator?.model === model
        }
        trayCoordinator = child
        return child
    }
}
