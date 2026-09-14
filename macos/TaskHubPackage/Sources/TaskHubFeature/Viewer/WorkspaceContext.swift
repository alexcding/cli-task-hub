import AppKit
import Foundation
import Observation
import WebKit

enum ReviewSection: String, Codable, CaseIterable, Identifiable {
    case changes = "Changes", history = "History"
    var id: String { rawValue }
}

enum WorkspacePane: String, Codable, CaseIterable { case off, term, diff, build }

struct ContextSnapshot: Codable, Equatable, Sendable {
    var pages: [WebPageRecord] = []
    var activeID: String?
    var history: [WebPageRecord] = []
    var pane = "term"
    var reviewSection: ReviewSection? = nil
    var documents: [FileDocumentRecord]? = nil
    var tabOrder: [String]? = nil
    var fileHistory: [FileDocumentRecord]? = nil
    var historyOrder: [String]? = nil
    var legacyDocuments: [SavedTabContent]? = nil
    var legacyFileHistory: [SavedTabContent]? = nil

    static func importing(_ tab: SavedTab) -> Self {
        var result = Self()
        result.reviewSection = tab.reviewView == "history" ? .history : .changes
        result.documents = []; result.tabOrder = []; result.fileHistory = []; result.historyOrder = []
        result.pane = tab.paneView == "off" ? "off" : "term"
        if tab.pageClosed != true, safeWebURL(tab.url) != nil {
            let current = tab.cur.flatMap { safeWebURL($0)?.absoluteString } ?? tab.url
            let page = WebPageRecord(url: current, title: tab.title)
            result.pages.append(page); result.tabOrder?.append(page.id); result.activeID = page.id
        }
        for link in tab.links ?? [] {
            if link.kind == "file" {
                if let path = link.filePath {
                    let file = FileDocumentRecord(path: path)
                    result.documents?.append(file); result.tabOrder?.append(file.id)
                    if link.active == true { result.activeID = file.id }
                }
                continue
            }
            guard let raw = link.url, safeWebURL(raw) != nil else { continue }
            let page = WebPageRecord(url: raw, title: link.title ?? raw)
            result.pages.append(page); result.tabOrder?.append(page.id)
            if link.active == true { result.activeID = page.id }
        }
        if result.activeID == nil { result.activeID = result.tabOrder?.first }
        for link in (tab.history ?? []).suffix(100) {
            if let path = link.filePath {
                let file = FileDocumentRecord(path: path)
                result.fileHistory?.append(file); result.historyOrder?.append(file.id)
            } else if let raw = link.url, safeWebURL(raw) != nil {
                let page = WebPageRecord(url: raw, title: link.title ?? raw)
                result.history.append(page); result.historyOrder?.append(page.id)
            }
        }
        // Retain the original metadata for older clients; native documents never navigate a remote WebKit page.
        result.legacyDocuments = (tab.links ?? []).filter { $0.kind == "file" }
        result.legacyFileHistory = (tab.history ?? []).filter { $0.kind == "file" }
        return result
    }
}

