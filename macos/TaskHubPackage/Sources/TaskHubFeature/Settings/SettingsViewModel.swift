import Foundation
import Observation

@MainActor @Observable final class SettingsViewModel {
    enum Action: Equatable { case saved([String: String]) }
    @ObservationIgnored var onAction: (Action) -> Void = { _ in }
    private(set) var retired = false
    var section = SettingsSection.general
    let clis: CLISettingsViewModel
    let diagnostics: DiagnosticsViewModel
    let loginItem: LoginItemViewModel
    let fonts: FontSettingsViewModel
    let resources: ResourceUsageViewModel
    var draft = AppConfigDraft() {
        didSet { if oldValue != draft { revision += 1; saved = false } }
    }
    private(set) var loaded = false
    private(set) var saving = false
    private(set) var loading = false
    private(set) var saved = false
    private(set) var loadError: String?
    private(set) var saveError: String?
    var error: String? { saveError ?? loadError }
    private(set) var sounds: [ReviewSound] = []
    private var baseline = AppConfigDraft()
    @ObservationIgnored private var service: (any SettingsService)?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var connection = UUID()
    @ObservationIgnored private var readGeneration = UUID()

    init(clis: CLISettingsViewModel, diagnostics: DiagnosticsViewModel, loginItem: LoginItemViewModel, fonts: FontSettingsViewModel,
         resources: ResourceUsageViewModel) {
        self.clis = clis; self.diagnostics = diagnostics; self.loginItem = loginItem
        self.fonts = fonts
        self.resources = resources
    }
    var dirty: Bool { draft != baseline }
    var canSave: Bool { !retired && loaded && dirty && !saving && service != nil && draft.validationError == nil }
    func connect(_ service: any SettingsService) {
        guard !retired else { return }
        disconnect(); self.service = service
    }
    func refresh() {
        guard !retired, task == nil, !saving, let service else { return }
        loading = true
        let requestRevision = revision
        let requestConnection = connection
        let requestRead = readGeneration
        task = Task {
            defer { if readGeneration == requestRead { task = nil; loading = false } }
            do {
                async let soundRequest = try? service.sounds()
                let values = try await service.config()
                try Task.checkCancellation()
                guard connection == requestConnection, readGeneration == requestRead else { return }
                if revision == requestRevision && !dirty {
                    baseline = AppConfigDraft(values); draft = baseline
                }
                loaded = true; loadError = nil
                let sounds = await soundRequest
                try Task.checkCancellation()
                guard connection == requestConnection, readGeneration == requestRead else { return }
                if let sounds { self.sounds = sounds }
            } catch {
                if !Task.isCancelled && connection == requestConnection && readGeneration == requestRead { loadError = error.localizedDescription }
            }
        }
    }
    func save() async {
        guard !retired, loaded, !saving, let service else { return }
        if let error = draft.validationError { saveError = error; return }
        let sent = AppConfigDraft(draft.values)
        let patch = sent.values.filter { baseline.values[$0.key] != $0.value }
        guard !patch.isEmpty else { return }
        let requestConnection = connection
        cancelRead()
        revision += 1; saving = true; saveError = nil; saved = false
        defer { saving = false }
        do {
            try await service.save(patch)
            guard connection == requestConnection else { return }
            baseline = sent
            // Preserve any newer edit made while the request was in flight.
            if draft.values == sent.values { draft = sent }
            saved = true
            onAction(.saved(patch))
        } catch { if connection == requestConnection { saveError = error.localizedDescription } }
    }
    func revert() { guard !retired, !saving else { return }; draft = baseline; saved = false; saveError = nil; loadError = nil }
    private func disconnect() {
        connection = UUID(); cancelRead(); service = nil
    }
    private func cancelRead() { readGeneration = UUID(); task?.cancel(); task = nil; loading = false }
    func retire() { retired = true; onAction = { _ in }; disconnect() }
    func stop() async {
        let read = task; disconnect(); diagnostics.stop()
        resources.stop()
        let cliReads = clis.disconnect()
        await loginItem.stop()
        await fonts.stop()
        await read?.value
        for task in cliReads { await task.value }
    }
}
