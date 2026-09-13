import AppKit
import Foundation
import Observation

@MainActor @Observable
public final class AppStore {
    public let shell = ShellStore()
    let viewer: ViewerStore
    let coordinator: AppCoordinator
    private(set) var root: RootViewModel!
    @ObservationIgnored private let creationFactory: any CreationFlowFactory
    @ObservationIgnored private let desktop: any DesktopActions
    @ObservationIgnored private let workspaceFactory: any WorkspaceFeatureFactory
    private(set) var dashboard: DashboardViewModel!
    private(set) var logs: LogsViewModel!
    private(set) var settings: SettingsViewModel!
    let workspaceLaunch = WorkspaceLaunchViewModel(launcher: NativeWorkspaceCommandLauncher())
    public private(set) var projects: [Project] = []
    public private(set) var connection = "Connecting"
    public private(set) var error: String?
    public private(set) var lastUpdate: Date?
    public private(set) var backendAddress = ""
    private(set) var sessions: [WorkspaceSession] = []
    private(set) var tabs: [SavedTab] = []
    var selection: SidebarDestination { coordinator.selection }
    private(set) var terminals: [String: TerminalSession] = [:]
    private(set) var projectModels: [String: ProjectPageViewModel] = [:]
    private(set) var changingSessions: Set<String> = []
    private(set) var buildModels: [String: BuildWorkspaceViewModel] = [:]
    private(set) var historyModels: [String: GitHistoryViewModel] = [:]
    private(set) var diffModels: [String: DiffViewModel] = [:]
    private(set) var workflowRuns: [String: WorkflowRunViewModel] = [:]
    private(set) var pageWorkflowRuns: [String: WorkflowRunViewModel] = [:]
    @ObservationIgnored private var pageWorkflowTargets: [String: WorkflowPageTarget] = [:]
    @ObservationIgnored private var preparingWorkflowPages: Set<String> = []
    @ObservationIgnored private var pendingPins: Set<String> = []
    @ObservationIgnored private var removalLocks: [UUID: Set<String>] = [:]
    @ObservationIgnored private var owner: BackendProcess?
    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshPending = false
    @ObservationIgnored private var started = false

    public convenience init() { self.init(creationFactory: NativeCreationFlowFactory()) }

    init(creationFactory: any CreationFlowFactory, desktop: any DesktopActions = NativeDesktopActions(),
         workspaceFactory: any WorkspaceFeatureFactory = NativeWorkspaceFeatureFactory(),
         rootFactory: any RootFeatureFactory = NativeRootFeatureFactory(),
         selectionStore: any SidebarSelectionPersisting = UserDefaultsSidebarSelectionStore(),
         router: any DeepLinkRouting = TaskHubRouter()) {
        self.creationFactory = creationFactory
        self.desktop = desktop
        self.workspaceFactory = workspaceFactory
        coordinator = AppCoordinator(factory: creationFactory, selectionStore: selectionStore, router: router,
            canOpenExternalRoute: {
                NSApplication.shared.modalWindow == nil && !NSApplication.shared.windows.contains { $0.attachedSheet != nil }
            })
        viewer = ViewerStore(cacheURL: try? PtydConfiguration.current().directory.appendingPathComponent("page-tabs.json"),
                             memoryPressure: NativeMemoryPressureMonitor(), pageFactory: BrowserPageFactory(desktop: desktop))
        viewer.setPageLimit(shell.remotePageLimit)
        shell.remotePageLimitChanged = { [weak viewer] in viewer?.setPageLimit($0) }
        dashboard = DashboardViewModel(openPage: { [weak self] request in
            guard let self else { throw BackendError.operation("The workspace has closed.") }
            try await self.openPage(request)
        }, openBrowser: { desktop.openBrowser($0) }, copy: {
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString($0, forType: .string)
        })
        logs = LogsViewModel(openPage: { [weak self] request in
            guard let self else { throw BackendError.operation("The workspace has closed.") }
            try await self.openPage(request)
        }, copy: {
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString($0, forType: .string)
        })
        settings = SettingsViewModel(clis: CLISettingsViewModel(copy: {
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString($0, forType: .string)
        }, openBrowser: { desktop.openBrowser($0) }), diagnostics: DiagnosticsViewModel(),
            loginItem: LoginItemViewModel(service: NativeLoginItemService()), fonts: FontSettingsViewModel(catalog: InstalledCodeFontCatalog()),
            resources: ResourceUsageViewModel(), didSave: { [weak self] patch in
            guard let self else { return }
            if patch["jira_base_url"] != nil || patch["jira_api_token"] != nil {
                for model in projectModels.values { await model.tickets?.invalidateSite() }
            }
        })
        viewer.prepareContext = { [weak self] context in
            guard let self else { return }
            context.configureWorkspace(factory: workspaceFactory, service: self)
            if let model = context.workspaceViewModel { coordinator.bindWorkspace(model, context: context, runtime: self) }
        }
        root = coordinator.makeRoot(factory: rootFactory, runtime: self, shell: shell, viewer: viewer)
    }

