import Foundation

extension AppStore: WorkspaceCoordinating {
    func updateWorkspaceReviewState() {
        for context in viewer.contexts.values { context.workspaceViewModel?.reviewStateChanged() }
    }

    func workspaceState(in context: WorkspaceContext) -> SessionWorkspaceState {
        guard viewer.contexts[context.id] === context else { return SessionWorkspaceState() }
        let session = sessions.first { "task:\($0.id)" == context.id }
        let project = session.flatMap { session in projects.first { $0.id == session.projectId } }
        let base = session.flatMap { session in dashboard.projects.flatMap(\.prs).first { $0.url == session.url }?.baseRefName }
        return SessionWorkspaceState(session: session, project: project, terminal: terminals[context.id],
            buildTerminal: terminals["build:\(context.sourceURL)"], build: buildModels[context.id],
            history: historyModels[context.id], diff: diffModels[context.id], workflow: workflowModel(in: context),
            appearance: shell.appearance, connected: connection == "Connected",
            changingSession: session.map { changingSessions.contains($0.id) } ?? false,
            openingExternal: workspaceLaunch.opening.contains(context.id), canPresent: coordinator.canPresent,
            canCreateSession: canPerform(.newSession), editorLabel: workspaceLaunch.editorLabel(project),
            gitClientLabel: workspaceLaunch.gitClientLabel(shell.gitClient), launchError: workspaceLaunch.errors[context.id],
            reviewBase: base)
    }

    func ownsWorkspace(_ context: WorkspaceContext) -> Bool {
        viewer.contexts[context.id] === context && viewer.active === context
    }

    func makeWorkspaceBuild(in context: WorkspaceContext) -> BuildWorkspaceViewModel? {
        guard ownsWorkspace(context), let session = workspaceState(in: context).session else { return nil }
        return buildModel(for: session, context: context)
    }

    func makeWorkspaceRemoval(in context: WorkspaceContext) -> SessionRemovalViewModel? {
        guard ownsWorkspace(context), let session = workspaceState(in: context).session else { return nil }
        return removalModel(for: session)
    }

    func restartWorkspaceSession(_ id: String, in context: WorkspaceContext) {
        guard viewer.contexts[context.id] === context,
              let current = sessions.first(where: { $0.id == id }), !changingSessions.contains(id) else { return }
        restartSession(current)
    }

    func performWorkspaceOperation(_ action: WorkspaceOperation, in context: WorkspaceContext) {
        guard ownsWorkspace(context) else { return }
        let state = workspaceState(in: context)
        switch action {
        case .reveal: if let session = state.session { revealWorktree(session) }
        case .openEditor:
            if let session = state.session {
                Task { await workspaceLaunch.openEditor(session: session, project: state.project) }
            }
        case .openGitClient:
            if let session = state.session {
                Task { await workspaceLaunch.openGitClient(session: session, id: shell.gitClient, custom: shell.gitClientCommand) }
            }
        case .createSession: perform(.newSession)
        case .openFile: viewer.openFile(in: context)
        case .addPage: addPage(in: context)
        case .changes: if let session = state.session { showChanges(for: session, context: context) }
        case .openTerminal: openTerminal()
        case .reconnectTerminal: reattachTerminal(key: context.id)
        case .reconnectBuild: reattachTerminal(key: "build:\(context.sourceURL)")
        case .hookSettings: openWorkflowHookSettings()
        case .prepareChanges: if let session = state.session { prepareChanges(for: session, context: context) }
        }
    }
}
