import Foundation
import Observation

@MainActor @Observable final class AddPageViewModel {
    enum Action { case opened }
    @ObservationIgnored var onAction: (Action) -> Void = { _ in }
    var address = "https://"
    private(set) var error: String?
    @ObservationIgnored private let openPage: (String) -> Bool
    private(set) var completed = false
    private(set) var retired = false

    init(openPage: @escaping (String) -> Bool) {
        self.openPage = openPage
    }
    private var trimmedAddress: String { address.trimmingCharacters(in: .whitespacesAndNewlines) }
    var canOpen: Bool { !retired && !completed && safeWebURL(trimmedAddress) != nil }

    func retire() { retired = true; onAction = { _ in } }

    func open() {
        guard !retired && !completed else { return }
        guard canOpen else { error = "Enter an HTTP or HTTPS address."; return }
        guard openPage(trimmedAddress) else { error = "Could not open the page. The workspace may have closed."; return }
        error = nil
        completed = true
        onAction(.opened)
    }
}