    var sidebarEntries: [SidebarEntry] {
        SidebarEntry.make(projects: projects, sessions: sessions, tabs: tabs,
            workflowProgress: workflowRuns.filter { $0.value.running }.mapValues { "\($0.step)/\($0.total)" })
    }
    var activeTerminalKey: String? {
        switch selection {
        case .terminal: "scratch"
        case .session(let id): "task:\(id)"
        default: nil
        }
    }
    var terminal: TerminalSession? { activeTerminalKey.flatMap { terminals[$0] } }
    public var hasOpenWork: Bool { !sessions.isEmpty || !tabs.isEmpty }
    public var hasActivePage: Bool { viewer.active?.activeID != nil }
    var activeHistory: GitHistoryViewModel? {
        guard let context = viewer.active, context.pane == .diff, context.reviewSection == .history else { return nil }
        return historyModels[context.id]
    }
    var sessionOperations: SessionOperations? { api.map { SessionOperations(api: $0) } }

    func showChanges(for session: WorkspaceSession, context: WorkspaceContext) {
        if context.pane == .diff { context.setPane(.term); return }
        prepareChanges(for: session, context: context)
        if diffModels[context.id] != nil { context.setPane(.diff) }
    }

    func prepareChanges(for session: WorkspaceSession, context: WorkspaceContext) {
        if context.reviewSection == .history, let api {
            let base = dashboard.projects.flatMap(\.prs).first(where: { $0.url == session.url })?.baseRefName
            if let history = historyModels[context.id] { if let base { history.updateBase(base) } }
            else {
                historyModels[context.id] = GitHistoryViewModel(worktree: session.worktree, baseURL: api.baseURL, base: base ?? "",
                    service: APIGitHistoryService(api: api), copy: {
                        NSPasteboard.general.clearContents(); NSPasteboard.general.setString($0, forType: .string)
                    })
            }
        }
        if diffModels[context.id] == nil {
            guard let api else { context.error = "Connect to the backend to load changes."; return }
            diffModels[context.id] = DiffViewModel(worktree: session.worktree, baseURL: api.baseURL,
                                                   service: APIDiffService(api: api), actionsService: APIGitChangesService(api: api), openFile: { [weak context] location in
                context?.openFile(location.path, line: location.line, column: location.column)
            })
        }
    }

    func projectEditor(for project: Project) -> ProjectEditorViewModel? {
        guard let api else { return nil }
        return creationFactory.projectEditor(project: project, service: APIProjectService(api: api),
            didSave: { [weak self] in self?.savedProject($0) }, didDelete: { [weak self] id in
                guard let self else { return }
                projects.removeAll { $0.id == id }
                if let removed = projectModels.removeValue(forKey: id) {
                    removed.board?.suspend()
                    Task { await removed.automation?.stop(); await removed.workflows?.stop(); await removed.tickets?.stop() }
                }
                select(.overview); refresh()
            })
    }

    private func savedProject(_ project: Project) {
        if let index = projects.firstIndex(where: { $0.id == project.id }) { projects[index] = project }
        else { projects.append(project) }
        projectModels[project.id]?.update(project)
        for session in sessions where session.projectId == project.id {
            buildModels.removeValue(forKey: "task:\(session.id)")?.disconnect()
        }
        select(.project(project.id))
        refresh()
    }

    private var sessionCreationRequest: SessionCreationRequest {
        let selected: String
        switch selection {
        case .project(let id): selected = id
        case .session(let id): selected = sessions.first { $0.id == id }?.projectId ?? ""
        default: selected = projects.count == 1 ? projects[0].id : ""
        }
        let pageURL: String? = if case .tab(let url) = selection { url } else { nil }
        return SessionCreationRequest(projects: projects, selectedProject: selected, agent: shell.defaultAgent, pageURL: pageURL)
    }

    public func canPerform(_ command: ShellCommand) -> Bool {
        switch command {
        case .newProject: connection == "Connected" && coordinator.canPresent
        case .newSession: connection == "Connected" && coordinator.canPresent && !projects.isEmpty && pageWorkflowRuns[viewer.activeContextID ?? ""]?.running != true
        case .back: viewer.active?.activePage?.canGoBack == true
        case .forward: viewer.active?.activePage?.canGoForward == true
        case .openFile: viewer.active != nil && connection == "Connected"
        case .saveFile: viewer.active?.activeDocument?.loaded == true && viewer.active?.activeDocument?.readOnly == false
        case .findPage: activeHistory != nil || hasActivePage
        case .zoomIn, .zoomOut, .resetZoom: viewer.active?.activePage != nil
        case .nextPage, .previousPage: (viewer.active?.tabOrder.count ?? 0) > 1
        case .biggerFont, .smallerFont, .resetFont: fontTarget != nil
        case .refresh: connection == "Connected"
        default: true
        }
    }

