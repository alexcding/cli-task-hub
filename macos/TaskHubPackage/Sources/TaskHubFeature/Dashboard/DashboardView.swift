import SwiftUI

struct DashboardView: View {
    @Bindable var model: DashboardViewModel
    let shell: ShellStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Pull requests").font(.title2.weight(.semibold))
                        Text("Your work and reviews across projects").foregroundStyle(.secondary)
                        if let date = model.updated {
                            Text("Snapshot read \(date.formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if model.loading { ProgressView().controlSize(.small).accessibilityLabel("Refreshing dashboard") }
                }
                DisclosureGroup("Agent usage") { UsagePanel(shell: shell).padding(.vertical, 8) }
                HStack {
                    TextField("Search pull requests", text: $model.search).textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("dashboard-search")
                    Picker("Project", selection: $model.projectID) {
                        Text("All projects").tag("")
                        ForEach(model.projects) { Text($0.name).tag($0.id) }
                    }.labelsHidden().frame(maxWidth: 220)
                }
                Picker("Pull request filter", selection: $model.filter) {
                    ForEach(DashboardFilter.allCases) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented)
                if let error = model.error {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).textSelection(.enabled)
                    Button("Retry dashboard", action: model.refresh)
                }
                ForEach(Array(model.warnings.enumerated()), id: \.offset) { _, message in
                    Label(message, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange)
                }
                if model.updated == nil {
                    Text(model.loading ? "Loading pull requests…" : "Connect to load pull requests.").foregroundStyle(.secondary)
                } else if model.projects.isEmpty {
                    ContentUnavailableView("No projects yet", systemImage: "folder", description: Text("Add a project to track its pull requests."))
                } else {
                    section("My Pull Requests", rows: model.mine, empty: "No matching open pull requests you authored.")
                    section("Review Requested", rows: model.reviews, empty: "No matching pull requests awaiting your review.")
                }
            }.padding(.bottom, 20)
        }.accessibilityIdentifier("native-dashboard")
        .task { await shell.watchUsage() }
    }

    private func section(_ title: String, rows: [DashboardRow], empty: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack { Text(title).font(.headline); Text("\(rows.count)").foregroundStyle(.secondary) }
            if rows.isEmpty { Text(empty).font(.callout).foregroundStyle(.secondary).padding(.vertical, 12) }
            LazyVStack(spacing: 0) {
                ForEach(rows) { row in
                    DashboardCard(row: row, opening: model.opening.contains(row.id),
                                  open: { Task { await model.open(row) } },
                                  external: { model.openExternally(row) }, copy: { model.copyLink(row) })
                    Divider()
                }
            }
        }
    }
}

struct DashboardCard: View {
    let row: DashboardRow
    let opening: Bool
    let open: () -> Void
    let external: () -> Void
    let copy: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: row.ciSymbol).foregroundStyle(ciColor).help(row.ciLabel).accessibilityLabel(row.ciLabel)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 7) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(row.number).monospacedDigit().foregroundStyle(.secondary)
                        Text(row.title).fontWeight(.medium).lineLimit(3).multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        if let status = row.reviewLabel { Text(status).font(.caption).foregroundStyle(status == "Approved" ? .green : .secondary) }
                    }
                    Text(row.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    if !(row.pr.labels ?? []).isEmpty || !(row.pr.jiraKeys ?? []).isEmpty {
                        Text(((row.pr.labels ?? []).map(\.name) + (row.pr.jiraKeys ?? [])).joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    HStack {
                        Text(row.ciLabel)
                        Spacer()
                        if let date = row.dateLabel { Text(date) }
                    }.font(.caption2).foregroundStyle(.secondary)
                }
            }.padding(.vertical, 12).padding(.horizontal, 4).contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(opening)
            .accessibilityIdentifier("dashboard-pr-\(row.pr.number ?? 0)")
            .contextMenu {
                Button("Open in TaskHub", action: open)
                Button("Open in Browser", action: external)
                Button("Copy Link", action: copy)
            }
    }
    private var ciColor: Color {
        if row.ciRunning { return .orange }
        switch row.pr.ci?.conclusion { case "success": return .green; case "failure": return .red; default: return .secondary }
    }
}