@MainActor @Observable final class WorkspaceContext: @MainActor Identifiable {
    fileprivate(set) var id: String
    let sourceURL: String
    private(set) var pages: [BrowserPage] = []
    private(set) var documents: [EditorDocumentViewModel] = []
    private(set) var tabOrder: [String] = []
    private(set) var fileHistory: [FileDocumentRecord] = []
    private(set) var historyOrder: [String] = []
    private(set) var activeID: String? {
        didSet { if oldValue != activeID { workspaceViewModel?.documentStateChanged() } }
    }
    private(set) var history: [WebPageRecord] = []
    private(set) var pane: WorkspacePane = .term {
        didSet { if oldValue != pane { workspaceViewModel?.reviewStateChanged() } }
    }
    private(set) var reviewSection: ReviewSection = .changes {
        didSet { if oldValue != reviewSection { workspaceViewModel?.reviewStateChanged() } }
    }
    var restoring = false {
        didSet { if oldValue != restoring { workspaceViewModel?.documentStateChanged() } }
    }
    var findVisible = false
    var findText = ""
    var error: String?
    private(set) var legacyDocuments: [SavedTabContent] = []
    private(set) var legacyFileHistory: [SavedTabContent] = []
    @ObservationIgnored var changed: () -> Void = {}
    @ObservationIgnored var activateDocument: (EditorDocumentViewModel) -> Void = { _ in }
    @ObservationIgnored var activatePage: (BrowserPage) -> Void = { _ in }
    @ObservationIgnored var isOwned: () -> Bool = { true }
    @ObservationIgnored private let closeCoordinator: EditorCloseCoordinator
    @ObservationIgnored private let pageFactory: BrowserPageFactory
    @ObservationIgnored private let documentFactory: any DocumentFeatureFactory
    private(set) var workspaceViewModel: SessionWorkspaceViewModel?

    func configureWorkspace(factory: any WorkspaceFeatureFactory, service: any WorkspaceServing) {
        guard workspaceViewModel == nil else { return }
        workspaceViewModel = factory.workspace(context: self, service: service)
    }

    init(id: String, sourceURL: String, title: String, snapshot: ContextSnapshot? = nil,
         pageFactory: BrowserPageFactory = BrowserPageFactory(),
         documentFactory: any DocumentFeatureFactory = NativeDocumentFeatureFactory(),
         closeCoordinator: EditorCloseCoordinator? = nil) {
        self.id = id; self.sourceURL = sourceURL
        self.pageFactory = pageFactory
        self.documentFactory = documentFactory
        self.closeCoordinator = closeCoordinator ?? EditorCloseCoordinator(factory: documentFactory)
        if let snapshot {
            legacyDocuments = snapshot.legacyDocuments ?? []
            legacyFileHistory = snapshot.legacyFileHistory ?? []
            var ids: Set<String> = []
            pages = snapshot.pages.filter { safeWebURL($0.url) != nil && ids.insert($0.id).inserted }.map(pageFactory.make)
            history = Array(snapshot.history.filter { safeWebURL($0.url) != nil }.suffix(100))
            let records = snapshot.documents ?? legacyDocuments.compactMap { entry in
                entry.filePath.map { FileDocumentRecord(path: $0) }
            }
            documents = records.filter { $0.path.hasPrefix("/") && ids.insert($0.id).inserted }.map { documentFactory.editor(record: $0) }
            tabOrder = Self.order(snapshot.tabOrder, ids: pages.map(\.id) + documents.map(\.id))
            fileHistory = snapshot.fileHistory ?? legacyFileHistory.compactMap { entry in
                entry.filePath.map { FileDocumentRecord(path: $0) }
            }
            historyOrder = Self.order(snapshot.historyOrder, ids: history.map(\.id) + fileHistory.map(\.id))
            activeID = tabOrder.contains(snapshot.activeID ?? "") ? snapshot.activeID : tabOrder.first
            pane = WorkspacePane(rawValue: snapshot.pane) ?? .term
            reviewSection = snapshot.reviewSection ?? .changes
            if pane == .build { pane = .term }
        } else if safeWebURL(sourceURL) != nil {
            let page = pageFactory.make(.init(url: sourceURL, title: title))
            pages = [page]; tabOrder = [page.id]; activeID = page.id
        }
        pages.forEach(wire)
        documents.forEach(wire)
    }