    public func perform(_ command: ShellCommand) {
        if [.overview, .activity, .settings, .terminal].contains(command) { coordinator.discardQueuedDeepLink() }
        switch command {
        case .newProject:
            guard canPerform(.newProject), let api else { return }
            coordinator.presentNewProject(service: APIProjectService(api: api), didSave: { [weak self] in self?.savedProject($0) })
        case .newSession:
            guard canPerform(.newSession) else { return }
            coordinator.presentNewSession(request: sessionCreationRequest, operations: sessionOperations,
                                           didCreate: { [weak self] in self?.createdSession($0) })
        case .openFile: if let context = viewer.active { viewer.openFile(in: context) }
        case .saveFile: if let document = viewer.active?.activeDocument { Task { await document.save() } }
        case .closePage: if let context = viewer.active, let id = context.activeID, let tab = context.tab(id) { context.close(tab) }
        case .findPage:
            if let history = activeHistory { history.find() }
            else if let document = viewer.active?.activeDocument { document.find() }
            else { viewer.active?.findVisible = true }
        case .back: viewer.active?.activePage?.back()
        case .forward: viewer.active?.activePage?.forward()
        case .nextPage: viewer.active?.cycle(1)
        case .previousPage: viewer.active?.cycle(-1)
        case .zoomIn: viewer.active?.activePage?.zoom(0.1)
        case .zoomOut: viewer.active?.activePage?.zoom(-0.1)
        case .resetZoom: viewer.active?.activePage?.zoom(nil)
        case .overview: select(.overview)
        case .activity: select(.activity)
        case .settings: select(.settings)
        case .terminal:
            if activeTerminalKey == nil { select(.terminal) }
            openTerminal()
            viewer.active?.setPane(.term)
            terminal?.showsSurface = true
            terminal?.surface.requestFocus()
        case .refresh: refresh()
        case .biggerFont: if let kind = fontTarget { shell.setFont(kind, size: shell.font(kind).size + 1) }
        case .smallerFont: if let kind = fontTarget { shell.setFont(kind, size: shell.font(kind).size - 1) }
        case .resetFont: if let kind = fontTarget { shell.setFont(kind, size: kind.defaultSize) }
        default: break
        }
    }

    private var fontTarget: CodeFontKind? {
        if selection == .settings && settings.section == .general { return .diff }
        if let context = viewer.active {
            if context.pane == .diff { return .diff }
            let hasTerminal = context.id == "scratch" || sessions.contains { "task:\($0.id)" == context.id }
            if context.activeDocument != nil && (!hasTerminal || context.pane == .term) { return .diff }
        }
        return terminal?.ready == true && terminal?.showsSurface == true ? .term : nil
    }

    func selectTrayTab(_ tab: SavedTab) {
        if let session = sessions.first(where: { $0.url == tab.url }) { select(.session(session.id)) }
        else { select(.tab(tab.url)) }
    }

    func revealWorktree(_ session: WorkspaceSession) {
        desktop.reveal(URL(fileURLWithPath: session.worktree))
    }

    func addPage(in context: WorkspaceContext) {
        coordinator.presentAddPage(openPage: { [weak self, weak context] address in
            guard let self, let context, viewer.contexts[context.id] === context else { return false }
            return context.open(address) != nil
        })
    }

    func openTrayReview(_ pr: TrayPR, dismiss: () -> Void) {
        guard !shell.acknowledging.contains(pr.id), let url = pr.webURL, desktop.openBrowser(url) else { return }
        shell.acknowledge(pr)
        dismiss()
    }

    var trayTabGroups: [TrayTabGroup] { TrayTabGroup.make(tabs: tabs, prs: shell.prs) }

    func openPage(_ request: OpenPageRequest) async throws {
        guard safeWebURL(request.url) != nil else { throw BackendError.operation("Invalid page address.") }
        if let session = sessions.first(where: { $0.url == request.url }) {
            select(.session(session.id))
            viewer.active?.open(request.url, title: request.title)
            return
        }
        guard let api else { throw BackendError.operation("Connect before opening a page.") }
        let saved: SavedTabs = try await api.request(Routes.TABS, method: "POST", body: request)
        tabs = saved.tabs
        select(.tab(request.url))
        viewer.active?.open(request.url, title: request.title)
    }

    public func trayWillOpen() {
        shell.notifications.refreshAuthorization()
        refresh()
        shell.refreshUsage()
        shell.loadSettings()
    }

    func select(_ destination: SidebarDestination) {
        coordinator.navigate(to: destination)
    }

    func activateRootDestination() { showSelectedContext() }
    func openRootBrowser(_ url: URL) { _ = desktop.openBrowser(url) }

