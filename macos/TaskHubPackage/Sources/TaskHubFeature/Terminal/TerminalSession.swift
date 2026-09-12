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
    private(set) var surface = TerminalViewState()
    private(set) var surfaceGeneration = UUID()
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
    @ObservationIgnored private var stopped = false
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var launchTask: Task<Void, Never>?
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private var commandWrites = 0
    @ObservationIgnored private let configuration: PtydConfiguration?
    @ObservationIgnored var openLink: (String, String, Bool) -> Void = { _, _, _ in }
    @ObservationIgnored var onCreated: ((TerminalSession) async throws -> Void)?

    init(pairKey: String = "native-terminal-spike", cwd: String = FileManager.default.homeDirectoryForCurrentUser.path, paired: Bool = false,
         configuration: PtydConfiguration? = nil) {
        self.pairKey = pairKey
        self.cwd = cwd
        self.paired = paired
        self.configuration = configuration
        makeSurface()
    }

    private func makeSurface() {
        let wasVisible = surface.isSurfaceVisible
        surfaceGeneration = UUID()
        let generation = surfaceGeneration
        surface = TerminalViewState()
        surface.isSurfaceVisible = wasVisible
        pipe = TerminalPipe(onError: { [weak self] text in
            Task { @MainActor in
                guard let self, self.surfaceGeneration == generation else { return }
                self.setError(text, prefer: true)
            }
        }, onExit: { [weak self] code in
            Task { @MainActor in
                guard let self, self.surfaceGeneration == generation else { return }
                self.status = "Exited (\(code))"; self.ready = false
            }
        })
        surface.configuration = .init(backend: .inMemory(pipe.memory), fontSize: 13, resizeThrottleMilliseconds: 80)
        surface.makePlatformView = { [weak self] in
            let view = WorkspaceTerminalView(frame: .zero)
            view.openLink = { [weak self] raw, directory, external in
                guard let self, self.surfaceGeneration == generation else { return }
                self.openLink(raw, directory ?? self.cwd, external)
            }
            return view
        }
        surface.onClose = { [weak self] _ in
            guard let self, self.surfaceGeneration == generation else { return }
            self.status = "Exited"; self.ready = false
        }
    }

    func start() async {
        guard !started, !stopped else { return }
        started = true
        let task = Task {
            do { try await connect(reconnecting: false) }
            catch { setError(error.localizedDescription); pipe.close(); client?.close() }
        }
        startTask = task
        await task.value
    }

    private func connect(reconnecting: Bool) async throws {
        let generation = surfaceGeneration
        // The engine must exist before replay; the package's pre-surface buffer
        // drops old bytes past 1 MiB and is not a substitute for our flow control.
        for _ in 0..<50 {
            if surface.surface != nil { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard surface.surface != nil else { throw PtyError.connection("Ghostty could not create a native surface.") }
        let config = try configuration ?? PtydConfiguration.current()
        let host = PtydHost(configuration: config)
        self.host = host
        let pipe = self.pipe!
        let client = PtydClient(onEvent: { pipe.receive($0) }, onDisconnect: { [weak self] failure in
            let inputWasIdle = pipe.freezeForReconnect()
            Task { @MainActor in
                guard let self, self.surfaceGeneration == generation else { return }
                self.connectionLost(failure, inputWasIdle: inputWasIdle)
            }
        })
        self.client = client
        // Reconnect only to the existing daemon. Never spawn a replacement
        // daemon or shell to hide the loss of the original process.
        if reconnecting { hello = try await client.connect(path: config.socketPath) }
        else { hello = try await host.connect(client: client) }
        try hello?.validateByteTransport()
        try hello?.validateInputAcknowledgements()
        try hello?.validateSnapshots()
        try hello?.validateStateResponseOwner()
        let negotiated: PtyHello = try await client.request(.init(op: "hello", dataEncoding: "base64",
                                                                  snapshotRevision: PtySnapshot.revision))
        try negotiated.validateSnapshots()
        try negotiated.validateStateResponseOwner()
        try Task.checkCancellation()
        let terminals: [PtyInfo] = try await client.request(.init(op: "list"))
        let info: PtyInfo
        let created: Bool
        if reconnecting {
            guard let existing = terminals.first(where: { $0.id == termID && $0.pid == shellPID }) else {
                throw PtyError.connection("The original terminal is no longer running. Automatic reconnect did not create a replacement shell.")
            }
            info = existing
            created = false
        } else if let existing = terminals.first(where: { $0.pairKey == pairKey && $0.paired == paired }) {
            info = existing
            created = false
        } else {
            info = try await client.request(.init(op: "create", opts: .init(
                cwd: cwd, paired: paired, pairKey: pairKey, stateResponseOwner: PtyHello.stateResponseOwnerVersion)))
            created = true
        }
        try info.validateStateResponseOwner()
        shellPID = info.pid
        termID = info.id
        pipe.bind(client: client, id: info.id)
        try await pipe.synchronizeGrid()
        status = "Restoring terminal"
        let snapshot = try await PtySnapshotDownloader(client: client).fetch(term: info.id)
        try await pipe.attach(snapshot, daemonOwnsStateResponses: true) { [weak self] in
            Task { @MainActor in
                guard let self, self.started, self.surfaceGeneration == generation, self.error == nil else { return }
                self.status = "Connected"
                self.ready = true
                if self.isActive && self.showsSurface { self.surface.requestFocus() }
                if created, let onCreated = self.onCreated {
                    self.launchTask = Task {
                        defer { self.launchTask = nil }
                        do {
                            // Let the shell finish its startup files before entering a command.
                            try await Task.sleep(for: .seconds(1))
                            try await onCreated(self)
                        } catch { if !Task.isCancelled, self.error == nil { self.error = error.localizedDescription } }
                    }
                }
            }
        }
        try await waitUntilReady()
    }

    private func connectionLost(_ failure: PtyError, inputWasIdle: Bool) {
        guard !stopped else { return }
        let wasReady = ready
        ready = false
        // The current attempt observes its closed pipeline and handles retry.
        guard reconnectTask == nil else { return }
        guard wasReady, failure.permitsReconnect, inputWasIdle,
              commandWrites == 0, launchTask == nil else {
            setError(inputWasIdle ? failure.localizedDescription :
                "Terminal disconnected while input or attachment was unsettled. Earlier input may have been sent. Check the shell before reattaching.")
            return
        }
        status = "Reconnecting"
        reconnectTask = Task {
            defer { reconnectTask = nil }
            for delay in [250, 500, 1000, 2000, 4000] {
                do {
                    try await Task.sleep(for: .milliseconds(delay))
                    try Task.checkCancellation()
                    guard !stopped else { return }
                    error = nil
                    makeSurface()
                    try await connect(reconnecting: true)
                    return
                } catch {
                    pipe.close()
                    guard !Task.isCancelled, !stopped else { return }
                    if (error as? PtyError)?.permitsReconnect != true {
                        setError(error.localizedDescription)
                        return
                    }
                    if delay == 4000 { setError(error.localizedDescription) }
                    else { status = "Reconnecting" }
                }
            }
        }
    }

    private func setError(_ text: String, prefer: Bool = false) {
        // Closing a failed pipeline also reports a socket disconnect; preserve
        // the actionable root cause (for example truncated restoration).
        if error == nil || prefer { error = text }
        status = "Disconnected"
        ready = false
    }

    func disconnect() {
        // This object owns one connection/surface generation. A delayed ready
        // callback must not reactivate it after its owner removes the pane.
        stopped = true
        reconnectTask?.cancel()
        started = false
        pipe.close()
        ready = false
    }

    func stopConnecting() async {
        stopped = true
        started = false
        launchTask?.cancel()
        startTask?.cancel()
        reconnectTask?.cancel()
        // A create already sent may still be completing in the daemon. Await its
        // reply before closing the transport so Quit can account for that shell.
        await startTask?.value
        await reconnectTask?.value
        await launchTask?.value
        disconnect()
    }

    func submit(_ line: String) async throws {
        guard ready, let client, let termID else { throw PtyError.closed }
        guard !line.contains("\n"), !line.contains("\r"), !line.contains("\0") else {
            throw PtyError.connection("Terminal commands must contain a single line.")
        }
        commandWrites += 1
        defer { commandWrites -= 1 }
        guard try await atShell() else { throw PtyError.connection("The terminal is busy. Return to its shell before launching a command.") }
        try Task.checkCancellation()
        do {
            let _: Bool? = try await client.request(.init(op: "write", term: termID, data: line))
            try await Task.sleep(for: .milliseconds(60))
            let _: Bool? = try await client.request(.init(op: "write", term: termID, data: "\r"))
        } catch {
            setError("Command delivery was interrupted. Earlier input may have been sent. Check the shell before reattaching.", prefer: true)
            throw error
        }
    }

    func atShell() async throws -> Bool {
        struct Foreground: Decodable, Sendable { let atShell: Bool }
        guard ready, let client, let termID else { throw PtyError.closed }
        let result: Foreground = try await client.request(.init(op: "foreground", term: termID))
        return result.atShell
    }

    func interrupt() async throws {
        guard ready, let client, let termID else { throw PtyError.closed }
        commandWrites += 1
        defer { commandWrites -= 1 }
        do {
            let _: Bool? = try await client.request(.init(op: "write", term: termID, data: "\u{03}"))
        } catch {
            setError("Interrupt delivery was interrupted. Earlier input may have been sent. Check the shell before reattaching.", prefer: true)
            throw error
        }
    }

    func waitUntilReady() async throws {
        for _ in 0..<100 {
            if ready { return }
            if let error { throw PtyError.connection(error) }
            if pipe.isClosed { throw PtyError.closed }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw PtyError.connection("The terminal did not become ready. Open its pane and retry.")
    }

    func quit() async {
        await stopConnecting()
        if let host {
            do { try await host.stopExisting() }
            catch { setError(error.localizedDescription) }
        }
    }

    func viewportText() async -> String? {
        let memory = pipe.memory!
        return await Task.detached {
            memory.waitForPendingOutput()
            return memory.readViewportText()
        }.value
    }
}
