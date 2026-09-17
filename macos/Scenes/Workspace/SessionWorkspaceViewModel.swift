import Foundation
import Observation

@MainActor struct SessionWorkspaceState {
    var session: WorkspaceSession?
    var project: Project?
    var terminal: TerminalSession?
    var buildTerminal: TerminalSession?
    var build: BuildWorkspaceViewModel?
    var history: GitHistoryViewModel?
    var diff: DiffViewModel?
    var workflow: WorkflowRunViewModel?
    var appearance: AppAppearance = .system
    var documentFont = CodeFont(size: 12)
    var terminalFont = CodeFont(size: 13)
    var connected = false
    var changingSession = false
    var openingExternal = false
    var canPresent = false
    var canCreateSession = false
    /// A GitHub PR or Jira ticket page whose project exists: the toolbar offers Create Session.
    var offersPageSession = false
    var editorID: String?
    var editorLabel: String?
    var gitClientID: String?
    var gitClientLabel: String?
    var launchError: String?
    var reviewBase: String?
}

enum WorkspaceOperation: Equatable {
    case reveal, openEditor, openGitClient, createSession, openFile
    case changes, openTerminal, hookSettings, prepareChanges
}

@MainActor protocol WorkspaceServing: AnyObject {
    func workspaceState(in context: WorkspaceContext) -> SessionWorkspaceState
}

@MainActor @Observable final class SessionWorkspaceViewModel {
    enum Action: Equatable {
        case operation(WorkspaceOperation), run, remove, restart, selectTab(String), closeTab(String), reopen(String)
        case newTab
    }
    struct ReviewInputs: Equatable {
        let pane: WorkspacePane?
        let section: ReviewSection?
        let connected: Bool
        let base: String?
        let sessionID: String?
    }
    @ObservationIgnored private weak var context: WorkspaceContext?
    @ObservationIgnored private weak var service: (any WorkspaceServing)?
    @ObservationIgnored var onAction: (Action) -> Void = { _ in }
    @ObservationIgnored private var previousReviewInputs: ReviewInputs?
    @ObservationIgnored private weak var presentedDiff: DiffViewModel?
    @ObservationIgnored private weak var presentedHistory: GitHistoryViewModel?
    @ObservationIgnored private weak var presentedTerminal: TerminalPaneViewModel?
    @ObservationIgnored private weak var presentedBuildTerminal: TerminalPaneViewModel?
    private(set) var active = false {
        didSet { if oldValue != active { reviewStateChanged(force: true) } }
    }

    init(context: WorkspaceContext, service: any WorkspaceServing) {
        self.context = context; self.service = service
    }
    private var state: SessionWorkspaceState {
        guard let context, let service else { return SessionWorkspaceState() }
        return service.workspaceState(in: context)
    }
    var session: WorkspaceSession? { state.session }
    var terminal: TerminalSession? { state.terminal }
    var buildTerminal: TerminalSession? { state.buildTerminal }
    var build: BuildWorkspaceViewModel? { state.build }
    var history: GitHistoryViewModel? { state.history }
    var diff: DiffViewModel? { state.diff }
    var workflow: WorkflowRunViewModel? {
        guard let model = state.workflow, !model.recipes.isEmpty || model.running else { return nil }
        return model
    }
    var appearance: AppAppearance { state.appearance }
    var launchError: String? { state.launchError }
    var editorID: String? { state.editorID }
    var editorLabel: String? { state.editorLabel }
    var gitClientID: String? { state.gitClientID }
    var gitClientLabel: String? { state.gitClientLabel }
    var runScheme: String {
        if let scheme = state.build?.scheme, !scheme.isEmpty { return scheme }
        if let scheme = state.project?.runScheme, !scheme.isEmpty { return scheme }
        return "Scheme"
    }
    /// The active web page's address when this workspace shows a page, for its favicon.
    var activePageURL: String? {
        guard let url = context?.activePage?.url, FaviconStore.host(of: url) != nil else { return nil }
        return url
    }
    var workspaceTitle: String {
        if context?.id == "scratch" { return "Terminal" }
        return context?.activeDocument?.title ?? context?.activePage?.title ?? "Workspace"
    }
    var terminalPrompt: String {
        context?.id == "scratch" ? "Open an interactive shell." : "Open this session’s shell in its worktree."
    }
    var showsBuild: Bool { session != nil && context?.pane == .build }
    var showsTerminal: Bool { session != nil || context?.id == "scratch" }
    var showsChanges: Bool { session != nil && context?.pane == .diff }
    var showsPage: Bool {
        !showsTerminal || showsChanges || (!showsBuild && context?.pane == .term)
    }
    var showsBuildActions: Bool { session != nil && state.project?.ide == "xcode" }
    var canCreateSession: Bool { state.canCreateSession }
    var offersPageSession: Bool { session == nil && state.offersPageSession }
    var canOpenExternal: Bool { session != nil && !state.openingExternal && !state.changingSession }
    var canShowChanges: Bool { session != nil && state.connected }
    var canRun: Bool { showsBuildActions && state.connected && state.canPresent && !state.changingSession }
    var canRemove: Bool { session != nil && state.connected && state.canPresent && !state.changingSession }
    var canRestart: Bool { session != nil && state.canPresent && !state.changingSession }
    var canToggleContext: Bool { showsTerminal && context != nil }
    var reviewInputs: ReviewInputs {
        .init(pane: context?.pane, section: context?.reviewSection, connected: state.connected, base: state.reviewBase, sessionID: state.session?.id)
    }

