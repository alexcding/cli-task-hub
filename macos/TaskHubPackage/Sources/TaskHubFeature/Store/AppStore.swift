import Foundation
import Observation

@MainActor @Observable
public final class AppStore {
    public private(set) var projects: [Project] = []
    public private(set) var connection = "Connecting"
    public private(set) var error: String?
    public private(set) var lastUpdate: Date?
    public private(set) var backendAddress = ""
    private(set) var terminal: TerminalSession?
    @ObservationIgnored private var owner: BackendProcess?
    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshPending = false
    @ObservationIgnored private var started = false

    public init() {}

    func openTerminal() {
        guard terminal == nil else { return }
        terminal = TerminalSession()
    }

    func reattachTerminal() {
        guard let previous = terminal else { return }
        Task {
            await previous.stopConnecting()
            if terminal === previous { terminal = TerminalSession() }
        }
    }

    public func quit() async throws {
        await terminal?.stopConnecting()
        let host = PtydHost(configuration: try PtydConfiguration.current())
        try await host.stopExisting()
        terminal?.disconnect()
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
            startStream(baseURL: config.baseURL)
        } catch {
            connection = "Disconnected"
            self.error = error.localizedDescription
            started = false
        }
    }

    public func refresh() {
        refreshPending = true
        guard refreshTask == nil, let api else { return }
        refreshTask = Task { [weak self] in
            guard let self else { return }
            defer { refreshTask = nil }
            while refreshPending && !Task.isCancelled {
                refreshPending = false
                do {
                    let snapshot: [Project] = try await api.get(Routes.PROJECTS)
                    try Task.checkCancellation()
                    if projects != snapshot { projects = snapshot }
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
        if ["sync", "jira-sync", "tabs", "reload"].contains(event.type) { refresh() }
    }

    public func stop() async {
        started = false
        streamTask?.cancel()
        refreshTask?.cancel()
        await streamTask?.value
        await refreshTask?.value
        streamTask = nil
        refreshTask = nil
        await owner?.stop()
        api = nil
    }
}
