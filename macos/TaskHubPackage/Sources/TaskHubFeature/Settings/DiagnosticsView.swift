import SwiftUI

struct DiagnosticsView: View {
    let model: DiagnosticsViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Database and sync").font(.headline)
                Spacer()
                if model.loading { ProgressView().controlSize(.small) }
                Button("Refresh Diagnostics", action: model.refresh).disabled(model.loading)
            }
            Text("Reads the saved snapshots. Refreshing this inspector does not run GitHub or Jira commands.")
                .foregroundStyle(.secondary)
            if let error = model.error {
                Text(error).foregroundStyle(.orange).textSelection(.enabled)
                if model.snapshot != nil { Text("Showing the last successful read.").foregroundStyle(.secondary) }
            }
            if let snapshot = model.snapshot {
                HStack(spacing: 24) {
                    Text("Projects: \(snapshot.counts.projects)")
                    Text("PR–Jira links: \(snapshot.counts.links)")
                    Text("Recent events: \(snapshot.counts.events) (up to 1,000)")
                }.accessibilityIdentifier("diagnostics-counts")
                GroupBox("GitHub CLI · since backend startup") {
                    HStack(spacing: 24) {
                        Text("Calls: \(snapshot.ghStats.calls) · Errors: \(snapshot.ghStats.errors)")
                        Text("Average: \(snapshot.ghStats.avgMs) ms · Maximum: \(snapshot.ghStats.maxMs) ms")
                        Text("Syncs in flight: \(snapshot.ghStats.inflight) · Coalesced: \(snapshot.ghStats.coalesced)")
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if model.projects.isEmpty { Text("No projects configured.").foregroundStyle(.secondary) }
                        ForEach(model.projects) { project in
                            GroupBox {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(project.repository).foregroundStyle(.secondary)
                                    Text(project.automation).foregroundStyle(.secondary)
                                    ForEach(project.caches) { cache in
                                        VStack(alignment: .leading, spacing: 3) {
                                            HStack {
                                                Text(cache.title).fontWeight(.medium).frame(width: 110, alignment: .leading)
                                                Text(cache.count)
                                                Spacer()
                                                Text(cache.lastSync).foregroundStyle(.secondary)
                                            }
                                            if let error = cache.error { Text(error).foregroundStyle(.orange) }
                                        }.accessibilityIdentifier("diagnostics-cache-\(project.id)-\(cache.id)")
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                            } label: { Text(project.name).fontWeight(.semibold) }
                        }
                    }.textSelection(.enabled)
                }
                if let updatedAt = model.updatedAt {
                    Text("Inspector updated \(updatedAt.formatted(date: .abbreviated, time: .standard))")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else if !model.loading && model.error == nil {
                ContentUnavailableView("Waiting for backend", systemImage: "externaldrive")
            }
        }.onAppear { model.setVisible(true) }.onDisappear { model.setVisible(false) }
    }
}