    private func showSelectedContext() {
        switch selection {
        case .project(let id):
            viewer.deactivate()
            if let project = projects.first(where: { $0.id == id }), let api {
                if let model = projectModels[id] { model.update(project) }
                else if let editor = projectEditor(for: project) {
                    let board = WebBoardViewModel(projectID: id, baseURL: api.baseURL, openPage: { [weak self] request in
                        guard let self else { throw BackendError.operation("The workspace has closed.") }
                        try await self.openPage(request)
                    }, openBrowser: { [desktop] in desktop.openBrowser($0) })
                    let tickets = JiraTicketsViewModel(project: project, service: APIJiraService(api: api), openPage: { [weak self] request in
                        guard let self else { throw BackendError.operation("The workspace has closed.") }
                        try await self.openPage(request)
                    }, openBrowser: { [desktop] in desktop.openBrowser($0) }, copy: {
                        NSPasteboard.general.clearContents(); NSPasteboard.general.setString($0, forType: .string)
                    })
                    let workflows = WorkflowEditorViewModel(project: project, service: APIWorkflowService(api: api), didSave: { [weak self] value in
                        guard let self else { return }
                        if let index = projects.firstIndex(where: { $0.id == value.id }) { projects[index] = value }
                        projectModels[value.id]?.update(value)
                        refresh()
                    })
                    let automation = AutomationViewModel(project: project, service: APIAutomationService(api: api), didSave: { [weak self] value in
                        guard let self else { return }
                        if let index = projects.firstIndex(where: { $0.id == value.id }) { projects[index] = value }
                        projectModels[value.id]?.update(value)
                        refresh()
                    })
                    projectModels[id] = ProjectPageViewModel(project: project, service: APIProjectService(api: api), editor: editor, board: board,
                                                           tickets: tickets, workflows: workflows, automation: automation)
                }
            }
        case .session(let id):
            if let session = sessions.first(where: { $0.id == id }) {
                viewer.select(id: "task:\(id)", url: session.url, title: session.title, legacy: tabs.first { $0.url == session.url })
                _ = workflowRunModel(for: session)
            } else { viewer.deactivate() }
        case .terminal:
            viewer.select(id: "scratch", url: "", title: "Terminal")
        case .tab(let url):
            let context = viewer.select(id: "tab:\(url)", url: url, title: tabs.first { $0.url == url }?.title ?? url, legacy: tabs.first { $0.url == url })
            preparePageWorkflowModel(context)
        default: viewer.deactivate()
        }
    }

    func openTerminal() {
        guard let key = activeTerminalKey, terminals[key] == nil else { return }
        if case .session(let id) = selection, let record = sessions.first(where: { $0.id == id }) {
            guard !changingSessions.contains(id) else { return }
            terminals[key] = makeTerminal(record)
        } else if selection == .terminal {
            let terminal = TerminalSession()
            wireLinks(terminal, contextID: "scratch")
            terminals[key] = terminal
        }
    }

    private func workflowRunModel(for record: WorkspaceSession) -> WorkflowRunViewModel? {
        guard let api, let project = projects.first(where: { $0.id == record.projectId }) else { return nil }
        if let existing = workflowRuns[record.id] { existing.update(project.workflows ?? []); return existing }
        let model = WorkflowRunViewModel(recipes: project.workflows ?? [], service: APIWorkflowRunService(api: api), context: { [weak self] in
            let latest = self?.sessions.first { $0.id == record.id } ?? record
            let project = self?.projects.first { $0.id == record.projectId } ?? project
            return WorkflowRunContext.values(project: project, session: latest)
        }, prepare: { [weak self] cli in
            guard let self else { throw BackendError.operation("The workspace closed.") }
            return try await prepareWorkflowTerminal(sessionID: record.id, cli: cli)
        })
        workflowRuns[record.id] = model
        return model
    }

    func workflowModel(in context: WorkspaceContext) -> WorkflowRunViewModel? {
        if let record = sessions.first(where: { "task:\($0.id)" == context.id }) { return workflowRuns[record.id] }
        return pageWorkflowRuns[context.id]
    }

    private func preparePageWorkflowModel(_ context: WorkspaceContext) {
        guard let api, let target = WorkflowPageTarget.resolve(url: context.sourceURL, projects: projects),
              let project = projects.first(where: { $0.id == target.projectID }) else {
            if pageWorkflowRuns[context.id]?.running != true {
                pageWorkflowRuns.removeValue(forKey: context.id); pageWorkflowTargets.removeValue(forKey: context.id)
            }
            return
        }
        if let model = pageWorkflowRuns[context.id], pageWorkflowTargets[context.id] == target || model.running {
            if pageWorkflowTargets[context.id] == target { model.update(project.workflows ?? []) }
            return
        }
        let sourceID = context.id
        var preparedSession: WorkspaceSession?
        let service = APIWorkflowPagePreparation(operations: SessionOperations(api: api))
        let model = WorkflowRunViewModel(recipes: project.workflows ?? [], service: APIWorkflowRunService(api: api), context: { [weak self] in
            guard let preparedSession else { return [:] }
            let latest = self?.sessions.first { $0.id == preparedSession.id } ?? preparedSession
            let project = self?.projects.first { $0.id == target.projectID } ?? project
            return WorkflowRunContext.values(project: project, session: latest)
        }, prepare: { [weak self] cli in
            guard let self else { throw BackendError.operation("The workspace closed.") }
            if let preparedSession {
                return try await prepareWorkflowTerminal(sessionID: preparedSession.id, cli: cli)
            }
            let record = try await prepareWorkflowPage(target, sourceID: sourceID, service: service)
            preparedSession = record
            try Task.checkCancellation()
            return try await prepareWorkflowTerminal(sessionID: record.id, cli: cli)
        })
        pageWorkflowRuns[sourceID] = model
        pageWorkflowTargets[sourceID] = target
    }

