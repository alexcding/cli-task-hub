import Foundation

/// Serializes asynchronous document/terminal cleanup at AppKit's termination
/// boundary. Command-Q is still a hide command; only an updater restart or the
/// explicit tray Quit enters this transaction.
@MainActor public final class AppTerminationCoordinator {
    public enum Reason: Sendable { case quit, update }
    public enum Decision: Equatable { case hide, later, now }
    public private(set) var pending: Reason?
    public private(set) var approved = false
    private let prepare: (Reason) async throws -> Void
    private let finished: (Reason, Bool) -> Void
    private let failed: (Error) -> Void

    public init(prepare: @escaping (Reason) async throws -> Void,
                finished: @escaping (Reason, Bool) -> Void,
                failed: @escaping (Error) -> Void) {
        self.prepare = prepare; self.finished = finished; self.failed = failed
    }

    public func systemTermination(updateRequested: Bool) -> Decision {
        if approved { return .now }
        if pending == .update { return .later }
        guard pending == nil, updateRequested else { return .hide }
        begin(.update)
        return .later
    }

    public func quit() {
        guard !approved, pending == nil else { return }
        begin(.quit)
    }

    private func begin(_ reason: Reason) {
        pending = reason
        Task {
            do {
                try await prepare(reason)
                approved = true
                pending = nil
                finished(reason, true)
            } catch {
                pending = nil
                finished(reason, false)
                failed(error)
            }
        }
    }
}
