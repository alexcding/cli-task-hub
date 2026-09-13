import AppKit
import Observation
import WebKit

struct BoardTicketLink: Decodable, Equatable {
    let type: String
    let url: String
    let title: String
    let external: Bool

    static func parse(_ body: Any, source: URL?, expected: URL, mainFrame: Bool) -> Self? {
        guard mainFrame, source == expected,
              JSONSerialization.isValidJSONObject(body),
              let data = try? JSONSerialization.data(withJSONObject: body), data.count <= 8192,
              let link = try? JSONDecoder().decode(Self.self, from: data),
              link.type == "openTicket", SessionPage.parse(link.url)?.kind == "jira" else { return nil }
        return link
    }
}

@MainActor @Observable final class WebBoardViewModel: NSObject, WKNavigationDelegate {
    enum Action: Equatable { case openTicket(BoardTicketLink) }
    @ObservationIgnored var onAction: (Action) -> Void = { _ in }
    let navigation: PageActionViewModel
    private(set) var retired = false
    let projectID: String
    private(set) var webView: WKWebView?
    private(set) var error: String?
    private var baseURL: URL
    private var appearance = AppAppearance.system
    private var active = false { didSet { if oldValue != active && !active { cancelActions() } } }
    private var connected = true { didSet { if oldValue != connected && !connected { cancelActions() } } }

    init(projectID: String, baseURL: URL, pageActions: any PageActionServing) {
        self.projectID = projectID; self.baseURL = baseURL
        navigation = PageActionViewModel(service: pageActions)
        super.init()
    }
    var pageURL: URL {
        var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        parts.path = "/native/board.html"
        parts.queryItems = [URLQueryItem(name: "project", value: projectID)]
        return parts.url!
    }
    func connect(baseURL: URL) {
        guard !retired else { return }
        connected = true
        if self.baseURL != baseURL {
            cancelActions()
            self.baseURL = baseURL
            webView?.load(URLRequest(url: pageURL))
        } else { applyState() }
    }
    func pause() { connected = false; applyState() }
    func materialize() -> WKWebView {
        guard !retired else { return WKWebView() }
        if let webView { return webView }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(BoardMessageReceiver(owner: self), name: "board")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.setAccessibilityIdentifier("sprint-board-webview")
        webView = view
        view.load(URLRequest(url: pageURL))
        return view
    }
    func show(appearance: AppAppearance) {
        guard !retired else { return }
        active = true; self.appearance = appearance
        _ = materialize(); applyState()
    }
    func setAppearance(_ appearance: AppAppearance) { self.appearance = appearance; applyState() }
    private func applyState() {
        let command = "window.nativeBoard?.setTheme('\(appearance.rawValue)'); window.nativeBoard?.setActive(\(active && connected ? "true" : "false"));"
        webView?.evaluateJavaScript(command, completionHandler: nil)
    }
    func refresh() { webView?.evaluateJavaScript("window.nativeBoard?.refresh()", completionHandler: nil) }
    func reload() { guard !retired else { return }; cancelActions(); error = nil; materialize().reload() }
    func cancelActions() { navigation.cancel() }
    func retire() { retired = true; onAction = { _ in }; connected = false; suspend() }
    func suspend() {
        active = false
        webView?.evaluateJavaScript("window.nativeBoard?.setActive(false)", completionHandler: nil)
        webView?.stopLoading()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "board")
        webView?.navigationDelegate = nil
        webView?.removeFromSuperview()
        webView = nil
    }
    fileprivate func receive(_ message: WKScriptMessage) {
        guard !retired, active, connected, message.webView === webView else { return }
        guard let link = BoardTicketLink.parse(message.body, source: message.frameInfo.request.url,
                                              expected: pageURL, mainFrame: message.frameInfo.isMainFrame) else { return }
        request(link)
    }
    func request(_ link: BoardTicketLink) {
        guard !retired, active, connected else { return }
        onAction(.openTicket(link))
    }
    func perform(_ action: Action) {
        guard !retired, active, connected else { return }
        switch action {
        case .openTicket(let link):
            guard link.type == "openTicket", SessionPage.parse(link.url)?.kind == "jira", let url = safeWebURL(link.url) else { return }
            if link.external { navigation.external(url) }
            else { navigation.open(OpenPageRequest(url: link.url, kind: "jira", title: link.title)) }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        // No remote or secondary document can inherit this page's message handler.
        decisionHandler(action.targetFrame?.isMainFrame == true && action.request.url == pageURL ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { error = nil; applyState() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { error = "The board process stopped. Reload to reconnect." }
    private func failed(_ error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { self.error = error.localizedDescription }
    }
}

@MainActor private final class BoardMessageReceiver: NSObject, WKScriptMessageHandler {
    weak var owner: WebBoardViewModel?
    init(owner: WebBoardViewModel) { self.owner = owner }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.receive(message)
    }
}
