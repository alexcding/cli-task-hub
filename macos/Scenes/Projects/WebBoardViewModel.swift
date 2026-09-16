import Foundation
import Observation

struct BoardTicketLink: Decodable, Equatable {
    let type: String
    let url: String
    let title: String
    let external: Bool

    static func parse(_ body: Any, source: URL?, expected: URL, mainFrame: Bool) -> Self? {
        guard mainFrame, source == expected, JSONSerialization.isValidJSONObject(body),
              let data = try? JSONSerialization.data(withJSONObject: body), data.count <= 8192,
              let link = try? JSONDecoder().decode(Self.self, from: data), link.type == "openTicket",
              SessionPage.parse(link.url)?.kind == "jira" else { return nil }
        return link
    }
}

struct BoardColumn: Decodable, Equatable, Sendable {
    let name: String
    var statusIds: [String] = []
    var statuses: [BoardStatus]?
}

struct BoardStatus: Decodable, Equatable, Sendable {
    let id: String
    let name: String
}

struct BoardSprint: Decodable, Equatable, Sendable {
    var name: String?
    var endDate: String?
}

struct BoardSnapshot: Decodable, Sendable {
    var items: [JiraTicket]
    var lastSynced: String?
    var error: String?
    var sprint: BoardSprint?
    var query: String?
    var columns: [BoardColumn]?
}

protocol BoardService: Sendable {
    func snapshot(projectID: String, force: Bool) async throws -> BoardSnapshot
    func site() async throws -> JiraSite
    func settings() async throws -> [String: String]
    func saveFilter(_ value: String, projectID: String) async throws
    func transition(key: String, status: String) async throws
    func assign(key: String, assignee: String) async throws
}

struct APIBoardService: BoardService {
    let api: APIClient
    func snapshot(projectID: String, force: Bool) async throws -> BoardSnapshot {
        try await api.get(Routes.projectBoard(projectID) + (force ? "?refresh=1" : ""), timeout: force ? 130 : 30)
    }
    func site() async throws -> JiraSite { try await api.get(Routes.JIRA_SITE, timeout: 30) }
    func settings() async throws -> [String: String] { try await api.get(Routes.SETTINGS) }
    func saveFilter(_ value: String, projectID: String) async throws { try await api.setSetting("board_filter_" + projectID, value: value) }
    func transition(key: String, status: String) async throws {
        let _: OperationOK = try await api.request(Routes.jiraKeyTransition(key), method: "POST", body: ["transition": status])
    }
    func assign(key: String, assignee: String) async throws {
        let _: OperationOK = try await api.request(Routes.jiraKeyAssign(key), method: "POST", body: ["assignee": assignee])
    }
}

@MainActor @Observable final class WebBoardViewModel {
    enum Action: Equatable { case openTicket(BoardTicketLink) }
    @ObservationIgnored var onAction: (Action) -> Void = { _ in }
    let navigation: PageActionViewModel
    private(set) var retired = false
    let projectID: String
    private(set) var snapshot: BoardSnapshot?
    private(set) var error: String?
    private(set) var loading = false
    private(set) var busy: Set<String> = []
    private(set) var siteURL: URL?
    var assigneeFilter = "" { didSet { if oldValue != assigneeFilter { persistFilter() } } }
    var appearance = AppAppearance.system
    var active = false { didSet { if active && !oldValue { refresh() } else if !active { cancelActions() } } }
    @ObservationIgnored private var service: any BoardService
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var preferenceTask: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var preferencesLoaded = false

    init(projectID: String, api: APIClient, pageActions: any PageActionServing) {
        self.projectID = projectID
        service = APIBoardService(api: api)
        navigation = PageActionViewModel(service: pageActions)
    }

