import Foundation
import Observation
import GhosttyTerminal

@MainActor @Observable
final class TerminalSession: Identifiable {
    let id = UUID()
    let surface = TerminalViewState()
    private(set) var status = "Connecting"
    private(set) var error: String?
    private(set) var shellPID: UInt32?
    private(set) var ready = false
    @ObservationIgnored private var pipe: TerminalPipe!
    @ObservationIgnored private var client: PtydClient?
    @ObservationIgnored private var host: PtydHost?
    @ObservationIgnored private var hello: PtyHello?
    @ObservationIgnored private var started = false
    @ObservationIgnored private var startTask: Task<Void, Never>?

    init() {
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
            if let existing = terminals.first(where: { $0.pairKey == "native-terminal-spike" }) {
                info = existing
            } else {
                info = try await client.request(.init(op: "create", opts: .init(
                    cwd: FileManager.default.homeDirectoryForCurrentUser.path,
                    pairKey: "native-terminal-spike")))
            }
            shellPID = info.pid
            pipe.bind(client: client, id: info.id)
            let attachment: PtyAttachment = try await client.request(.init(op: "attach", term: info.id))
            status = "Restoring output"
            pipe.attach(attachment) { [weak self] in
                Task { @MainActor in
                    guard let self, self.error == nil else { return }
                    self.status = "Connected"
                    self.ready = true
                    self.surface.requestFocus()
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
        startTask?.cancel()
        // A create already sent may still be completing in the daemon. Await its
        // reply before closing the transport so Quit can account for that shell.
        await startTask?.value
        disconnect()
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
