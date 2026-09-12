import AppKit
import Observation
import WebKit

struct WebPageRecord: Codable, Identifiable, Equatable, Sendable {
    var id = UUID().uuidString
    var url: String
    var title: String
}

@MainActor @Observable final class BrowserPage: NSObject, Identifiable, WKNavigationDelegate, WKUIDelegate {
    let id: String
    private(set) var url: String
    private(set) var title: String
    private(set) var loading = false
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    private(set) var error: String?
    private(set) var webView: WKWebView?
    private(set) var found: Bool?
    @ObservationIgnored var changed: () -> Void = {}
    @ObservationIgnored var openPopup: ((URL, WKWebViewConfiguration) -> WKWebView?)?
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []

    init(_ record: WebPageRecord) { id = record.id; url = record.url; title = record.title; super.init() }
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

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { error = nil; update() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { error = nil; update() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    private func failed(_ error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { self.error = error.localizedDescription }
        update()
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
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
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        guard let window = webView.window else { completionHandler(); return }
        let alert = NSAlert(); alert.messageText = frame.request.url?.host ?? "Web page"; alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        guard let window = webView.window else { completionHandler(false); return }
        let alert = NSAlert(); alert.messageText = frame.request.url?.host ?? "Web page"; alert.informativeText = message
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
}
