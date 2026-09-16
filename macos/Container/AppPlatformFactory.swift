import Foundation

struct AppTerminalRequest: Equatable {
    let key: String
    let directory: String
    let paired: Bool
}

protocol TerminalRuntimeControlling: Sendable {
    func stopPaired(keys: Set<String>) async throws
    func stopExisting() async throws
}

struct NativeTerminalRuntimeControl: TerminalRuntimeControlling {
    let configuration: @Sendable () throws -> PtydConfiguration
    func stopPaired(keys: Set<String>) async throws {
        try await PtydHost(configuration: configuration()).stopPaired(keys: keys)
    }
    func stopExisting() async throws {
        try await PtydHost(configuration: configuration()).stopExisting()
    }
}

@MainActor protocol AppPlatformFactory {
    var homeDirectory: String { get }
    func viewer(desktop: any DesktopActions, dialogs: BrowserDialogCoordinator,
                documents: any DocumentFeatureFactory, close: EditorCloseCoordinator) -> ViewerStore
    func workspaceLauncher() -> WorkspaceLaunchViewModel
    func terminal(_ request: AppTerminalRequest) -> TerminalSession
    func terminalControl() -> any TerminalRuntimeControlling
    func workflowTerminal(_ terminal: TerminalSession, cli: WorkflowCLI, sessionID: String?) async throws -> any WorkflowTerminal
    func resources(api: APIClient?) -> any ResourceUsageService
    func pageActions(open: @escaping (OpenPageRequest) async throws -> Void,
                     desktop: any DesktopActions, copy: @escaping (String) -> Void) -> any PageActionServing
}

@MainActor struct NativeAppPlatformFactory: AppPlatformFactory {
    var homeDirectory = FileManager.default.homeDirectoryForCurrentUser.path
    var configuration: @Sendable () throws -> PtydConfiguration = { try .current() }
    var launcher: any WorkspaceCommandLauncher = NativeWorkspaceCommandLauncher()

    func viewer(desktop: any DesktopActions, dialogs: BrowserDialogCoordinator,
                documents: any DocumentFeatureFactory, close: EditorCloseCoordinator) -> ViewerStore {
        ViewerStore(cacheURL: try? configuration().directory.appendingPathComponent("page-tabs.json"),
                    pageFactory: BrowserPageFactory(desktop: desktop, dialogs: dialogs),
                    documentFactory: documents, closeCoordinator: close)
    }
    func workspaceLauncher() -> WorkspaceLaunchViewModel { WorkspaceLaunchViewModel(launcher: launcher) }
    func terminal(_ request: AppTerminalRequest) -> TerminalSession {
        TerminalSession(pairKey: request.key, cwd: request.directory, paired: request.paired, configurationProvider: configuration)
    }
    func terminalControl() -> any TerminalRuntimeControlling { NativeTerminalRuntimeControl(configuration: configuration) }
    func workflowTerminal(_ terminal: TerminalSession, cli: WorkflowCLI, sessionID: String?) async throws -> any WorkflowTerminal {
        try await NativeWorkflowTerminal(terminal: terminal, cli: cli, sessionID: sessionID)
    }
    func resources(api: APIClient?) -> any ResourceUsageService {
        NativeResourceUsageService(api: api, pty: try? configuration())
    }
    func pageActions(open: @escaping (OpenPageRequest) async throws -> Void,
                     desktop: any DesktopActions, copy: @escaping (String) -> Void) -> any PageActionServing {
        NativePageActionService(open: open, desktop: desktop, copy: copy)
    }
}
