import SwiftUI

struct AddPageSheet: View {
    @Bindable var model: AddPageViewModel
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Add Page").font(.headline)
            TextField("Web address (example.com)", text: $model.address).textFieldStyle(.roundedBorder)
            if let error = model.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
            HStack {
                Button("Cancel", role: .cancel, action: cancel).keyboardShortcut(.cancelAction)
                Spacer()
                Button("Open", action: model.open).keyboardShortcut(.defaultAction).disabled(!model.canOpen)
            }
        }.padding(24).frame(width: 440)
    }
}
