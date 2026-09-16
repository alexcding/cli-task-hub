import Foundation
import Observation

@MainActor @Observable final class AddPageViewModel {
    enum Action { case opened }
    @ObservationIgnored var onAction: (Action) -> Void = { _ in }
    var address = ""
    private(set) var error: String?
    @ObservationIgnored private let openPage: (String) -> Bool
    private(set) var completed = false
    private(set) var retired = false

    init(openPage: @escaping (String) -> Bool) {
        self.openPage = openPage
    }
    private var url: URL? { webAddress(address) }
    var canOpen: Bool { !retired && !completed && url != nil }

    func retire() { retired = true; onAction = { _ in } }

    func open() {
        guard !retired && !completed else { return }
        guard canOpen, let url else { error = "Enter a web address, like example.com."; return }
        guard openPage(url.absoluteString) else { error = "Could not open the page. The workspace may have closed."; return }
        error = nil
        completed = true
        onAction(.opened)
    }
}
