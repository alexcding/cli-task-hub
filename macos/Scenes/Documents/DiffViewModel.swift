import Foundation
import Observation

struct DiffSnapshot: Codable, Equatable, Sendable {
    let diff: String
    let untracked: [String]
    let branch: String?
    var fileLinks = true
    var revision: String? = nil
    var ahead: Int? = nil
    var behind: Int? = nil
}

protocol DiffService: Sendable { func load(worktree: String) async throws -> DiffSnapshot }

struct APIDiffService: DiffService {
    let api: APIClient
    func load(worktree: String) async throws -> DiffSnapshot {
        struct Response: Decodable, Sendable {
            let diff: String?, untracked: [String]?, branch: String?, revision: String?
            let ahead: Int?, behind: Int?, error: String?
        }
        let result: Response = try await api.get(APIClient.query(Routes.DIFF, ["path": worktree]), timeout: 30)
        if let error = result.error { throw BackendError.operation(error) }
        guard let diff = result.diff else { throw BackendError.operation("The backend returned no diff.") }
        return .init(diff: diff, untracked: result.untracked ?? [], branch: result.branch,
                     revision: result.revision, ahead: result.ahead, behind: result.behind)
    }
}

enum NativeDiffLineKind: Sendable { case context, addition, deletion, metadata }

struct NativeDiffLine: Identifiable, Sendable {
    let id: Int
    let text: String
    let kind: NativeDiffLineKind
    let oldLine: Int?
    let newLine: Int?
    let selection: [Int]?
    let beginsBlock: Bool
}

struct NativeDiffFile: Identifiable, Sendable {
    let id: Int
    let path: String
    let lines: [NativeDiffLine]
    let additions: Int
    let deletions: Int
}

enum NativeDiffParser {
    static func parse(_ patch: String) -> [NativeDiffFile] {
        struct Builder {
            var path = "Changes"
            var lines: [NativeDiffLine] = []
            var additions = 0, deletions = 0
            var oldLine: Int?, newLine: Int?
            var hunk = -1, block = -1
            var contextGap = 0
        }
        var files: [NativeDiffFile] = []
        var current: Builder?
        var rowID = 0
        func finish(_ builder: Builder?, into files: inout [NativeDiffFile]) {
            guard let builder else { return }
            files.append(.init(id: files.count, path: builder.path, lines: builder.lines,
                               additions: builder.additions, deletions: builder.deletions))
        }
        for rawLine in patch.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if rawLine.hasPrefix("diff --git ") {
                finish(current, into: &files)
                let pieces = rawLine.split(separator: " ")
                let path = pieces.count >= 4 ? String(pieces[3]).replacingOccurrences(of: "b/", with: "", options: .anchored) : "Changes"
                current = Builder(path: path)
                continue
            }
            if current == nil { current = Builder() }
            var builder = current!
            if rawLine.hasPrefix("+++ ") {
                let candidate = String(rawLine.dropFirst(4))
                if candidate != "/dev/null" { builder.path = candidate.replacingOccurrences(of: "b/", with: "", options: .anchored) }
            }
            if rawLine.hasPrefix("@@ ") {
                builder.hunk += 1; builder.block = -1; builder.contextGap = 0
                if let expression = try? NSRegularExpression(pattern: #"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@"#),
                   let match = expression.firstMatch(in: rawLine, range: NSRange(rawLine.startIndex..., in: rawLine)),
                   let oldRange = Range(match.range(at: 1), in: rawLine),
                   let newRange = Range(match.range(at: 2), in: rawLine) {
                    builder.oldLine = Int(rawLine[oldRange]); builder.newLine = Int(rawLine[newRange])
                }
                builder.lines.append(.init(id: rowID, text: rawLine, kind: .metadata,
                                           oldLine: nil, newLine: nil, selection: nil, beginsBlock: false))
                current = builder; rowID += 1; continue
            }
            let kind: NativeDiffLineKind
            var old: Int?, new: Int?, selection: [Int]?
            var beginsBlock = false
            if rawLine.hasPrefix("+") && !rawLine.hasPrefix("+++") {
                kind = .addition; new = builder.newLine; builder.newLine = (builder.newLine ?? 0) + 1; builder.additions += 1
            } else if rawLine.hasPrefix("-") && !rawLine.hasPrefix("---") {
                kind = .deletion; old = builder.oldLine; builder.oldLine = (builder.oldLine ?? 0) + 1; builder.deletions += 1
            } else if rawLine.hasPrefix(" ") {
                kind = .context; old = builder.oldLine; new = builder.newLine
                builder.oldLine = (builder.oldLine ?? 0) + 1; builder.newLine = (builder.newLine ?? 0) + 1
            } else { kind = .metadata }
            if kind == .addition || kind == .deletion, builder.hunk >= 0 {
                if builder.block < 0 || builder.contextGap > 3 { builder.block += 1; beginsBlock = true }
                builder.contextGap = 0; selection = [files.count, builder.hunk, builder.block]
            } else if kind == .context, builder.block >= 0 { builder.contextGap += 1 }
            builder.lines.append(.init(id: rowID, text: rawLine, kind: kind, oldLine: old,
                                       newLine: new, selection: selection, beginsBlock: beginsBlock))
            current = builder; rowID += 1
        }
        finish(current, into: &files)
        return files.filter { !$0.lines.isEmpty }
    }
}