    private func prepareWorkflowPage(_ target: WorkflowPageTarget, sourceID: String,
                                     service: any WorkflowPagePreparing) async throws -> WorkspaceSession {
        guard let project = projects.first(where: { $0.id == target.projectID }),
              WorkflowPageTarget.resolve(url: target.page.url, projects: projects) == target,
              let model = pageWorkflowRuns[sourceID],
              preparingWorkflowPages.insert(target.identity).inserted else {
            throw BackendError.operation("The page's project changed or another workflow is preparing this page.")
        }
        defer { preparingWorkflowPages.remove(target.identity) }
        let record: WorkspaceSession
        if let existing = sessions.first(where: target.matches) {
            guard workflowRuns[existing.id]?.running != true, !changingSessions.contains(existing.id) else {
                throw BackendError.operation("This page already has an active session operation. Open its session to continue.")
            }
            record = existing
        } else {
            record = try await service.prepare(target, project: project)
        }
        // Once creation succeeds, retain the durable result even when Stop raced
        // the HTTP response. Cancellation is checked before any agent startup.
        if !sessions.contains(where: { $0.id == record.id }) { sessions.append(record) }
        let destination = "task:\(record.id)"
        let wasSelected = selection == .tab(target.page.url)
        try viewer.promoteContext(from: sourceID, to: destination)
        pageWorkflowRuns.removeValue(forKey: sourceID)
        pageWorkflowTargets.removeValue(forKey: sourceID)
        workflowRuns[record.id] = model
        if wasSelected { select(.session(record.id)) }
        refresh()
        return record
    }

    func openWorkflowHookSettings() {
        settings.section = .clis; select(.settings); settings.clis.refresh()
    }

    private func prepareWorkflowTerminal(sessionID: String, cli: WorkflowCLI) async throws -> any WorkflowTerminal {
        guard let operations = sessionOperations, var record = sessions.first(where: { $0.id == sessionID }),
              !record.worktree.isEmpty, changingSessions.insert(sessionID).inserted else {
            throw BackendError.operation("The session is unavailable or another session operation is in progress.")
        }
        defer { changingSessions.remove(sessionID) }
        let key = "task:\(sessionID)"
        if let existing = terminals[key] {
            try await existing.waitForAutomaticLaunch()
            guard let latest = sessions.first(where: { $0.id == sessionID }) else {
                throw BackendError.operation("The session was removed during agent startup.")
            }
            record = latest
            if try await !existing.atShell(), record.cli != cli.rawValue {
                throw BackendError.operation("Another agent is running. Return to the shell before switching to \(cli.title).")
            }
        }
        try Task.checkCancellation()
        record = try await operations.configureAgent(cli, session: record)
        if let index = sessions.firstIndex(where: { $0.id == record.id }) { sessions[index] = record }
        try Task.checkCancellation()
        let terminal: TerminalSession
        if let existing = terminals[key] { terminal = existing }
        else { terminal = makeTerminal(record); terminals[key] = terminal }
        // Retained native panes mount the new surface even if navigation changes.
        await terminal.start()
        try await terminal.waitForAutomaticLaunch()
        if try await terminal.atShell() {
            try await launchAgent(terminal, record: record, fresh: false)
        }
        try await Task.sleep(for: .seconds(2))
        try Task.checkCancellation()
        let latest = sessions.first { $0.id == sessionID } ?? record
        return try await NativeWorkflowTerminal(terminal: terminal, cli: cli, sessionID: latest.sessionId)
    }

    func removalModel(for record: WorkspaceSession) -> SessionRemovalViewModel? {
        guard let api else { return nil }
        let operationID = UUID()
        let service = SessionRemovalService(api: api, stopTerminals: { [weak self] keys in
            guard let self else { throw BackendError.operation("The workspace closed before removal.") }
            try await self.stopForRemoval(keys, operationID: operationID)
        })
        return workspaceFactory.removal(service: service, record: record, projects: projects, sessions: sessions,
            didRemove: { [weak self] removed in
                guard let self else { return }
                for record in removed {
                    let key = "task:\(record.id)"
                    buildModels.removeValue(forKey: key)?.disconnect()
                    diffModels.removeValue(forKey: key)?.disconnect()
                    historyModels.removeValue(forKey: key)?.hide()
                    terminals.removeValue(forKey: "build:\(record.url)")?.disconnect()
                    terminals.removeValue(forKey: key)?.disconnect()
                    await viewer.remove(id: key)
                }
                sessions.removeAll { record in removed.contains { $0.id == record.id } }
                select(.overview)
                refresh()
            }, finished: { [weak self] in
                if let self, let ids = removalLocks.removeValue(forKey: operationID) { changingSessions.subtract(ids) }
                self?.refresh()
            })
    }

    func buildModel(for record: WorkspaceSession, context: WorkspaceContext) -> BuildWorkspaceViewModel? {
        if let existing = buildModels[context.id] { return existing }
        guard let api, let project = projects.first(where: { $0.id == record.projectId }), project.ide == "xcode" else { return nil }
        let model = workspaceFactory.build(api: api, project: project, session: record, terminalFactory: { [weak self] in
            guard let self else { throw BackendError.operation("The workspace closed before the build could start.") }
            let key = "build:\(record.url)"
            if let terminal = terminals[key] { return terminal }
            let terminal = TerminalSession(pairKey: key, cwd: record.worktree, paired: true)
            wireLinks(terminal, contextID: context.id)
            terminals[key] = terminal
            return terminal
        }, reveal: { [weak context] in context?.setPane(.build) })
        buildModels[context.id] = model
        return model
    }

