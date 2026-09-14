import SwiftUI

struct AppCoordinatorView: View {
    let coordinator: AppCoordinator
    let model: RootViewModel

    var body: some View {
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
