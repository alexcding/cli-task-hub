import Foundation
import WebKit

@MainActor final class WebEditorSurface: NSObject, EditorSurface, WKNavigationDelegate {
    private(set) var webView: WKWebView?
    var changed: (Bool) -> Void = { _ in }
    var failed: (String) -> Void = { _ in }
    var saveRequested: () -> Void = {}
    private let pageURL: URL
    private var ready = false
    private var failure: String?

    init(baseURL: URL) {
        pageURL = baseURL.appendingPathComponent("native/editor.html")
        super.init()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(EditorMessageReceiver(owner: self), name: "editor")
        config.userContentController.addUserScript(WKUserScript(source: #"window.addEventListener('error', e => window.webkit.messageHandlers.editor.postMessage({type:'error', message:e.message || 'An editor asset failed to load.'}), true); window.addEventListener('unhandledrejection', e => window.webkit.messageHandlers.editor.postMessage({type:'error', message:String(e.reason?.message || e.reason).slice(0,4096)}));"#,
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.setAccessibilityIdentifier("native-code-editor")
        webView = view
        view.load(URLRequest(url: pageURL))
    }
    func load(_ value: FileDocumentSnapshot, path: String) async throws {
        for _ in 0..<400 {
            try Task.checkCancellation()
            if let failure { throw BackendError.operation(failure) }
            if ready { break }
            try await Task.sleep(for: .milliseconds(25))
        }
        guard ready else { throw BackendError.operation("The code editor did not finish loading.") }
        struct Payload: Encodable { let content: String; let path: String; let readOnly: Bool }
        let payload = String(decoding: try JSONEncoder().encode(Payload(content: value.content, path: path, readOnly: value.readOnly)), as: UTF8.self)
        _ = try await evaluate("window.nativeEditor.load(\(payload)); true")
    }
    func snapshot(freeze: Bool) async throws -> EditorBuffer {
        let result = try await evaluate("JSON.stringify(window.nativeEditor.snapshot(\(freeze)))")
        guard let json = result as? String else { throw BackendError.operation("The editor returned no buffer.") }
        return try JSONDecoder().decode(EditorBuffer.self, from: Data(json.utf8))
    }
    func acknowledge(version: Int) async throws -> Bool {
        guard let dirty = try await evaluate("window.nativeEditor.acknowledge(\(version))") as? Bool else {
            throw BackendError.operation("The editor did not acknowledge the saved version.")
        }
        return dirty
    }
    func unfreeze() async throws { _ = try await evaluate("window.nativeEditor.unfreeze(); true") }
    func setAppearance(_ value: AppAppearance) { command("setTheme('\(value.rawValue)')") }
    func focus(line: Int) { command("focus(\(max(0, line)))") }
    func find() { command("find()") }
    private func command(_ call: String) {
        guard ready else { return }
        webView?.evaluateJavaScript("window.nativeEditor.\(call); true") { [weak self] _, error in
            if let error { self?.report(error.localizedDescription) }
        }
    }
    private func evaluate(_ script: String) async throws -> Any? {
        guard let webView, ready else { throw BackendError.operation(failure ?? "The code editor is unavailable.") }
        return try await webView.evaluateJavaScript(script)
    }
    func dispose() {
        ready = false
        webView?.stopLoading(); webView?.navigationDelegate = nil
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "editor")
        webView?.removeFromSuperview(); webView = nil
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.targetFrame?.isMainFrame == true && action.request.url == pageURL ? .allow : .cancel)
    }
    fileprivate func receive(_ message: WKScriptMessage) {
        guard message.webView === webView, message.frameInfo.isMainFrame, message.frameInfo.request.url == pageURL,
              let body = message.body as? [String: Any], body.count <= 2, let type = body["type"] as? String else { return }
        switch type {
        case "ready": ready = true
        case "changed": if let dirty = body["dirty"] as? Bool { changed(dirty) }
        case "save": saveRequested()
        case "error": if let text = body["message"] as? String, text.utf8.count <= 4096 { report(text) }
        default: break
        }
    }
    private func report(_ text: String) { failure = text; failed(text) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { report(error.localizedDescription) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { report(error.localizedDescription) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ready = false
        report("The editor stopped. Its unsaved buffer is unavailable. Keep this tab open or explicitly discard it before reopening.")
    }
}

@MainActor private final class EditorMessageReceiver: NSObject, WKScriptMessageHandler {
    weak var owner: WebEditorSurface?
    init(owner: WebEditorSurface) { self.owner = owner }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { owner?.receive(message) }
}