    var activeDocument: EditorDocumentViewModel? { documents.first { $0.id == activeID } }
    var tabs: [WorkspaceTab] { tabOrder.compactMap(tab) }
    var visits: [WorkspaceVisit] { historyOrder.compactMap { id in
        if let page = history.first(where: { $0.id == id }) { return .page(page) }
        return fileHistory.first(where: { $0.id == id }).map(WorkspaceVisit.file)
    } }
    func tab(_ id: String) -> WorkspaceTab? {
        if let page = pages.first(where: { $0.id == id }) { return .page(page) }
        return documents.first(where: { $0.id == id }).map(WorkspaceTab.file)
    }
    private static func order(_ preferred: [String]?, ids: [String]) -> [String] {
        var seen: Set<String> = []
        return ((preferred ?? []) + ids).filter { ids.contains($0) && seen.insert($0).inserted }
    }
    var activePage: BrowserPage? { pages.first { $0.id == activeID } }
    var snapshot: ContextSnapshot {
        .init(pages: pages.map(\.record), activeID: activeID, history: history, pane: pane == .build ? "term" : pane.rawValue,
              reviewSection: reviewSection, documents: documents.map(\.record), tabOrder: tabOrder, fileHistory: fileHistory, historyOrder: historyOrder,
              legacyDocuments: legacyDocuments, legacyFileHistory: legacyFileHistory)
    }
    func setReviewSection(_ value: ReviewSection) { reviewSection = value; changed() }
    func setPane(_ value: WorkspacePane) { pane = value; changed() }
    fileprivate func absorb(_ source: WorkspaceContext) {
        let pageIDs = Set(pages.map(\.id)), documentIDs = Set(documents.map(\.id))
        let incomingPages = source.pages.filter { !pageIDs.contains($0.id) }
        let incomingDocuments = source.documents.filter { !documentIDs.contains($0.id) }
        pages += incomingPages; documents += incomingDocuments
        incomingPages.forEach(wire); incomingDocuments.forEach(wire)
        tabOrder = Self.order(tabOrder + source.tabOrder, ids: pages.map(\.id) + documents.map(\.id))
        history += source.history.filter { value in !history.contains { $0.id == value.id } }
        fileHistory += source.fileHistory.filter { value in !fileHistory.contains { $0.id == value.id } }
        historyOrder = Self.order(historyOrder + source.historyOrder, ids: history.map(\.id) + fileHistory.map(\.id))
        trimHistory()
        if let selected = source.activeID, tabOrder.contains(selected) { activeID = selected }
        source.changed = {}; source.activatePage = { _ in }; source.activateDocument = { _ in }
        source.pages = []; source.documents = []; source.tabOrder = []; source.activeID = nil
    }
    func select(_ page: BrowserPage) { activeID = page.id; pane = .term; activatePage(page); changed() }
    func select(_ tab: WorkspaceTab) {
        switch tab { case .page(let page): select(page)
        case .file(let file): activeID = file.id; pane = .term; activateDocument(file); changed() }
    }
    func cycle(_ direction: Int) {
        guard !tabOrder.isEmpty else { return }
        let index = tabOrder.firstIndex(of: activeID ?? "") ?? 0
        if let tab = tab(tabOrder[(index + direction + tabOrder.count) % tabOrder.count]) { select(tab) }
    }
    @discardableResult func openFile(_ path: String, line: Int = 1, column: Int = 1) -> EditorDocumentViewModel? {
        guard path.hasPrefix("/"), !path.contains("\0") else { error = "Choose an absolute file path."; return nil }
        let path = (path as NSString).standardizingPath
        if let file = documents.first(where: { $0.record.path == path }) { select(.file(file)); file.focus(line: line, column: column); return file }
        let file = documentFactory.editor(record: .init(path: path))
        documents.append(file); wire(file); insert(file.id); noteHistory(file.record)
        select(.file(file)); file.focus(line: line, column: column); return file
    }
    private func insert(_ id: String) {
        let index = tabOrder.firstIndex(of: activeID ?? "").map { $0 + 1 } ?? tabOrder.endIndex
        tabOrder.insert(id, at: index)
        pages.sort { tabOrder.firstIndex(of: $0.id)! < tabOrder.firstIndex(of: $1.id)! }
    }
    func close(_ tab: WorkspaceTab) {
        switch tab { case .page(let page): close(page)
        case .file(let file):
            closeCoordinator.requestClose([file], isOwned: { [weak self, weak file] in
                guard let self, let file else { return false }
                return isOwned() && documents.contains { $0 === file }
            }, commit: { [weak self, weak file] in
                if let file { self?.remove(file) }
            })
        }
    }
    func remove(_ file: EditorDocumentViewModel) {
        guard documents.contains(where: { $0 === file }) else { return }
        noteHistory(file.record); file.dispose(); documents.removeAll { $0 === file }; removeTab(file.id)
    }
    private func removeTab(_ id: String) {
        let index = tabOrder.firstIndex(of: id) ?? 0
        tabOrder.removeAll { $0 == id }
        if activeID == id {
            activeID = tabOrder.isEmpty ? nil : tabOrder[min(index, tabOrder.count - 1)]
            if let activeID, let tab = tab(activeID) { select(tab) }
        }
        changed()
    }
    @discardableResult func open(_ url: String, title: String = "", configuration: WKWebViewConfiguration? = nil) -> BrowserPage? {
        guard safeWebURL(url) != nil || (configuration != nil && url == "about:blank") else {
            error = "Enter an HTTP or HTTPS address."; return nil
        }
        if configuration == nil, let existing = pages.first(where: { $0.url == url }) { select(existing); return existing }
        let page = pageFactory.make(.init(url: url, title: title.isEmpty ? (URL(string: url)?.host ?? url) : title))
        wire(page)
        pages.append(page); insert(page.id)
        if let configuration { page.materialize(configuration: configuration, load: false) }
        error = nil
        select(page)
        noteHistory(page.record)
        return page
    }
    func close(_ page: BrowserPage) {
        guard let index = pages.firstIndex(where: { $0 === page }) else { return }
        noteHistory(page.record)
        page.evict()
        pages.remove(at: index)
        removeTab(page.id)
    }
    func apply(_ snapshot: ContextSnapshot) {
        // Used only for the first backend load, before the user edits this context.
        pages.forEach { $0.evict() }; documents.forEach { $0.dispose() }
        let restored = WorkspaceContext(id: id, sourceURL: sourceURL, title: "", snapshot: snapshot, pageFactory: pageFactory, documentFactory: documentFactory, closeCoordinator: closeCoordinator)
        pages = restored.pages; activeID = restored.activeID; history = restored.history; pane = restored.pane
        reviewSection = restored.reviewSection
        documents = restored.documents; tabOrder = restored.tabOrder; fileHistory = restored.fileHistory; historyOrder = restored.historyOrder
        documents.forEach(wire)
        legacyDocuments = restored.legacyDocuments; legacyFileHistory = restored.legacyFileHistory
        pages.forEach(wire)
    }
    private func noteHistory(_ page: WebPageRecord) {
        guard safeWebURL(page.url) != nil else { return }
        history.removeAll { $0.url == page.url }
        history.append(page)
        historyOrder.removeAll { id in !history.contains { $0.id == id } && !fileHistory.contains { $0.id == id } }
        historyOrder.removeAll { $0 == page.id }; historyOrder.append(page.id)
        trimHistory()
    }
    private func noteHistory(_ file: FileDocumentRecord) {
        fileHistory.removeAll { $0.path == file.path }; fileHistory.append(file)
        historyOrder.removeAll { id in !history.contains { $0.id == id } && !fileHistory.contains { $0.id == id } }
        historyOrder.removeAll { $0 == file.id }; historyOrder.append(file.id); trimHistory()
    }
    private func trimHistory() {
        historyOrder = Array(historyOrder.suffix(100))
        history.removeAll { !historyOrder.contains($0.id) }; fileHistory.removeAll { !historyOrder.contains($0.id) }
    }
    private func wire(_ file: EditorDocumentViewModel) { file.changed = { [weak self] in self?.changed() } }
    private func wire(_ page: BrowserPage) {
        page.isOwned = { [weak self, weak page] in
            guard let self, let page else { return false }
            return isOwned() && pages.contains { $0 === page }
        }
        page.changed = { [weak self, weak page] in
            guard let self, let page else { return }
            noteHistory(page.record); changed()
        }
        page.openPopup = { [weak self] url, configuration in
            self?.open(url.absoluteString, configuration: configuration)?.webView
        }
    }
}

