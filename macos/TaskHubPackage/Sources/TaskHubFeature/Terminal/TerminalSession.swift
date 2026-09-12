import Foundation
import Observation
import GhosttyTerminal

@MainActor @Observable
final class TerminalSession: Identifiable {
    let id = UUID()
    let pairKey: String
    let cwd: String
    let paired: Bool
    @ObservationIgnored var isActive = true
    var showsSurface = true
    let surface = TerminalViewState()
    private(set) var status = "Connecting"
    private(set) var error: String?
    private(set) var shellPID: UInt32?
    private(set) var termID: String?
    var agentBusy = false
    private(set) var ready = false
    @ObservationIgnored private var pipe: TerminalPipe!
    @ObservationIgnored private var client: PtydClient?
    @ObservationIgnored private var host: PtydHost?
    @ObservationIgnored private var hello: PtyHello?
    @ObservationIgnored private var started = false
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var launchTask: Task<Void, Never>?
    @ObservationIgnored var onCreated: ((TerminalSession) async throws -> Void)?

    init(pairKey: String = "native-terminal-spike", cwd: String = FileManager.default.homeDirectoryForCurrentUser.path, paired: Bool = false) {
        self.pairKey = pairKey
        self.cwd = cwd
        self.paired = paired
        pipe = TerminalPipe(onError: { [weak self] text in Task { @MainActor in self?.setError(text) } },
                            onExit: { [weak self] code in Task { @MainActor in self?.status = "Exited (\(code))"; self?.ready = false } })
        surface.configuration = .init(backend: .inMemory(pipe.memory), fontSize: 13, resizeThrottleMilliseconds: 80)
        surface.onClose = { [weak self] _ in self?.status = "Exited"; self?.ready = false }
    }

    func start() async {
        guard !started else { return }
        started = true
        let task = Task { await connect() }
        startTask = task
        await task.value
    }

    private func connect() async {
        do {
            // The engine must exist before replay; the package's pre-surface buffer
            // drops old bytes past 1 MiB and is not a substitute for our flow control.
            for _ in 0..<50 {
                if surface.surface != nil { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            guard surface.surface != nil else { throw PtyError.connection("Ghostty could not create a native surface.") }
            let config = try PtydConfiguration.current()
            let host = PtydHost(configuration: config)
            self.host = host
            let pipe = self.pipe!
            let client = PtydClient(onEvent: { pipe.receive($0) }, onDisconnect: { [weak self] message in
                Task { @MainActor in self?.setError(message) }
            })
            self.client = client
            hello = try await host.connect(client: client)
            try Task.checkCancellation()
            let terminals: [PtyInfo] = try await client.request(.init(op: "list"))
            let info: PtyInfo
            let created: Bool
            if let existing = terminals.first(where: { $0.pairKey == pairKey && $0.paired == paired }) {
                info = existing
                created = false
            } else {
                info = try await client.request(.init(op: "create", opts: .init(
                    cwd: cwd, paired: paired, pairKey: pairKey)))
                created = true
            }
            shellPID = info.pid
            termID = info.id
            pipe.bind(client: client, id: info.id)
            let attachment: PtyAttachment = try await client.request(.init(op: "attach", term: info.id))
            status = "Restoring output"
            pipe.attach(attachment) { [weak self] in
                Task { @MainActor in
                    guard let self, self.started, self.error == nil else { return }
                    self.status = "Connected"
                    self.ready = true
                    if self.isActive { self.surface.requestFocus() }
                    if created, let onCreated = self.onCreated {
                        self.launchTask = Task {
                            do {
                                // Let the shell finish its startup files before entering a command.
                                try await Task.sleep(for: .seconds(1))
                                try await onCreated(self)
                            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
                        }
                    }
                }
            }
        } catch { setError(error.localizedDescription) }
    }

    private func setError(_ text: String) {
        // Closing a failed pipeline also reports a socket disconnect; preserve
        // the actionable root cause (for example truncated restoration).
        if error == nil { error = text }
        status = "Disconnected"
        ready = false
    }

    func disconnect() { pipe.close(); ready = false }

    func stopConnecting() async {
        started = false
        launchTask?.cancel()
        startTask?.cancel()
        // A create already sent may still be completing in the daemon. Await its
        // reply before closing the transport so Quit can account for that shell.
        await startTask?.value
        await launchTask?.value
        disconnect()
    }

    func submit(_ line: String) async throws {
        guard ready, let client, let termID else { throw PtyError.closed }
        guard !line.contains("\n"), !line.contains("\r"), !line.contains("\0") else {
            throw PtyError.connection("Terminal commands must contain a single line.")
        }
        guard try await atShell() else { throw PtyError.connection("The terminal is busy. Return to its shell before launching a command.") }
        try Task.checkCancellation()
        let _: Bool? = try await client.request(.init(op: "write", term: termID, data: line))
        try await Task.sleep(for: .milliseconds(60))
        let _: Bool? = try await client.request(.init(op: "write", term: termID, data: "\r"))
    }

    func atShell() async throws -> Bool {
        struct Foreground: Decodable, Sendable { let atShell: Bool }
        guard ready, let client, let termID else { throw PtyError.closed }
        let result: Foreground = try await client.request(.init(op: "foreground", term: termID))
        return result.atShell
    }

    func interrupt() async throws {
        guard ready, let client, let termID else { throw PtyError.closed }
        let _: Bool? = try await client.request(.init(op: "write", term: termID, data: "\u{03}"))
    }

    func waitUntilReady() async throws {
        for _ in 0..<100 {
            if ready { return }
            if let error { throw PtyError.connection(error) }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw PtyError.connection("The terminal did not become ready. Open its pane and retry.")
    }

    func quit() async {
        if let host, let client, let hello { await host.quit(client: client, hello: hello) }
        pipe.close()
    }

    func viewportText() async -> String? {
        let memory = pipe.memory!
        return await Task.detached {
            memory.waitForPendingOutput()
            return memory.readViewportText()
        }.value
    }
}
