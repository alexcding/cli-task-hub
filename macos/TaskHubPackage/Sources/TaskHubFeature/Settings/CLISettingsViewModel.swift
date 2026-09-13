import Foundation
import Observation

@MainActor @Observable final class CLISettingsViewModel {
    private(set) var availability: [String: CLIAvailability] = [:]
    private(set) var hooks: [String: String] = [:]
    private(set) var probing = false
    private(set) var loadingHooks = false
    private(set) var changing: ManagedCLI?
    private(set) var probeError: String?
    private(set) var hookError: String?
    private(set) var message: String?
    @ObservationIgnored private var service: (any CLISettingsService)?
    @ObservationIgnored private var probeTask: Task<Void, Never>?
    @ObservationIgnored private var hookTask: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private let copy: (String) -> Void
    @ObservationIgnored private let openBrowser: (URL) -> Bool

    init(copy: @escaping (String) -> Void, openBrowser: @escaping (URL) -> Bool) { self.copy = copy; self.openBrowser = openBrowser }
    func connect(_ service: any CLISettingsService) { _ = disconnect(); self.service = service }
    func label(_ cli: ManagedCLI) -> String { availability[cli.rawValue]?.label(for: cli) ?? (probing ? "Checking…" : "Not checked") }
    func hookLabel(_ cli: ManagedCLI) -> String {
        guard let status = hooks[cli.rawValue] else { return loadingHooks ? "Checking…" : "Not checked" }
        return status == "installed" ? "Installed" : "Not installed"
    }
    func canChange(_ cli: ManagedCLI) -> Bool {
        cli.supportsHooks && service != nil && changing == nil && hooks[cli.rawValue] != nil
    }
    func refresh() {
        guard let service else { return }
        let requestGeneration = generation
        if probeTask == nil {
            probing = true
            probeTask = Task {
                defer { if generation == requestGeneration { probeTask = nil; probing = false } }
                do {
                    let result = try await service.probe()
                    try Task.checkCancellation()
                    guard generation == requestGeneration else { return }
                    availability = result; probeError = nil
                } catch { if !Task.isCancelled && generation == requestGeneration { probeError = error.localizedDescription } }
            }
        }
        if hookTask == nil && changing == nil {
            loadingHooks = true
            hookTask = Task {
                defer { if generation == requestGeneration { hookTask = nil; loadingHooks = false } }
                do {
                    let result = try await service.hooks()
                    try Task.checkCancellation()
                    guard generation == requestGeneration else { return }
                    hooks = result; hookError = nil
                } catch { if !Task.isCancelled && generation == requestGeneration { hookError = error.localizedDescription } }
            }
        }
    }
    func toggleHook(_ cli: ManagedCLI) async {
        guard canChange(cli), let service else { return }
        let installed = hooks[cli.rawValue] != "installed"
        let requestGeneration = generation
        changing = cli; hookError = nil; message = nil
        defer { changing = nil }
        // A read started before this edit must not replace its returned status.
        hookTask?.cancel(); await hookTask?.value
        guard requestGeneration == generation else { return }
        do {
            let result = try await service.setHook(cli, installed: installed)
            guard requestGeneration == generation else { return }
            hooks = result
            message = "\(cli.title) hooks \(installed ? "installed" : "removed")."
        } catch { if requestGeneration == generation { hookError = error.localizedDescription } }
    }
    func copyLogin(_ cli: ManagedCLI) { if let command = cli.loginCommand { copy(command) } }
    func openGuide(_ cli: ManagedCLI) {
        if !openBrowser(cli.installationGuide) { probeError = "macOS could not open the installation guide." }
    }
    func disconnect() -> [Task<Void, Never>] {
        let reads = [probeTask, hookTask].compactMap { $0 }
        generation = UUID(); probeTask?.cancel(); hookTask?.cancel()
        probeTask = nil; hookTask = nil; probing = false; loadingHooks = false; service = nil
        return reads
    }
    func stop() async {
        for task in disconnect() { await task.value }
    }
}
