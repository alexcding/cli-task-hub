import Foundation
import Observation

@MainActor @Observable final class AddPageViewModel {
    var address = "https://"
    private(set) var error: String?
    @ObservationIgnored private let openPage: (String) -> Bool
    @ObservationIgnored private let didOpen: () -> Void

    init(openPage: @escaping (String) -> Bool, didOpen: @escaping () -> Void) {
        self.openPage = openPage; self.didOpen = didOpen
    }
    private var trimmedAddress: String { address.trimmingCharacters(in: .whitespacesAndNewlines) }
    var canOpen: Bool { safeWebURL(trimmedAddress) != nil }

    func open() {
        guard canOpen else { error = "Enter an HTTP or HTTPS address."; return }
        guard openPage(trimmedAddress) else { error = "Could not open the page. The workspace may have closed."; return }
        error = nil
        didOpen()
    }
}
