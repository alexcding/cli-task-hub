import Foundation

@MainActor protocol WorkspaceFeatureFactory {
    func workspace(context: WorkspaceContext, service: any WorkspaceServing) -> SessionWorkspaceViewModel
    func removal(service: SessionRemovalService, record: WorkspaceSession, projects: [Project], sessions: [WorkspaceSession],
                 didRemove: @escaping ([WorkspaceSession]) async -> Void, finished: @escaping () -> Void) -> SessionRemovalViewModel
    func build(api: APIClient, project: Project, session: WorkspaceSession,
               terminalFactory: @escaping () throws -> any BuildTerminal, reveal: @escaping () -> Void) -> BuildWorkspaceViewModel
}

@MainActor struct NativeWorkspaceFeatureFactory: WorkspaceFeatureFactory {
    func workspace(context: WorkspaceContext, service: any WorkspaceServing) -> SessionWorkspaceViewModel {
        SessionWorkspaceViewModel(context: context, service: service)
    }
    func removal(service: SessionRemovalService, record: WorkspaceSession, projects: [Project], sessions: [WorkspaceSession],
                 didRemove: @escaping ([WorkspaceSession]) async -> Void, finished: @escaping () -> Void) -> SessionRemovalViewModel {
        SessionRemovalViewModel(service: service, record: record, projects: projects, sessions: sessions,
                                didRemove: didRemove, finished: finished)
    }
    func build(api: APIClient, project: Project, session: WorkspaceSession,
               terminalFactory: @escaping () throws -> any BuildTerminal, reveal: @escaping () -> Void) -> BuildWorkspaceViewModel {
        BuildWorkspaceViewModel(api: api, project: project, session: session, terminalFactory: terminalFactory, reveal: reveal)
    }
}
