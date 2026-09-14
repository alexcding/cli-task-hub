import Testing

@MainActor final class FixtureMemoryPressureMonitor: MemoryPressureMonitoring {
    private var handler: (@MainActor @Sendable () -> Void)?
    private(set) var stopped = false
    func start(_ handler: @escaping @MainActor @Sendable () -> Void) { self.handler = handler; stopped = false }
    func stop() { stopped = true; handler = nil }
    func emit() { handler?() }
}

@MainActor @Test func nativeMemoryPressureMonitorStartsAndStopsWithoutRetainingViewer() {
    let monitor = NativeMemoryPressureMonitor()
    weak var released: ViewerStore?
    do {
        let viewer = ViewerStore(memoryPressure: monitor)
        released = viewer
        viewer.setPageLimit(0)
        #expect(viewer.pageLimit == 1)
        viewer.setPageLimit(Int.max)
        #expect(viewer.pageLimit == 12)
    }
    #expect(released == nil)
    monitor.stop()
    monitor.start { }
    monitor.stop()
}
