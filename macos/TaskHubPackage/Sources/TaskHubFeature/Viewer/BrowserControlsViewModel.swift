import Foundation
import Observation

@MainActor protocol BrowserControlling: AnyObject {
    var url: String { get }
    var loading: Bool { get }
    var canGoBack: Bool { get }
    var canGoForward: Bool { get }
    var error: String? { get }
    var found: Bool? { get }
    func navigate(_ address: String)
    func back()
    func forward()
    func reload()
    func stop()
    func zoom(_ delta: Double?)
    func find(_ text: String, backwards: Bool)
}

@MainActor @Observable final class BrowserControlsViewModel {
    enum Action {
        case navigate(URL), back, forward, reload, stop, zoom(Double?), find(String, backwards: Bool), openExternally
    }
    enum ActionError {
        case invalidAddress, externalBrowser
        var message: String {
            switch self {
            case .invalidAddress: "Enter an HTTP or HTTPS address."
            case .externalBrowser: "Could not open this page in the default browser."
            }
        }
    }
    var address: String
    var active = false {
        didSet { if oldValue != active && !active { editingAddress = false } }
    }
    private(set) var editingAddress = false {
        didSet { if oldValue != editingAddress && !editingAddress { synchronizeAddress() } }
    }
    private(set) var actionError: ActionError?
    // The page owns its controls. Controls must not keep a closed page alive.
    @ObservationIgnored private weak var page: (any BrowserControlling)?
    @ObservationIgnored var onAction: ((Action) -> Void)?
    @ObservationIgnored var bindingID = UUID()

    init(page: any BrowserControlling) {
        self.page = page; address = page.url
    }

    var loading: Bool { page?.loading == true }
    var canGoBack: Bool { active && page?.canGoBack == true }
    var canGoForward: Bool { active && page?.canGoForward == true }
    var found: Bool? { page?.found }
    var error: String? { actionError?.message ?? page?.error }
    var canOpenExternally: Bool { active && page.flatMap { safeWebURL($0.url) } != nil }

    func setEditingAddress(_ value: Bool) { editingAddress = value }
    func synchronizeAddress() {
        guard !editingAddress, let page else { return }
        address = page.url
    }

    @discardableResult func submitAddress() -> Bool {
        guard active, page != nil, onAction != nil else { return false }
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = safeWebURL(trimmed) else {
            actionError = .invalidAddress
            return false
        }
        actionError = nil
        address = trimmed
        perform(.navigate(url))
        return true
    }

    func back() { perform(.back) }
    func forward() { perform(.forward) }
    func reload() { perform(.reload) }
    func zoom(_ delta: Double?) { perform(.zoom(delta)) }
    func retry() {
        switch actionError {
        case .invalidAddress: submitAddress()
        case .externalBrowser: openExternally()
        case nil: reload()
        }
    }
    func toggleLoading() {
        perform(loading ? .stop : .reload)
    }
    func find(_ text: String, backwards: Bool = false) { perform(.find(text, backwards: backwards)) }
    func openExternally() {
        guard canOpenExternally else { return }
        perform(.openExternally)
    }
    func externalOpenCompleted(_ succeeded: Bool) { actionError = succeeded ? nil : .externalBrowser }
    private func perform(_ action: Action) {
        guard active, page != nil else { return }
        actionError = nil
        onAction?(action)
    }
}

@MainActor struct BrowserPageFactory {
    let controls: BrowserControlsCoordinator
    let dialogs: BrowserDialogCoordinator
    init(desktop: any DesktopActions = NativeDesktopActions(), dialogs: BrowserDialogCoordinator = BrowserDialogCoordinator()) {
        self.dialogs = dialogs
        controls = BrowserControlsCoordinator(desktop: desktop, canPerform: {
            dialogs.enabled && !dialogs.isPresenting && dialogs.canPresent()
        })
    }
    func make(_ record: WebPageRecord) -> BrowserPage {
        let page = BrowserPage(record)
        controls.bind(page.controls, page: page, isOwned: { [weak page] in page?.isOwned() == true })
        dialogs.bind(page.dialogs, isOwned: { [weak page] in page?.isOwned() == true },
                     window: { [weak page] in page?.webView?.window })
        return page
    }
}
