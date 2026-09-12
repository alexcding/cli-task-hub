import AppKit
import Foundation
import Observation

@MainActor @Observable
public final class AppStore {
    public let shell = ShellStore()
    let viewer: ViewerStore
    private(set) var dashboard: DashboardViewModel!
    private(set) var logs: LogsViewModel!
    private(set) var settings: SettingsViewModel!
    public private(set) var projects: [Project] = []
    public private(set) var connection = "Connecting"
    public private(set) var error: String?
    public private(set) var lastUpdate: Date?
    public private(set) var backendAddress = ""
    private(set) var sessions: [WorkspaceSession] = []
    private(set) var tabs: [SavedTab] = []
    private(set) var selection: SidebarDestination = .overview
    private(set) var terminals: [String: TerminalSession] = [:]
    var creatingSession = false
    var creatingProject = false
    private(set) var projectModels: [String: ProjectPageViewModel] = [:]
    private(set) var changingSessions: Set<String> = []
    private(set) var buildModels: [String: BuildWorkspaceViewModel] = [:]
    private(set) var historyModels: [String: GitHistoryViewModel] = [:]
    private(set) var diffModels: [String: DiffViewModel] = [:]
    @ObservationIgnored private var pendingPins: Set<String> = []
    @ObservationIgnored private var removalLocks: [UUID: Set<String>] = [:]
    @ObservationIgnored private var owner: BackendProcess?
    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshPending = false
    @ObservationIgnored private var started = false

