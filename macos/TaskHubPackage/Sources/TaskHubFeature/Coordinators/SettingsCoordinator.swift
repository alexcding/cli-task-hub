import Foundation
import Observation

@MainActor protocol SettingsFeatureFactory { func settings() -> SettingsViewModel }

@MainActor struct NativeSettingsFeatureFactory: SettingsFeatureFactory {
    let desktop: any DesktopActions
    let copy: (String) -> Void
    var loginItem: any LoginItemService = NativeLoginItemService()
    var fontCatalog: any CodeFontCatalog = InstalledCodeFontCatalog()

    func settings() -> SettingsViewModel {
        SettingsViewModel(clis: CLISettingsViewModel(copy: copy, openBrowser: desktop.openBrowser), diagnostics: DiagnosticsViewModel(),
            loginItem: LoginItemViewModel(service: loginItem), fonts: FontSettingsViewModel(catalog: fontCatalog),
            resources: ResourceUsageViewModel())
    }
}

@MainActor protocol SettingsCoordinating: AnyObject {
    func applySettingsSave(_ patch: [String: String]) async
    func activateSettings()
}

@MainActor @Observable final class SettingsCoordinator {
    let model: SettingsViewModel
    private(set) var retired = false
    @ObservationIgnored private weak var runtime: (any SettingsCoordinating)?
    @ObservationIgnored var isOwned: () -> Bool = { true }
    @ObservationIgnored var canPresent: () -> Bool = { true }
    @ObservationIgnored private var completion: Task<Void, Never>?
    init(model: SettingsViewModel, runtime: any SettingsCoordinating) {
        self.model = model; self.runtime = runtime
        model.onAction = { [weak self] in self?.handle($0) }
    }
    func handle(_ action: SettingsViewModel.Action) {
        guard !retired, isOwned() else { return }
        switch action {
        case .cli(let action):
            guard model.active, model.section == .clis, canPresent() else { return }
            model.clis.perform(action)
        case .saved(let patch):
            let previous = completion
            completion = Task { [weak self] in
                await previous?.value
                guard let self, !Task.isCancelled, !retired, isOwned() else { return }
                // Saving connections applies even if the user has since left Settings.
                await runtime?.applySettingsSave(patch)
            }
        }
    }
    func setActive(_ value: Bool) {
        guard !retired, isOwned(), model.active != value else { return }
        if value { runtime?.activateSettings() }
        model.setActive(value)
    }
    func waitForCompletion() async { await completion?.value }
    func retire() {
        retired = true; isOwned = { false }; canPresent = { false }; completion?.cancel(); completion = nil
        runtime = nil; model.retire()
        Task { await model.stop() }
    }
}

extension AppCoordinator {
    @discardableResult func installSettings(_ model: SettingsViewModel, runtime: any SettingsCoordinating) -> SettingsCoordinator {
        if let existing = settingsCoordinator, existing.model === model { return existing }
        settingsCoordinator?.retire()
        let child = SettingsCoordinator(model: model, runtime: runtime)
        child.isOwned = { [weak self, weak model] in
            guard let self, let model else { return false }
            return settingsCoordinator?.model === model
        }
        child.canPresent = { [weak self] in
            self?.selection == .settings && self?.canPresent == true && self?.canOpenExternalRoute() == true
        }
        settingsCoordinator = child
        child.setActive(selection == .settings)
        return child
    }
    func makeSettings(factory: any SettingsFeatureFactory, runtime: any SettingsCoordinating) -> SettingsViewModel {
        installSettings(factory.settings(), runtime: runtime).model
    }
}
