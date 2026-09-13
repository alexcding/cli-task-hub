import SwiftUI

/// Public scene entry; runtime and feature models are assembled before rendering.
public struct ContentView: View {
    @State private var store: AppStore
    private let showTray: () -> Void

    public var body: some View {
        AppCoordinatorView(coordinator: store.coordinator, model: store.root, showTray: showTray)
    }

    public init(store: AppStore, showTray: @escaping () -> Void = {}) {
        _store = State(initialValue: store)
        self.showTray = showTray
    }
}
