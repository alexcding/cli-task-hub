import AppKit
import Foundation
import Observation

@MainActor @Observable
public final class AppViewModel {
    public let shell: ShellStore
    @ObservationIgnored private let shellFactory: any ShellFeatureFactory
    @ObservationIgnored private let shellCoordinator: ShellCoordinator
    let viewer: ViewerStore
    let coordinator: AppCoordinator
    private(set) var root: RootViewModel!
    @ObservationIgnored private let creationFactory: any CreationFlowFactory
    @ObservationIgnored private let desktop: any DesktopActions
    @ObservationIgnored private let workspaceFactory: any WorkspaceFeatureFactory
    @ObservationIgnored private let projectFactory: any ProjectFeatureFactory
    @ObservationIgnored private let documentFactory: any DocumentFeatureFactory
    @ObservationIgnored private let trayFactory: any TrayFeatureFactory
    @ObservationIgnored private let copy: (String) -> Void
    var dashboard: DashboardViewModel? { coordinator.dashboardCoordinator?.model }
    var logs: LogsViewModel? { coordinator.logsCoordinator?.model }
    var settings: SettingsViewModel? { coordinator.settingsCoordinator?.model }
    let workspaceLaunch: WorkspaceLaunchViewModel
    /// The sidebar bell's "Today" popover.
    let todayActivity = TodayActivityViewModel()
    @ObservationIgnored private let platformFactory: any AppPlatformFactory
    @ObservationIgnored private let terminalControl: any TerminalRuntimeControlling
    public private(set) var projects: [Project] = []
    public private(set) var connection = "Connecting" { didSet { if oldValue != connection { updateWorkspaceReviewState() } } }
    public private(set) var error: String?
    public private(set) var lastUpdate: Date?
    public private(set) var backendAddress = ""
    private(set) var sessions: [WorkspaceSession] = [] { didSet { if oldValue != sessions { updateWorkspaceReviewState() } } }
    private(set) var tabs: [SavedTab] = []
    var selection: SidebarDestination { coordinator.selection }
    private(set) var terminals: [String: TerminalSession] = [:] {
        didSet { updateWorkspaceTerminalState() }
    }
    var projectModels: [String: ProjectPageViewModel] { coordinator.projectModels }
    private(set) var changingSessions: Set<String> = []
    /// PR / ticket pages whose session is being created right now (their Create Session is busy).
    private(set) var startingPages: Set<String> = []
    private(set) var buildModels: [String: BuildWorkspaceViewModel] = [:]
    private(set) var historyModels: [String: GitHistoryViewModel] = [:]
    private(set) var diffModels: [String: DiffViewModel] = [:]
    private(set) var workflowRuns: [String: WorkflowRunViewModel] = [:]
    private(set) var pageWorkflowRuns: [String: WorkflowRunViewModel] = [:]
    @ObservationIgnored private var pageWorkflowTargets: [String: WorkflowPageTarget] = [:]
    @ObservationIgnored private var preparingWorkflowPages: Set<String> = []
    @ObservationIgnored private var pendingPins: Set<String> = []
    @ObservationIgnored private var removalLocks: [UUID: Set<String>] = [:]
    @ObservationIgnored private let backendRuntime: any BackendRuntimeServing
    @ObservationIgnored private let backendFactory: any BackendFeatureFactory
    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var shutdownTask: Task<Void, Never>?
    @ObservationIgnored private var startGeneration = UUID()
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshPending = false
    @ObservationIgnored private var refreshRequestID = UUID()
    @ObservationIgnored private var started = false

    public convenience init() { self.init(creationFactory: NativeCreationFlowFactory()) }

