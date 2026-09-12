import SwiftUI

struct EditorDocumentView: View {
    let model: EditorDocumentViewModel
    let appearance: AppAppearance
    let active: Bool
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(model.record.path).font(.caption).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                Spacer()
                if model.readOnly { Text("Read Only").foregroundStyle(.secondary) }
                if model.loading || model.saving { ProgressView().controlSize(.small) }
                Button("Save", systemImage: "square.and.arrow.down") { Task { await model.save() } }
                    .disabled(!model.loaded || model.readOnly || model.saving || model.closing)
            }.padding(8)
            if let error = model.error {
                HStack {
                    Text(error).font(.callout).foregroundStyle(.orange)
                    if !model.loaded && !model.loading { Button("Retry") { model.show(appearance: appearance) } }
                }.padding(8)
            }
            Divider()
            if let view = model.webView { BrowserSurface(webView: view) }
            else { Color.clear }
        }
        .onAppear { if active { model.show(appearance: appearance) } }
        .onChange(of: active) { _, value in if value { model.show(appearance: appearance) } else { model.hide() } }
        .onDisappear { model.hide() }
        .onChange(of: appearance) { _, value in model.setAppearance(value) }
    }
}
