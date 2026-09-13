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
    func find(_ text: String, backwards: Bool)
}

@MainActor @Observable final class BrowserControlsViewModel {
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
    private(set) var editingAddress = false {
        didSet { if oldValue != editingAddress && !editingAddress { synchronizeAddress() } }
    }
    private(set) var actionError: ActionError?
    // The page owns its controls. Controls must not keep a closed page alive.
    @ObservationIgnored private weak var page: (any BrowserControlling)?
    @ObservationIgnored private let desktop: any DesktopActions

    init(page: any BrowserControlling, desktop: any DesktopActions) {
        self.page = page; self.desktop = desktop; address = page.url
    }

    var loading: Bool { page?.loading == true }
    var canGoBack: Bool { page?.canGoBack == true }
    var canGoForward: Bool { page?.canGoForward == true }
    var found: Bool? { page?.found }
    var error: String? { actionError?.message ?? page?.error }
    var canOpenExternally: Bool { page.flatMap { safeWebURL($0.url) } != nil }

    func setEditingAddress(_ value: Bool) { editingAddress = value }
    func synchronizeAddress() {
        guard !editingAddress, let page else { return }
        address = page.url
    }

    @discardableResult func submitAddress() -> Bool {
        guard let page else { return false }
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = safeWebURL(trimmed) else {
            actionError = .invalidAddress
            return false
        }
        actionError = nil
        address = trimmed
        page.navigate(url.absoluteString)
        return true
    }

    func back() { actionError = nil; page?.back() }
    func forward() { actionError = nil; page?.forward() }
    func reload() { actionError = nil; page?.reload() }
    func retry() {
        switch actionError {
        case .invalidAddress: submitAddress()
        case .externalBrowser: openExternally()
        case nil: reload()
        }
    }
    func toggleLoading() {
        actionError = nil
        if loading { page?.stop() } else { page?.reload() }
    }
    func find(_ text: String, backwards: Bool = false) { page?.find(text, backwards: backwards) }
    func openExternally() {
        guard let page, let url = safeWebURL(page.url) else { return }
        actionError = desktop.openBrowser(url) ? nil : .externalBrowser
    }
}

@MainActor struct BrowserPageFactory {
    let desktop: any DesktopActions
    let dialogs: BrowserDialogCoordinator
    init(desktop: any DesktopActions = NativeDesktopActions(), dialogs: BrowserDialogCoordinator = BrowserDialogCoordinator()) {
        self.desktop = desktop; self.dialogs = dialogs
    }
    func make(_ record: WebPageRecord) -> BrowserPage {
        let page = BrowserPage(record, desktop: desktop)
        dialogs.bind(page.dialogs, isOwned: { [weak page] in page?.isOwned() == true },
                     window: { [weak page] in page?.webView?.window })
        return page
    }
}
