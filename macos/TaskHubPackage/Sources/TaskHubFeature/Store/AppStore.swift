import Foundation
import Observation

@MainActor @Observable
public final class AppStore {
    public let shell = ShellStore()
    public private(set) var projects: [Project] = []
    public private(set) var connection = "Connecting"
    public private(set) var error: String?
    public private(set) var lastUpdate: Date?
    public private(set) var backendAddress = ""
    private(set) var sessions: [WorkspaceSession] = []
    private(set) var tabs: [SavedTab] = []
    private(set) var selection: SidebarDestination = .overview
    private(set) var terminals: [String: TerminalSession] = [:]
    @ObservationIgnored private var pendingPins: Set<String> = []
    @ObservationIgnored private var owner: BackendProcess?
    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshPending = false
    @ObservationIgnored private var started = false

    public init() {
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

    func selectTrayTab(_ tab: SavedTab) {
        if let session = sessions.first(where: { $0.url == tab.url }) { select(.session(session.id)) }
        else { select(.tab(tab.url)) }
    }

    public func trayWillOpen() {
        refresh()
        shell.refreshUsage()
        shell.loadSettings()
    }

    func select(_ destination: SidebarDestination) {
        selection = destination
        if let data = try? JSONEncoder().encode(destination) { UserDefaults.standard.set(data, forKey: "sidebar.selection") }
    }

    func openTerminal() {
        guard let key = activeTerminalKey, terminals[key] == nil else { return }
        if case .session(let id) = selection, let record = sessions.first(where: { $0.id == id }) {
            terminals[key] = TerminalSession(pairKey: record.id, cwd: record.worktree, paired: true)
        } else if selection == .terminal { terminals[key] = TerminalSession() }
    }

    func reattachTerminal() {
        guard let key = activeTerminalKey, let previous = terminals[key] else { return }
        Task {
            await previous.stopConnecting()
            if terminals[key] === previous {
                terminals[key] = TerminalSession(pairKey: previous.pairKey, cwd: previous.cwd, paired: previous.paired)
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
            if let api { shell.connect(api) }
            startStream(baseURL: config.baseURL)
        } catch {
            connection = "Disconnected"
            self.error = error.localizedDescription
            started = false
        }
    }

    public func refresh() {
        shell.refresh()
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
        if event.type == "settings" { shell.loadSettings() }
        if event.type == "reviews" { shell.refresh() }
        if ["sync", "jira-sync", "tabs", "tasks", "reload"].contains(event.type) { refresh() }
    }

    public func stop() async {
        started = false
        streamTask?.cancel()
        refreshTask?.cancel()
        await streamTask?.value
        await refreshTask?.value
        streamTask = nil
        refreshTask = nil
        await shell.stop()
        await owner?.stop()
        api = nil
    }
}
