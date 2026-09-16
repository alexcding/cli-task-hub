import SwiftUI

struct TaskHubToolbar: ToolbarContent {
    let model: RootViewModel

    var body: some ToolbarContent {
        if let workspace = model.activeWorkspace {
            if workspace.model.session != nil {
                ToolbarItem(placement: .automatic) {
                    SessionWorkspaceLeadingToolbar(model: workspace.model)
                }
            }
            if workspace.model.offersPageSession {
                if #available(macOS 26.0, *) { ToolbarSpacer(.flexible) }
                ToolbarItem(placement: .primaryAction) {
                    Button("Create Session", systemImage: "terminal", action: workspace.model.createSession)
                        .labelStyle(.titleAndIcon)
                        .disabled(!workspace.model.canCreateSession)
                        .help("Start an agent session for this page in its project")
                }
            }
            if workspace.model.showsTerminal {
                if #available(macOS 26.0, *) { ToolbarSpacer(.flexible) }
                ToolbarItem(placement: .primaryAction) {
                    SessionWorkspaceInspectorToolbarButton(model: workspace.model)
                }
            }
        } else if model.showsDashboard {
            if #available(macOS 26.0, *) { ToolbarSpacer(.flexible) }
            ToolbarItem(placement: .primaryAction) { usageAgentPicker }
        }
    }

    /// Dashboard's usage agent: a plain native segmented control.
    private var usageAgentPicker: some View {
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
        .help("Usage agent")
        .accessibilityIdentifier("dashboard-agent")
    }
}