@MainActor @Observable final class ViewerStore {
    let closeCoordinator: EditorCloseCoordinator
    let fileOpen: FileOpenViewModel
    let fileOpenCoordinator: FileOpenCoordinator
    private(set) var contexts: [String: WorkspaceContext] = [:]
    private(set) var activeContextID: String? {
        didSet {
            guard oldValue != activeContextID else { return }
            fileOpen.cancel()
            oldValue.flatMap { contexts[$0] }?.workspaceViewModel?.setActive(false)
            active?.workspaceViewModel?.setActive(true)
        }
    }
    @ObservationIgnored var prepareContext: (WorkspaceContext) -> Void = { _ in }
    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var saved: [String: ContextSnapshot] = [:]
    @ObservationIgnored private var dirty: Set<String> = []
    @ObservationIgnored private var edited: Set<String> = []
    @ObservationIgnored private var writes: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var loading: Task<Void, Never>?
    @ObservationIgnored private var restoring = false
    @ObservationIgnored private var restoreGeneration = UUID()
    @ObservationIgnored private var lru: [String] = []
    private(set) var pageLimit: Int
    private(set) var pressureCleanupCount = 0
    @ObservationIgnored private let memoryPressure: (any MemoryPressureMonitoring)?
    @ObservationIgnored private let pageFactory: BrowserPageFactory
    @ObservationIgnored private let documentFactory: any DocumentFeatureFactory
    private let cacheURL: URL?
    private struct Cache: Codable { let snapshots: [String: ContextSnapshot]; let pending: Set<String> }
    init(limit: Int = RemotePageRetention.defaultLimit, cacheURL: URL? = nil, memoryPressure: (any MemoryPressureMonitoring)? = nil,
         pageFactory: BrowserPageFactory = BrowserPageFactory(),
         documentFactory: any DocumentFeatureFactory = NativeDocumentFeatureFactory(),
         closeCoordinator: EditorCloseCoordinator? = nil) {
        pageLimit = RemotePageRetention.clamp(limit); self.cacheURL = cacheURL
        self.pageFactory = pageFactory
        self.documentFactory = documentFactory
        self.closeCoordinator = closeCoordinator ?? EditorCloseCoordinator(factory: documentFactory)
        fileOpen = documentFactory.fileOpen()
        fileOpenCoordinator = documentFactory.fileOpenCoordinator()
        self.memoryPressure = memoryPressure
        fileOpenCoordinator.bind(fileOpen, activeContext: { [weak self] in self?.active })
        if let cacheURL, let data = try? Data(contentsOf: cacheURL), let cache = try? JSONDecoder().decode(Cache.self, from: data) {
            saved = cache.snapshots; dirty = cache.pending; edited = cache.pending
        }
        memoryPressure?.start { [weak self] in self?.handleMemoryPressure() }
    }
    var active: WorkspaceContext? { activeContextID.flatMap { contexts[$0] } }
    func configure(_ document: EditorDocumentViewModel) {
        guard let api else { return }
        document.connect(service: documentFactory.editorService(api: api), makeSurface: { [documentFactory] in documentFactory.editorSurface(baseURL: api.baseURL) })
    }
    func openFile(in context: WorkspaceContext) {
        guard active === context, !closeCoordinator.isPresenting else { return }
        fileOpen.begin(contextID: context.id)
    }
    func closeDocuments(contextIDs: Set<String>? = nil, worktrees: [String] = []) async -> Bool {
        fileOpen.cancel()
        func affected(_ document: EditorDocumentViewModel, context: WorkspaceContext) -> Bool {
            if contextIDs == nil || contextIDs!.contains(context.id) { return true }
            let path = URL(fileURLWithPath: document.record.path).resolvingSymlinksInPath().path
            return worktrees.contains { root in
                let root = URL(fileURLWithPath: root).resolvingSymlinksInPath().path
                return path == root || path.hasPrefix(root + "/")
            }
        }
        while true {
            let targets = contexts.values.flatMap { context in
                context.documents.filter { affected($0, context: context) }.map { (context, $0) }
            }
            if targets.isEmpty { return true }
            guard await closeCoordinator.close(targets.map { $0.1 }, isOwned: {
                targets.allSatisfy { context, document in
                    contexts[context.id] === context && context.documents.contains { $0 === document }
                }
            }, commit: {
                for (context, document) in targets { context.remove(document) }
            }) else { return false }
            // Include documents opened by other routes while a save awaits.
        }
    }
    var livePageCount: Int { contexts.values.flatMap(\.pages).filter { $0.webView != nil }.count }
    var suspendedPageCount: Int { contexts.values.flatMap(\.pages).filter { $0.webView == nil }.count }
    var backgroundPageCount: Int { livePageCount - (active?.activePage?.webView == nil ? 0 : 1) }

