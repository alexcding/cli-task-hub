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
            if workspace.model.showsTerminal {
                if #available(macOS 26.0, *) { ToolbarSpacer(.flexible) }
                ToolbarItem(placement: .primaryAction) {
                    SessionWorkspaceInspectorToolbarButton(model: workspace.model)
                }
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
                .controlSize(.small)
                .fixedSize()
                .accessibilityIdentifier("dashboard-agent")
            }
        }
    }
}
