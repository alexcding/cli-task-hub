import Foundation
import Testing
@testable import TaskHubFeature

private actor OperationGate<Value: Sendable> {
    private var pending: CheckedContinuation<Value, any Error>?
    private var started: CheckedContinuation<Void, Never>?
    func value() async throws -> Value {
        try await withCheckedThrowingContinuation {
            pending = $0; started?.resume(); started = nil
        }
    }
    func waitForStart() async {
        if pending != nil { return }
        await withCheckedContinuation { started = $0 }
    }
    func finish(_ result: Result<Value, any Error>) {
        let continuation = pending; pending = nil
        continuation?.resume(with: result)
    }
}

private let operationProject = Project(id: "operation", name: "Operation", repo: "", color: nil, workspace: "/tmp/fixture", ide: "xcode")
private let operationSession = WorkspaceSession(id: "operation-session", projectId: "operation", workspace: "/tmp/fixture",
    worktree: "/tmp/fixture/session", title: "Operation", branch: "feature", url: "", createdAt: nil, pinned: false)
private let operationDestinations = (BuildSchemes(target: "/tmp/Fixture.xcodeproj", schemes: ["Fixture"]),
    [BuildSimulator(udid: "fixture-simulator", name: "Fixture", runtime: "Fixture OS")])
private let operationSettings = BuildSettings(appPath: "/tmp/Fixture.app", bundleId: "fixture.app", target: "/tmp/Fixture.xcodeproj", configuration: "Debug")

private actor OperationBuildService: BuildServing {
    var loads = 0, settingsReads = 0, saves = 0
    var destinationsGate: OperationGate<(BuildSchemes, [BuildSimulator])>?
    let settingsGate: OperationGate<BuildSettings>?
    init(destinations: OperationGate<(BuildSchemes, [BuildSimulator])>? = nil, settings: OperationGate<BuildSettings>? = nil) {
        destinationsGate = destinations; settingsGate = settings
    }
    func destinations(project: Project, session: WorkspaceSession) async throws -> (BuildSchemes, [BuildSimulator]) {
        loads += 1
        if let gate = destinationsGate { destinationsGate = nil; return try await gate.value() }
        return operationDestinations
    }
    func settings(project: Project, session: WorkspaceSession, scheme: String, simulator: String) async throws -> BuildSettings {
        settingsReads += 1
        if let settingsGate { return try await settingsGate.value() }
        return operationSettings
    }
    func saveDestination(projectID: String, scheme: String, simulator: String) { saves += 1 }
}

@MainActor private final class OperationBuildTerminal: BuildTerminal {
    var commands: [String] = []
    var interrupts = 0
    let shellGate: OperationGate<Bool>?
    init(shell: OperationGate<Bool>? = nil) { shellGate = shell }
    func waitUntilReady() async throws {}
    func atShell() async throws -> Bool {
        if let shellGate { return try await shellGate.value() }
        return false
    }
    func submit(_ line: String) { commands.append(line) }
    func interrupt() { interrupts += 1 }
}

@MainActor @Test(.timeLimit(.minutes(1))) func operationLifetimeBuildReplacementRejectsOldLoadAndActions() async throws {
    let gate = OperationGate<(BuildSchemes, [BuildSimulator])>(), service = OperationBuildService(destinations: gate)
    var factories = 0
    let runtime = BuildWorkspaceViewModel(service: service, project: operationProject, session: operationSession,
        terminalFactory: { factories += 1; return OperationBuildTerminal() }, reveal: {})
    let coordinator = AppCoordinator(factory: NativeCreationFlowFactory(chooseFolder: { nil }))
    coordinator.presentBuild { runtime }
    let first = try #require(coordinator.sheet)
    guard case .build(let old) = first.destination else { Issue.record("Wrong destination"); return }
    let oldAction = old.onAction
    let loading = Task { await old.load() }
    await gate.waitForStart()
    coordinator.dismissSheet(id: first.id)
    coordinator.presentBuild { runtime }
    let second = try #require(coordinator.sheet)
    guard case .build(let current) = second.destination else { Issue.record("Wrong destination"); return }
    await current.load()
    #expect(current.canRun && current.scheme == "Fixture")
    old.scheme = "obsolete"; await old.load(); await old.run(); oldAction(.started); old.retire()
    await gate.finish(.success((BuildSchemes(target: "old", schemes: ["Obsolete"]), [])))
    await loading.value
    #expect(old.retired && !old.canRun && !old.loading && current.canRun && current.scheme == "Fixture")
    #expect(coordinator.sheet?.id == second.id && factories == 0)
    #expect(await service.loads == 2)
    #expect(await service.settingsReads == 0)
    coordinator.dismissSheet(id: second.id); runtime.disconnect()
}

@MainActor @Test(.timeLimit(.minutes(1))) func operationLifetimeBuildDisconnectDuringSettingsCannotPersistOrStart() async {
    let gate = OperationGate<BuildSettings>(), service = OperationBuildService(settings: gate)
    var factories = 0, callbacks = 0
    let runtime = BuildWorkspaceViewModel(service: service, project: operationProject, session: operationSession,
        terminalFactory: { factories += 1; return OperationBuildTerminal() }, reveal: {})
    let destination = BuildDestinationViewModel(runtime: runtime)
    destination.onAction = { _ in callbacks += 1 }
    await destination.load()
    let run = Task { await destination.run() }
    await gate.waitForStart()
    runtime.disconnect()
    await gate.finish(.success(operationSettings)); await run.value
    await destination.load(); await destination.run(); await runtime.stop()
    #expect(!destination.canRun && !runtime.running && factories == 0 && callbacks == 0)
    #expect(await service.saves == 0)
    #expect(await service.settingsReads == 1)
}

