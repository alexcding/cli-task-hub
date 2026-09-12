import AppKit
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
                    usage
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
                    guard let url = pr.webURL, NSWorkspace.shared.open(url) else { return }
                    store.shell.acknowledge(pr)
                    dismiss()
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
        ForEach(TrayTabGroup.make(tabs: store.tabs, prs: store.shell.prs)) { group in
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

    private var usage: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Usage").font(.headline)
                Spacer()
                Picker("Agent", selection: Binding(get: { store.shell.usageAgent }, set: store.shell.setUsageAgent)) {
                    Text("Claude").tag("claude")
                    Text("Codex").tag("codex")
                }.labelsHidden().frame(width: 110)
            }
            if store.shell.usageLoading && store.shell.usage == nil {
                ProgressView("Loading usage…").controlSize(.small)
            }
            if let error = store.shell.usageError { Text(error).font(.caption).foregroundStyle(.orange) }
            let snapshot = store.shell.usage
            let agent = store.shell.usageAgent == "codex" ? snapshot?.codex : snapshot?.claude
            let limits = store.shell.usageAgent == "codex" ? snapshot?.codexLimits : snapshot?.limits
            if let agent {
                Text("Today: \(agent.tokens.formatted(.number.precision(.fractionLength(0)))) tokens · \(agent.cost.formatted(.currency(code: "USD")))")
                    .font(.callout).monospacedDigit()
            }
            if let session = limits?.session { usageWindow("Session", window: session, duration: 5 * 3600) }
            if let weekly = limits?.weekly { usageWindow("Weekly", window: weekly, duration: 7 * 86400) }
            if let scoped = limits?.scoped {
                ForEach(Array(scoped.enumerated()), id: \.offset) { _, window in
                    usageWindow("\(window.label ?? "Model") · Weekly", window: window, duration: 7 * 86400)
                }
            }
            if agent == nil && limits == nil && !store.shell.usageLoading {
                Text("Usage is unavailable").font(.callout).foregroundStyle(.secondary)
            }
            if let asOf = snapshot?.asOf, let date = backendTimestamp(asOf) {
                Text("Updated \(date.formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func usageWindow(_ title: String, window: UsageSnapshot.Window, duration: TimeInterval) -> some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title)
                Spacer()
                Text("\(Int(window.remaining.rounded()))% left").monospacedDigit()
            }.font(.caption)
            ProgressView(value: window.remaining, total: 100)
                .tint(window.remaining < 20 ? .orange : .accentColor)
                .accessibilityLabel("\(title) remaining")
            if let pace = window.paceRemaining(duration: duration, now: context.date) {
                let reserve = Int((window.remaining - pace).rounded())
                Text(reserve >= 0 ? "\(reserve)% in reserve" : "\(-reserve)% over pace")
                    .font(.caption2).foregroundStyle(reserve < 0 ? .orange : .secondary)
            }
            if let reset = window.resetsAt, let date = backendTimestamp(reset) {
                Text("Resets \(date.formatted(date: .abbreviated, time: .shortened))").font(.caption2).foregroundStyle(.secondary)
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