    private func stopForRemoval(_ keys: Set<String>, operationID: UUID) async throws {
        let ids = Set(sessions.filter { keys.contains($0.id) }.map(\.id))
        guard changingSessions.isDisjoint(with: ids) else { throw BackendError.operation("A session operation is already in progress.") }
        changingSessions.formUnion(ids)
        removalLocks[operationID] = ids
        let worktrees = sessions.filter { ids.contains($0.id) }.map(\.worktree)
        guard !diffModels.values.contains(where: { model in
            worktrees.contains(model.worktree) && model.actions?.busy == true
        }) else {
            changingSessions.subtract(ids); removalLocks.removeValue(forKey: operationID)
            throw BackendError.operation("Wait for the Git operation to finish before removing this worktree.")
        }
        guard await viewer.closeDocuments(contextIDs: Set(ids.map { "task:\($0)" }), worktrees: worktrees) else {
            changingSessions.subtract(ids); removalLocks.removeValue(forKey: operationID)
            throw CancellationError()
        }
        for id in ids {
            await workflowRuns.removeValue(forKey: id)?.stop()
            workspaceLaunch.cancel(sessionID: id)
            buildModels.removeValue(forKey: "task:\(id)")?.disconnect()
        }
        for (key, terminal) in terminals where keys.contains(terminal.pairKey) {
            await terminal.stopConnecting()
            if terminals[key] === terminal { terminals.removeValue(forKey: key) }
        }
        try await PtydHost(configuration: PtydConfiguration.current()).stopPaired(keys: keys)
    }

    private func makeTerminal(_ record: WorkspaceSession, fresh: Bool = false) -> TerminalSession {
        let terminal = TerminalSession(pairKey: record.id, cwd: record.worktree, paired: true)
        terminal.agentTurns.setStreamAvailable(connection == "Connected")
        wireLinks(terminal, contextID: "task:\(record.id)")
        terminal.onCreated = { [weak self] terminal in
            guard let self else { return }
            try await launchAgent(terminal, record: record, fresh: fresh)
        }
        return terminal
    }

    private func launchAgent(_ terminal: TerminalSession, record: WorkspaceSession, fresh: Bool) async throws {
        let latest = self.sessions.first { $0.id == record.id } ?? record
        let agent = SessionAgent(rawValue: latest.cli ?? "") ?? .shell
        var id = latest.sessionId
        var firstLaunch = fresh
        if agent == .claude && (id == nil || id == "") {
            guard let operations = self.sessionOperations else { throw BackendError.operation("Connect before starting the agent.") }
            let newID = UUID().uuidString.lowercased()
            try await operations.saveAgentID(newID, session: latest)
            id = newID; firstLaunch = true
            if let index = self.sessions.firstIndex(where: { $0.id == latest.id }) { self.sessions[index].sessionId = newID }
        }
        if let command = agent.command(sessionID: id, fresh: firstLaunch) {
            try await terminal.submit(command)
            terminal.launchedAgent = WorkflowCLI(rawValue: agent.rawValue)
            terminal.launchedAgentForeground = nil
            for _ in 0..<100 {
                let foreground = try await terminal.workflowForeground()
                if !foreground.atShell {
                    terminal.launchedAgentForeground = foreground; break
                }
                try await Task.sleep(for: .milliseconds(20))
            }
        }
    }

    private func wireLinks(_ terminal: TerminalSession, contextID: String) {
        terminal.openLink = { [weak self] raw, directory, external in
            guard let self, let context = viewer.contexts[contextID] else { return }
            guard let link = WorkspaceLink.parse(raw, directory: directory, home: NSHomeDirectory()) else {
                context.error = "This terminal link is not a supported web or local file address."
                return
            }
            if external, case .web(let url) = link {
                desktop.openBrowser(url)
                return
            }
            if contextID == "scratch" { select(.terminal) }
            else if let record = sessions.first(where: { "task:\($0.id)" == contextID }) { select(.session(record.id)) }
            context.error = nil
            switch link {
            case .web(let url): context.open(url.absoluteString)
            case .file(let location): context.openFile(location.path, line: location.line, column: location.column)
            }
        }
    }

    func createdSession(_ session: WorkspaceSession) {
        if !sessions.contains(where: { $0.id == session.id }) { sessions.append(session) }
        select(.session(session.id))
        terminals["task:\(session.id)"] = makeTerminal(session, fresh: true)
        refresh()
    }

    func restartSession(_ record: WorkspaceSession) {
        guard changingSessions.insert(record.id).inserted else { return }
        Task {
            defer { changingSessions.remove(record.id) }
            do {
                let key = "task:\(record.id)"
                await workflowRuns.removeValue(forKey: record.id)?.stop()
                await terminals[key]?.stopConnecting()
                let host = PtydHost(configuration: try PtydConfiguration.current())
                try await host.stopPaired(keys: [record.id])
                terminals[key] = makeTerminal(sessions.first { $0.id == record.id } ?? record)
            } catch { self.error = "Could not restart session: \(error.localizedDescription)" }
        }
    }

