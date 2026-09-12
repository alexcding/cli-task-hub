import SwiftUI

public struct ContentView: View {
    @State private var store: AppStore

    public var body: some View {
        NavigationSplitView {
            List {
                Label("TaskHub", systemImage: "square.stack.3d.up")
                    .font(.headline)
                Section("Projects") {
                    ForEach(store.projects) { project in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(project.name)
                            if !project.repo.isEmpty {
                                Text(project.repo).font(.caption).foregroundStyle(.secondary)
                            }
                        }.padding(.vertical, 4)
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 240)
        } detail: {
            VStack(alignment: .leading, spacing: 20) {
                Label("TaskHub Native", systemImage: "square.stack.3d.up")
                    .font(.largeTitle.weight(.semibold))
                Text("Native foundation").font(.title3).foregroundStyle(.secondary)
                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        LabeledContent("Backend", value: store.connection)
                        LabeledContent("Projects", value: String(store.projects.count))
                        if let date = store.lastUpdate {
                            LabeledContent("Last update", value: date.formatted(date: .omitted, time: .standard))
                        }
                    }.padding(8)
                }
                if let error = store.error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange).textSelection(.enabled)
                    Button("Reconnect") { Task { await store.reconnect() } }
                }
                Text("The native terminal is the next implementation gate. Dashboard, sessions, and document views follow it.")
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .navigationTitle("TaskHub")
            .toolbar {
                Button("Refresh", systemImage: "arrow.clockwise") { store.refresh() }
                    .disabled(store.connection != "Connected")
            }
        }
        .frame(minWidth: 760, minHeight: 480)
        .task { await store.start() }
    }

    public init(store: AppStore) { _store = State(initialValue: store) }
}
