import Foundation

@MainActor protocol WorkspaceCoordinating: WorkspaceServing {
    func ownsWorkspace(_ context: WorkspaceContext) -> Bool
    func performWorkspaceOperation(_ operation: WorkspaceOperation, in context: WorkspaceContext)
    func makeWorkspaceBuild(in context: WorkspaceContext) -> BuildWorkspaceViewModel?
    func makeWorkspaceRemoval(in context: WorkspaceContext) -> SessionRemovalViewModel?
    func restartWorkspaceSession(_ id: String, in context: WorkspaceContext)
}

extension AppCoordinator {
    @discardableResult
    func bindWorkspace(_ model: SessionWorkspaceViewModel, context: WorkspaceContext,
                       runtime: any WorkspaceCoordinating) -> SessionWorkspaceCoordinator {
        defer { refreshRoot() }
        pruneWorkspaces()
        if let existing = workspaceCoordinator(for: context), existing.model === model { return existing }
        workspaceCoordinators.removeAll { $0.context === context }
        let child = SessionWorkspaceCoordinator(model: model, context: context)
        workspaceRuntime = runtime
        child.action = { [weak self] in self?.handle($0) }
        workspaceCoordinators.append(child)
        return child
    }

    func workspaceCoordinator(for context: WorkspaceContext) -> SessionWorkspaceCoordinator? {
        workspaceCoordinators.first { $0.context === context }
    }

    /// Drops coordinators whose contexts the viewer no longer holds.
    func pruneWorkspaces() {
        guard let viewer = rootModel?.viewer else { return }
        let live = viewer.contexts.values
        workspaceCoordinators.removeAll { child in !live.contains { $0 === child.context } }
    }

    func handleWorkspace(_ action: SessionWorkspaceViewModel.Action, in context: WorkspaceContext) {
        guard let runtime = workspaceRuntime, runtime.ownsWorkspace(context),
              workspaceCoordinator(for: context) != nil else { return }
        switch action {
        case .selectTab(let id):
            guard canPresent, let tab = context.tab(id) else { return }
            context.select(tab)
        case .newTab:
            guard canPresent else { return }
            context.openBlankPage()
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
        case .configureRun: presentBuild(purpose: .configure) { runtime.makeWorkspaceBuild(in: context) }
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