    func reattachTerminal() {
        if let key = activeTerminalKey { reattachTerminal(key: key) }
    }

    func reattachTerminal(key: String) {
        guard let previous = terminals[key] else { return }
        guard !changingSessions.contains(previous.pairKey) else { return }
        Task {
            await workflowRuns.removeValue(forKey: previous.pairKey)?.stop()
            await previous.stopConnecting()
            if terminals[key] === previous {
                if let record = sessions.first(where: { $0.id == previous.pairKey }) { terminals[key] = makeTerminal(record) }
                else {
                    let replacement = TerminalSession(pairKey: previous.pairKey, cwd: previous.cwd, paired: previous.paired)
                    replacement.openLink = previous.openLink
                    terminals[key] = replacement
                }
            }
        }
    }

    func togglePin(_ id: String) {
        guard let api, let record = sessions.first(where: { $0.id == id }), pendingPins.insert(id).inserted else { return }
        Task {
            defer { pendingPins.remove(id) }
            do {
                try await api.setPinned(!record.pinned, for: id)
                if let index = sessions.firstIndex(where: { $0.id == id }) { sessions[index].pinned = !record.pinned }
                refresh()
            } catch { self.error = "Could not update pin: \(error.localizedDescription)" }
        }
    }

    public func quit() async throws {
        try await prepareToTerminate(stopShells: true)
    }

    /// An app update reconnects to the detached daemon on launch. Explicit tray
    /// Quit remains the only normal lifecycle action that reaps its shells.
    public func prepareForUpdate() async throws {
        try await prepareToTerminate(stopShells: false)
    }

    private func prepareToTerminate(stopShells: Bool) async throws {
        let actions = diffModels.values.compactMap(\.actions)
        for action in actions { await action.suspendAndWait() }
        defer { actions.forEach { $0.resume() } }
        guard await viewer.closeDocuments() else { throw CancellationError() }
        for model in workflowRuns.values { await model.stop() }
        for model in pageWorkflowRuns.values { await model.stop() }
        for terminal in terminals.values { await terminal.stopConnecting() }
        if stopShells {
            let host = PtydHost(configuration: try PtydConfiguration.current())
            try await host.stopExisting()
        }
        for terminal in terminals.values { terminal.disconnect() }
        await stop()
    }

    public func start() async {
        guard !started else { return }
        coordinator.setRoutingReady(false)
        started = true
        settings.resources.connect(NativeResourceUsageService(api: nil, pty: try? PtydConfiguration.current()))
        do {
            let config = try BackendConfiguration.current()
            backendAddress = config.baseURL.absoluteString
            let process = BackendProcess(configuration: config)
            owner = process
            api = try await process.start()
            guard started else { await process.stop(); return }
            if let api { shell.connect(api); viewer.connect(api); dashboard.connect(APIDashboardService(api: api)); shell.refreshUsage() }
            if let api { for model in projectModels.values {
                model.connect(APIProjectService(api: api)); model.board?.connect(baseURL: api.baseURL)
                model.tickets?.connect(APIJiraService(api: api))
                model.workflows?.connect(APIWorkflowService(api: api))
                model.automation?.connect(APIAutomationService(api: api))
            } }
            if let api { logs.connect(APILogService(api: api)) }
            if let api { for model in historyModels.values { model.connect(baseURL: api.baseURL, service: APIGitHistoryService(api: api)) } }
            if let api { for model in diffModels.values { model.connect(baseURL: api.baseURL, service: APIDiffService(api: api)); model.actions?.connect(APIGitChangesService(api: api)) } }
            if let api {
                settings.connect(APISettingsService(api: api))
                settings.clis.connect(APICLISettingsService(api: api))
                settings.diagnostics.connect(APIDiagnosticsService(api: api))
                settings.resources.connect(NativeResourceUsageService(api: api, pty: try? PtydConfiguration.current()))
                workspaceLaunch.connect(APIWorkspaceTargetService(api: api))
                if selection == .settings { settings.refresh() }
                if selection == .settings && settings.section == .clis { settings.clis.refresh() }
            }
            startStream(baseURL: config.baseURL)
        } catch {
            connection = "Disconnected"
            self.error = error.localizedDescription
            started = false
        }
    }

