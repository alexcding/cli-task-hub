import AppKit
import Testing

private let sidebarProject = Project(id: "p1", name: "Project", repo: "o/r", color: nil, workspace: "/tmp")
private func workspaceSession(_ id: String, created: String?, pinned: Bool = false, project: String = "p1", url: String = "") -> WorkspaceSession {
    .init(id: id, projectId: project, workspace: "/tmp", worktree: "/tmp/\(id)", title: id,
          branch: id, url: url, createdAt: created, pinned: pinned)
}

@Test func sidebarPinsAreMirrorsAndTaskTabsAreNotDuplicated() {
    let sessions = [workspaceSession("new", created: "2026-02", pinned: true, url: "https://example.com/task"),
                    workspaceSession("old", created: nil),
                    workspaceSession("orphan", created: "2026-01", project: "deleted")]
    let tabs = [SavedTab(kind: "web", title: "Task context", url: "https://example.com/task"),
                SavedTab(kind: "web", title: "Docs", url: "https://example.com/docs")]
    let entries = SidebarEntry.make(projects: [sidebarProject], sessions: sessions, tabs: tabs)
    // Web sidebar order: Dashboard, Pinned, Projects (sessions nested), orphans, Tabs.
    #expect(entries.map(\.id) == ["overview", "label:pinned", "pin:new", "label:projects", "project:p1",
                                   "session:orphan", "label:tabs", "tab:https://example.com/docs"])
    let project = entries.first { $0.id == "project:p1" }
    #expect(project?.children.map(\.id) == ["session:old", "session:new"])
    #expect(entries.flatMap(\.descendants).filter { $0.destination == .session("new") }.count == 2)
    #expect(entries.filter { $0.role == .label }.allSatisfy { $0.destination == nil && $0.children.isEmpty })
    #expect(Set(entries.flatMap(\.descendants).map(\.id)).count == entries.flatMap(\.descendants).count)
}

@MainActor @Test func cocoaOutlineRetainsNodesSelectionAndExpansionAcrossRefresh() throws {
    _ = NSApplication.shared
    let suite = "taskhub-sidebar-test-\(UUID().uuidString)"
    let preferences = try #require(UserDefaults(suiteName: suite))
    defer { preferences.removePersistentDomain(forName: suite) }
    var selected: SidebarDestination = .overview
    func sidebar(_ sessions: [WorkspaceSession], selection: SidebarDestination) -> CocoaSidebar {
        .init(entries: SidebarEntry.make(projects: [sidebarProject], sessions: sessions, tabs: []),
              selection: selection, pinnedIDs: Set(sessions.filter(\.pinned).map(\.id)),
              onSelect: { selected = $0 }, onTogglePin: { _ in })
    }
    let first = workspaceSession("first", created: "2026-01")
    let value = sidebar([first], selection: .overview)
    let coordinator = CocoaSidebar.Coordinator(parent: value, preferences: preferences)
    let outline = NSOutlineView(frame: NSRect(x: 0, y: 0, width: 260, height: 400))
    let column = NSTableColumn(identifier: .init("name"))
    outline.addTableColumn(column); outline.outlineTableColumn = column
    outline.dataSource = coordinator; outline.delegate = coordinator
    coordinator.outline = outline
    coordinator.update(value)
    func node(_ id: String) throws -> CocoaSidebar.Node {
        try #require((0..<outline.numberOfRows).compactMap { outline.item(atRow: $0) as? CocoaSidebar.Node }.first { $0.entry.id == id })
    }
    let original = try node("session:first")
    outline.selectRowIndexes(IndexSet(integer: outline.row(forItem: original)), byExtendingSelection: false)
    #expect(selected == .session("first"))
    var pinned = first; pinned.pinned = true
    coordinator.update(sidebar([pinned, workspaceSession("second", created: "2026-02")], selection: selected))
    #expect(try node("session:first") === original)
    #expect(outline.item(atRow: outline.selectedRow) as? CocoaSidebar.Node === original)
    let project = try node("project:p1")
    outline.collapseItem(project)
    coordinator.update(sidebar([pinned], selection: .project("p1")))
    #expect(!outline.isItemExpanded(project))
    #expect(preferences.stringArray(forKey: "sidebar.collapsed")?.contains("project:p1") == true)
}

@Test func sidebarSessionRowsCarryAgentStatusAndTabIcons() {
    let sessions = [workspaceSession("busy", created: "2026-01"), workspaceSession("stopped", created: "2026-02")]
    let tabs = [SavedTab(kind: "github", title: "PR", url: "https://github.com/o/r/pull/1", login: "octocat")]
    let entries = SidebarEntry.make(projects: [sidebarProject], sessions: sessions, tabs: tabs,
                                    status: ["busy": .init(live: true, busy: true, cli: "claude")])
    let rows = entries.flatMap(\.descendants)
    #expect(rows.first { $0.id == "session:busy" }?.role == .session(.init(live: true, busy: true, cli: "claude"), pinned: false))
    #expect(rows.first { $0.id == "session:stopped" }?.role == .session(.init(), pinned: false))
    #expect(rows.first { $0.id == "session:stopped" }?.tooltip?.contains("Stopped") == true)
    #expect(rows.first { $0.id == "tab:https://github.com/o/r/pull/1" }?.role == .tab(.init(kind: "github", login: "octocat", url: "https://github.com/o/r/pull/1")))
    #expect(rows.first { $0.id == "project:p1" }?.role == .project(canCreateSession: true))
}
