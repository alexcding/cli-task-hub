import SwiftUI

public struct ContentView: View {
    @State private var store: AppStore
    private let showTray: () -> Void

    public var body: some View {
        NavigationSplitView {
            CocoaSidebar(entries: store.sidebarEntries, selection: store.selection,
                         pinnedIDs: Set(store.sessions.filter(\.pinned).map(\.id)),
                         onSelect: store.select, onTogglePin: store.togglePin)
                .navigationSplitViewColumnWidth(min: 200, ideal: 260, max: 420)
        } detail: {
            VStack(alignment: .leading, spacing: 18) {
                Text(title).font(.largeTitle.weight(.semibold))
                if let error = store.error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange).textSelection(.enabled)
                    Button("Reconnect") { Task { await store.reconnect() } }
                }
                ZStack(alignment: .topLeading) {
                    // Keep every opened emulator mounted. Selection changes only
                    // visibility, never the PTY identity or parser state.
                    ForEach(store.terminals.keys.sorted(), id: \.self) { key in
                        if let terminal = store.terminals[key] {
                            let active = key == store.activeTerminalKey
                            TerminalPane(session: terminal, reconnect: store.reattachTerminal, active: active)
                                .id(terminal.id)
                                .opacity(active ? 1 : 0)
                                .allowsHitTesting(active)
                                .accessibilityHidden(!active)
                        }
                    }
                    if store.terminal == nil { selectedContent }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .padding(28)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .navigationTitle("TaskHub")
            .toolbar {
                Button("Reviews & Usage", systemImage: "menubar.rectangle", action: showTray)
                Button("Refresh", systemImage: "arrow.clockwise") { store.refresh() }
                    .disabled(store.connection != "Connected")
            }
        }
        .frame(minWidth: 760, minHeight: 480)
        .task { await store.start() }
    }

    private var title: String {
        switch store.selection {
        case .overview: "TaskHub Native"
        case .terminal: "Terminal"
        case .project(let id): store.projects.first { $0.id == id }?.name ?? "Project"
        case .session(let id): store.sessions.first { $0.id == id }?.label ?? "Session"
        case .tab(let url): store.tabs.first { $0.url == url }?.title ?? "Tab"
        }
    }

    @ViewBuilder private var selectedContent: some View {
        switch store.selection {
        case .overview:
            VStack(alignment: .leading, spacing: 20) {
                Text("Native foundation").font(.title3).foregroundStyle(.secondary)
                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        LabeledContent("Backend", value: store.connection)
                        LabeledContent("Projects", value: String(store.projects.count))
                        LabeledContent("Sessions", value: String(store.sessions.count))
                        if let date = store.lastUpdate {
                            LabeledContent("Last update", value: date.formatted(date: .omitted, time: .standard))
                        }
                    }.padding(8)
                }
                Text("Choose a project or session in the sidebar.").foregroundStyle(.secondary)
                Button("Open native terminal", systemImage: "terminal") {
                    store.select(.terminal)
                    store.openTerminal()
                }.buttonStyle(.borderedProminent)
            }
        case .terminal:
            VStack(alignment: .leading, spacing: 16) {
                Text("Open an interactive shell.").foregroundStyle(.secondary)
                Button("Open native terminal", systemImage: "terminal", action: store.openTerminal)
                    .buttonStyle(.borderedProminent)
            }
        case .project(let id):
            if let project = store.projects.first(where: { $0.id == id }) {
                VStack(alignment: .leading, spacing: 16) {
                    LabeledContent("Repository", value: project.repo.isEmpty ? "None" : project.repo)
                    LabeledContent("Workspace", value: project.workspace)
                    LabeledContent("Sessions", value: String(store.sessions.filter { $0.projectId == id }.count))
                    Text("Select a session to open its terminal.").foregroundStyle(.secondary)
                }.textSelection(.enabled)
            }
        case .session(let id):
            if let session = store.sessions.first(where: { $0.id == id }) {
                VStack(alignment: .leading, spacing: 16) {
                    Text(session.title).font(.headline)
                    LabeledContent("Worktree", value: session.worktree)
                    LabeledContent("Branch", value: session.branch)
                    HStack {
                        Button("Open Terminal", systemImage: "terminal", action: store.openTerminal)
                            .buttonStyle(.borderedProminent)
                        Button(session.pinned ? "Unpin Session" : "Pin Session", systemImage: "pin") { store.togglePin(id) }
                    }
                }.textSelection(.enabled)
            }
        case .tab(let url):
            VStack(alignment: .leading, spacing: 16) {
                Text(url).textSelection(.enabled).foregroundStyle(.secondary)
                if let address = URL(string: url), ["http", "https"].contains(address.scheme?.lowercased() ?? "") {
                    Link("Open in Browser", destination: address)
                }
            }
        }
    }

    public init(store: AppStore, showTray: @escaping () -> Void = {}) {
        _store = State(initialValue: store)
        self.showTray = showTray
    }
}
