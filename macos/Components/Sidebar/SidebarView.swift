import SwiftUI

struct SidebarView: View {
    let model: RootViewModel
    let showTray: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text("TaskHub").font(.headline)
                Spacer()
                Button("New Project", systemImage: "plus") { model.newProject() }
                    .labelStyle(.iconOnly).buttonStyle(.borderless).controlSize(.small)
                    .disabled(!model.canCreateProject).help("New Project")
                Button("Activity", systemImage: "bell") { showTray() }
                    .labelStyle(.iconOnly).buttonStyle(.borderless).controlSize(.small)
                    .accessibilityLabel("Reviews & Usage").help("Activity")
            }
            .padding(.horizontal, 14).padding(.vertical, 8)

            CocoaSidebar(entries: model.entries, selection: model.selection,
                         pinnedIDs: model.pinnedIDs,
                         onSelect: model.select, onTogglePin: model.togglePin)

            Divider()
            Button { model.select(.settings) } label: {
                Label("Settings", systemImage: "gearshape")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).frame(height: 38)
                    .foregroundStyle(.primary)
                    .background(model.selection == .settings ? Color.primary.opacity(0.08) : .clear,
                                in: RoundedRectangle(cornerRadius: 7))
            }
            .buttonStyle(.plain).padding(8)
        }
        .navigationSplitViewColumnWidth(min: 200, ideal: 250, max: 420)
    }
}
