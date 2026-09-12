import Foundation
import Observation

@MainActor @Observable final class GitHistoryViewModel {
    let worktree: String
    private(set) var scope = GitHistoryScope.branchChanges
    private(set) var search = ""
    private(set) var commits: [GitCommit] = []
    private(set) var selectedSHA: String?
    private(set) var detail: GitCommitDetail?
    private(set) var patch: DiffViewModel?
    private(set) var page: GitHistoryPage?
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var loadingDetail = false
    private(set) var error: String?
    private(set) var detailError: String?
    private(set) var hasMore = false
    @ObservationIgnored private var service: any GitHistoryService
    @ObservationIgnored private var baseURL: URL
    @ObservationIgnored private var base = ""
    @ObservationIgnored private var active = false
    @ObservationIgnored private var listTask: Task<Void, Never>?
    @ObservationIgnored private var detailTask: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var detailGeneration = UUID()
    @ObservationIgnored private var nextOffset = 0
    @ObservationIgnored private let pageSize: Int
    @ObservationIgnored private let copy: (String) -> Void

    init(worktree: String, baseURL: URL, base: String = "", service: any GitHistoryService,
         pageSize: Int = 200, copy: @escaping (String) -> Void = { _ in }) {
        self.worktree = worktree; self.baseURL = baseURL; self.base = base
        self.service = service; self.pageSize = pageSize; self.copy = copy
    }
    var rows: [GitCommit] { commits.filter { search.isEmpty || $0.searchText.localizedStandardContains(search) } }
    var contextLabel: String {
        if let base = page?.base, !base.isEmpty { return "Commits ahead of \(base)" }
        return page?.branch.map { "History of \($0)" } ?? "Commit history"
    }
    var emptyLabel: String {
        if !search.isEmpty { return "No loaded commits match this search." }
        if let base = page?.base, !base.isEmpty { return "No commits ahead of \(base)." }
        return "No commits on this branch yet."
    }
    func connect(baseURL: URL, service: any GitHistoryService) {
        hide(); self.baseURL = baseURL; self.service = service
    }
    func updateBase(_ value: String) {
        guard value != base else { return }
        base = value
        if active, scope == .branchChanges { refresh() }
    }
    func setScope(_ value: GitHistoryScope) {
        guard scope != value else { return }
        scope = value; commits = []; page = nil; clearDetail(); refresh()
    }
    func setSearch(_ value: String) {
        search = value
        if let selectedSHA, !rows.contains(where: { $0.sha == selectedSHA }) { select(rows.first?.sha) }
    }
    func show() { active = true; reload(preserveLoadedPages: true) }
    func refresh() { reload(preserveLoadedPages: false) }
    private func reload(preserveLoadedPages: Bool) {
        listTask?.cancel(); generation = UUID(); loadingMore = false; loading = false
        loadPage(reset: true, preserveLoadedPages: preserveLoadedPages)
    }
    func loadMore() { guard hasMore, !loading, !loadingMore else { return }; loadPage(reset: false) }
    private func loadPage(reset: Bool, preserveLoadedPages: Bool = false) {
        guard active else { return }
        let generation = generation
        let query = GitHistoryQuery(aheadOnly: scope == .branchChanges, base: base)
        let offset = reset ? 0 : nextOffset
        if reset { loading = true } else { loadingMore = true }
        error = nil
        listTask = Task {
            defer {
                if self.generation == generation { loading = false; loadingMore = false; listTask = nil }
            }
            do {
                let value = try await service.log(worktree: worktree, query: query, skip: offset, limit: pageSize)
                try Task.checkCancellation()
                guard self.generation == generation, active else { return }
                if !reset {
                    guard let revision = page?.historyRevision, revision == value.historyRevision else {
                        hasMore = false
                        throw BackendError.operation("History changed while loading older commits. Refresh history to continue.")
                    }
                }
                var seen = Set(reset ? [] : commits.map(\.sha))
                let added = value.commits.filter { seen.insert($0.sha).inserted }
                if reset, preserveLoadedPages, value.historyRevision != nil,
                   value.historyRevision == page?.historyRevision, nextOffset > value.commits.count {
                    let firstIDs = Set(added.map(\.sha))
                    commits = added + commits.filter { !firstIDs.contains($0.sha) }
                } else {
                    commits = reset ? added : commits + added
                    nextOffset = offset + value.commits.count
                    hasMore = value.commits.count == pageSize && !added.isEmpty
                }
                page = value
                if let selectedSHA, rows.contains(where: { $0.sha == selectedSHA }) {
                    if patch == nil { select(selectedSHA) }
                } else { select(rows.first?.sha) }
            } catch {
                if self.generation == generation, !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
    }
    func select(_ sha: String?) {
        clearDetail()
        guard let sha, commits.contains(where: { $0.sha == sha }) else { return }
        selectedSHA = sha; loadingDetail = true
        let generation = detailGeneration
        detailTask = Task {
            defer { if detailGeneration == generation { loadingDetail = false; detailTask = nil } }
            do {
                let value = try await service.detail(worktree: worktree, sha: sha)
                try Task.checkCancellation()
                guard detailGeneration == generation, selectedSHA == sha, active else { return }
                detail = value
                patch = DiffViewModel(worktree: worktree, baseURL: baseURL,
                    service: HistoricalPatchService(diff: value.diff), allowsFileOpening: false)
            } catch { if detailGeneration == generation, !Task.isCancelled { detailError = error.localizedDescription } }
        }
    }
    func retryDetail() { select(selectedSHA) }
    func copySHA() { if let selectedSHA { copy(selectedSHA) } }
    private func clearDetail() {
        detailTask?.cancel(); detailTask = nil; detailGeneration = UUID()
        patch?.disconnect(); patch = nil; detail = nil; detailError = nil; loadingDetail = false; selectedSHA = nil
    }
    func hide() {
        active = false; listTask?.cancel(); listTask = nil; generation = UUID(); loading = false; loadingMore = false
        let selection = selectedSHA
        clearDetail(); selectedSHA = selection
    }
    func waitForList() async { await listTask?.value }
    func waitForDetail() async { await detailTask?.value }
}
