import Foundation
import GhosttyTerminal

// Output travels from the socket straight to this bounded pipeline, never through
// observable app state. Ghostty parses on its own serial queue; the drain fence is
// waited on a worker, so parsing and replay cannot block the UI actor.
final class TerminalPipe: @unchecked Sendable {
    private let lock = NSLock()
    private let outputQueue = DispatchQueue(label: "taskhub.terminal.output", qos: .userInitiated)
    private var client: PtydClient?
    private var termID: String?
    private var replaying = true
    private var attaching = true
    private var buffered: [PtyEvent] = []
    private var queuedBytes = 0
    private var paused = false
    private var failed = false
    private var lastSequence: UInt64 = 0
    private var latestGrid: (UInt16, UInt16)?
    private let error: @Sendable (String) -> Void
    private let exited: @Sendable (Int) -> Void
    private(set) var memory: InMemoryTerminalSession!

    init(onError: @escaping @Sendable (String) -> Void, onExit: @escaping @Sendable (Int) -> Void) {
        error = onError
        exited = onExit
        memory = InMemoryTerminalSession(write: { [weak self] in self?.write($0) }, resize: { [weak self] in
            self?.resize(columns: $0.columns, rows: $0.rows)
        }, suppressesPixelOnlyResizes: true)
    }

    func bind(client: PtydClient, id: String) {
        lock.lock()
        self.client = client; termID = id
        let grid = latestGrid
        lock.unlock()
        if let grid { resize(columns: grid.0, rows: grid.1) }
    }

    func receive(_ event: PtyEvent) {
        lock.lock()
        defer { lock.unlock() }
        guard event.id == termID, !failed else { return }
        if event.ev == "data" {
            guard let bytes = event.bytes, event.seq != nil else {
                failLocked("The terminal daemon sent an incomplete byte frame."); return
            }
            queuedBytes += bytes.count
            guard queuedBytes <= 8 * 1024 * 1024 else { failLocked("Terminal output exceeded its buffer limit."); return }
            if queuedBytes > 1024 * 1024 && !paused { flowLocked(true) }
        }
        if attaching { buffered.append(event) }
        else { scheduleLocked(event) }
    }

    func attach(_ attachment: PtyAttachment, onReady: @escaping @Sendable () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard !failed else { return }
        do { try attachment.validateReplay() }
        catch { failLocked(error.localizedDescription); return }
        lastSequence = attachment.seq
        let replay = attachment.bytes
        queuedBytes += replay.count
        guard queuedBytes <= 8 * 1024 * 1024 else { failLocked("Terminal attachment exceeded its buffer limit."); return }
        if queuedBytes > 1024 * 1024 && !paused { flowLocked(true) }
        outputQueue.async { [self] in
            memory.receive(replay)
            memory.waitForPendingOutput()
            lock.lock()
            guard !failed else { lock.unlock(); return }
            replaying = false
            consumedLocked(replay.count)
            lock.unlock()
            onReady()
        }
        for event in buffered {
            if event.ev == "data", (event.seq ?? 0) <= attachment.seq {
                consumedLocked(event.bytes?.count ?? 0)
            } else { scheduleLocked(event) }
        }
        buffered.removeAll()
        attaching = false
    }

    private func scheduleLocked(_ event: PtyEvent) {
        if event.ev == "data", let sequence = event.seq, let bytes = event.bytes {
            guard sequence > lastSequence else { consumedLocked(bytes.count); return }
            guard sequence == lastSequence + 1 else { failLocked("Terminal output sequence gap; reconnect required."); return }
            lastSequence = sequence
            outputQueue.async { [self] in
                memory.receive(bytes)
                memory.waitForPendingOutput()
                lock.lock(); consumedLocked(bytes.count); lock.unlock()
            }
        } else if event.ev == "exit" {
            outputQueue.async { [self] in
                memory.waitForPendingOutput()
                lock.lock(); replaying = true; lock.unlock()
                exited(event.exitCode ?? 0)
            }
        }
    }

    private func consumedLocked(_ count: Int) {
        queuedBytes = max(0, queuedBytes - count)
        if paused && queuedBytes < 256 * 1024 { flowLocked(false) }
    }

    private func flowLocked(_ pause: Bool) {
        paused = pause
        client?.fire(.init(op: "flow", term: termID, pause: pause))
    }

    private func failLocked(_ message: String) {
        failed = true
        buffered.removeAll()
        if paused { flowLocked(false) }
        client?.close()
        error(message)
    }

    private func write(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        // The drain fence keeps replies to historical terminal queries from being
        // injected into the live shell after the replay has supposedly finished.
        guard !replaying, !failed, let termID else { return }
        client?.fire(.init(op: "write", term: termID, bytes: data))
    }

    private func resize(columns: UInt16, rows: UInt16) {
        guard columns > 0, rows > 0 else { return }
        lock.lock()
        defer { lock.unlock() }
        latestGrid = (columns, rows)
        guard !failed, let termID else { return }
        client?.fire(.init(op: "resize", term: termID, cols: columns, rows: rows))
    }

    func close() {
        lock.lock()
        failed = true
        buffered.removeAll()
        if paused { flowLocked(false) }
        client?.close()
        client = nil
        lock.unlock()
    }
}