    var tickets: [JiraTicket] {
        let items = snapshot?.items ?? []
        if assigneeFilter == "__unassigned__" { return items.filter { ($0.assigneeId ?? "").isEmpty } }
        if !assigneeFilter.isEmpty { return items.filter { $0.assigneeId == assigneeFilter } }
        return items
    }
    var columns: [String] {
        var result: [String] = []
        // Jira columns may contain multiple workflow statuses. Render each status
        // as a lane so moving a card always names a real transition destination.
        for column in snapshot?.columns ?? [] {
            for id in column.statusIds {
                let name = column.statuses?.first(where: { $0.id == id })?.name
                let status = (name?.isEmpty == false ? name : nil)
                    ?? snapshot?.items.first(where: { $0.statusId == id })?.status
                if let status, !status.isEmpty, !result.contains(status) { result.append(status) }
            }
        }
        for status in (snapshot?.items ?? []).compactMap(\.status) where !status.isEmpty && !result.contains(status) { result.append(status) }
        return result
    }
    func tickets(in column: String) -> [JiraTicket] { tickets.filter { $0.status == column } }
    var assignees: [(id: String, name: String)] {
        var people: [String: String] = [:]
        for ticket in snapshot?.items ?? [] {
            if let id = ticket.assigneeId, !id.isEmpty { people[id] = ticket.assignee ?? id }
        }
        return people.map { ($0.key, $0.value) }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    func connect(api: APIClient) {
        guard !retired else { return }
        generation = UUID(); task?.cancel(); task = nil; service = APIBoardService(api: api)
        preferencesLoaded = false
        if active { refresh() }
    }
    func pause() { task?.cancel(); task = nil; generation = UUID(); cancelActions() }
    // Retired is terminal: the coordinator has handed this model's screen to another instance, so
    // reactivating here would put a detached board back on the refresh timer and let its callbacks
    // fire again. Every other entry point already refuses; this one did not.
    func show(appearance: AppAppearance) {
        guard !retired else { return }
        self.appearance = appearance
        active = true
    }
    func refresh(force: Bool = false) {
        guard !retired, active, task == nil else { return }
        let generation = generation, service = service
        loading = true; error = nil
        task = Task {
            defer { if self.generation == generation { loading = false; task = nil } }
            do {
                async let board = service.snapshot(projectID: projectID, force: force)
                async let site = service.site()
                let value = try await board
                try Task.checkCancellation()
                guard self.generation == generation else { return }
                snapshot = value
                if let message = value.error { error = message }
                if let location = try? await site { siteURL = safeWebURL(location.baseUrl) }
                if !preferencesLoaded, let settings = try? await service.settings() {
                    assigneeFilter = settings["board_filter_" + projectID] ?? ""
                    preferencesLoaded = true
                }
            } catch { if !Task.isCancelled, self.generation == generation { self.error = error.localizedDescription } }
        }
    }
    func reload() { error = nil; refresh(force: true) }
    func cancelActions() { navigation.cancel() }
    func retire() { suspend(); retired = true; onAction = { _ in } }
    func suspend() { active = false; pause() }

    private func persistFilter() {
        guard preferencesLoaded, !retired else { return }
        preferenceTask?.cancel()
        let value = assigneeFilter, service = service
        preferenceTask = Task {
            do { try await service.saveFilter(value, projectID: projectID) }
            catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
    func move(_ ticket: JiraTicket, to status: String) {
        guard !retired, active, ticket.status != status, !busy.contains(ticket.key) else { return }
        busy.insert(ticket.key); error = nil
        let service = service
        Task {
            defer { busy.remove(ticket.key) }
            do { try await service.transition(key: ticket.key, status: status); refresh(force: true) }
            catch { self.error = error.localizedDescription }
        }
    }
    func assign(_ ticket: JiraTicket, to assignee: String) {
        guard !retired, active, !busy.contains(ticket.key) else { return }
        busy.insert(ticket.key); error = nil
        let service = service
        Task {
            defer { busy.remove(ticket.key) }
            do { try await service.assign(key: ticket.key, assignee: assignee); refresh(force: true) }
            catch { self.error = error.localizedDescription }
        }
    }
    func open(_ ticket: JiraTicket, external: Bool = false) {
        guard let base = siteURL else { error = "Configure the Jira site before opening a ticket."; return }
        let url = base.appendingPathComponent("browse").appendingPathComponent(ticket.key).absoluteString
        onAction(.openTicket(.init(type: "openTicket", url: url, title: ticket.key, external: external)))
    }
    func perform(_ action: Action) {
        guard !retired, active else { return }
        switch action {
        case .openTicket(let link):
            guard let url = safeWebURL(link.url) else { return }
            if link.external { navigation.external(url) }
            else { navigation.open(OpenPageRequest(url: link.url, kind: "jira", title: link.title)) }
        }
    }
    func request(_ link: BoardTicketLink) { perform(.openTicket(link)) }
}