@MainActor @Observable final class DiffViewModel {
    enum Action { case showActions, openFile(DocumentLocation), hide }
    let coordinator: DiffCoordinator
    @ObservationIgnored var onAction: (Action) -> Void = { _ in }
    var presentation = DocumentPresentation() {
        didSet {
            guard oldValue != presentation else { return }
            if oldValue.font != presentation.font { setFont(presentation.font) }
            if oldValue.active != presentation.active {
                if presentation.active { show(appearance: presentation.appearance) } else { hide() }
            }
        }
    }
    let worktree: String
    private(set) var snapshot: DiffSnapshot?
    private(set) var files: [NativeDiffFile] = []
    private(set) var loading = false
    private var loadError: String?
    var error: String? { loadError ?? actions?.error }
    var showsActions: Bool { get { coordinator.showsActions } set { newValue ? requestActions() : coordinator.dismissActions() } }
    var isActive: Bool { active }
    private(set) var actions: GitChangesActions?
    private(set) var font = CodeFont(size: 12)
    @ObservationIgnored private var service: (any DiffService)?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var active = false
    @ObservationIgnored private let allowsFileOpening: Bool

    init(worktree: String, baseURL: URL, service: (any DiffService)? = nil,
         actionsService: (any GitChangesService)? = nil, allowsFileOpening: Bool = true,
         factory: any DocumentFeatureFactory = NativeDocumentFeatureFactory(),
         openFile: @escaping (DocumentLocation) -> Void = { _ in }) {
        self.allowsFileOpening = allowsFileOpening; coordinator = factory.diffCoordinator()
        self.worktree = worktree; self.service = service
        if let actionsService {
            actions = factory.changes(worktree: worktree, service: actionsService, didChange: { [weak self] in
                guard let self, active else { return }
                task?.cancel(); task = nil; generation = UUID(); refresh()
            })
        }
        coordinator.bind(self, openFile: openFile)
    }
    func requestActions() { onAction(.showActions) }
    func connect(baseURL: URL, service: any DiffService) {
        task?.cancel(); task = nil; generation = UUID(); loading = false; self.service = service
        if active { refresh() }
    }
    func show(appearance: AppAppearance) { active = true; refresh() }
    func refresh() {
        guard task == nil else { return }
        guard let service else { loadError = "Connect to the backend to load changes."; return }
        loading = true; loadError = nil
        let generation = generation
        task = Task {
            defer { if self.generation == generation { loading = false; task = nil } }
            do {
                let value = try await service.load(worktree: worktree)
                try Task.checkCancellation()
                let parsed = try await Task.detached(priority: .userInitiated) {
                    guard value.diff.utf8.count <= 8 * 1024 * 1024, value.untracked.count <= 100_000 else {
                        throw BackendError.operation("Diff too large to display.")
                    }
                    return NativeDiffParser.parse(value.diff)
                }.value
                try Task.checkCancellation()
                guard self.generation == generation else { return }
                snapshot = value; files = parsed
            } catch { if !Task.isCancelled, self.generation == generation { self.loadError = error.localizedDescription } }
        }
    }
    func waitForRefresh() async { await task?.value }
    func setAppearance(_ value: AppAppearance) {}
    func setFont(_ value: CodeFont) { font = value }
    func reload() { loadError = nil; refresh() }
    func hide() {
        active = false; onAction(.hide); actions?.cancelDiscard(); task?.cancel(); task = nil
        generation = UUID(); loading = false; snapshot = nil; files = []; loadError = nil
    }
    func disconnect() { presentation.active = false; hide(); service = nil; showsActions = false }
    func open(path: String, line: Int?) {
        guard active, allowsFileOpening else { return }
        do { onAction(.openFile(try WorkingFileLocation.resolve(path, line: line ?? 1, root: worktree))) }
        catch { loadError = error.localizedDescription }
    }
    func discard(_ selection: [Int]) {
        guard active, !loading, let revision = snapshot?.revision, let actions else { return }
        Task { await actions.prepareDiscard(revision: revision, selection: selection) }
    }
}
