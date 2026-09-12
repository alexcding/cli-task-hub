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
    private var input: TerminalInputQueue?
    private var replaying = true
    private var attaching = true
    private var buffered: [PtyEvent] = []
    private var queuedBytes = 0
    private var queuedEvents = 0
    private var paused = false
    private var failed = false
    private var lastSequence: UInt64 = 0
    private var lastStateSequence: UInt64?
    private var ended = false
    private var inputEnqueues = 0
    private var latestGrid: (UInt16, UInt16)?
    private let error: @Sendable (String) -> Void
    private let exited: @Sendable (Int) -> Void
    private(set) var memory: InMemoryTerminalSession!
    var isClosed: Bool { lock.withLock { failed } }

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
        input?.close()
        input = TerminalInputQueue(send: { data in
            let _: Bool? = try await client.request(.init(op: "write", term: id, bytes: data))
        }, onError: { [weak self] message in
            guard let self else { return }
            self.lock.lock(); self.failLocked(message); self.lock.unlock()
        })
        let grid = latestGrid
        lock.unlock()
        if let grid { resize(columns: grid.0, rows: grid.1) }
    }

    func synchronizeGrid() async throws {
        for _ in 0..<100 {
            let state = lock.withLock { (failed, client, termID, latestGrid) }
            guard !state.0, let client = state.1, let term = state.2 else { throw PtyError.closed }
            if let grid = state.3 {
                let _: Bool? = try await client.request(.init(op: "resize", term: term, cols: grid.0, rows: grid.1))
                return
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw PtyError.connection("The native terminal did not report its grid size.")
    }

    func receive(_ event: PtyEvent) {
        lock.lock()
        defer { lock.unlock() }
        guard event.id == termID, !failed else { return }
        queuedEvents += 1
        guard queuedEvents <= 16384 else { failLocked("Terminal output exceeded its event limit."); return }
        if event.ev == "inputError" {
            failLocked("Terminal input delivery failed: \(event.message ?? "PTY write failed.") Earlier input may have been sent; remaining input was stopped. Check the shell before reattaching.")
            return
        }
        if event.ev == "data" {
            guard let bytes = event.bytes, event.seq != nil else {
                failLocked("The terminal daemon sent an incomplete byte frame."); return
            }
            queuedBytes += bytes.count
            guard queuedBytes <= 8 * 1024 * 1024 else { failLocked("Terminal output exceeded its buffer limit."); return }
            if queuedBytes > 1024 * 1024 && !paused { flowLocked(true) }
        }
        if attaching {
            buffered.append(event)
        }
        else { scheduleLocked(event) }
    }

    @MainActor
    func attach(_ snapshot: PtySnapshot, daemonOwnsStateResponses: Bool = false, daemonOwnsIdentityResponses: Bool = false, onReady: @escaping @Sendable () -> Void) async throws {
        try snapshot.header.validate()
        guard snapshot.bytes.count == snapshot.header.size else {
            throw PtyError.connection("The terminal snapshot is incomplete.")
        }
        guard memory.restoreSnapshot(snapshot.bytes) else {
            throw PtyError.connection("The terminal snapshot could not be imported. Reattach to retry with a fresh capture; the shell is still running.")
        }
        if daemonOwnsIdentityResponses {
            guard memory.enableHostIdentityResponses() else {
                throw PtyError.connection("Terminal identity response ownership could not be configured.")
            }
        } else if daemonOwnsStateResponses, !memory.enableHostStateResponses() {
            throw PtyError.connection("Terminal state response ownership could not be configured.")
        }
        let memory = memory!
        // Metadata uses Ghostty's bounded app mailbox. Keep draining it while
        // the worker publishes, including when an occluded surface has no ticks.
        let ticker = Task { @MainActor in
            while !Task.isCancelled {
                _ = memory.flushSnapshotMetadataCallbacks()
                do { try await Task.sleep(for: .milliseconds(10)) }
                catch { return }
            }
        }
        let published = await Task.detached(operation: { memory.publishSnapshotMetadata() }).value
        ticker.cancel()
        guard published,
              memory.flushSnapshotMetadataCallbacks() else {
            throw PtyError.connection("The restored terminal metadata could not be published.")
        }
        try Task.checkCancellation()
        finishSnapshotAttachment(snapshot.header, onReady: onReady)
    }

    private func finishSnapshotAttachment(_ header: PtySnapshot.Header, onReady: @escaping @Sendable () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard !failed else { return }
        lastSequence = header.seq
        lastStateSequence = header.stateSeq
        // Import does not replay historical side effects. Live protocol replies
        // must be delivered while the UI still gates user interaction.
        replaying = false
        for event in buffered {
            if (event.ev == "data" || event.ev == "resize"), let state = event.stateSeq, state <= header.stateSeq {
                consumedLocked(event.bytes?.count ?? 0)
            } else { scheduleLocked(event) }
            if failed { break }
        }
        buffered.removeAll()
        attaching = false
        outputQueue.async { [self] in
            lock.lock()
            let ready = !failed && !ended
            lock.unlock()
            if ready { onReady() }
        }
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
            consumedLocked(replay.count, event: false)
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
        guard !failed else { return }
        if let state = lastStateSequence, event.ev == "data" || event.ev == "resize" {
            guard let next = event.stateSeq, let sequence = event.seq else {
                failLocked("The terminal daemon omitted ordered state metadata."); return
            }
            guard next > state else { consumedLocked(event.bytes?.count ?? 0); return }
            guard state < UInt64.max, next == state + 1 else {
                failLocked("Terminal state sequence gap; reattachment required."); return
            }
            if event.ev == "resize" {
                guard sequence == lastSequence, let cols = event.cols, let rows = event.rows,
                      cols > 0, rows > 0, cols <= 4096, rows <= 4096,
                      UInt32(cols) * UInt32(rows) <= 1024 * 1024 else {
                    failLocked("The terminal daemon returned an invalid ordered resize."); return
                }
                lastStateSequence = next
                outputQueue.async { [self] in
                    lock.lock(); let active = !failed; lock.unlock()
                    guard active else { return }
                    if !memory.applyHostGridSize(columns: cols, rows: rows) {
                        lock.lock(); failLocked("The terminal could not apply its ordered grid change."); lock.unlock()
                    }
                    lock.lock(); consumedLocked(0); lock.unlock()
                }
                return
            }
            guard lastSequence < UInt64.max, sequence == lastSequence + 1 else {
                failLocked("Terminal output sequence gap; reattachment required."); return
            }
            lastStateSequence = next
        }
        if event.ev == "data", let sequence = event.seq, let bytes = event.bytes {
            guard sequence > lastSequence else { consumedLocked(bytes.count); return }
            guard sequence == lastSequence + 1 else { failLocked("Terminal output sequence gap; reconnect required."); return }
            lastSequence = sequence
            outputQueue.async { [self] in
                lock.lock(); let active = !failed; lock.unlock()
                guard active else { return }
                memory.receive(bytes)
                memory.waitForPendingOutput()
                lock.lock(); consumedLocked(bytes.count); lock.unlock()
            }
        } else if event.ev == "exit" {
            ended = true
            outputQueue.async { [self] in
                memory.waitForPendingOutput()
                lock.lock(); replaying = true; consumedLocked(0); lock.unlock()
                exited(event.exitCode ?? 0)
            }
        } else { consumedLocked(0) }
    }

    private func consumedLocked(_ count: Int, event: Bool = true) {
        queuedBytes = max(0, queuedBytes - count)
        if event { queuedEvents = max(0, queuedEvents - 1) }
        if paused && queuedBytes < 256 * 1024 { flowLocked(false) }
    }

    private func flowLocked(_ pause: Bool) {
        paused = pause
        client?.fire(.init(op: "flow", term: termID, pause: pause))
    }

    private func failLocked(_ message: String) {
        guard !failed else { return }
        failed = true
        input?.close()
        buffered.removeAll()
        if paused { flowLocked(false) }
        client?.close()
        error(message)
    }

    private func write(_ data: Data) {
        lock.lock()
        // The drain fence keeps replies to historical terminal queries from being
        // injected into the live shell after the replay has supposedly finished.
        guard !replaying, !failed, !ended, termID != nil else { lock.unlock(); return }
        let input = input
        inputEnqueues += 1
        lock.unlock()
        input?.enqueue(data)
        lock.lock(); inputEnqueues -= 1; lock.unlock()
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
        input?.close()
        buffered.removeAll()
        if paused { flowLocked(false) }
        client?.close()
        client = nil
        lock.unlock()
    }

    func freezeForReconnect() -> Bool {
        lock.lock(); defer { lock.unlock() }
        let idleInput = input?.freezeForReconnect() == true
        let safe = !failed && !ended && !attaching && inputEnqueues == 0 && idleInput
        failed = true
        buffered.removeAll()
        if paused { flowLocked(false) }
        client?.close()
        client = nil
        return safe
    }
}
