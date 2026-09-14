import Dispatch
import Foundation

@MainActor protocol MemoryPressureMonitoring: AnyObject {
    func start(_ handler: @escaping @MainActor @Sendable () -> Void)
    func stop()
}

@MainActor final class NativeMemoryPressureMonitor: MemoryPressureMonitoring {
    private var source: (any DispatchSourceMemoryPressure)?
    private var generation = UUID()

    func start(_ handler: @escaping @MainActor @Sendable () -> Void) {
        guard source == nil else { return }
        let token = UUID(); generation = token
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .global(qos: .utility))
        source.setEventHandler { [weak self] in
            Task { @MainActor in
                guard let self, self.source != nil, self.generation == token else { return }
                handler()
            }
        }
        self.source = source
        source.resume()
    }

    func stop() { generation = UUID(); source?.cancel(); source = nil }
    deinit { source?.cancel() }
}

enum RemotePageRetention {
    static let defaultLimit = 6
    static let range = 1...12
    static func clamp(_ limit: Int) -> Int { min(range.upperBound, max(range.lowerBound, limit)) }
}
