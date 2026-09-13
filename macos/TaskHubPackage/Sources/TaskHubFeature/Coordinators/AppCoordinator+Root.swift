import Foundation

@MainActor protocol RootCoordinating: RootServing {
    func activateRootDestination()
    func performRootCommand(_ command: ShellCommand)
    func reconnect() async
    func togglePin(_ id: String)
    func openTerminal()
    func openRootBrowser(_ url: URL)
}

extension AppCoordinator {
    func makeRoot(factory: any RootFeatureFactory, runtime: any RootCoordinating,
                  shell: ShellStore, viewer: ViewerStore) -> RootViewModel {
        rootRuntime = runtime
        let bindingID = UUID()
        rootBindingID = bindingID
        let model = factory.root(service: runtime, shell: shell, viewer: viewer)
        model.onAction = { [weak self] action in
            guard let self, rootBindingID == bindingID else { return }
            handle(action)
        }
        return model
    }

    func handle(_ action: RootViewModel.Action) {
        switch action {
        case .select(let destination): navigate(to: destination)
        case .command(let command): rootRuntime?.performRootCommand(command)
        case .togglePin(let id): rootRuntime?.togglePin(id)
        case .reconnect: Task { [weak rootRuntime] in await rootRuntime?.reconnect() }
        case .openTerminal: rootRuntime?.openTerminal()
        case .openBrowser(let url): rootRuntime?.openRootBrowser(url)
        }
    }
}
