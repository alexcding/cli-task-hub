import Foundation
import Observation

@MainActor @Observable final class SettingsViewModel {
    var section = SettingsSection.general
    let clis: CLISettingsViewModel
    let diagnostics: DiagnosticsViewModel
    var draft = AppConfigDraft()
    private(set) var loaded = false
    private(set) var saving = false
    private(set) var loading = false
    private(set) var saved = false
    private(set) var error: String?
    private(set) var sounds: [ReviewSound] = []
    private var baseline = AppConfigDraft()
    @ObservationIgnored private var service: (any SettingsService)?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var connection = UUID()
    @ObservationIgnored private let didSave: ([String: String]) async -> Void

    init(clis: CLISettingsViewModel, diagnostics: DiagnosticsViewModel, didSave: @escaping ([String: String]) async -> Void) {
        self.clis = clis; self.diagnostics = diagnostics; self.didSave = didSave
    }
    var dirty: Bool { draft != baseline }
    var canSave: Bool { loaded && dirty && !saving && service != nil && draft.validationError == nil }
    func connect(_ service: any SettingsService) { self.service = service }
    func refresh() {
        guard task == nil, !saving, let service else { return }
        loading = true
        let requestRevision = revision
        task = Task {
            defer { task = nil; loading = false }
            do {
                async let soundRequest = try? service.sounds()
                let values = try await service.config()
                try Task.checkCancellation()
                if revision == requestRevision && !dirty {
                    baseline = AppConfigDraft(values); draft = baseline
                }
                loaded = true; error = nil
                let sounds = await soundRequest
                try Task.checkCancellation()
                if let sounds { self.sounds = sounds }
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
    func save() async {
        guard loaded, !saving, let service else { return }
        if let error = draft.validationError { self.error = error; return }
        let sent = AppConfigDraft(draft.values)
        let patch = sent.values.filter { baseline.values[$0.key] != $0.value }
        guard !patch.isEmpty else { return }
        let requestConnection = connection
        revision += 1; saving = true; error = nil; saved = false
        defer { saving = false }
        do {
            try await service.save(patch)
            guard connection == requestConnection else { return }
            baseline = sent; saved = true
            // Preserve any newer edit made while the request was in flight.
            if draft.values == sent.values { draft = sent }
            await didSave(patch)
        } catch { if connection == requestConnection { self.error = error.localizedDescription } }
    }
    func revert() { draft = baseline; saved = false; error = nil }
    func stop() async {
        connection = UUID(); task?.cancel(); diagnostics.stop()
        await task?.value; await clis.stop(); service = nil
    }
}