    init(creationFactory: any CreationFlowFactory, desktop: any DesktopActions = NativeDesktopActions(),
         backendRuntime: any BackendRuntimeServing = BackendRuntime(),
         backendFactory: any BackendFeatureFactory = NativeBackendFeatureFactory(),
         shellFactory: any ShellFeatureFactory = NativeShellFeatureFactory(),
         platformFactory: any AppPlatformFactory = NativeAppPlatformFactory(),
         workspaceFactory: any WorkspaceFeatureFactory = NativeWorkspaceFeatureFactory(),
         rootFactory: any RootFeatureFactory = NativeRootFeatureFactory(),
         dashboardFactory: any DashboardFeatureFactory = NativeDashboardFeatureFactory(),
         logsFactory: any LogsFeatureFactory = NativeLogsFeatureFactory(),
         settingsFactory: (any SettingsFeatureFactory)? = nil,
         documentFactory: any DocumentFeatureFactory = NativeDocumentFeatureFactory(),
         documentClosePresenter: any EditorClosePresenting = NativeEditorClosePresenter(),
         browserDialogPresenter: any BrowserDialogPresenting = NativeBrowserDialogPresenter(),
         trayFactory: any TrayFeatureFactory = NativeTrayFeatureFactory(),
         notificationFactory: any NotificationFeatureFactory = NativeNotificationFeatureFactory(),
         selectionStore: any SidebarSelectionPersisting = UserDefaultsSidebarSelectionStore(),
         router: any DeepLinkRouting = TaskHubRouter(),
         projectFactory: (any ProjectFeatureFactory)? = nil,
         copy: @escaping (String) -> Void = { NativeClipboard.copy($0) }) {
        self.creationFactory = creationFactory
        self.backendRuntime = backendRuntime
        self.backendFactory = backendFactory
        self.platformFactory = platformFactory
        self.terminalControl = platformFactory.terminalControl()
        self.workspaceLaunch = platformFactory.workspaceLauncher()
        self.shellFactory = shellFactory
        let shell = shellFactory.shell(notifications: notificationFactory.notifications())
        self.shell = shell
        self.shellCoordinator = shellFactory.coordinator(model: shell)
        self.desktop = desktop
        self.workspaceFactory = workspaceFactory
        self.documentFactory = documentFactory
        self.trayFactory = trayFactory
        self.copy = copy
        self.projectFactory = projectFactory ?? NativeProjectFeatureFactory(creation: creationFactory, desktop: desktop, copy: copy)
        let documentCloser = EditorCloseCoordinator(factory: documentFactory, presenter: documentClosePresenter)
        let browserDialogs = BrowserDialogCoordinator(presenter: browserDialogPresenter)
        viewer = platformFactory.viewer(desktop: desktop, dialogs: browserDialogs, documents: documentFactory, close: documentCloser)
        coordinator = AppCoordinator(factory: creationFactory, selectionStore: selectionStore, workspaceFactory: workspaceFactory, router: router,
            documentCloseCoordinator: documentCloser, browserDialogCoordinator: browserDialogs,
            fileOpenCoordinator: viewer.fileOpenCoordinator,
            canOpenExternalRoute: {
                NSApplication.shared.modalWindow == nil && !NSApplication.shared.windows.contains { $0.attachedSheet != nil }
            })
        viewer.setPageLimit(shell.remotePageLimit)
        coordinator.hasDocumentPresentation = { [weak self] in
            self?.diffModels.values.contains { $0.coordinator.isPresenting } == true
        }
        shell.remotePageLimitChanged = { [weak viewer] in viewer?.setPageLimit($0) }
        coordinator.appearance = shell.appearance
        shell.documentStyleChanged = { [weak self] in
            guard let self else { return }
            coordinator.appearance = shell.appearance
            updateWorkspaceDocumentState()
        }
        shell.terminalStyleChanged = { [weak self] in self?.updateWorkspaceTerminalState() }
        _ = coordinator.makeDashboard(factory: dashboardFactory, pageActions: platformFactory.pageActions(open: { [weak self] request in
            guard let self else { throw BackendError.operation("The workspace has closed.") }
            try await self.openPage(request)
        }, desktop: desktop, copy: copy))
        _ = coordinator.makeLogs(factory: logsFactory, pageActions: platformFactory.pageActions(open: { [weak self] request in
            guard let self else { throw BackendError.operation("The workspace has closed.") }
            try await self.openPage(request)
        }, desktop: desktop, copy: copy), copy: copy)
        dashboard?.snapshotChanged = { [weak self] in self?.updateWorkspaceReviewState() }
        _ = coordinator.makeSettings(factory: settingsFactory ?? NativeSettingsFeatureFactory(desktop: desktop, copy: copy), runtime: self)
        viewer.prepareContext = { [weak self] context in
            guard let self else { return }
            context.configureWorkspace(factory: workspaceFactory, service: self)
            if let model = context.workspaceViewModel { coordinator.bindWorkspace(model, context: context, runtime: self) }
        }
        root = coordinator.makeRoot(factory: rootFactory, runtime: self, shell: shell, viewer: viewer)
        coordinator.installNotifications(shell.notifications, runtime: self, desktop: desktop)
        todayActivity.openPage = { [weak self] entry in
            guard let self else { throw CancellationError() }
            try await openActivityEntry(entry)
        }
    }

