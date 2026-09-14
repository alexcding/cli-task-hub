import SwiftUI

/// Root window layout; destinations and presentations belong to the coordinator.
public struct ContentView: View {
    @State private var app: AppViewModel
    private let showTray: () -> Void
    private var model: RootViewModel { app.root }

    public var body: some View {
        NavigationSplitView {
            SidebarView(model: model, showTray: showTray)
        } detail: {
            VStack(alignment: .leading, spacing: 18) {
                if !model.hasWorkspace && !model.showsDashboard { Text(model.title).font(.largeTitle.weight(.semibold)) }
                if let error = model.error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange).textSelection(.enabled)
                    Button("Reconnect", action: model.reconnect)
                }
                AppCoordinatorView(coordinator: app.coordinator, model: model)
            }
            .padding(.horizontal, model.hasWorkspace ? 0 : 28)
            .padding(.vertical, model.hasWorkspace ? 0 : model.showsDashboard ? 16 : 28)
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
            .toolbar { TaskHubToolbar(model: model) }
        }
    }

    public init(model: AppViewModel, showTray: @escaping () -> Void = {}) {
        _app = State(initialValue: model)
        self.showTray = showTray
    }
}
