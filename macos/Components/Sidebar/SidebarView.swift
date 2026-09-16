import AppKit
import SwiftUI

// The web sidebar's chrome around the outline (src/renderer/index.html <aside>, layout.css):
// the wordmark with Open Link, New Project and the activity bell, and Settings pinned in a footer.
struct SidebarView: View {
    let model: RootViewModel
    @State private var showingActivity = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                Text("TaskHub").font(.system(size: 17, weight: .bold)).kerning(-0.3)
                    .foregroundStyle(Color(nsColor: SidebarPalette.text))
                Spacer()
                SidebarAppButton(icon: "globe", label: "Open Link", help: "Open Link (⌘T)") { model.openLink() }
                    .disabled(!model.canOpenLink)
                SidebarAppButton(icon: "appPlus", label: "New Project", help: "New Project") { model.newProject() }
                    .disabled(!model.canCreateProject)
                SidebarAppButton(icon: "bell", label: "Today's activity", help: "Today's activity") { showingActivity.toggle() }
                    .popover(isPresented: $showingActivity, arrowEdge: .bottom) {
                        if let today = model.todayActivity {
                            TodayActivityPopover(model: today, showAllEvents: {
                                showingActivity = false
                                model.select(.activity)
                            }, dismiss: { showingActivity = false })
                        }
                    }
                    .onChange(of: showingActivity) { _, open in model.todayActivity?.setVisible(open) }
            }
            .padding(.leading, 16).padding(.trailing, 12).padding(.top, 4).padding(.bottom, 6)

            CocoaSidebar(entries: model.entries, selection: model.selection,
                         pinnedIDs: model.pinnedIDs,
                         onSelect: model.select, onTogglePin: model.togglePin,
                         onNewSession: model.newSession(in:), onCloseTab: model.closeTab)

            Divider()
            SidebarFooterRow(title: "Settings", icon: "settings", selected: model.selection == .settings) {
                model.select(.settings)
            }
            .padding(8)
        }
        .navigationSplitViewColumnWidth(min: 170, ideal: 250, max: 420)
    }
}

/// .app-btn: a 30pt square, 18pt glyph in --text-2, a soft plate + --text on hover.
private struct SidebarAppButton: View {
    let icon: String
    let label: String
    let help: String
    let action: () -> Void
    @State private var hovered = false
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button(action: action) {
            Image(nsImage: SidebarIcons.image(icon, size: 18) ?? NSImage())
                .renderingMode(.template)
                .foregroundStyle(Color(nsColor: hovered && enabled ? SidebarPalette.text : SidebarPalette.text2))
                .frame(width: 30, height: 30)
                .background(hovered && enabled ? Color(nsColor: SidebarPalette.hover) : .clear, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(enabled ? 1 : 0.5)
        .onHover { hovered = $0 }
        .help(help)
        .accessibilityLabel(label)
    }
}

/// A sidebar row outside the outline (Settings), drawn exactly like the outline's rows.
private struct SidebarFooterRow: View {
    let title: String
    let icon: String
    let selected: Bool
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(nsImage: SidebarIcons.image(icon) ?? NSImage()).renderingMode(.template)
                    .frame(width: 16, height: 16)
                Text(title).font(.system(size: 14))
                Spacer(minLength: 0)
            }
            .foregroundStyle(Color(nsColor: hovered || selected ? SidebarPalette.text : SidebarPalette.navText))
            .padding(.horizontal, SidebarMetrics.padding)
            .frame(height: SidebarMetrics.rowHeight - 2)
            .background(selected ? Color(nsColor: SidebarPalette.selected) : hovered ? Color(nsColor: SidebarPalette.hover) : .clear,
                        in: RoundedRectangle(cornerRadius: SidebarMetrics.radius))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
    }
}