    public init() {
        viewer = ViewerStore(cacheURL: try? PtydConfiguration.current().directory.appendingPathComponent("page-tabs.json"))
        dashboard = DashboardViewModel(openPage: { [weak self] request in
            guard let self else { throw BackendError.operation("The workspace has closed.") }
            try await self.openPage(request)
        }, openBrowser: { NSWorkspace.shared.open($0) }, copy: {
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
        }, openBrowser: { NSWorkspace.shared.open($0) }), didSave: { [weak self] patch in
            guard let self else { return }
            if patch["jira_base_url"] != nil || patch["jira_api_token"] != nil {
                for model in projectModels.values { await model.tickets?.invalidateSite() }
            }
        })
        if let data = UserDefaults.standard.data(forKey: "sidebar.selection"),
           let saved = try? JSONDecoder().decode(SidebarDestination.self, from: data) { selection = saved }
    }

    var sidebarEntries: [SidebarEntry] { SidebarEntry.make(projects: projects, sessions: sessions, tabs: tabs) }
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

    func projectEditor(for project: Project? = nil) -> ProjectEditorViewModel? {
        guard let api else { return nil }
        return ProjectEditorViewModel(project: project, service: APIProjectService(api: api), chooseFolder: NativeFolderPicker.choose,
            didSave: { [weak self] project in
                guard let self else { return }
                if let index = projects.firstIndex(where: { $0.id == project.id }) { projects[index] = project }
                else { projects.append(project) }
                projectModels[project.id]?.update(project)
                for session in sessions where session.projectId == project.id {
                    buildModels.removeValue(forKey: "task:\(session.id)")?.disconnect()
                }
                creatingProject = false
                select(.project(project.id))
                refresh()
            }, didDelete: { [weak self] id in
                guard let self else { return }
                projects.removeAll { $0.id == id }
                if let removed = projectModels.removeValue(forKey: id) {
                    removed.board?.suspend()
                    Task { await removed.tickets?.stop() }
                }
                select(.overview); refresh()
            })
    }

    func newSessionModel() -> NewSessionViewModel {
        let selected: String
        switch selection {
        case .project(let id): selected = id
        case .session(let id): selected = sessions.first { $0.id == id }?.projectId ?? ""
        default: selected = projects.count == 1 ? projects[0].id : ""
        }
        let model = NewSessionViewModel(projects: projects, selectedProject: selected, operations: sessionOperations,
                                        didCreate: { [weak self] in self?.createdSession($0) })
        model.draft.agent = shell.defaultAgent
        if case .tab(let url) = selection {
            model.draft.url = url
            if SessionPage.parse(url) != nil { model.draft.branch = url }
        }
        return model
    }

    public func canPerform(_ command: ShellCommand) -> Bool {
        switch command {
        case .newProject: connection == "Connected"
        case .newSession: connection == "Connected" && !projects.isEmpty
        case .back: viewer.active?.activePage?.canGoBack == true
        case .forward: viewer.active?.activePage?.canGoForward == true
        case .openFile: viewer.active != nil && connection == "Connected"
        case .saveFile: viewer.active?.activeDocument?.loaded == true && viewer.active?.activeDocument?.readOnly == false
        case .findPage: hasActivePage
        case .zoomIn, .zoomOut, .resetZoom: viewer.active?.activePage != nil
        case .nextPage, .previousPage: (viewer.active?.tabOrder.count ?? 0) > 1
        case .biggerFont, .smallerFont, .resetFont: terminal?.ready == true
        case .refresh: connection == "Connected"
        default: true
        }
    }

    public func perform(_ command: ShellCommand) {
        switch command {
        case .newProject: creatingProject = true
        case .newSession: creatingSession = true
        case .openFile: if let context = viewer.active { viewer.openFile(in: context) }
        case .saveFile: if let document = viewer.active?.activeDocument { Task { await document.save() } }
        case .closePage: if let context = viewer.active, let id = context.activeID, let tab = context.tab(id) { context.close(tab) }
        case .findPage:
            if let document = viewer.active?.activeDocument { document.find() }
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
        case .biggerFont: _ = terminal?.surface.performBindingAction("increase_font_size:1")
        case .smallerFont: _ = terminal?.surface.performBindingAction("decrease_font_size:1")
        case .resetFont: _ = terminal?.surface.performBindingAction("reset_font_size")
        default: break
        }
    }

    func selectTrayTab(_ tab: SavedTab) {
        if let session = sessions.first(where: { $0.url == tab.url }) { select(.session(session.id)) }
        else { select(.tab(tab.url)) }
    }

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
        selection = destination
        showSelectedContext()
        if let data = try? JSONEncoder().encode(destination) { UserDefaults.standard.set(data, forKey: "sidebar.selection") }
    }

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
                    }, openBrowser: { NSWorkspace.shared.open($0) })
                    let tickets = JiraTicketsViewModel(project: project, service: APIJiraService(api: api), openPage: { [weak self] request in
                        guard let self else { throw BackendError.operation("The workspace has closed.") }
                        try await self.openPage(request)
                    }, openBrowser: { NSWorkspace.shared.open($0) }, copy: {
                        NSPasteboard.general.clearContents(); NSPasteboard.general.setString($0, forType: .string)
                    })
                    projectModels[id] = ProjectPageViewModel(project: project, service: APIProjectService(api: api), editor: editor, board: board, tickets: tickets)
                }
            }
        case .session(let id):
            if let session = sessions.first(where: { $0.id == id }) {
                viewer.select(id: "task:\(id)", url: session.url, title: session.title, legacy: tabs.first { $0.url == session.url })
            }
        case .terminal:
            viewer.select(id: "scratch", url: "", title: "Terminal")
        case .tab(let url):
            viewer.select(id: "tab:\(url)", url: url, title: tabs.first { $0.url == url }?.title ?? url, legacy: tabs.first { $0.url == url })
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

    func removalModel(for record: WorkspaceSession) -> SessionRemovalViewModel? {
        guard let api else { return nil }
        let operationID = UUID()
        let service = SessionRemovalService(api: api, stopTerminals: { [weak self] keys in
            guard let self else { throw BackendError.operation("The workspace closed before removal.") }
            try await self.stopForRemoval(keys, operationID: operationID)
        })
        return SessionRemovalViewModel(service: service, record: record, projects: projects, sessions: sessions,
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
        let model = BuildWorkspaceViewModel(api: api, project: project, session: record, terminalFactory: { [unowned self] in
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
        for id in ids { buildModels.removeValue(forKey: "task:\(id)")?.disconnect() }
        for (key, terminal) in terminals where keys.contains(terminal.pairKey) {
            await terminal.stopConnecting()
            if terminals[key] === terminal { terminals.removeValue(forKey: key) }
        }
        try await PtydHost(configuration: PtydConfiguration.current()).stopPaired(keys: keys)
    }

    private func makeTerminal(_ record: WorkspaceSession, fresh: Bool = false) -> TerminalSession {
        let terminal = TerminalSession(pairKey: record.id, cwd: record.worktree, paired: true)
        wireLinks(terminal, contextID: "task:\(record.id)")
        terminal.onCreated = { [weak self] terminal in
            guard let self else { return }
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
            if let command = agent.command(sessionID: id, fresh: firstLaunch) { try await terminal.submit(command) }
        }
        return terminal
    }

    private func wireLinks(_ terminal: TerminalSession, contextID: String) {
        terminal.openLink = { [weak self] raw, directory in
            guard let self, let context = viewer.contexts[contextID] else { return }
            guard let link = WorkspaceLink.parse(raw, directory: directory, home: NSHomeDirectory()) else {
                context.error = "This terminal link is not a supported web or local file address."
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
        creatingSession = false
        refresh()
    }

    func restartSession(_ record: WorkspaceSession) {
        guard changingSessions.insert(record.id).inserted else { return }
        Task {
            defer { changingSessions.remove(record.id) }
            do {
                let key = "task:\(record.id)"
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
        let actions = diffModels.values.compactMap(\.actions)
        for action in actions { await action.suspendAndWait() }
        defer { actions.forEach { $0.resume() } }
        guard await viewer.closeDocuments() else { throw CancellationError() }
        for terminal in terminals.values { await terminal.stopConnecting() }
        let host = PtydHost(configuration: try PtydConfiguration.current())
        try await host.stopExisting()
        for terminal in terminals.values { terminal.disconnect() }
        await stop()
    }

    public func start() async {
        guard !started else { return }
        started = true
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
            } }
            if let api { logs.connect(APILogService(api: api)) }
            if let api { for model in historyModels.values { model.connect(baseURL: api.baseURL, service: APIGitHistoryService(api: api)) } }
            if let api { for model in diffModels.values { model.connect(baseURL: api.baseURL, service: APIDiffService(api: api)); model.actions?.connect(APIGitChangesService(api: api)) } }
            if let api {
                settings.connect(APISettingsService(api: api))
                settings.clis.connect(APICLISettingsService(api: api))
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
                    if sessions != sessionSnapshot { sessions = sessionSnapshot }
                    if tabs != tabSnapshot.tabs { tabs = tabSnapshot.tabs }
                    showSelectedContext()
                    if case .project(let id) = selection, let model = projectModels[id], model.section == .prs && model.state == "open" {
                        await model.refresh()
                    }
                    if !sidebarEntries.flatMap(\.descendants).contains(where: { $0.destination == selection }) { select(.overview) }
                    lastUpdate = Date()
                    error = nil
                } catch {
                    if !Task.isCancelled { self.error = error.localizedDescription }
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
                self?.connection = "Reconnecting"
                do { try await Task.sleep(for: .seconds(delay)) } catch { break }
                delay = min(delay * 2, 15)
            }
        }
    }

    private func connected() {
        guard started else { return }
        connection = "Connected"
        refresh() // SSE has no replay IDs: refresh the snapshot on every reconnect.
    }

    private func received(_ event: ServerEvent) {
        if ["agent-turn-start", "agent-turn-done"].contains(event.type), let runID = event.runId,
           let terminal = terminals.values.first(where: { $0.termID == runID }),
           let session = sessions.first(where: { $0.id == terminal.pairKey }) {
            terminal.agentBusy = event.type == "agent-turn-start"
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
        if event.type == "reviews" { shell.refresh() }
        if ["sync", "jira-sync", "tabs", "tasks", "reload"].contains(event.type) { refresh() }
    }

    public func stop() async {
        started = false
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
        for model in projectModels.values { model.connect(nil); model.board?.pause(); await model.tickets?.stop() }
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
