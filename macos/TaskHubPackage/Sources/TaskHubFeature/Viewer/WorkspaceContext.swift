import AppKit
import Foundation
import Observation
import WebKit

enum WorkspacePane: String, Codable, CaseIterable { case off, term, diff, build }

struct ContextSnapshot: Codable, Equatable, Sendable {
    var pages: [WebPageRecord] = []
    var activeID: String?
    var history: [WebPageRecord] = []
    var pane = "term"
    var documents: [FileDocumentRecord]? = nil
    var tabOrder: [String]? = nil
    var fileHistory: [FileDocumentRecord]? = nil
    var historyOrder: [String]? = nil
    var legacyDocuments: [SavedTabContent]? = nil
    var legacyFileHistory: [SavedTabContent]? = nil

    static func importing(_ tab: SavedTab) -> Self {
        var result = Self()
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

@MainActor @Observable final class WorkspaceContext: Identifiable {
    let id: String
    let sourceURL: String
    private(set) var pages: [BrowserPage] = []
    private(set) var documents: [EditorDocumentViewModel] = []
    private(set) var tabOrder: [String] = []
    private(set) var fileHistory: [FileDocumentRecord] = []
    private(set) var historyOrder: [String] = []
    private(set) var activeID: String?
    private(set) var history: [WebPageRecord] = []
    private(set) var pane: WorkspacePane = .term
    var restoring = false
    var findVisible = false
    var findText = ""
    var error: String?
    private(set) var legacyDocuments: [SavedTabContent] = []
    private(set) var legacyFileHistory: [SavedTabContent] = []
    @ObservationIgnored var changed: () -> Void = {}
    @ObservationIgnored var activateDocument: (EditorDocumentViewModel) -> Void = { _ in }
    @ObservationIgnored var activatePage: (BrowserPage) -> Void = { _ in }

    init(id: String, sourceURL: String, title: String, snapshot: ContextSnapshot? = nil) {
        self.id = id; self.sourceURL = sourceURL
        if let snapshot {
            legacyDocuments = snapshot.legacyDocuments ?? []
            legacyFileHistory = snapshot.legacyFileHistory ?? []
            var ids: Set<String> = []
            pages = snapshot.pages.filter { safeWebURL($0.url) != nil && ids.insert($0.id).inserted }.map(BrowserPage.init)
            history = Array(snapshot.history.filter { safeWebURL($0.url) != nil }.suffix(100))
            let records = snapshot.documents ?? legacyDocuments.compactMap { entry in
                entry.filePath.map { FileDocumentRecord(path: $0) }
            }
            documents = records.filter { $0.path.hasPrefix("/") && ids.insert($0.id).inserted }.map { EditorDocumentViewModel(record: $0) }
            tabOrder = Self.order(snapshot.tabOrder, ids: pages.map(\.id) + documents.map(\.id))
            fileHistory = snapshot.fileHistory ?? legacyFileHistory.compactMap { entry in
                entry.filePath.map { FileDocumentRecord(path: $0) }
            }
            historyOrder = Self.order(snapshot.historyOrder, ids: history.map(\.id) + fileHistory.map(\.id))
            activeID = tabOrder.contains(snapshot.activeID ?? "") ? snapshot.activeID : tabOrder.first
            pane = WorkspacePane(rawValue: snapshot.pane) ?? .term
            if pane == .build { pane = .term }
        } else if safeWebURL(sourceURL) != nil {
            let page = BrowserPage(.init(url: sourceURL, title: title))
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
              documents: documents.map(\.record), tabOrder: tabOrder, fileHistory: fileHistory, historyOrder: historyOrder,
              legacyDocuments: legacyDocuments, legacyFileHistory: legacyFileHistory)
    }
    func setPane(_ value: WorkspacePane) { pane = value; changed() }
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
        let file = EditorDocumentViewModel(record: .init(path: path))
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
        case .file(let file): Task { if await EditorCloseCoordinator.confirm([file]) { remove(file) } } }
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
        let page = BrowserPage(.init(url: url, title: title.isEmpty ? (URL(string: url)?.host ?? url) : title))
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
        let restored = WorkspaceContext(id: id, sourceURL: sourceURL, title: "", snapshot: snapshot)
        pages = restored.pages; activeID = restored.activeID; history = restored.history; pane = restored.pane
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
    private(set) var contexts: [String: WorkspaceContext] = [:]
    private(set) var activeContextID: String?
    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var saved: [String: ContextSnapshot] = [:]
    @ObservationIgnored private var dirty: Set<String> = []
    @ObservationIgnored private var edited: Set<String> = []
    @ObservationIgnored private var writes: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var loading: Task<Void, Never>?
    @ObservationIgnored private var openingFile = false
    @ObservationIgnored private var restoring = false
    @ObservationIgnored private var restoreGeneration = UUID()
    @ObservationIgnored private var lru: [String] = []
    private let limit: Int
    private let cacheURL: URL?
    private struct Cache: Codable { let snapshots: [String: ContextSnapshot]; let pending: Set<String> }
    init(limit: Int = 6, cacheURL: URL? = nil) {
        self.limit = max(1, limit); self.cacheURL = cacheURL
        if let cacheURL, let data = try? Data(contentsOf: cacheURL), let cache = try? JSONDecoder().decode(Cache.self, from: data) {
            saved = cache.snapshots; dirty = cache.pending; edited = cache.pending
        }
    }
    var active: WorkspaceContext? { activeContextID.flatMap { contexts[$0] } }
    func configure(_ document: EditorDocumentViewModel) {
        guard let api else { return }
        document.connect(service: APIFileDocumentService(api: api), makeSurface: { WebEditorSurface(baseURL: api.baseURL) })
    }
    func openFile(in context: WorkspaceContext) {
        guard !openingFile, let window = NSApp.keyWindow else { return }
        openingFile = true
        Task { [weak context] in
            defer { openingFile = false }
            let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
            let response = await panel.beginSheetModal(for: window)
            guard response == .OK, let url = panel.url else { return }
            context?.openFile(url.path)
        }
    }
    func closeDocuments(contextIDs: Set<String>? = nil, worktrees: [String] = []) async -> Bool {
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
            guard await EditorCloseCoordinator.confirm(targets.map { $0.1 }) else { return false }
            for (context, document) in targets { context.remove(document) }
            // A previously open file picker can complete while a close sheet awaits.
            // Include any newly opened document before reporting that Quit is safe.
        }
    }
    var livePageCount: Int { contexts.values.flatMap(\.pages).filter { $0.webView != nil }.count }

    func connect(_ api: APIClient) {
        self.api = api
        contexts.values.flatMap(\.documents).forEach(configure)
        loading?.cancel()
        restoring = true
        contexts.values.forEach { $0.restoring = true }
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
                                                       snapshot: saved[id] ?? legacy.map(ContextSnapshot.importing))
        contexts[id] = context
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
    func remove(id: String) async {
        let context = contexts.removeValue(forKey: id)
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
        let all = contexts.values.flatMap(\.pages)
        lru.removeAll { id in !all.contains { $0.id == id && $0.webView != nil } }
        while lru.count > limit {
            let id = lru.removeFirst()
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
        loading?.cancel(); await loading?.value; loading = nil
        for task in writes.values { await task.value }
        writes.removeAll(); api = nil
    }
}
