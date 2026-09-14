import Foundation

@MainActor protocol WorkspaceCoordinating: WorkspaceServing {
    func ownsWorkspace(_ context: WorkspaceContext) -> Bool
    func performWorkspaceOperation(_ operation: WorkspaceOperation, in context: WorkspaceContext)
    func makeWorkspaceBuild(in context: WorkspaceContext) -> BuildWorkspaceViewModel?
    func makeWorkspaceRemoval(in context: WorkspaceContext) -> SessionRemovalViewModel?
    func restartWorkspaceSession(_ id: String, in context: WorkspaceContext)
}

extension AppCoordinator {
    func bindWorkspace(_ model: SessionWorkspaceViewModel, context: WorkspaceContext, runtime: any WorkspaceCoordinating) {
        model.onAction = { [weak self, weak context, weak runtime] action in
            guard let self, let context, let runtime, runtime.ownsWorkspace(context) else { return }
            self.handle(action, context: context, runtime: runtime)
        }
    }

    private func handle(_ action: SessionWorkspaceViewModel.Action, context: WorkspaceContext, runtime: any WorkspaceCoordinating) {
        switch action {
        case .selectTab(let id):
            guard canPresent, let tab = context.tab(id) else { return }
            context.select(tab)
        case .closeTab(let id):
            guard canPresent, let tab = context.tab(id) else { return }
            context.close(tab)
        case .reopen(let id):
            guard canPresent, let visit = context.visits.first(where: { $0.id == id }) else { return }
            switch visit {
            case .page(let page): context.open(page.url, title: page.title)
            case .file(let file): context.openFile(file.path)
            }
        case .operation(let operation): runtime.performWorkspaceOperation(operation, in: context)
        case .run: presentBuild { runtime.makeWorkspaceBuild(in: context) }
        case .remove: presentRemoval { runtime.makeWorkspaceRemoval(in: context) }
        case .restart:
            guard let session = runtime.workspaceState(in: context).session else { return }
            presentRestart { [weak context, weak runtime] in
                guard let context else { return }
                runtime?.restartWorkspaceSession(session.id, in: context)
            }
        }
    }
}
