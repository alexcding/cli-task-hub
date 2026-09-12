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
                if store.viewer.active == nil { Text(title).font(.largeTitle.weight(.semibold)) }
                if let error = store.error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange).textSelection(.enabled)
                    Button("Reconnect") { Task { await store.reconnect() } }
                }
                ZStack(alignment: .topLeading) {
                    // Keep every opened emulator mounted. Selection changes only
                    // visibility, never the PTY identity or parser state.
                    ForEach(store.terminals.keys.filter { $0 == "scratch" }.sorted(), id: \.self) { key in
                        if let terminal = store.terminals[key] {
                            let active = key == store.activeTerminalKey
                            TerminalPane(session: terminal, reconnect: store.reattachTerminal, active: active)
                                .id(terminal.id)
                                .opacity(active ? 1 : 0)
                                .allowsHitTesting(active)
                                .accessibilityHidden(!active)
                        }
                    }
                    ForEach(store.viewer.contexts.keys.sorted(), id: \.self) { id in
                        if let context = store.viewer.contexts[id] {
                            let active = store.viewer.activeContextID == id
                            SessionWorkspaceView(context: context, store: store, active: active)
                                .opacity(active ? 1 : 0).allowsHitTesting(active).accessibilityHidden(!active)
                        }
                    }
                    if store.terminal == nil && store.viewer.active == nil { selectedContent }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .padding(store.viewer.active == nil ? 28 : 0)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .navigationTitle("TaskHub")
            .toolbar {
                Button("New Project", systemImage: "folder.badge.plus") { store.creatingProject = true }
                    .disabled(store.connection != "Connected")
                Button("New Session", systemImage: "plus") { store.creatingSession = true }
                    .disabled(store.connection != "Connected" || store.projects.isEmpty)
                Button("Reviews & Usage", systemImage: "menubar.rectangle", action: showTray)
                Button("Refresh", systemImage: "arrow.clockwise") { store.refresh() }
                    .disabled(store.connection != "Connected")
            }
        }
        .frame(minWidth: 760, minHeight: 480)
        .overlay(alignment: .topTrailing) {
            ActivityToastView(notifications: store.shell.notifications)
                .frame(maxWidth: 420).padding(16)
        }
        .task { await store.start() }
        .sheet(isPresented: $store.creatingSession) { NewSessionView(model: store.newSessionModel()) }
        .sheet(isPresented: $store.creatingProject) {
            if let model = store.projectEditor() { NewProjectSheet(model: model) }
        }
    }

    private var title: String {
        switch store.selection {
        case .overview: "Overview"
        case .terminal: "Terminal"
        case .activity: "Activity"
        case .project(let id): store.projects.first { $0.id == id }?.name ?? "Project"
        case .session(let id): store.sessions.first { $0.id == id }?.label ?? "Session"
        case .tab(let url): store.tabs.first { $0.url == url }?.title ?? "Tab"
        }
    }

    @ViewBuilder private var selectedContent: some View {
        switch store.selection {
        case .overview:
            DashboardView(model: store.dashboard, shell: store.shell)
        case .activity:
            LogsView(model: store.logs)
        case .terminal:
            VStack(alignment: .leading, spacing: 16) {
                Text("Open an interactive shell.").foregroundStyle(.secondary)
                Button("Open native terminal", systemImage: "terminal", action: store.openTerminal)
                    .buttonStyle(.borderedProminent)
            }
        case .project(let id):
            if let model = store.projectModels[id] {
                ProjectPageView(model: model, actions: store.dashboard).id(id)
            } else {
                Text("Connect to load this project.").foregroundStyle(.secondary)
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
