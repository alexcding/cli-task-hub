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
            // NavigationSplitView and inspector each install their own hosting
            // views. Bound the content inside those hosts: a window-level
            // GeometryReader cannot stop their minimum-size feedback loop.
            GeometryReader { _ in
                detailContent
            }
            .navigationTitle("")
            .inspector(isPresented: Binding(
                get: {
                    guard let workspace = model.activeWorkspace else { return false }
                    return workspace.model.showsTerminal && (workspace.model.showsPage || workspace.model.showsBuild)
                },
                set: { model.activeWorkspace?.model.setInspectorPresented($0) }
            )) {
                GeometryReader { _ in
                    if let workspace = model.activeWorkspace {
                        SessionWorkspaceInspectorContent(context: workspace.context, model: workspace.model)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .inspectorColumnWidth(min: 320, ideal: 560, max: 900)
            }
            .toolbar { TaskHubToolbar(model: model) }
        }
    }

    private var detailContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            if !model.hasWorkspace && !model.showsDashboard { Text(model.title).font(.largeTitle.weight(.semibold)) }
            // RootViewModel scopes connection feedback to Dashboard and project
            // detail; it never overlays unrelated web or session content.
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
    }

    public init(model: AppViewModel, showTray: @escaping () -> Void = {}) {
        _app = State(initialValue: model)
        self.showTray = showTray
    }
}
