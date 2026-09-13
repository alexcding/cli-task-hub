import Foundation
import Observation

@MainActor @Observable final class DashboardViewModel {
    private(set) var projects: [DashboardProject] = [] { didSet { if oldValue != projects { snapshotChanged() } } }
    @ObservationIgnored var snapshotChanged: () -> Void = {}
    private(set) var loading = false
    private(set) var updated: Date?
    private(set) var error: String?
    private(set) var opening: Set<String> = []
    var search = ""
    var projectID = ""
    var filter = DashboardFilter.all
    @ObservationIgnored private var service: (any DashboardService)?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshPending = false
    @ObservationIgnored private let openPage: (OpenPageRequest) async throws -> Void
    @ObservationIgnored private let openBrowser: (URL) -> Bool
    @ObservationIgnored private let copy: (String) -> Void

    init(openPage: @escaping (OpenPageRequest) async throws -> Void,
         openBrowser: @escaping (URL) -> Bool, copy: @escaping (String) -> Void) {
        self.openPage = openPage; self.openBrowser = openBrowser; self.copy = copy
    }

    func connect(_ service: any DashboardService) { self.service = service; refresh() }

    var rows: [DashboardRow] {
        var seen: Set<String> = []
        return projects.flatMap { project in
            project.prs.compactMap { pr -> DashboardRow? in
                guard pr.error == nil, pr.state == "OPEN", let address = pr.url, let url = safeWebURL(address) else { return nil }
                let row = DashboardRow(projectID: project.id, projectName: project.name, pr: pr, url: url)
                guard seen.insert(row.id).inserted else { return nil }
                return row
            }
        }
    }
    var visibleRows: [DashboardRow] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return rows.filter { row in
            guard row.isMine || row.inReviewGroup,
                  projectID.isEmpty || row.projectID == projectID,
                  query.isEmpty || row.searchText.localizedStandardContains(query) else { return false }
            switch filter {
            case .all: return true
            case .mine: return row.isMine
            case .review: return row.inReviewGroup
            case .failing: return !row.ciRunning && row.pr.ci?.conclusion == "failure"
            case .drafts: return row.pr.isDraft == true
            }
        }
    }
    var mine: [DashboardRow] { visibleRows.filter(\.isMine) }
    var reviews: [DashboardRow] { visibleRows.filter { !$0.isMine && $0.inReviewGroup } }
    var warnings: [String] {
        projects.flatMap { project -> [String] in
            var messages = project.prs.compactMap { $0.error.map { "\(project.name): \($0)" } }
            if let error = project.syncError { messages.insert("\(project.name): \(error)", at: 0) }
            if project.lastSynced == nil { messages.append("\(project.name): waiting for the first sync.") }
            return messages
        }
    }

    func refresh() {
        refreshPending = true
        guard refreshTask == nil, let service else { return }
        loading = true
        refreshTask = Task {
            defer { refreshTask = nil; loading = false }
            while refreshPending && !Task.isCancelled {
                refreshPending = false
                do {
                    let snapshot = try await service.snapshot()
                    try Task.checkCancellation()
                    if projects != snapshot { projects = snapshot }
                    if !projectID.isEmpty && !projects.contains(where: { $0.id == projectID }) { projectID = "" }
                    updated = Date(); error = nil
                } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            }
        }
    }

    func open(_ row: DashboardRow) async {
        guard opening.insert(row.id).inserted else { return }
        defer { opening.remove(row.id) }
        do {
            try await openPage(row.openPageRequest)
            error = nil
        } catch { self.error = "Could not open pull request: \(error.localizedDescription)" }
    }

    func openExternally(_ row: DashboardRow) {
        if !openBrowser(row.url) { error = "macOS could not open the browser." }
    }
    func copyLink(_ row: DashboardRow) { copy(row.url.absoluteString) }

    func stop() async {
        refreshTask?.cancel(); await refreshTask?.value
        refreshTask = nil; service = nil
    }
}
