import SwiftUI

struct UsagePanel: View {
    let shell: ShellStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Usage").font(.headline)
                Spacer()
                Picker("Agent", selection: Binding(get: { shell.usageAgent }, set: shell.setUsageAgent)) {
                    Text("Claude").tag("claude")
                    Text("Codex").tag("codex")
                }.labelsHidden().frame(width: 110)
            }
            if shell.usageLoading && shell.usage == nil {
                ProgressView("Loading usage…").controlSize(.small)
            }
            if let error = shell.usageError { Text(error).font(.caption).foregroundStyle(.orange) }
            let snapshot = shell.usage
            let agent = shell.usageAgent == "codex" ? snapshot?.codex : snapshot?.claude
            let limits = shell.usageAgent == "codex" ? snapshot?.codexLimits : snapshot?.limits
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
            if agent == nil && limits == nil && !shell.usageLoading {
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

}
