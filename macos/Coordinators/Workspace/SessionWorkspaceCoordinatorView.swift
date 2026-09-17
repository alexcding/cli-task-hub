import SwiftUI

/// Hosts one session workspace in the detail column and owns its toolbar. Every
/// workspace stays mounted so its terminal keeps its PTY and parser state; only the
/// active one is visible and only it contributes toolbar items.
struct SessionWorkspaceCoordinatorView: View {
    @Bindable var coordinator: SessionWorkspaceCoordinator
    var title: String = ""
    var active: Bool = true

    var body: some View {
        coordinator.root.view()
            .opacity(active ? 1 : 0)
            .allowsHitTesting(active)
            .accessibilityHidden(!active)
            .toolbar { if active { SessionWorkspaceToolbar(title: title, model: coordinator.model) } }
    }
}
