import Foundation
import Observation
import WebKit

enum WorkspacePane: String, Codable, CaseIterable { case off, term, diff, build }

struct ContextSnapshot: Codable, Equatable, Sendable {
    var pages: [WebPageRecord] = []
    var activeID: String?
    var history: [WebPageRecord] = []
    var pane = "term"
    var legacyDocuments: [SavedTabContent]? = nil
    var legacyFileHistory: [SavedTabContent]? = nil

    static func importing(_ tab: SavedTab) -> Self {
        var result = Self()
        result.pane = tab.paneView == "off" ? "off" : "term"
        if tab.pageClosed != true, safeWebURL(tab.url) != nil {
            let current = tab.cur.flatMap { safeWebURL($0)?.absoluteString } ?? tab.url
            let page = WebPageRecord(url: current, title: tab.title)
            result.pages.append(page); result.activeID = page.id
        }
        for link in tab.links ?? [] {
            guard link.kind != "file", let raw = link.url, safeWebURL(raw) != nil else { continue }
            let page = WebPageRecord(url: raw, title: link.title ?? raw)
            result.pages.append(page)
            if link.active == true { result.activeID = page.id }
        }
        if result.activeID == nil { result.activeID = result.pages.first?.id }
        result.history = Array((tab.history ?? []).compactMap { link -> WebPageRecord? in
            guard link.kind != "file", let raw = link.url, safeWebURL(raw) != nil else { return nil }
            return WebPageRecord(url: raw, title: link.title ?? raw)
        }.suffix(100))
        // Keep saved file entries for the document milestone. They never become
        // remote WebKit navigations or disappear during the native tab import.
        result.legacyDocuments = (tab.links ?? []).filter { $0.kind == "file" }
        result.legacyFileHistory = (tab.history ?? []).filter { $0.kind == "file" }
        return result
    }
}

@MainActor @Observable final class WorkspaceContext: Identifiable {
    let id: String
    let sourceURL: String
    private(set) var pages: [BrowserPage] = []
    private(set) var activeID: String?
    private(set) var history: [WebPageRecord] = []
    private(set) var pane: WorkspacePane = .term
    var findVisible = false
    var findText = ""
    var error: String?
    private(set) var legacyDocuments: [SavedTabContent] = []
    private(set) var legacyFileHistory: [SavedTabContent] = []
    @ObservationIgnored var changed: () -> Void = {}
    @ObservationIgnored var activatePage: (BrowserPage) -> Void = { _ in }

    init(id: String, sourceURL: String, title: String, snapshot: ContextSnapshot? = nil) {
        self.id = id; self.sourceURL = sourceURL
        if let snapshot {
            legacyDocuments = snapshot.legacyDocuments ?? []
            legacyFileHistory = snapshot.legacyFileHistory ?? []
            var ids: Set<String> = []
            pages = snapshot.pages.filter { safeWebURL($0.url) != nil && ids.insert($0.id).inserted }.map(BrowserPage.init)
            history = Array(snapshot.history.filter { safeWebURL($0.url) != nil }.suffix(100))
            activeID = pages.contains { $0.id == snapshot.activeID } ? snapshot.activeID : pages.first?.id
            pane = WorkspacePane(rawValue: snapshot.pane) ?? .term
            if pane == .build { pane = .term }
        } else if safeWebURL(sourceURL) != nil {
            let page = BrowserPage(.init(url: sourceURL, title: title))
            pages = [page]; activeID = page.id
        }
        pages.forEach(wire)
    }

    var activePage: BrowserPage? { pages.first { $0.id == activeID } }
    var snapshot: ContextSnapshot {
        .init(pages: pages.map(\.record), activeID: activeID, history: history, pane: pane == .build ? "term" : pane.rawValue,
              legacyDocuments: legacyDocuments, legacyFileHistory: legacyFileHistory)
    }
    func setPane(_ value: WorkspacePane) { pane = value; changed() }
    func select(_ page: BrowserPage) { activeID = page.id; pane = .term; activatePage(page); changed() }
    func cycle(_ direction: Int) {
        guard !pages.isEmpty else { return }
        let index = pages.firstIndex { $0.id == activeID } ?? 0
        select(pages[(index + direction + pages.count) % pages.count])
    }
    @discardableResult func open(_ url: String, title: String = "", configuration: WKWebViewConfiguration? = nil) -> BrowserPage? {
        guard safeWebURL(url) != nil || (configuration != nil && url == "about:blank") else {
            error = "Enter an HTTP or HTTPS address."; return nil
        }
        if configuration == nil, let existing = pages.first(where: { $0.url == url }) { select(existing); return existing }
        let page = BrowserPage(.init(url: url, title: title.isEmpty ? (URL(string: url)?.host ?? url) : title))
        wire(page)
        let position = pages.firstIndex { $0.id == activeID }.map { $0 + 1 } ?? pages.endIndex
        pages.insert(page, at: position)
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
        if activeID == page.id {
            activeID = pages.isEmpty ? nil : pages[min(index, pages.count - 1)].id
            if let activePage { activatePage(activePage) }
        }
        changed()
    }
    func apply(_ snapshot: ContextSnapshot) {
        // Used only for the first backend load, before the user edits this context.
        pages.forEach { $0.evict() }
        let restored = WorkspaceContext(id: id, sourceURL: sourceURL, title: "", snapshot: snapshot)
        pages = restored.pages; activeID = restored.activeID; history = restored.history; pane = restored.pane
        legacyDocuments = restored.legacyDocuments; legacyFileHistory = restored.legacyFileHistory
        pages.forEach(wire)
    }
    private func noteHistory(_ page: WebPageRecord) {
        guard safeWebURL(page.url) != nil else { return }
        history.removeAll { $0.url == page.url }
        history.append(page)
        if history.count > 100 { history.removeFirst(history.count - 100) }
    }
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
    var livePageCount: Int { contexts.values.flatMap(\.pages).filter { $0.webView != nil }.count }

    func connect(_ api: APIClient) {
        self.api = api
        loading?.cancel()
        restoring = true
        let generation = UUID(); restoreGeneration = generation
        loading = Task {
            defer {
                if restoreGeneration == generation {
                    restoring = false
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
        context.changed = { [weak self, weak context] in
            if let context { self?.save(context) }
        }
        context.activatePage = { [weak self] in self?.activate($0) }
        activeContextID = id
        if !restoring, let page = context.activePage { activate(page) }
        return context
    }
    func deactivate() { activeContextID = nil }
    func remove(id: String) async {
        let context = contexts.removeValue(forKey: id)
        context?.changed = {}
        context?.pages.forEach { $0.evict() }
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
