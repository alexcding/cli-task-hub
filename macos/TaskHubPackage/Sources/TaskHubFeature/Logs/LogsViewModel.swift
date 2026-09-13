import Foundation
import Observation

@MainActor @Observable final class LogsViewModel {
    var category = "event" { didSet { if oldValue != category { refresh() } } }
    var errorsOnly = false { didSet { if oldValue != errorsOnly { refresh() } } }
    var search = ""
    var confirmingClear = false
    private(set) var clearCategory: String?
    private(set) var categories = ["all", "event"]
    private(set) var entries: [LogEntry] = []
    private(set) var error: String?
    private(set) var loading = false
    private(set) var clearing = false
    private(set) var updated: Date?
    @ObservationIgnored private var service: (any LogService)?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var pending = false
    @ObservationIgnored private var loadedCategory: String?
    @ObservationIgnored private var loadedErrorsOnly = false
    @ObservationIgnored private let openPage: (OpenPageRequest) async throws -> Void
    @ObservationIgnored private let copy: (String) -> Void

    init(openPage: @escaping (OpenPageRequest) async throws -> Void, copy: @escaping (String) -> Void) {
        self.openPage = openPage; self.copy = copy
    }
    func connect(_ service: any LogService) { self.service = service }
    var rows: [LogEntry] {
        guard loadedCategory == category && loadedErrorsOnly == errorsOnly else { return [] }
        return entries.filter { search.isEmpty || "\($0.title) \($0.detail) \($0.category)".localizedStandardContains(search) }
    }
    var clearScopeLabel: String { Self.label(clearCategory ?? category) }
    static func label(_ category: String) -> String {
        switch category { case "all": "All logs"; case "event": "Activity"; default: category.capitalized }
    }
    func refresh() {
        pending = true
        guard task == nil, let service else { return }
        loading = true
        task = Task {
            defer { task = nil; loading = false }
            while pending && !Task.isCancelled {
                pending = false
                let scope = category, errors = errorsOnly
                do {
                    async let categoryRequest = try? service.categories()
                    let entries = try await service.entries(category: scope, errorsOnly: errors)
                    let names = await categoryRequest
                    try Task.checkCancellation()
                    if let names { categories = ["all", "event"] + names.filter { !["all", "event"].contains($0) }.sorted() }
                    if !categories.contains(category) { categories.append(category) }
                    guard scope == category && errors == errorsOnly else { pending = true; continue }
                    self.entries = entries; loadedCategory = scope; loadedErrorsOnly = errors
                    updated = Date(); error = nil
                } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            }
        }
    }
    func requestClear() { guard !clearing else { return }; clearCategory = category; confirmingClear = true }
    func clear(confirmed: Bool) async {
        guard confirmed, let scope = clearCategory, !clearing, let service else { return }
        clearing = true; error = nil
        defer { clearing = false; clearCategory = nil; confirmingClear = false }
        do {
            try await service.clear(category: scope)
            // Invalidate any read taken before deletion; it must not restore deleted rows.
            task?.cancel(); await task?.value
            entries.removeAll { scope == "all" || $0.category == scope }
            refresh()
        } catch { self.error = error.localizedDescription }
    }
    func open(_ entry: LogEntry) async {
        guard let raw = entry.link, safeWebURL(raw) != nil else { return }
        do { try await openPage(OpenPageRequest(url: raw, kind: "github", title: entry.title)) }
        catch { self.error = error.localizedDescription }
    }
    func copyEntry(_ entry: LogEntry) {
        copy("\(entry.created_at) [\(entry.category)/\(entry.level)] \(entry.title)\n\(entry.payload ?? entry.detail)")
    }
    func stop() async { task?.cancel(); await task?.value; task = nil; service = nil }
}
