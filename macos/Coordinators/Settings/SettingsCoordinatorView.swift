import SwiftUI

/// Hosts Settings and owns its toolbar.
struct SettingsCoordinatorView: View {
    @Bindable var coordinator: SettingsCoordinator

    var body: some View {
        coordinator.root.view()
            .padding(28)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .toolbar { PageTitleToolbarItem(title: "Settings") }
    }
}
