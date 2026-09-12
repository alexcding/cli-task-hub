import SwiftUI

struct DiffView: View {
    @Environment(\.documentFont) private var font
    @Bindable var model: DiffViewModel
    let appearance: AppAppearance
    let active: Bool
    var title = "Changes"

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(title, systemImage: "arrow.triangle.branch").font(.headline).lineLimit(1)
                if let branch = model.snapshot?.branch { Text(branch).foregroundStyle(.secondary).lineLimit(1) }
                Spacer()
                if model.actions != nil {
                    Button("Commit and Push…", systemImage: "arrow.up.circle") { model.showsActions = true }.disabled(model.actions?.busy == true)
                }
                if model.loading || model.actions?.busy == true { ProgressView().controlSize(.small) }
                Button("Refresh Changes", systemImage: "arrow.clockwise", action: model.refresh)
                    .labelStyle(.iconOnly).disabled(model.loading || model.actions?.busy == true)
            }.padding(10)
            if let error = model.error {
                HStack {
                    Text(error).font(.callout).foregroundStyle(.orange)
                    Spacer()
                    Button("Reload Changes", action: model.reload).disabled(model.actions?.busy == true)
                }.padding(10)
            }
            Divider()
            if let view = model.webView { BrowserSurface(webView: view) }
            else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
        }
        .sheet(isPresented: $model.showsActions) {
            if let actions = model.actions { GitChangesSheet(model: actions) }
        }
        .sheet(item: Binding(get: { model.actions?.discardProposal }, set: { if $0 == nil { model.actions?.cancelDiscard() } })) { proposal in
            if let actions = model.actions { DiscardChangeSheet(model: actions, proposal: proposal) }
        }
        .onAppear { model.setFont(font); if active { model.show(appearance: appearance) } }
        .onChange(of: active) { _, value in if value { model.show(appearance: appearance) } else { model.hide() } }
        .onChange(of: appearance) { _, value in model.setAppearance(value) }
        .onChange(of: font) { _, value in model.setFont(value) }
        .onDisappear { model.hide() }
    }
}