    var sidebarEntries: [SidebarEntry] {
        // Per-session agent state for the row glyph (sidebar.js taskSessions + refreshTermBusy):
        // live while its terminal is attached, busy between the CLI's turn hooks or while a
        // workflow runs on it.
        var status: [String: SidebarSessionStatus] = [:]
        for session in sessions {
            let terminal = terminals["task:\(session.id)"]
            let live = terminal.map { !$0.status.hasPrefix("Exited") && $0.status != "Disconnected" } ?? false
            let busy = terminal?.agentBusy == true || workflowRuns[session.id]?.running == true
            status[session.id] = SidebarSessionStatus(live: live, busy: busy, cli: terminal?.agentTurns.cli?.rawValue ?? session.cli)
        }
        let prs = Dictionary((dashboard?.projects ?? []).flatMap(\.prs).compactMap { pr in pr.url.map { ($0, pr) } },
                             uniquingKeysWith: { first, _ in first })
        var tabIcons: [String: SidebarTabIcon] = [:]
        for tab in tabs where tab.kind == "github" {
            let pr = prs[tab.url]
            let ci: SidebarTabIcon.CI = switch (pr?.ci?.status, pr?.ci?.conclusion) {
            case ("in_progress", _), ("queued", _): .running
            case (_, "success"): .success
            case (_, "failure"): .failure
            default: .none
            }
            tabIcons[tab.url] = SidebarTabIcon(kind: tab.kind, login: pr?.author?.login ?? tab.login, avatar: tab.avatar, ci: ci)
        }
        return SidebarEntry.make(projects: projects, sessions: sessions, tabs: tabs, status: status,
            workflowProgress: workflowRuns.filter { $0.value.running }.mapValues { "\($0.step)/\($0.total)" },
            tabIcons: tabIcons)
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
    var sessionOperations: (any SessionServing)? { api.map { backendFactory.sessions(api: $0) } }

    func showChanges(for session: WorkspaceSession, context: WorkspaceContext) {
        if context.pane == .diff { context.setPane(.term); return }
        prepareChanges(for: session, context: context)
        if diffModels[context.id] != nil { context.setPane(.diff) }
    }

    func prepareChanges(for session: WorkspaceSession, context: WorkspaceContext) {
        defer { context.workspaceViewModel?.documentStateChanged() }
        if context.reviewSection == .history, let api {
            let base = dashboard?.projects.flatMap(\.prs).first(where: { $0.url == session.url })?.baseRefName
            if let history = historyModels[context.id] { if let base { history.updateBase(base) } }
            else {
                historyModels[context.id] = documentFactory.history(worktree: session.worktree, baseURL: api.baseURL, base: base ?? "",
                    service: backendFactory.history(api: api), copy: copy)
            }
        }
        if diffModels[context.id] == nil {
            guard let api else { context.error = "Connect to the backend to load changes."; return }
            diffModels[context.id] = documentFactory.diff(worktree: session.worktree, baseURL: api.baseURL,
                                                   service: backendFactory.diff(api: api), actionsService: backendFactory.changes(api: api), openFile: { [weak context] location in
                context?.openFile(location.path, line: location.line, column: location.column)
            })
            diffModels[context.id]?.coordinator.canPresent = { [weak self, weak context] in
                guard let self, let context else { return false }
                return viewer.active === context && coordinator.canPresent
            }
            diffModels[context.id]?.coordinator.presentationEnded = { [weak coordinator] in coordinator?.schedulePendingDeepLink() }
        }
    }

    func ownsProject(_ id: String) -> Bool { projects.contains { $0.id == id } }

    func applyProjectDeletion(_ id: String, model: ProjectPageViewModel) {
        projects.removeAll { $0.id == id }
        retireProject(model)
        refresh()
    }

    private func retireProject(_ model: ProjectPageViewModel) {
        model.retire(); model.board?.suspend()
        Task { await model.automation?.stop(); await model.workflows?.stop(); await model.tickets?.stop() }
    }

    private func savedProject(_ project: Project) {
        applyProjectSave(project, source: .configuration)
        select(.project(project.id))
    }

    func applyProjectSave(_ project: Project, source: ProjectSaveSource) {
        if let index = projects.firstIndex(where: { $0.id == project.id }) { projects[index] = project }
        else { projects.append(project) }
        projectModels[project.id]?.update(project)
        for session in sessions where source == .configuration && session.projectId == project.id {
            buildModels.removeValue(forKey: "task:\(session.id)")?.disconnect()
        }
        refresh()
    }

    /// The project a new session is created under, from where it was asked for — the sheet never
    /// offers another. A PR page belongs to the project of its repository, a ticket to the project
    /// on its Jira key; failing that, the only project there is.
    func sessionProject(for destination: SidebarDestination) -> Project? {
        let local = projects.filter { !$0.workspace.isEmpty }
        switch destination {
        // A destination that names its project gets that project or none — never a stand-in.
        case .project(let id): return local.first { $0.id == id }
        case .session(let id):
            guard let session = sessions.first(where: { $0.id == id }) else { return nil }
            return local.first { $0.id == session.projectId }
        case .tab(let url) where SessionPage.parse(url) != nil: return pageProject(url, in: local)
        default: return local.count == 1 ? local[0] : nil
        }
    }

    private func pageProject(_ url: String, in local: [Project]) -> Project? {
        guard let page = SessionPage.parse(url) else { return nil }
        if page.kind == "github" {
            let path = URL(string: page.url)?.path.split(separator: "/").prefix(2).joined(separator: "/").lowercased()
            return local.first { !$0.repo.isEmpty && $0.repo.lowercased() == path }
        }
        let prefix = page.key.split(separator: "-").first.map(String.init) ?? ""
        return local.first { project in
            (project.jiraProjectKey ?? "").split(separator: ",").contains { $0.trimmingCharacters(in: .whitespaces).uppercased() == prefix }
        }
    }

    /// The projects a page's Create Session can pick from: the page's own project when it has one,
    /// else every local project (the page CTA then asks which, like the web toolbar's menu).
    func sessionProjectChoices(for destination: SidebarDestination) -> [Project] {
        guard canStartSession else { return [] }
        if let project = sessionProject(for: destination) { return [project] }
        // A pull request belongs to its repository's project; with none configured there is
        // nothing to pick. A ticket or plain page can be started under any local project.
        if case .tab(let url) = destination, SessionPage.parse(url)?.kind == "github" { return [] }
        return projects.filter { !$0.workspace.isEmpty }
    }

    private var canStartSession: Bool {
        connection == "Connected" && coordinator.canPresent && pageWorkflowRuns[viewer.activeContextID ?? ""]?.running != true
            && !(selection.tabURL.map(startingPages.contains) ?? false)
    }

    /// New Session from where it was asked. A PR or ticket page already decides its branch, so its
    /// session is created at once (viewer.js newSession); anything else opens the sheet.
    func startSession(in projectID: String, pageURL: String?) {
        guard let pageURL, SessionPage.parse(pageURL) != nil else { presentNewSession(in: projectID, pageURL: pageURL); return }
        guard canStartSession, let operations = sessionOperations,
              let project = projects.first(where: { $0.id == projectID && !$0.workspace.isEmpty }),
              startingPages.insert(pageURL).inserted else { return }
        let context = viewer.active
        context?.error = nil
        let agent = shell.defaultAgent
        Task {
            let outcome = await PageSessionStart.run(url: pageURL, project: project, agent: agent, operations: operations)
            // Release the page BEFORE acting: the sheet fallback checks canStartSession, which is
            // false while this page is still marked as starting.
            startingPages.remove(pageURL)
            switch outcome {
            case .created(let session): createdSession(session)
            case .needsBranch: presentNewSession(in: projectID, pageURL: pageURL)
            case .failed(let message): context?.error = message
            }
        }
    }

    /// Present New Session for `project`. `pageURL` is the page it was asked from, if any.
    func presentNewSession(in projectID: String, pageURL: String?) {
        guard canStartSession, let project = projects.first(where: { $0.id == projectID && !$0.workspace.isEmpty }) else { return }
        coordinator.presentNewSession(request: .init(project: project, agent: shell.defaultAgent, pageURL: pageURL),
                                      operations: sessionOperations, didCreate: { [weak self] in self?.createdSession($0) })
    }

    public func canPerform(_ command: ShellCommand) -> Bool {
        switch command {
        case .newProject: connection == "Connected" && coordinator.canPresent
        case .newSession: canStartSession && sessionProject(for: selection) != nil
        case .back: coordinator.canPresent && viewer.active?.activePage?.controls.canGoBack == true
        case .forward: coordinator.canPresent && viewer.active?.activePage?.controls.canGoForward == true
        case .openFile: viewer.active != nil && connection == "Connected" && coordinator.canPresent
        case .saveFile: viewer.active?.activeDocument?.loaded == true && viewer.active?.activeDocument?.readOnly == false
        case .findPage: activeHistory != nil || hasActivePage
        case .zoomIn, .zoomOut, .resetZoom: coordinator.canPresent && viewer.active?.activePage?.controls.active == true
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
            coordinator.presentNewProject(service: backendFactory.projects(api: api), didSave: { [weak self] in self?.savedProject($0) })
        case .newSession:
            guard canPerform(.newSession), let project = sessionProject(for: selection) else { return }
            let pageURL: String? = if case .tab(let url) = selection { url } else { nil }
            startSession(in: project.id, pageURL: pageURL)
        case .openFile: if canPerform(.openFile), let context = viewer.active { viewer.openFile(in: context) }
        case .saveFile: if let document = viewer.active?.activeDocument { Task { await document.save() } }
        case .closePage: if let context = viewer.active, let id = context.activeID, let tab = context.tab(id) { context.close(tab) }
        case .findPage:
            if let history = activeHistory { history.find() }
            else if let document = viewer.active?.activeDocument { document.find() }
            else { viewer.active?.findVisible = true }
        case .back: viewer.active?.activePage?.controls.back()
        case .forward: viewer.active?.activePage?.controls.forward()
        case .nextPage: viewer.active?.cycle(1)
        case .previousPage: viewer.active?.cycle(-1)
        case .zoomIn: viewer.active?.activePage?.controls.zoom(0.1)
        case .zoomOut: viewer.active?.activePage?.controls.zoom(-0.1)
        case .resetZoom: viewer.active?.activePage?.controls.zoom(nil)
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
        if selection == .settings && settings?.section == .appearance { return .diff }
        if let context = viewer.active {
            if context.pane == .diff { return .diff }
            let hasTerminal = context.id == "scratch" || sessions.contains { "task:\($0.id)" == context.id }
            if context.activeDocument != nil && (!hasTerminal || context.pane == .term) { return .diff }
        }
        return terminal?.ready == true && terminal?.showsSurface == true ? .term : nil
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

    /// A Today-popover row: its PR opens by link; a ticket by its key on the configured Jira site.
    func openActivityEntry(_ entry: LogEntry) async throws {
        if let link = entry.link {
            try await openPage(OpenPageRequest(url: link, kind: "github", title: entry.title)); return
        }
        guard let key = entry.jiraKey, let api else { throw BackendError.operation("Connect before opening a page.") }
        let site: JiraSite = try await api.get(Routes.JIRA_SITE, timeout: 30)
        guard let base = safeWebURL(site.baseUrl) else { throw BackendError.operation("Configure the Jira site to open ticket links.") }
        try await openPage(OpenPageRequest(url: base.appendingPathComponent("browse").appendingPathComponent(key).absoluteString,
                                           kind: "jira", title: key))
    }

    func openPage(_ request: OpenPageRequest) async throws {
        try Task.checkCancellation()
        guard safeWebURL(request.url) != nil else { throw BackendError.operation("Invalid page address.") }
        if let session = sessions.first(where: { $0.url == request.url }) {
            select(.session(session.id))
            viewer.active?.open(request.url, title: request.title)
            return
        }
        guard let api else { throw BackendError.operation("Connect before opening a page.") }
        let saved: SavedTabs = try await api.request(Routes.TABS, method: "POST", body: request)
        try Task.checkCancellation()
        tabs = saved.tabs
        select(.tab(request.url))
        viewer.active?.open(request.url, title: request.title)
    }

    public func makeTray(openWindow: @escaping () -> Void, dismiss: @escaping () -> Void,
                         quit: @escaping () -> Void = {}) -> TrayCoordinator {
        coordinator.makeTray(factory: trayFactory, runtime: self, shell: shell, desktop: desktop,
                             presentation: TrayPresentation(openWindow: openWindow, dismiss: dismiss, quit: quit))
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
                let services = backendFactory.projectServices(api: api)
                coordinator.prepareProject(project, services: services, factory: projectFactory, runtime: self) { [weak self] request in
                    guard let self else { throw BackendError.operation("The workspace has closed.") }
                    try await self.openPage(request)
                }
            }
        case .session(let id):
            if let session = sessions.first(where: { $0.id == id }) {
                viewer.select(id: "task:\(id)", url: session.url, title: session.title, legacy: tabs.first { $0.url == session.url })
                _ = workflowRunModel(for: session)
                openTerminal()
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
            let terminal = platformFactory.terminal(.init(key: "native-terminal-spike", directory: platformFactory.homeDirectory, paired: false))
            wireLinks(terminal, contextID: "scratch")
            terminals[key] = terminal
        }
    }

    private func workflowRunModel(for record: WorkspaceSession) -> WorkflowRunViewModel? {
        guard let api, let project = projects.first(where: { $0.id == record.projectId }) else { return nil }
        if let existing = workflowRuns[record.id] { existing.update(project.workflows ?? []); return existing }
        let model = backendFactory.workflowRun(api: api, recipes: project.workflows ?? [], context: { [weak self] in
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
        let service = backendFactory.workflowPreparation(api: api)
        let model = backendFactory.workflowRun(api: api, recipes: project.workflows ?? [], context: { [weak self] in
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
        settings?.section = .clis; select(.settings)
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
        return try await platformFactory.workflowTerminal(terminal, cli: cli, sessionID: latest.sessionId)
    }

    func removalModel(for record: WorkspaceSession) -> SessionRemovalViewModel? {
        guard let api else { return nil }
        let operationID = UUID()
        let service = backendFactory.removal(api: api, stopTerminals: { [weak self] keys in
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
            let terminal = platformFactory.terminal(.init(key: key, directory: record.worktree, paired: true))
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
        try await terminalControl.stopPaired(keys: keys)
    }

    private func makeTerminal(_ record: WorkspaceSession, fresh: Bool = false) -> TerminalSession {
        let terminal = platformFactory.terminal(.init(key: record.id, directory: record.worktree, paired: true))
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
            guard let link = WorkspaceLink.parse(raw, directory: directory, home: platformFactory.homeDirectory) else {
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
        terminals["task:\(session.id)"] = makeTerminal(session, fresh: true)
        select(.session(session.id))
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
                try await terminalControl.stopPaired(keys: [record.id])
                terminals[key] = makeTerminal(sessions.first { $0.id == record.id } ?? record)
            } catch { self.error = "Could not restart session: \(error.localizedDescription)" }
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

    public func quit() async throws { try await prepareToTerminate() }

    public func prepareForUpdate() async throws { try await prepareToTerminate() }

    public func cancelBrowserPresentation() { coordinator.browserDialogCoordinator.cancel() }

    private func prepareToTerminate() async throws {
        let browserDialogs = coordinator.browserDialogCoordinator
        let browserWasEnabled = browserDialogs.enabled
        let picker = viewer.fileOpenCoordinator
        let pickerWasEnabled = picker.enabled
        picker.enabled = false
        browserDialogs.enabled = false
        defer { if started { browserDialogs.enabled = browserWasEnabled; picker.enabled = pickerWasEnabled } }
        let actions = diffModels.values.compactMap(\.actions)
        for action in actions { await action.suspendAndWait() }
        defer { actions.forEach { $0.resume() } }
        guard await viewer.closeDocuments() else { throw CancellationError() }
        for model in workflowRuns.values { await model.stop() }
        for model in pageWorkflowRuns.values { await model.stop() }
        for terminal in terminals.values { await terminal.stopConnecting() }
        try await terminalControl.stopExisting()
        for terminal in terminals.values { terminal.disconnect() }
        await stop()
    }

    private func restoreSessionTerminals() {
        for record in sessions {
            let key = "task:\(record.id)"
            _ = viewer.restore(id: key, url: record.url, title: record.title,
                               legacy: tabs.first { $0.url == record.url })
            _ = workflowRunModel(for: record)
            if terminals[key] == nil { terminals[key] = makeTerminal(record) }
        }
    }

    public func start() async {
        if let shutdownTask { await shutdownTask.value }
        guard !started else { return }
        coordinator.browserDialogCoordinator.enabled = true
        viewer.fileOpenCoordinator.enabled = true
        coordinator.setRoutingReady(false)
        started = true
        let generation = UUID()
        startGeneration = generation
        backendRuntime.onEvent = { [weak self] event in
            guard let self, self.started, self.startGeneration == generation else { return }
            self.handleBackendEvent(event)
        }
        settings?.resources.connect(platformFactory.resources(api: nil))
        coordinator.settingsCoordinator?.setActive(selection == .settings)
        do {
            let connectedAPI = try await backendRuntime.start()
            guard started, startGeneration == generation else { return }
            api = connectedAPI
            if let api { shell.connect(shellFactory.data(api: api)); viewer.connect(api); dashboard?.connect(backendFactory.dashboard(api: api)); shell.refreshUsage() }
            if let api { for model in projectModels.values {
                model.connect(backendFactory.projects(api: api)); model.board?.connect(api: api)
                model.tickets?.connect(backendFactory.tickets(api: api))
                model.workflows?.connect(backendFactory.workflows(api: api))
                model.automation?.connect(backendFactory.automation(api: api))
            } }
            if let api { logs?.connect(backendFactory.logs(api: api)); todayActivity.connect(backendFactory.logs(api: api)) }
            if let api { for model in historyModels.values { model.connect(baseURL: api.baseURL, service: backendFactory.history(api: api)) } }
            if let api { for model in diffModels.values { model.connect(baseURL: api.baseURL, service: backendFactory.diff(api: api)); model.actions?.connect(backendFactory.changes(api: api)) } }
            if let api {
                settings?.connect(backendFactory.settings(api: api))
                settings?.clis.connect(backendFactory.cliSettings(api: api))
                settings?.diagnostics.connect(backendFactory.diagnostics(api: api))
                settings?.resources.connect(platformFactory.resources(api: api))
                workspaceLaunch.connect(backendFactory.workspaceTargets(api: api))
                if selection == .settings { settings?.refresh() }
                settings?.refreshCurrentSection()
            }
            backendRuntime.startEvents()
        } catch {
            guard started, startGeneration == generation else { return }
            connection = "Disconnected"
            self.error = error.localizedDescription
            started = false
        }
    }

    public func refresh() {
        refreshRequestID = UUID()
        shell.refresh()
        dashboard?.refresh()
        if selection == .activity { logs?.refresh() }
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
                let requestID = refreshRequestID
                do {
                    async let projectRequest: [Project] = api.get(Routes.PROJECTS)
                    async let sessionRequest: [WorkspaceSession] = api.get(Routes.TASKS)
                    async let tabRequest: SavedTabs = api.get(Routes.TABS)
                    let (snapshot, sessionSnapshot, tabSnapshot) = try await (projectRequest, sessionRequest, tabRequest)
                    try Task.checkCancellation()
                    // A save/delete or newer SSE refresh supersedes this batch.
                    // Do not apply its older inventory or retire newly created models.
                    guard requestID == refreshRequestID else { refreshPending = true; continue }
                    if projects != snapshot { projects = snapshot }
                    for model in coordinator.removeMissingProjects(Set(snapshot.map(\.id))) { retireProject(model) }
                    if sessions != sessionSnapshot {
                        let retained = Set(sessionSnapshot.map(\.id))
                        for session in sessions where !retained.contains(session.id) {
                            workspaceLaunch.cancel(sessionID: session.id)
                            await workflowRuns.removeValue(forKey: session.id)?.stop()
                        }
                        sessions = sessionSnapshot
                    }
                    if tabs != tabSnapshot.tabs { tabs = tabSnapshot.tabs }
                    restoreSessionTerminals()
                    showSelectedContext()
                    if case .project(let id) = selection, let model = projectModels[id], model.section == .prs {
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

    private func handleBackendEvent(_ event: BackendRuntimeEvent) {
        switch event {
        case .starting(let url):
            backendAddress = url.absoluteString
            connection = "Connecting"
        case .connected: connected()
        case .message(let event): received(event)
        case .reconnecting(let message):
            if let message { error = message }
            terminals.values.forEach { $0.agentTurns.setStreamAvailable(false) }
            connection = "Reconnecting"
            coordinator.setRoutingReady(false)
        }
    }

    private func connected() {
        guard started else { return }
        connection = "Connected"
        terminals.values.forEach { $0.agentTurns.setStreamAvailable(true) }
        refresh() // SSE has no replay IDs: refresh the snapshot on every reconnect.
        settings?.diagnostics.invalidate()
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
            if selection == .activity { logs?.refresh() }
            todayActivity.activityReceived()
        }
        if event.type == "settings" { shell.loadSettings() }
        if event.type == "config" { settings?.refresh() }
        if ["sync", "jira-sync", "activity", "config", "reload"].contains(event.type) { settings?.diagnostics.invalidate() }
        if event.type == "reviews" { shell.refresh() }
        if ["sync", "jira-sync", "tabs", "tasks", "reload"].contains(event.type) { refresh() }
    }

    public func stop() async {
        viewer.fileOpenCoordinator.enabled = false
        if let shutdownTask { await shutdownTask.value; return }
        coordinator.browserDialogCoordinator.enabled = false
        started = false
        startGeneration = UUID()
        backendRuntime.onEvent = { _ in }
        coordinator.setRoutingReady(false)
        let task = Task { await finishStop() }
        shutdownTask = task
        await task.value
        shutdownTask = nil
    }

    private func finishStop() async {
        await backendRuntime.stopEvents()
        for model in pageWorkflowRuns.values { await model.stop() }
        pageWorkflowRuns.removeAll()
        pageWorkflowTargets.removeAll()
        for model in workflowRuns.values { await model.stop() }
        workflowRuns.removeAll()
        terminals.values.forEach { $0.agentTurns.setStreamAvailable(false) }
        workspaceLaunch.stop()
        for model in diffModels.values { await model.actions?.suspendAndWait() }
        refreshTask?.cancel()
        await refreshTask?.value
        refreshTask = nil
        await shell.stop()
        await dashboard?.stop()
        await logs?.stop()
        await settings?.stop()
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
        await backendRuntime.stop()
        api = nil
    }
}