@MainActor @Test(.timeLimit(.minutes(1))) func operationLifetimeBuildDisconnectDuringShellCheckCannotSubmitOrInterrupt() async {
    let gate = OperationGate<Bool>(), service = OperationBuildService()
    let terminal = OperationBuildTerminal(shell: gate)
    let runtime = BuildWorkspaceViewModel(service: service, project: operationProject, session: operationSession,
        terminalFactory: { terminal }, reveal: {})
    let destination = BuildDestinationViewModel(runtime: runtime)
    await destination.load()
    let run = Task { await destination.run() }
    await gate.waitForStart()
    runtime.disconnect()
    await gate.finish(.success(true)); await run.value
    await runtime.stop()
    #expect(terminal.commands.isEmpty && terminal.interrupts == 0 && !runtime.running)
    #expect(await service.saves == 1)
}

private actor OperationRemovalService: SessionRemoving {
    var loads = 0, removals = 0
    let preparation: OperationGate<SessionRemovalPlan>?
    var removal: OperationGate<Void>?
    init(preparation: OperationGate<SessionRemovalPlan>? = nil, removal: OperationGate<Void>? = nil) {
        self.preparation = preparation; self.removal = removal
    }
    func prepare(record: WorkspaceSession, projects: [Project], sessions: [WorkspaceSession]) async throws -> SessionRemovalPlan {
        loads += 1
        if let preparation { return try await preparation.value() }
        return .init(record: record, sessions: [record], removesWorktree: false, holders: [])
    }
    func remove(_ plan: SessionRemovalPlan, discardChanges: Bool) async throws {
        removals += 1
        if let gate = removal { removal = nil; try await gate.value() }
    }
}

@MainActor @Test(.timeLimit(.minutes(1)), arguments: [false, true])
func operationLifetimeDismissedRemovalRejectsPendingPreparation(failing: Bool) async throws {
    let gate = OperationGate<SessionRemovalPlan>(), service = OperationRemovalService(preparation: gate)
    var cleaned = 0, finished = 0
    let model = SessionRemovalViewModel(service: service, record: operationSession, projects: [operationProject], sessions: [operationSession],
        didRemove: { _ in cleaned += 1 }, finished: { finished += 1 })
    let coordinator = AppCoordinator(factory: NativeCreationFlowFactory(chooseFolder: { nil }))
    coordinator.presentRemoval { model }
    let sheet = try #require(coordinator.sheet)
    let loading = Task { await model.load() }
    await gate.waitForStart()
    await model.load() // Coalesce duplicate initial loads.
    coordinator.dismissSheet(id: sheet.id)
    await gate.finish(failing ? .failure(BackendError.operation("Obsolete preview"))
        : .success(.init(record: operationSession, sessions: [operationSession], removesWorktree: false, holders: [])))
    await loading.value
    await model.load(); await model.remove()
    coordinator.presentRemoval { model }
    #expect(model.retired && model.plan == nil && model.error == nil && !model.canRemove && !model.loading)
    #expect(coordinator.sheet == nil && cleaned == 0 && finished == 0)
    #expect(await service.loads == 1)
    #expect(await service.removals == 0)
}

@MainActor @Test(.timeLimit(.minutes(1)), arguments: [false, true])
func operationLifetimeRemovalRetriesOnceAndCoordinatorPreservesUnrelatedNavigation(selected: Bool) async throws {
    let gate = OperationGate<Void>(), service = OperationRemovalService(removal: gate)
    var cleaned = 0, finished = 0
    let model = SessionRemovalViewModel(service: service, record: operationSession, projects: [operationProject], sessions: [operationSession],
        didRemove: { _ in cleaned += 1 }, finished: { finished += 1 })
    let coordinator = AppCoordinator(factory: NativeCreationFlowFactory(chooseFolder: { nil }))
    coordinator.navigate(to: selected ? .session(operationSession.id) : .settings)
    coordinator.presentRemoval { model }
    let sheet = try #require(coordinator.sheet), oldAction = model.onAction
    await model.load()
    let remove = Task { await model.remove() }
    await gate.waitForStart()
    coordinator.dismissSheet(id: sheet.id)
    await model.remove()
    #expect(coordinator.sheet?.id == sheet.id && !sheet.canDismiss)
    await gate.finish(.failure(BackendError.operation("Retry removal"))); await remove.value
    #expect(model.canRemove && finished == 1 && cleaned == 0 && model.error == "Retry removal")
    await model.remove(); await model.remove()
    #expect(model.completed && model.retired && !model.canRemove && cleaned == 1 && finished == 2)
    #expect(coordinator.sheet == nil && coordinator.selection == (selected ? .overview : .settings))
    #expect(await service.removals == 2)
    coordinator.presentAddPage { _ in true }
    let next = try #require(coordinator.sheet)
    oldAction(.removed([operationSession]))
    #expect(coordinator.sheet?.id == next.id)
    coordinator.dismissSheet(id: next.id)
}

@MainActor @Test(.timeLimit(.minutes(1))) func operationLifetimeRetiredRemovalStillFinishesStartedCleanup() async {
    let gate = OperationGate<Void>(), service = OperationRemovalService(removal: gate)
    var cleaned = 0, finished = 0, callbacks = 0
    let model = SessionRemovalViewModel(service: service, record: operationSession, projects: [operationProject], sessions: [operationSession],
        didRemove: { _ in cleaned += 1 }, finished: { finished += 1 })
    model.onAction = { _ in callbacks += 1 }
    await model.load()
    let remove = Task { await model.remove() }
    await gate.waitForStart()
    model.retire()
    await gate.finish(.success(())); await remove.value
    await model.remove()
    #expect(cleaned == 1 && finished == 1 && callbacks == 0 && model.completed && !model.removing)
    #expect(await service.removals == 1)
}
