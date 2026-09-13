import Foundation
import Observation

@MainActor @Observable final class ProjectPageViewModel {
    private(set) var project: Project
    let editor: ProjectEditorViewModel
    let board: WebBoardViewModel?
    let tickets: JiraTicketsViewModel?
    let workflows: WorkflowEditorViewModel?
    var section = ProjectSection.prs
    var state = "open"
    var search = ""
    private(set) var prs: [DashboardPR] = []
    private(set) var loadedState: String?
    private(set) var error: String?
    private(set) var loading = false
    private var service: (any ProjectService)?
    private var generation = UUID()
    init(project: Project, service: any ProjectService, editor: ProjectEditorViewModel, board: WebBoardViewModel? = nil, tickets: JiraTicketsViewModel? = nil,
         workflows: WorkflowEditorViewModel? = nil) {
        self.project = project; self.service = service; self.editor = editor; self.board = board; self.tickets = tickets
        self.workflows = workflows
    }
    func connect(_ service: (any ProjectService)?) {
        generation = UUID(); loading = false
        self.service = service; editor.connect(service)
    }
    var rows: [DashboardRow] {
        guard loadedState == state else { return [] }
        var seen: Set<String> = []
        return prs.compactMap { pr in
            guard pr.error == nil, let raw = pr.url, let url = safeWebURL(raw) else { return nil }
            let row = DashboardRow(projectID: project.id, projectName: project.name, pr: pr, url: url)
            guard seen.insert(row.id).inserted, search.isEmpty || row.searchText.localizedStandardContains(search) else { return nil }
            return row
        }
    }
    var warnings: [String] { prs.compactMap(\.error) }
    func update(_ project: Project, snapshot: [DashboardPR]? = nil) {
        self.project = project; editor.update(project); tickets?.update(project)
        workflows?.update(project)
        if state == "open", let snapshot { prs = snapshot; loadedState = "open" }
    }
    func refresh() async {
        guard let service else { return }
        let generation = UUID(); self.generation = generation
        let requestedState = state
        loading = true; error = nil
        defer { if self.generation == generation { loading = false } }
        do {
            let result = try await service.pullRequests(project.id, state: requestedState)
            try Task.checkCancellation()
            guard self.generation == generation && state == requestedState else { return }
            prs = result; loadedState = requestedState
        } catch { if self.generation == generation && !Task.isCancelled { self.error = error.localizedDescription } }
    }
}
