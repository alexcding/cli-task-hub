import Foundation

extension AppStore: WorkspaceServing {
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

    func performWorkspaceAction(_ action: WorkspaceAction, in context: WorkspaceContext) {
        guard viewer.contexts[context.id] === context, viewer.active === context else { return }
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
        case .run:
            if let session = state.session { coordinator.presentBuild { buildModel(for: session, context: context) } }
        case .remove:
            if let session = state.session { coordinator.presentRemoval { removalModel(for: session) } }
        case .restart:
            if let session = state.session {
                coordinator.presentRestart { [weak self, weak context] in
                    guard let self, let context, viewer.contexts[context.id] === context,
                          let current = sessions.first(where: { $0.id == session.id }),
                          !changingSessions.contains(current.id) else { return }
                    restartSession(current)
                }
            }
        case .openTerminal: openTerminal()
        case .reconnectTerminal: reattachTerminal(key: context.id)
        case .reconnectBuild: reattachTerminal(key: "build:\(context.sourceURL)")
        case .hookSettings: openWorkflowHookSettings()
        case .prepareChanges: if let session = state.session { prepareChanges(for: session, context: context) }
        }
    }
}
