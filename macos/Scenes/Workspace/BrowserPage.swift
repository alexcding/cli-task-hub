import AppKit
import Observation
import WebKit

struct WebPageRecord: Codable, Identifiable, Equatable, Sendable {
    var id = UUID().uuidString
    var url: String
    var title: String
}

@MainActor @Observable final class BrowserPage: NSObject, Identifiable, BrowserControlling, WKNavigationDelegate, WKUIDelegate {
    let id: String
    private(set) var url: String { didSet { if oldValue != url { controls.synchronizeAddress() } } }
    private(set) var title: String
    private(set) var loading = false
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    private(set) var error: String?
    private(set) var webView: WKWebView?
    private(set) var found: Bool?
    let dialogs = BrowserDialogViewModel()
    @ObservationIgnored var isOwned: () -> Bool = { false }
    @ObservationIgnored var changed: () -> Void = {}
    @ObservationIgnored var openPopup: ((URL, WKWebViewConfiguration) -> WKWebView?)?
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []
    @ObservationIgnored lazy var controls = BrowserControlsViewModel(page: self)

    init(_ record: WebPageRecord) {
        id = record.id; url = record.url; title = record.title; super.init()
    }
    var record: WebPageRecord { .init(id: id, url: url, title: title) }

    @discardableResult func materialize(configuration: WKWebViewConfiguration? = nil, load: Bool = true) -> WKWebView {
        if let webView { return webView }
        let configuration = configuration ?? WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        // Remote pages never receive a document bridge, local file read access,
        // terminal handlers, or injected app scripts.
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        view.setAccessibilityIdentifier("context-webview")
        webView = view
        observations = [view.observe(\.title, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.update() }
        }, view.observe(\.url, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.update() }
        }, view.observe(\.isLoading, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.update() }
        }]
        if load, let address = safeWebURL(url) { view.load(URLRequest(url: address)) }
        return view
    }

    func evict() {
        dialogs.cancel()
        update()
        observations.removeAll()
        webView?.stopLoading()
        webView?.navigationDelegate = nil; webView?.uiDelegate = nil
        webView?.removeFromSuperview()
        webView = nil
        loading = false
        canGoBack = false; canGoForward = false
    }

    func navigate(_ address: String) {
        guard let destination = safeWebURL(address) else { error = "Enter an HTTP or HTTPS address."; return }
        error = nil
        materialize().load(URLRequest(url: destination))
    }

    func back() { webView?.goBack() }
    func forward() { webView?.goForward() }
    func reload() { error = nil; materialize().reload() }
    func stop() { webView?.stopLoading() }
    func zoom(_ delta: Double?) {
        guard let webView else { return }
        webView.pageZoom = delta.map { min(3, max(0.5, webView.pageZoom + $0)) } ?? 1
    }
    func find(_ text: String, backwards: Bool = false) {
        guard let webView, !text.isEmpty else { found = nil; return }
        let configuration = WKFindConfiguration()
        configuration.backwards = backwards
        configuration.wraps = true
        webView.find(text, configuration: configuration) { [weak self] result in self?.found = result.matchFound }
    }

    private func update() {
        guard let webView else { return }
        let previous = record
        if let address = webView.url, safeWebURL(address.absoluteString) != nil { url = address.absoluteString }
        if let text = webView.title, !text.isEmpty { title = text }
        loading = webView.isLoading
        canGoBack = webView.canGoBack; canGoForward = webView.canGoForward
        if record != previous { changed() }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard self.webView === webView else { return }
        dialogs.cancel(); error = nil; update()
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { error = nil; update() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    private func failed(_ error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { self.error = error.localizedDescription }
        update()
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard self.webView === webView else { return }
        dialogs.cancel()
        error = "This page stopped responding. Reload to recover it."
        loading = false
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let raw = action.request.url?.absoluteString ?? ""
        // about:blank is needed by login popups. Subframes can render data/blob
        // content, but may never navigate into the host filesystem.
        let subframe = action.targetFrame?.isMainFrame == false
        let scheme = action.request.url?.scheme ?? ""
        let allowed = safeWebURL(raw) != nil || raw == "about:blank"
            || (subframe && ["about", "data", "blob"].contains(scheme))
        if !allowed { error = "This page tried to open an unsupported address." }
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard action.targetFrame == nil, let url = action.request.url,
              safeWebURL(url.absoluteString) != nil || url.absoluteString == "about:blank" else { return nil }
        return openPopup?(url, configuration)
    }
    private func requestDialog(_ kind: BrowserDialogViewModel.Kind, from webView: WKWebView, frame: WKFrameInfo,
                               completion: @escaping (BrowserDialogViewModel.Response) -> Void) {
        guard self.webView === webView, isOwned() else { completion(.cancel); return }
        dialogs.begin(kind, origin: frame.request.url?.host ?? "Web page", completion: completion)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        requestDialog(.alert(message), from: webView, frame: frame) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        requestDialog(.confirm(message), from: webView, frame: frame) { result in
            if case .confirm(let accepted) = result { completionHandler(accepted) } else { completionHandler(false) }
        }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor (String?) -> Void) {
        requestDialog(.prompt(prompt, defaultText: defaultText ?? ""), from: webView, frame: frame) { result in
            if case .text(let text) = result { completionHandler(text) } else { completionHandler(nil) }
        }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        requestDialog(.files(multiple: parameters.allowsMultipleSelection, directories: parameters.allowsDirectories),
                      from: webView, frame: frame) { result in
            if case .files(let urls) = result { completionHandler(urls) } else { completionHandler(nil) }
        }
    }
}
