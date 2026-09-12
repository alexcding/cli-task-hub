import Darwin
import Foundation

enum ResourceGroup: String, Sendable { case app = "App", backend = "Backend", terminals = "Terminals" }
struct ResourceRoot: Sendable { let pid: Int32; let group: ResourceGroup }
struct ProcessResourceCounter: Sendable, Identifiable {
    let pid: Int32
    let startedSeconds: UInt64
    let startedMicroseconds: UInt64
    let name: String
    let group: ResourceGroup
    let residentBytes: UInt64
    let cpuTicks: UInt64
    let sampledTicks: UInt64
    var id: String { "\(pid):\(startedSeconds):\(startedMicroseconds)" }
    func cpuPercent(since previous: Self?) -> Double? {
        guard let previous, previous.id == id, sampledTicks > previous.sampledTicks,
              cpuTicks >= previous.cpuTicks else { return nil }
        // PROC_PIDTASKINFO and mach_absolute_time both use Mach clock units.
        // Apple verifies the counter unit in xnu/tests/recount/recount_perf_tests.c.
        return 100 * Double(cpuTicks - previous.cpuTicks) / Double(sampledTicks - previous.sampledTicks)
    }
}
struct ResourceUsageSample: Sendable {
    var processes: [ProcessResourceCounter]
    var notes: [String] = []
    var updatedAt = Date()
}
protocol ResourceUsageService: Sendable { func sample() async throws -> ResourceUsageSample }

// Kernel reads run off the UI actor. No shell commands, process arguments, private
// WebKit selectors or machine-wide process table are collected.
actor NativeProcessResourceSampler {
    func sample(roots: [ResourceRoot]) throws -> ResourceUsageSample {
        let limit = 512
        var queue = roots.filter { $0.pid > 1 }.map { (root: $0, parent: Int32?.none) }
        var seen = Set<Int32>(), counters: [ProcessResourceCounter] = []
        var skipped = 0, truncated = false, index = 0
        while index < queue.count && index < limit {
            try Task.checkCancellation()
            let item = queue[index]; index += 1
            guard seen.insert(item.root.pid).inserted else { continue }
            var info = proc_taskallinfo()
            let size = Int32(MemoryLayout<proc_taskallinfo>.size)
            guard proc_pidinfo(item.root.pid, PROC_PIDTASKALLINFO, 0, &info, size) == size,
                  info.pbsd.pbi_pid == UInt32(item.root.pid),
                  item.parent == nil || info.pbsd.pbi_ppid == UInt32(item.parent!) else { skipped += 1; continue }
            let (ticks, overflow) = info.ptinfo.pti_total_user.addingReportingOverflow(info.ptinfo.pti_total_system)
            guard !overflow else { skipped += 1; continue }
            var name = withUnsafeBytes(of: info.pbsd.pbi_name) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
            if name.isEmpty { name = withUnsafeBytes(of: info.pbsd.pbi_comm) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) } }
            counters.append(.init(pid: item.root.pid, startedSeconds: info.pbsd.pbi_start_tvsec,
                startedMicroseconds: info.pbsd.pbi_start_tvusec, name: name.isEmpty ? "Process" : name,
                group: item.root.group, residentBytes: info.ptinfo.pti_resident_size,
                cpuTicks: ticks, sampledTicks: mach_absolute_time()))
            var children = [Int32](repeating: 0, count: limit)
            errno = 0
            let count = children.withUnsafeMutableBytes { proc_listchildpids(item.root.pid, $0.baseAddress, Int32($0.count)) }
            if count < 0 || (count == 0 && errno != 0) { skipped += 1; continue }
            if count >= limit { truncated = true }
            for pid in children.prefix(min(limit, Int(count))) where pid > 1 && !seen.contains(pid) {
                guard queue.count < limit else { truncated = true; break }
                queue.append((ResourceRoot(pid: pid, group: item.root.group), item.root.pid))
            }
        }
        var notes: [String] = []
        if skipped > 0 { notes.append("\(skipped) process reads were unavailable or changed during sampling.") }
        if truncated { notes.append("Process sampling reached its 512-process limit; totals are partial.") }
        return .init(processes: counters, notes: notes)
    }
}

struct NativeResourceUsageService: ResourceUsageService {
    let api: APIClient?
    let pty: PtydConfiguration?
    private let sampler = NativeProcessResourceSampler()
    init(api: APIClient?, pty: PtydConfiguration?) { self.api = api; self.pty = pty }

    func sample() async throws -> ResourceUsageSample {
        async let backend = backendRoot()
        async let terminal = terminalRoot()
        let discoveries = await [backend, terminal]
        try Task.checkCancellation()
        // Explicit roots precede the app so a child backend/daemon keeps its own
        // category even when also reachable through the app's descendants.
        let roots = discoveries.compactMap(\.root) + [ResourceRoot(pid: getpid(), group: .app)]
        var result = try await sampler.sample(roots: roots)
        result.notes += discoveries.compactMap(\.note)
        return result
    }

    private func backendRoot() async -> (root: ResourceRoot?, note: String?) {
        guard let api else { return (nil, "Backend is disconnected; its resources are not included.") }
        do {
            let pid = try await api.health().pid
            guard pid > 1 else { throw BackendError.incompatible }
            return (ResourceRoot(pid: pid, group: .backend), nil)
        }
        catch { return (nil, "Backend resources are unavailable: \(error.localizedDescription)") }
    }
    private func terminalRoot() async -> (root: ResourceRoot?, note: String?) {
        guard let pty else { return (nil, "Terminal configuration is unavailable.") }
        let client = PtydClient(onEvent: { _ in })
        defer { client.close() }
        do {
            try pty.validateSocket()
            let hello = try await client.connect(path: pty.socketPath)
            guard hello.pid > 1 else { throw PtyError.connection("Invalid PTY helper identity.") }
            return (ResourceRoot(pid: hello.pid, group: .terminals), nil)
        } catch {
            if PtydHost.mayStartDaemon(after: error) { return (nil, "PTY helper is not running.") }
            return (nil, "Terminal resources are unavailable: \(error.localizedDescription)")
        }
    }
}
