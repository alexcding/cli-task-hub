import Foundation
import Observation

@MainActor struct TrayState {
    var connection = "Connecting"
    var tabs: [SavedTab] = []
    var sessions: [WorkspaceSession] = []
    var reviews: [TrayPR] = []
    var acknowledging: Set<String> = []
    var canNavigate = false
}

@MainActor protocol TrayServing: AnyObject {
    func trayState() -> TrayState
    func refreshTray()
    func acknowledgeTrayReview(_ review: TrayPR)
}

@MainActor @Observable public final class TrayViewModel {
    enum Action: Equatable { case refresh, openReview(String), openTab(String), openWindow }
    let shell: ShellStore
    @ObservationIgnored var onAction: (Action) -> Void = { _ in }
    @ObservationIgnored private weak var service: (any TrayServing)?
    private(set) var retired = false
    private(set) var active = false {
        didSet { if oldValue != active && active { refresh() } }
    }
    private(set) var actionError: String?

    init(service: any TrayServing, shell: ShellStore) {
        self.service = service; self.shell = shell
    }
    private var state: TrayState { service?.trayState() ?? TrayState() }
    var available: Bool { !retired && service != nil }
    var connection: String { state.connection }
    var pendingReviews: [TrayPR] { state.reviews.filter(\.pendingReview) }
    var tabGroups: [TrayTabGroup] { TrayTabGroup.make(tabs: state.tabs, prs: state.reviews) }
    var canNavigate: Bool { available && active && state.canNavigate }
    func canOpen(_ review: TrayPR) -> Bool {
        available && active && review.pendingReview
            && review.webURL != nil && !state.acknowledging.contains(review.id)
    }
    func setActive(_ value: Bool) { if !retired { active = value } }
    func refresh() { request(.refresh) }
    func openReview(_ review: TrayPR) { request(.openReview(review.id)) }
    func openTab(_ tab: SavedTab) { request(.openTab(tab.id)) }
    func openWindow() { request(.openWindow) }
    private func request(_ action: Action) { if available && active { onAction(action) } }

    func performRefresh() { if available { service?.refreshTray() } }
    func review(for id: String) -> TrayPR? {
        guard let review = pendingReviews.first(where: { $0.id == id }), canOpen(review) else { return nil }
        return review
    }
    func reviewDidOpen(_ review: TrayPR, success: Bool) {
        guard available else { return }
        guard success else { actionError = "macOS could not open the browser."; return }
        actionError = nil
        service?.acknowledgeTrayReview(review)
    }
    func destination(for id: String) -> SidebarDestination? {
        guard canNavigate else { return nil }
        let state = state
        guard let tab = state.tabs.first(where: { $0.id == id }), safeWebURL(tab.url) != nil else { return nil }
        if let session = state.sessions.first(where: { $0.url == tab.url }) { return .session(session.id) }
        return .tab(tab.url)
    }
    func retire() { active = false; retired = true; onAction = { _ in }; service = nil }
}