    func setPageLimit(_ value: Int) {
        pageLimit = RemotePageRetention.clamp(value)
        trimPages(maximum: pageLimit)
    }

    func suspendBackgroundPages() { trimPages(maximum: active?.activePage?.webView == nil ? 0 : 1) }

    private func handleMemoryPressure() {
        pressureCleanupCount += 1
        suspendBackgroundPages()
    }

    func connect(_ api: APIClient) {
        fileOpenCoordinator.enabled = true
        memoryPressure?.start { [weak self] in self?.handleMemoryPressure() }
        self.api = api
        loading?.cancel()
        restoring = true
        contexts.values.forEach { $0.restoring = true }
        contexts.values.flatMap(\.documents).forEach(configure)
        let generation = UUID(); restoreGeneration = generation
        loading = Task {
            defer {
                if restoreGeneration == generation {
                    restoring = false
                    contexts.values.forEach { $0.restoring = false }
                    if !Task.isCancelled, let page = active?.activePage { activate(page) }
                }
            }
            do {
                let values: [String: String?] = try await api.get(Routes.SETTINGS)
                try Task.checkCancellation()
                for (key, value) in values where key.hasPrefix("native.context.") {
                    guard let value, let data = value.data(using: .utf8),
                          let snapshot = try? JSONDecoder().decode(ContextSnapshot.self, from: data) else { continue }
                    let id = String(key.dropFirst("native.context.".count))
                    guard !edited.contains(id) else { continue }
                    saved[id] = snapshot
                    contexts[id]?.apply(snapshot)
                    contexts[id]?.documents.forEach(configure)
                }
                cache()
                for id in dirty { if let snapshot = saved[id] { enqueue(id: id, snapshot: snapshot, api: api) } }
            } catch { if !Task.isCancelled { active?.error = "Could not restore page tabs: \(error.localizedDescription)" } }
        }
    }
    @discardableResult func select(id: String, url: String, title: String, legacy: SavedTab? = nil) -> WorkspaceContext {
        let context = contexts[id] ?? WorkspaceContext(id: id, sourceURL: url, title: title,
                                                       snapshot: saved[id] ?? legacy.map(ContextSnapshot.importing), pageFactory: pageFactory, documentFactory: documentFactory, closeCoordinator: closeCoordinator)
        contexts[id] = context
        context.isOwned = { [weak self, weak context] in
            guard let self, let context else { return false }
            return contexts[context.id] === context
        }
        prepareContext(context)
        context.restoring = restoring
        context.changed = { [weak self, weak context] in
            if let context { self?.save(context) }
        }
        context.activatePage = { [weak self] in self?.activate($0) }
        context.activateDocument = { [weak self] in self?.configure($0) }
        context.documents.forEach(configure)
        activeContextID = id
        if !restoring, let page = context.activePage { activate(page) }
        return context
    }
    func deactivate() { activeContextID = nil }
    func promoteContext(from sourceID: String, to destinationID: String) throws {
        guard sourceID != destinationID, let source = contexts[sourceID] else {
            throw BackendError.operation("The source page is no longer available. Open its session to continue.")
        }
        // Move the actual objects, including dirty documents and live WebKit
        // pages. Recreating them from a snapshot would discard unsaved buffers.
        fileOpen.cancel()
        contexts.removeValue(forKey: sourceID)
        let context: WorkspaceContext
        if let existing = contexts[destinationID] {
            source.workspaceViewModel?.setActive(false)
            existing.absorb(source); context = existing
        } else {
            source.id = destinationID; contexts[destinationID] = source; context = source
        }
        if activeContextID == sourceID { activeContextID = destinationID }
        context.setPane(.term)
        // Keep the old persisted snapshot as history for reopening the page.
        // Outstanding writes under its old key cannot overwrite this context.
    }
    func remove(id: String) async {
        if fileOpen.request?.contextID == id { fileOpen.cancel() }
        let context = contexts.removeValue(forKey: id)
        context?.workspaceViewModel?.setActive(false)
        context?.changed = {}
        context?.pages.forEach { $0.evict() }
        context?.documents.forEach { $0.dispose() }
        if activeContextID == id { activeContextID = nil }
        await writes[id]?.value
        writes[id] = nil
        saved.removeValue(forKey: id); dirty.remove(id); edited.remove(id)
        cache()
        if let api { try? await api.setSetting("native.context.\(id)", value: "") }
    }
    private func activate(_ page: BrowserPage) {
        page.materialize()
        lru.removeAll { $0 == page.id }; lru.append(page.id)
        trimPages(maximum: pageLimit)
    }
    private func trimPages(maximum: Int) {
        let all = contexts.values.flatMap(\.pages)
        lru.removeAll { id in !all.contains { $0.id == id && $0.webView != nil } }
        let protectedID = active?.activePage?.id
        while lru.count > maximum {
            guard let index = lru.firstIndex(where: { $0 != protectedID }) else { break }
            let id = lru.remove(at: index)
            all.first { $0.id == id }?.evict()
        }
    }
    private func save(_ context: WorkspaceContext) {
        edited.insert(context.id)
        dirty.insert(context.id)
        saved[context.id] = context.snapshot
        cache()
        guard let api else { return }
        enqueue(id: context.id, snapshot: context.snapshot, api: api)
    }
    private func enqueue(id: String, snapshot: ContextSnapshot, api: APIClient) {
        let previous = writes[id]
        writes[id] = Task { [weak self] in
            await previous?.value
            do {
                try Task.checkCancellation()
                let json = String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)
                try await api.setSetting("native.context.\(id)", value: json)
                guard let self else { return }
                if saved[id] == snapshot { dirty.remove(id); cache() }
            } catch { if !Task.isCancelled { self?.contexts[id]?.error = "Page tabs saved locally; backend sync failed: \(error.localizedDescription)" } }
        }
    }
    private func cache() {
        guard let cacheURL else { return }
        do {
            try FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(Cache(snapshots: saved, pending: dirty)).write(to: cacheURL, options: .atomic)
        } catch { active?.error = "Could not save page tabs locally: \(error.localizedDescription)" }
    }
    func stop() async {
        fileOpenCoordinator.enabled = false
        memoryPressure?.stop()
        loading?.cancel(); await loading?.value; loading = nil
        for task in writes.values { await task.value }
        writes.removeAll(); api = nil
    }
}
