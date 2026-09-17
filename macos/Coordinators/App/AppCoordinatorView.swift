import SwiftUI

/// Root of the window. Lays out the sidebar and the detail column, renders the
/// coordinator's `root` destination, keeps every workspace mounted, and hosts the
/// app-wide presentations. Each child coordinator view owns its own toolbar.
struct AppCoordinatorView: View {
    @Bindable var coordinator: AppCoordinator

    var body: some View {
        NavigationSplitView {
            if let model = coordinator.rootModel { SidebarView(model: model) }
        } detail: {
            detailContent
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

    @ViewBuilder private var detailContent: some View {
        if let model = coordinator.rootModel {
            VStack(alignment: .leading, spacing: 18) {
                // RootViewModel scopes connection feedback to Dashboard and project
                // detail; it never overlays unrelated web or session content.
                if let error = model.error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange).textSelection(.enabled)
                    Button("Reconnect", action: model.reconnect)
                }
                ZStack(alignment: .topLeading) {
                    // Keep every opened emulator mounted. Selection changes only
                    // visibility, never the PTY identity or parser state.
                    ForEach(model.workspaces) { workspace in
                        if let child = coordinator.workspaceCoordinator(for: workspace.context) {
                            SessionWorkspaceCoordinatorView(coordinator: child, title: model.title, active: workspace.active)
                        }
                    }
                    if model.showsDestination {
                        coordinator.root.view()
                            // Placeholders have no coordinator of their own; the root titles them.
                            .toolbar { if coordinator.rootIsPlaceholder { PageTitleToolbarItem(title: model.title) } }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .padding(.horizontal, model.hasWorkspace ? 0 : 28)
            .padding(.vertical, model.hasWorkspace ? 0 : model.showsDashboard ? 16 : 28)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}