    public func refresh() {
        shell.refresh()
        dashboard.refresh()
        if selection == .activity { logs.refresh() }
        if case .project(let id) = selection, let model = projectModels[id], model.section == .board {
            model.board?.refresh()
        }
        if case .project(let id) = selection, let model = projectModels[id], model.section == .tickets {
            model.tickets?.refresh()
        }
        refreshPending = true
        guard refreshTask == nil, let api else { return }
        refreshTask = Task { [weak self] in
            guard let self else { return }
            defer { refreshTask = nil }
            while refreshPending && !Task.isCancelled {
                refreshPending = false
                do {
                    async let projectRequest: [Project] = api.get(Routes.PROJECTS)
                    async let sessionRequest: [WorkspaceSession] = api.get(Routes.TASKS)
                    async let tabRequest: SavedTabs = api.get(Routes.TABS)
                    let (snapshot, sessionSnapshot, tabSnapshot) = try await (projectRequest, sessionRequest, tabRequest)
                    try Task.checkCancellation()
                    if projects != snapshot { projects = snapshot }
                    if sessions != sessionSnapshot {
                        let retained = Set(sessionSnapshot.map(\.id))
                        for session in sessions where !retained.contains(session.id) {
                            workspaceLaunch.cancel(sessionID: session.id)
                            await workflowRuns.removeValue(forKey: session.id)?.stop()
                        }
                        sessions = sessionSnapshot
                    }
                    if tabs != tabSnapshot.tabs { tabs = tabSnapshot.tabs }
                    showSelectedContext()
                    if case .project(let id) = selection, let model = projectModels[id], model.section == .prs && model.state == "open" {
                        await model.refresh()
                    }
                    if !sidebarEntries.flatMap(\.descendants).contains(where: { $0.destination == selection }),
                       pageWorkflowRuns[viewer.activeContextID ?? ""]?.running != true { select(.overview) }
                    lastUpdate = Date()
                    error = nil
                    coordinator.setRoutingReady(started && connection == "Connected")
                } catch {
                    if !Task.isCancelled { self.error = error.localizedDescription; coordinator.setRoutingReady(false) }
                }
            }
        }
    }

    public func reconnect() async {
        await stop()
        await start()
    }

    private func startStream(baseURL: URL) {
        streamTask = Task { [weak self] in
            let stream = SSEClient()
            var delay = 1
            while !Task.isCancelled {
                do {
                    try await stream.consume(from: baseURL, onConnect: { [weak self] in
                        await self?.connected()
                    }, onEvent: { [weak self] event in
                        await self?.received(event)
                    })
                    delay = 1
                } catch {
                    if Task.isCancelled { break }
                    self?.error = error.localizedDescription
                }
                self?.terminals.values.forEach { $0.agentTurns.setStreamAvailable(false) }
                self?.connection = "Reconnecting"
                self?.coordinator.setRoutingReady(false)
                do { try await Task.sleep(for: .seconds(delay)) } catch { break }
                delay = min(delay * 2, 15)
            }
        }
    }

    private func connected() {
        guard started else { return }
        connection = "Connected"
        terminals.values.forEach { $0.agentTurns.setStreamAvailable(true) }
        refresh() // SSE has no replay IDs: refresh the snapshot on every reconnect.
        settings.diagnostics.invalidate()
    }

    private func received(_ event: ServerEvent) {
        if ["agent-turn-start", "agent-turn-done"].contains(event.type), let runID = event.runId,
           let terminal = terminals.values.first(where: { $0.termID == runID }),
           let session = sessions.first(where: { $0.id == terminal.pairKey }), event.cli == session.cli,
           terminal.agentTurns.receive(event) {
            if let id = event.sessionId, !id.isEmpty, id != session.sessionId, event.cli == session.cli,
               let operations = sessionOperations {
                Task {
                    do {
                        try await operations.saveAgentID(id, session: session)
                        if let index = sessions.firstIndex(where: { $0.id == session.id }) { sessions[index].sessionId = id }
                    } catch { self.error = "Could not save agent session: \(error.localizedDescription)" }
                }
            }
        }
        if event.type == "activity", let activity = event.event {
            shell.notifications.receiveActivity(activity, enabled: shell.activityNotify)
            if selection == .activity { logs.refresh() }
        }
        if event.type == "settings" { shell.loadSettings() }
        if event.type == "config" { settings.refresh() }
        if ["sync", "jira-sync", "activity", "config", "reload"].contains(event.type) { settings.diagnostics.invalidate() }
        if event.type == "reviews" { shell.refresh() }
        if ["sync", "jira-sync", "tabs", "tasks", "reload"].contains(event.type) { refresh() }
    }

    public func stop() async {
        started = false
        coordinator.setRoutingReady(false)
        for model in pageWorkflowRuns.values { await model.stop() }
        pageWorkflowRuns.removeAll()
        pageWorkflowTargets.removeAll()
        for model in workflowRuns.values { await model.stop() }
        workflowRuns.removeAll()
        terminals.values.forEach { $0.agentTurns.setStreamAvailable(false) }
        workspaceLaunch.stop()
        for model in diffModels.values { await model.actions?.suspendAndWait() }
        streamTask?.cancel()
        refreshTask?.cancel()
        await streamTask?.value
        await refreshTask?.value
        streamTask = nil
        refreshTask = nil
        await shell.stop()
        await dashboard.stop()
        await logs.stop()
        await settings.stop()
        for model in projectModels.values {
            await model.automation?.stop()
            await model.workflows?.stop()
            model.connect(nil); model.board?.pause(); await model.tickets?.stop()
        }
        await viewer.stop()
        for model in buildModels.values { model.disconnect() }
        buildModels.removeAll()
        for model in diffModels.values { model.disconnect() }
        diffModels.removeAll()
        for model in historyModels.values { model.hide() }
        historyModels.removeAll()
        await owner?.stop()
        api = nil
    }
}
