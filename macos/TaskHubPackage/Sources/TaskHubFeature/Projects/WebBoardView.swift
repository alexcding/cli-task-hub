import SwiftUI
import WebKit

struct WebBoardView: View {
    let model: WebBoardViewModel
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error = model.navigation.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
            if model.navigation.opening != nil { ProgressView("Opening ticket…").controlSize(.small) }
            if let error = model.error {
                Text(error).foregroundStyle(.orange).textSelection(.enabled)
                Button("Reload Board", action: model.reload)
            }
            BoardSurface(model: model)
        }
    }
}

private struct BoardSurface: NSViewRepresentable {
    let model: WebBoardViewModel
    func makeNSView(context: Context) -> WKWebView { model.materialize() }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
