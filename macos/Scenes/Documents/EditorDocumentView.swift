import AppKit
import SwiftUI

struct EditorDocumentView: View {
    let model: EditorDocumentViewModel
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
                    if !model.loaded && !model.loading { Button("Retry", action: model.retry) }
                }.padding(8)
            }
            Divider()
            if let view = model.editorView { NativeEditorHost(view: view) }
            else { Color.clear }
        }
    }
}

private struct NativeEditorHost: NSViewRepresentable {
    let view: NSView
    func makeNSView(context: Context) -> NSView { view }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
