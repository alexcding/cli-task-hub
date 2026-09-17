import SwiftUI

/// Hosts Settings and owns its toolbar.
struct SettingsCoordinatorView: View {
    @Bindable var coordinator: SettingsCoordinator

    var body: some View {
        coordinator.root.view()
            .toolbar { PageTitleToolbarItem(title: "Settings") }
    }
}
