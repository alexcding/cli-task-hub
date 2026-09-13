import Foundation
import Observation

@MainActor @Observable final class LoginItemViewModel {
    private(set) var state: LoginItemState?
    private(set) var loading = false
    private(set) var changing = false
    private(set) var error: String?
    @ObservationIgnored private let service: any LoginItemService
    @ObservationIgnored private var read: Task<Void, Never>?
    @ObservationIgnored private var mutation: Task<Void, Never>?
    @ObservationIgnored private var revision = UUID()

    init(service: any LoginItemService) { self.service = service }
    var registered: Bool { state?.registered == true }
    var needsApproval: Bool { state?.status == .requiresApproval }
    var canToggle: Bool {
        guard let state, !loading, !changing else { return false }
        return state.registered || (state.registrationUnavailableReason == nil && state.status == .notRegistered)
    }
    var statusText: String {
        guard let state else { return "Checking login-item status…" }
        switch state.status {
        case .notRegistered: return "Off"
        case .enabled: return "Enabled"
        case .requiresApproval: return "Registered; approval required in System Settings."
        case .notFound: return "macOS could not find this login item. Reinstall the packaged app."
        case .unknown: return "macOS returned an unknown login-item status."
        }
    }
    func refresh() {
        guard read == nil, !changing else { return }
        loading = true
        let requestRevision = revision
        read = Task {
            let result = await service.state()
            guard !Task.isCancelled, revision == requestRevision else { return }
            if state?.status != result.status { error = nil }
            state = result; loading = false; read = nil
        }
    }
    func setEnabled(_ enabled: Bool) {
        guard canToggle, enabled != registered else { return }
        revision = UUID(); read?.cancel(); read = nil; loading = false
        changing = true; error = nil
        mutation = Task {
            do { try await service.setEnabled(enabled) }
            catch { self.error = error.localizedDescription }
            // Even a failed registration can change approval state. Read the OS
            // after both success and failure rather than optimistically flipping.
            state = await service.state()
            changing = false; mutation = nil
        }
    }
    func openSystemSettings() { Task { await service.openSystemSettings() } }
    func cancelRead() -> Task<Void, Never>? {
        revision = UUID(); read?.cancel(); read = nil; loading = false
        return mutation
    }
    func stop() async { await cancelRead()?.value }
}
