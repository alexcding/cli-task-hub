import SwiftUI

/// Public scene entry; runtime and feature models are assembled before rendering.
public struct ContentView: View {
    @State private var model: AppViewModel
    private let showTray: () -> Void

    public var body: some View {
        AppCoordinatorView(coordinator: model.coordinator, model: model.root, showTray: showTray)
    }

    public init(model: AppViewModel, showTray: @escaping () -> Void = {}) {
        _model = State(initialValue: model)
        self.showTray = showTray
    }
}
