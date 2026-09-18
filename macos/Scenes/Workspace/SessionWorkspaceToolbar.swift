import SwiftUI

/// Toolbar for a session workspace: git client icon and title flat at the leading edge,
/// editor and run controls in a glass container, session actions trailing.
struct SessionWorkspaceToolbar: ToolbarContent {
    let model: SessionWorkspaceViewModel

    var body: some ToolbarContent {
        if !model.fillsTitleBar {
            PageTitleToolbarItem(title: model.title, font: .headline) {
                if model.session != nil {
                    SessionWorkspaceGitClientButton(model: model)
                } else if let url = model.activePageURL {
                    FaviconImage(url: url, size: 18)
                }
            }
        }
        // With the bar in the title-bar zone, Create Session lives in the bar instead.
        if model.offersPageSession, !model.fillsTitleBar {
            if #available(macOS 26.0, *) { ToolbarSpacer(.flexible) }
            ToolbarItem(placement: .primaryAction) {
                Button("Create Session", systemImage: "terminal", action: model.createSession)
                    .labelStyle(.titleAndIcon)
                    .disabled(!model.canCreateSession)
                    .help("Start an agent session for this page in its project")
            }
        }
        if model.session != nil {
            // Flat, like the title at the other end: the editor and run controls carry their own
            // shapes, and a glass capsule around them only boxes in what is already legible.
            if #available(macOS 26.0, *) {
                ToolbarSpacer(.flexible)
                ToolbarItem(placement: .primaryAction) { SessionWorkspaceLeadingToolbar(model: model) }
                    .sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .primaryAction) { SessionWorkspaceLeadingToolbar(model: model) }
            }
        }
        if model.showsModePicker {
            // One flexible spacer per trailing run, or two of them split the free space and
            // leave the run controls stranded mid-bar. When there is no session to put those
            // controls there, this is the spacer that does the pushing.
            if #available(macOS 26.0, *) { ToolbarSpacer(model.session != nil ? .fixed : .flexible) }
            ToolbarItem(placement: .primaryAction) { SessionWorkspaceModePicker(model: model) }
        }
        if model.showsTerminal {
            if #available(macOS 26.0, *) { ToolbarSpacer(.fixed) }
            ToolbarItem(placement: .primaryAction) { SessionWorkspaceContextToggle(model: model) }
        }
    }
}
