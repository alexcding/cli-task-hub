import SwiftUI

struct LogsView: View {
    @Bindable var model: LogsViewModel
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Picker("Category", selection: $model.category) {
                    ForEach(model.categories, id: \.self) { Text(LogsViewModel.label($0)).tag($0) }
                }.frame(maxWidth: 240)
                Toggle("Errors only", isOn: $model.errorsOnly)
                Spacer()
                Button("Refresh logs", systemImage: "arrow.clockwise", action: model.refresh).labelStyle(.iconOnly)
                Button("Clear Logs…", role: .destructive, action: model.requestClear).disabled(model.clearing)
            }
            TextField("Search loaded logs", text: $model.search).textFieldStyle(.roundedBorder).accessibilityIdentifier("logs-search")
            if let error = model.error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).textSelection(.enabled) }
            if model.loading { ProgressView("Loading logs…").controlSize(.small) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if model.rows.isEmpty && !model.loading {
                        Text(model.updated == nil ? "Connect to load activity." : "No matching entries.").foregroundStyle(.secondary)
                    }
                    ForEach(model.rows) { entry in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .firstTextBaseline) {
                                Image(systemName: entry.level == "error" ? "exclamationmark.circle" : "clock")
                                    .foregroundStyle(entry.level == "error" ? .red : .secondary)
                                Text(entry.title).font(.headline)
                                Spacer()
                                Text(entry.timestamp).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(entry.detail).font(.callout).textSelection(.enabled)
                            HStack {
                                Text("\(LogsViewModel.label(entry.category)) · \(entry.level)").font(.caption).foregroundStyle(.secondary)
                                Spacer()
                                if entry.link != nil { Button("Open Pull Request") { Task { await model.open(entry) } } }
                                Button("Copy entry", systemImage: "doc.on.doc") { model.copyEntry(entry) }.labelStyle(.iconOnly)
                            }
                        }.accessibilityIdentifier("log-entry-\(entry.id)")
                        Divider()
                    }
                }
            }
            Text("Latest 200 entries for the selected category and level.").font(.caption).foregroundStyle(.secondary)
        }.task { model.refresh() }
            .onChange(of: model.category) { model.refresh() }
            .onChange(of: model.errorsOnly) { model.refresh() }
            .alert("Clear \(model.clearScopeLabel)?", isPresented: $model.confirmingClear) {
                Button("Cancel", role: .cancel) {}
                Button("Clear Logs", role: .destructive) { Task { await model.clear(confirmed: true) } }
            } message: {
                Text("This deletes every entry in this category, including entries hidden by search or Errors only.")
            }
    }
}
