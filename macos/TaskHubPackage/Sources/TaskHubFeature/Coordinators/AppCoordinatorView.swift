import SwiftUI

struct AppCoordinatorView: View {
    @Bindable var coordinator: AppCoordinator
    let model: RootViewModel
    let showTray: () -> Void

    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Text("TaskHub").font(.system(size: 22, weight: .bold))
                    Spacer()
                    Button("New Project", systemImage: "plus") { model.newProject() }
                        .labelStyle(.iconOnly).buttonStyle(.plain).font(.system(size: 18))
                        .disabled(!model.canCreateProject).help("New Project")
                    Button("Activity", systemImage: "bell") { showTray() }
                        .labelStyle(.iconOnly).buttonStyle(.plain).font(.system(size: 17))
                        .accessibilityLabel("Reviews & Usage").help("Activity")
                }
                .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 18)

                CocoaSidebar(entries: model.entries, selection: model.selection,
                             pinnedIDs: model.pinnedIDs,
                             onSelect: model.select, onTogglePin: model.togglePin)

                Divider()
                Button { model.select(.settings) } label: {
                    Label("Settings", systemImage: "gearshape")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14).frame(height: 38)
                        .foregroundStyle(.primary)
                        .background(model.selection == .settings ? Color.primary.opacity(0.08) : .clear,
                                    in: RoundedRectangle(cornerRadius: 7))
                }
                .buttonStyle(.plain).padding(8)
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 250, max: 420)
        } detail: {
            VStack(alignment: .leading, spacing: 18) {
                if !model.hasWorkspace && !model.showsDashboard { Text(model.title).font(.largeTitle.weight(.semibold)) }
                if let error = model.error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange).textSelection(.enabled)
                    Button("Reconnect", action: model.reconnect)
                }
                ZStack(alignment: .topLeading) {
                    // Keep every opened emulator mounted. Selection changes only
                    // visibility, never the PTY identity or parser state.
                    ForEach(model.workspaces) { workspace in
                        SessionWorkspaceView(context: workspace.context, model: workspace.model)
                            .opacity(workspace.active ? 1 : 0).allowsHitTesting(workspace.active).accessibilityHidden(!workspace.active)
                    }
                    if model.showsDestination { selectedContent }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .padding(model.hasWorkspace ? 0 : 28)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .navigationTitle("")
            .inspector(isPresented: Binding(
                get: {
                    guard let workspace = model.activeWorkspace else { return false }
                    return workspace.model.showsTerminal && (workspace.model.showsPage || workspace.model.showsBuild)
                },
                set: { model.activeWorkspace?.model.setInspectorPresented($0) }
            )) {
                if let workspace = model.activeWorkspace {
                    SessionWorkspaceInspectorContent(context: workspace.context, model: workspace.model)
                        .inspectorColumnWidth(min: 320, ideal: 560, max: 900)
                }
            }
            .toolbar {
                if let workspace = model.activeWorkspace {
                    ToolbarItem(placement: .automatic) {
                        SessionWorkspaceLeadingToolbar(model: workspace.model)
                    }
                    if #available(macOS 26.0, *) { ToolbarSpacer(.flexible) }
                    ToolbarItem(placement: .primaryAction) {
                        SessionWorkspaceInspectorToolbarButton(model: workspace.model)
                    }
                } else if model.showsDashboard {
                    if #available(macOS 26.0, *) { ToolbarSpacer(.flexible) }
                    ToolbarItem(placement: .primaryAction) {
                        Picker("Usage agent", selection: Binding(
                            get: { model.shell.usageAgent },
                            set: model.shell.setUsageAgent
                        )) {
                            Text("Claude").tag("claude")
                            Text("Codex").tag("codex")
                        }
                        .labelsHidden()
                        .pickerStyle(.segmented)
                        .fixedSize()
                        .accessibilityIdentifier("dashboard-agent")
                    }
                }
            }
        }
        .taskHubWindowToolbarChrome()
        .frame(minWidth: 760, minHeight: 480)
        .environment(\.terminalFont, model.shell.font(.term))
        .environment(\.documentFont, model.shell.font(.diff))
        .overlay(alignment: .topTrailing) {
            ActivityToastView(notifications: model.shell.notifications)
                .frame(maxWidth: 420).padding(16)
        }
        .sheet(item: Binding(get: { coordinator.sheet }, set: { value in
            if value == nil, let sheet = coordinator.sheet { coordinator.dismissSheet(id: sheet.id) }
        })) { sheet in
            AppCoordinatorSheetView(sheet: sheet, cancel: { coordinator.dismissSheet(id: sheet.id) })
        }
        .confirmationDialog("Restart this session?", isPresented: Binding(get: { coordinator.restartConfirmation != nil }, set: { value in
            if !value, let request = coordinator.restartConfirmation { coordinator.dismissRestart(id: request.id) }
        }), titleVisibility: .visible) {
            if let request = coordinator.restartConfirmation {
                Button("Restart Session", role: .destructive) { coordinator.confirmRestart(id: request.id) }
            }
        } message: {
            Text("This stops the session’s shell and any command it is running. The worktree is kept. The agent resumes its saved conversation when an ID is available.")
        }
    }

    @ViewBuilder private var selectedContent: some View {
        switch model.destination {
        case .dashboard(let dashboard):
            DashboardView(model: dashboard, shell: model.shell)
        case .activity:
            if let child = coordinator.logsCoordinator { LogsCoordinatorView(coordinator: child) }
        case .settings(let settings):
            SettingsView(model: settings, shell: model.shell, viewer: model.viewer)
        case .terminal:
            VStack(alignment: .leading, spacing: 16) {
                Text("Open an interactive shell.").foregroundStyle(.secondary)
                Button("Open native terminal", systemImage: "terminal", action: model.openTerminal)
                    .buttonStyle(.borderedProminent)
            }
        case .project:
            if let child = coordinator.projectCoordinator {
                ProjectCoordinatorView(coordinator: child).id(child.model.project.id)
            }
        case .session(let session):
                VStack(alignment: .leading, spacing: 16) {
                    Text(session.title).font(.headline)
                    LabeledContent("Worktree", value: session.worktree)
                    LabeledContent("Branch", value: session.branch)
                    HStack {
                        Button("Open Terminal", systemImage: "terminal", action: model.openTerminal)
                            .buttonStyle(.borderedProminent)
                        Button(session.pinned ? "Unpin Session" : "Pin Session", systemImage: "pin") { model.togglePin(session.id) }
                    }
                }.textSelection(.enabled)
        case .tab(let url, let address):
            VStack(alignment: .leading, spacing: 16) {
                Text(url).textSelection(.enabled).foregroundStyle(.secondary)
                if let address {
                    Button("Open in Browser") { model.openBrowser(address) }
                }
            }
        case .unavailable(let message):
            Text(message).foregroundStyle(.secondary)
        }
    }

}

private extension View {
    @ViewBuilder func taskHubWindowToolbarChrome() -> some View {
        if #available(macOS 26.0, *) {
            self
                .toolbar(removing: .sidebarToggle)
                .toolbar(removing: .title)
                .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
        } else {
            self
        }
    }
}
