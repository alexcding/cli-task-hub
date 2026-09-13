import SwiftUI

public struct NativeTrayView: View {
    let model: TrayViewModel

    public init(model: TrayViewModel) { self.model = model }

    public var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("TaskHub").font(.headline)
                Spacer()
                Text(model.connection).font(.caption).foregroundStyle(.secondary)
                Button("Refresh", systemImage: "arrow.clockwise", action: model.refresh)
                    .labelStyle(.iconOnly).help("Refresh reviews and usage")
            }.padding(16)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    reviews
                    openTabs
                    RecentActivityView(notifications: model.shell.notifications)
                    Divider()
                    UsagePanel(shell: model.shell)
                    Divider()
                    Picker("Appearance", selection: Binding(get: { model.shell.appearance }, set: model.shell.setAppearance)) {
                        ForEach(AppAppearance.allCases) { Text($0.title).tag($0) }
                    }.pickerStyle(.segmented)
                    if let error = model.shell.settingsError { Text(error).font(.caption).foregroundStyle(.orange) }
                    Divider()
                    NotificationPreferencesView(shell: model.shell)
                }.padding(16)
            }
            if let error = model.actionError { Text(error).font(.caption).foregroundStyle(.orange).padding(.horizontal, 12) }
            Divider()
            HStack {
                Button("Open TaskHub", action: model.openWindow)
                Spacer()
                Button("Quit TaskHub", action: model.quit)
            }.padding(12)
        }
        .frame(width: 380, height: 580)
        .accessibilityIdentifier("native-tray-panel")
    }

    private var reviews: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Review requested").font(.headline)
            if let error = model.shell.trayError {
                Text("Showing last available reviews. \(error)").font(.caption).foregroundStyle(.orange)
            }
            if model.shell.trayLoading && model.shell.trayUpdated == nil {
                ProgressView("Loading reviews…").controlSize(.small)
            } else if model.shell.trayUpdated == nil {
                Text("Connect to load review requests").foregroundStyle(.secondary).font(.callout)
            } else if model.pendingReviews.isEmpty {
                Text(model.shell.trayError == nil ? "No pending review requests" : "Reviews unavailable")
                    .foregroundStyle(.secondary).font(.callout)
            }
            ForEach(model.pendingReviews) { pr in
                Button {
                    model.openReview(pr)
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
                    .disabled(!model.canOpen(pr))
                    .help("Open in browser and mark this review request opened")
            }
        }
    }

    private var openTabs: some View {
        ForEach(model.tabGroups) { group in
            VStack(alignment: .leading, spacing: 6) {
                Text(group.title).font(.headline)
                ForEach(group.tabs) { tab in
                    Button {
                        model.openTab(tab)
                    } label: {
                        Label(tab.title.isEmpty ? tab.url : tab.title, systemImage: tab.kind == "jira" ? "checklist" : "globe")
                            .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain).padding(.vertical, 3).disabled(!model.canNavigate)
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
