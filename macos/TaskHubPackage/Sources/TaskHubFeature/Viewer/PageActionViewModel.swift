import Foundation
import Observation

/// Per-surface navigation lifetime. Cancelling a page open does not undo an already
/// persisted tab or affect independent ticket mutations.
@MainActor @Observable final class PageActionViewModel {
    private(set) var opening: String?
    private(set) var error: String?
    @ObservationIgnored private let service: any PageActionServing
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var feedbackGeneration = UUID()
    @ObservationIgnored private var task: Task<Void, Never>? { didSet { oldValue?.cancel() } }

    init(service: any PageActionServing) { self.service = service }

    func open(_ request: OpenPageRequest) {
        guard opening != request.url else { return }
        let generation = UUID(), feedback = UUID()
        self.generation = generation; feedbackGeneration = feedback
        opening = request.url; error = nil
        let service = service
        task = Task { [weak self] in
            defer { if self?.generation == generation { self?.opening = nil; self?.task = nil } }
            do {
                try Task.checkCancellation()
                try await service.openPage(request)
            } catch {
                if !Task.isCancelled && self?.generation == generation && self?.feedbackGeneration == feedback {
                    self?.error = "Could not open ticket: \(error.localizedDescription)"
                }
            }
        }
    }
    func external(_ url: URL) {
        feedbackGeneration = UUID()
        error = service.openBrowser(url) ? nil : "macOS could not open the browser."
    }
    func copy(_ url: URL) {
        feedbackGeneration = UUID(); error = nil; service.copyLink(url.absoluteString)
    }
    func cancel() { generation = UUID(); task = nil; opening = nil }
    func waitForOpen() async { await task?.value }
}
