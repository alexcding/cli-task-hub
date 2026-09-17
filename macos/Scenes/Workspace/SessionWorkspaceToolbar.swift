import SwiftUI

/// Toolbar for a session workspace: git client icon and title flat at the leading edge,
/// editor and run controls in a centred glass container, session actions trailing.
struct SessionWorkspaceToolbar: ToolbarContent {
    let title: String
    let model: SessionWorkspaceViewModel

    var body: some ToolbarContent {
        PageTitleToolbarItem(title: title) {
            if model.session != nil {
                SessionWorkspaceGitClientButton(model: model)
            } else if let url = model.activePageURL {
                FaviconImage(url: url, size: 18)
            }
        }
        if model.session != nil {
            ToolbarItem(placement: .principal) { SessionWorkspaceLeadingToolbar(model: model) }
        }
        if model.offersPageSession {
            if #available(macOS 26.0, *) { ToolbarSpacer(.flexible) }
            ToolbarItem(placement: .primaryAction) {
                Button("Create Session", systemImage: "terminal", action: model.createSession)
                    .labelStyle(.titleAndIcon)
                    .disabled(!model.canCreateSession)
                    .help("Start an agent session for this page in its project")
            }
        }
        if model.showsModePicker {
            if #available(macOS 26.0, *) { ToolbarSpacer(.flexible) }
            ToolbarItem(placement: .primaryAction) { SessionWorkspaceModePicker(model: model) }
        }
        if model.showsTerminal {
            if #available(macOS 26.0, *) { ToolbarSpacer(.fixed) }
            ToolbarItem(placement: .primaryAction) { SessionWorkspaceContextToggle(model: model) }
        }
    }
}
