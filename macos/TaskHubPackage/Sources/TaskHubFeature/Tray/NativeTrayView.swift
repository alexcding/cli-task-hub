import SwiftUI

public struct NativeTrayView: View {
    let store: AppStore
    let openWindow: () -> Void
    let dismiss: () -> Void
    let quit: () -> Void

    public init(store: AppStore, openWindow: @escaping () -> Void, dismiss: @escaping () -> Void, quit: @escaping () -> Void) {
        self.store = store; self.openWindow = openWindow; self.dismiss = dismiss; self.quit = quit
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("TaskHub").font(.headline)
                Spacer()
                Text(store.connection).font(.caption).foregroundStyle(.secondary)
                Button("Refresh", systemImage: "arrow.clockwise") { store.refresh(); store.shell.refreshUsage() }
                    .labelStyle(.iconOnly).help("Refresh reviews and usage")
            }.padding(16)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    reviews
                    openTabs
                    RecentActivityView(notifications: store.shell.notifications)
                    Divider()
                    UsagePanel(shell: store.shell)
                    Divider()
                    Picker("Appearance", selection: Binding(get: { store.shell.appearance }, set: store.shell.setAppearance)) {
                        ForEach(AppAppearance.allCases) { Text($0.title).tag($0) }
                    }.pickerStyle(.segmented)
                    if let error = store.shell.settingsError { Text(error).font(.caption).foregroundStyle(.orange) }
                    Divider()
                    NotificationPreferencesView(shell: store.shell)
                }.padding(16)
            }
            Divider()
            HStack {
                Button("Open TaskHub", action: openWindow)
                Spacer()
                Button("Quit TaskHub", action: quit)
            }.padding(12)
        }
        .frame(width: 380, height: 580)
        .accessibilityIdentifier("native-tray-panel")
    }

    private var reviews: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Review requested").font(.headline)
            if let error = store.shell.trayError {
                Text("Showing last available reviews. \(error)").font(.caption).foregroundStyle(.orange)
            }
            if store.shell.trayLoading && store.shell.trayUpdated == nil {
                ProgressView("Loading reviews…").controlSize(.small)
            } else if store.shell.trayUpdated == nil {
                Text("Connect to load review requests").foregroundStyle(.secondary).font(.callout)
            } else if store.shell.pendingReviews.isEmpty {
                Text(store.shell.trayError == nil ? "No pending review requests" : "Reviews unavailable")
                    .foregroundStyle(.secondary).font(.callout)
            }
            ForEach(store.shell.pendingReviews) { pr in
                Button {
                    store.openTrayReview(pr, dismiss: dismiss)
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: ciSymbol(pr)).foregroundStyle(ciColor(pr))
                            .accessibilityLabel(pr.ciLabel)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("#\(pr.number) \(pr.title)").lineLimit(2).multilineTextAlignment(.leading)
                            Text("\(pr.projectName ?? pr.repo) · \(pr.ciLabel)").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }.padding(.vertical, 4).contentShape(Rectangle())
                }.buttonStyle(.plain)
                    .disabled(pr.webURL == nil || store.shell.acknowledging.contains(pr.id))
                    .help("Open in browser and mark this review request opened")
            }
        }
    }

    private var openTabs: some View {
        ForEach(store.trayTabGroups) { group in
            VStack(alignment: .leading, spacing: 6) {
                Text(group.title).font(.headline)
                ForEach(group.tabs) { tab in
                    Button {
                        store.selectTrayTab(tab)
                        openWindow()
                    } label: {
                        Label(tab.title.isEmpty ? tab.url : tab.title, systemImage: tab.kind == "jira" ? "checklist" : "globe")
                            .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain).padding(.vertical, 3)
                }
            }
        }
    }

    private func ciSymbol(_ pr: TrayPR) -> String {
        if pr.ci?.status == "in_progress" { return "clock" }
        switch pr.ci?.conclusion { case "success": return "checkmark.circle"; case "failure": return "xmark.circle"; default: return "circle.dashed" }
    }
    private func ciColor(_ pr: TrayPR) -> Color {
        if pr.ci?.status == "in_progress" { return .orange }
        switch pr.ci?.conclusion { case "success": return .green; case "failure": return .red; default: return .secondary }
    }
}
