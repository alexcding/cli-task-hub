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

@MainActor @Observable final class SettingsCoordinator: Coordinatable {
    var root: Destination = .none
    var path: [Destination] = []
    @ObservationIgnored var action: ((Action) -> Void)?

    let model: SettingsViewModel
    let shell: ShellStore
    private(set) var retired = false
    @ObservationIgnored private weak var runtime: (any SettingsCoordinating)?
    @ObservationIgnored var isOwned: () -> Bool = { true }
    @ObservationIgnored var canPresent: () -> Bool = { true }
    @ObservationIgnored private var completion: Task<Void, Never>?
    init(model: SettingsViewModel, shell: ShellStore = ShellStore(), runtime: any SettingsCoordinating) {
        self.model = model; self.shell = shell; self.runtime = runtime
        root = .settings(model, shell)
        model.onAction = { [weak self] in self?.handle($0) }
    }
    func makeDestination(for route: Route) -> Destination { .none }
    func handle(_ action: Action) {
        if case .settings(let action) = action { handle(action) } else { self.action?(action) }
    }
    func handle(_ action: SettingsViewModel.Action) {
        guard !retired, isOwned(), runtime != nil else { return }
        switch action {
        case .loginItem(let action):
            guard model.active, model.section == .system, canPresent() else { return }
            model.loginItem.perform(action)
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
        if value {
            guard let runtime else { return }
            runtime.activateSettings()
        }
        model.setActive(value)
    }
    func waitForCompletion() async { await completion?.value }
    func cancelNavigation() { model.loginItem.cancelSettingsOpen() }
    func retire() {
        retired = true; isOwned = { false }; canPresent = { false }; completion?.cancel(); completion = nil
        runtime = nil; model.retire()
        Task { await model.stop() }
    }
}

extension AppCoordinator {
    @discardableResult func installSettings(_ model: SettingsViewModel, shell: ShellStore = ShellStore(), runtime: any SettingsCoordinating) -> SettingsCoordinator {
        if let existing = settingsCoordinator, existing.model === model { return existing }
        model.loginItem.inheritRegistration(from: settingsCoordinator?.model.loginItem)
        settingsCoordinator?.retire()
        let child = SettingsCoordinator(model: model, shell: shell, runtime: runtime)
        child.isOwned = { [weak self, weak model] in
            guard let self, let model else { return false }
            return settingsCoordinator?.model === model
        }
        child.canPresent = { [weak self] in
            self?.selection == .settings && self?.canPresent == true && self?.canOpenExternalRoute() == true
        }
        settingsCoordinator = child
        child.setActive(selection == .settings)
        refreshRoot()
        return child
    }
    func makeSettings(factory: any SettingsFeatureFactory, shell: ShellStore = ShellStore(), runtime: any SettingsCoordinating) -> SettingsViewModel {
        installSettings(factory.settings(), shell: shell, runtime: runtime).model
    }
}