    func setActive(_ value: Bool) { active = value }
    func selectTab(_ tab: WorkspaceTab) { onAction(.selectTab(tab.id)) }
    func closeTab(_ tab: WorkspaceTab) { onAction(.closeTab(tab.id)) }
    func newTab() { onAction(.newTab) }
    func reviewStateChanged(force: Bool = false) {
        let inputs = reviewInputs
        if force || previousReviewInputs != inputs {
            previousReviewInputs = inputs
            prepareChanges()
        }
        documentStateChanged()
        terminalStateChanged()
    }
    func terminalStateChanged() {
        let state = state
        let terminal = state.terminal?.presentation, build = state.buildTerminal?.presentation
        if presentedTerminal !== terminal { presentedTerminal?.presentation.active = false }
        if presentedBuildTerminal !== build { presentedBuildTerminal?.presentation.active = false }
        presentedTerminal = terminal; presentedBuildTerminal = build
        terminal?.presentation = .init(active: active && showsTerminal, font: state.terminalFont)
        build?.presentation = .init(active: active && showsBuild, font: state.terminalFont)
    }
    func documentStateChanged() {
        let state = state
        let visible = active && context?.restoring == false
        let reviewing = visible && showsChanges && state.connected
        if presentedDiff !== state.diff { presentedDiff?.presentation.active = false }
        if presentedHistory !== state.history { presentedHistory?.presentation.active = false }
        presentedDiff = state.diff; presentedHistory = state.history
        state.diff?.presentation = .init(active: reviewing && context?.reviewSection == .changes,
                                         appearance: state.appearance, font: state.documentFont)
        state.history?.presentation = .init(active: reviewing && context?.reviewSection == .history,
                                            appearance: state.appearance, font: state.documentFont)
        for page in context?.pages ?? [] {
            let activePage = visible && showsPage && !showsChanges && page === context?.activePage
            page.controls.active = activePage
            page.dialogs.active = activePage
        }
        for document in context?.documents ?? [] {
            document.presentation = .init(active: visible && showsPage && !showsChanges && document === context?.activeDocument,
                                           appearance: state.appearance, font: state.documentFont)
        }
    }
    func prepareChanges() { if active && showsChanges { perform(.prepareChanges) } }
    func reveal() { if session != nil { perform(.reveal) } }
    func openEditor() { if canOpenExternal && editorLabel != nil { perform(.openEditor) } }
    func openGitClient() { if canOpenExternal && gitClientLabel != nil { perform(.openGitClient) } }
    func createSession() { if canCreateSession { perform(.createSession) } }
    func openFile() { perform(.openFile) }
    func toggleChanges() { if canShowChanges { perform(.changes) } }
    func run() { if canRun { onAction(.run) } }
    func remove() { if canRemove { onAction(.remove) } }
    func restart() { if canRestart { onAction(.restart) } }
    func openTerminal() { if showsTerminal { perform(.openTerminal) } }
    func openHookSettings() { perform(.hookSettings) }
    func stopBuild() async { await build?.stop() }
    func toggleBuild() { if buildTerminal != nil { context?.setPane(showsBuild ? .term : .build) } }
    func toggleContext() { if canToggleContext { context?.setPane(context?.pane == .term ? .off : .term) } }
    func setContextPresented(_ presented: Bool) {
        guard canToggleContext else { return }
        context?.setPane(presented ? .term : .off)
    }
    func reopen(_ visit: WorkspaceVisit) {
        guard active, state.canPresent else { return }
        onAction(.reopen(visit.id))
    }
    private func perform(_ operation: WorkspaceOperation) {
        guard context != nil else { return }
        onAction(.operation(operation))
    }
}
