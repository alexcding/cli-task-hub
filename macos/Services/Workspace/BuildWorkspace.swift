import Foundation
import Observation
import SwiftUI

@MainActor protocol BuildTerminal: AnyObject {
    func waitUntilReady() async throws
    func atShell() async throws -> Bool
    func submit(_ line: String) async throws
    func interrupt() async throws
}
extension TerminalSession: BuildTerminal {}

struct BuildSchemes: Decodable, Sendable { let target: String; let schemes: [String] }
struct BuildSimulator: Decodable, Sendable, Identifiable {
    let udid: String
    let name: String
    let runtime: String
    var id: String { udid }
}
struct BuildSettings: Decodable, Sendable {
    let appPath: String
    let bundleId: String
    let target: String
    let configuration: String

    func command(scheme: String, simulator: String) throws -> String {
        guard appPath.hasSuffix(".app"), !bundleId.isEmpty, !scheme.isEmpty, !simulator.isEmpty else {
            throw BackendError.operation("Choose a scheme that builds an application and a simulator.")
        }
        let q = SessionAgent.quote
        let document = target.hasSuffix(".xcworkspace") ? " -workspace \(q(target))"
            : target.hasSuffix(".xcodeproj") ? " -project \(q(target))" : ""
        let cwd = target.hasSuffix("Package.swift") ? (target as NSString).deletingLastPathComponent
            : document.isEmpty ? target : (target as NSString).deletingLastPathComponent
        // One foreground shell group keeps Stop and completion detection scoped to
        // the entire build/install/launch chain, including transitions between tools.
        return "(cd \(q(cwd)) && { /usr/bin/xcrun simctl boot \(q(simulator)) >/dev/null 2>&1 || true; "
            + "{ /usr/bin/open \"$(/usr/bin/xcode-select -p)/Applications/Simulator.app\" || /usr/bin/open \"$(/usr/bin/xcode-select -p)/../Applications/DeviceHub.app\" || /usr/bin/open -a Simulator; } >/dev/null 2>&1; "
            + "/usr/bin/xcodebuild\(document) -scheme \(q(scheme)) -configuration \(q(configuration)) -destination \(q("id=" + simulator)) -quiet build"
            + " && /usr/bin/xcrun simctl install \(q(simulator)) \(q(appPath))"
            + " && /usr/bin/xcrun simctl launch --console-pty --terminate-running-process \(q(simulator)) \(q(bundleId)); })"
    }
}

protocol BuildServing: Sendable {
    func destinations(project: Project, session: WorkspaceSession) async throws -> (BuildSchemes, [BuildSimulator])
    func settings(project: Project, session: WorkspaceSession, scheme: String, simulator: String) async throws -> BuildSettings
    func saveDestination(projectID: String, scheme: String, simulator: String) async throws
}

struct APIBuildService: BuildServing {
    let api: APIClient
    func destinations(project: Project, session: WorkspaceSession) async throws -> (BuildSchemes, [BuildSimulator]) {
        async let schemes: BuildSchemes = api.get(APIClient.query(Routes.XCODE_SCHEMES,
            ["path": session.worktree, "rel": project.ideTarget ?? ""]), timeout: 100)
        async let simulators: [BuildSimulator] = api.get(Routes.XCODE_SIMULATORS, timeout: 100)
        return try await (schemes, simulators)
    }
    func settings(project: Project, session: WorkspaceSession, scheme: String, simulator: String) async throws -> BuildSettings {
        try await api.get(APIClient.query(Routes.XCODE_BUILD_SETTINGS,
            ["path": session.worktree, "rel": project.ideTarget ?? "", "scheme": scheme, "sim": simulator]), timeout: 100)
    }
    func saveDestination(projectID: String, scheme: String, simulator: String) async throws {
        let _: Project = try await api.request(Routes.project(projectID), method: "PUT",
            body: ["runScheme": scheme, "runSim": simulator])
    }
}

@MainActor @Observable final class BuildWorkspaceViewModel {
    var scheme: String
    var simulator: String
    private(set) var schemes: [String] = []
    private(set) var simulators: [BuildSimulator] = []
    private(set) var loading = false
    private(set) var starting = false
    private(set) var running = false
    private(set) var error: String?
    private let service: any BuildServing
    private var project: Project
    private let session: WorkspaceSession
    private let terminalFactory: () throws -> any BuildTerminal
    private let reveal: () -> Void
    @ObservationIgnored private var terminal: (any BuildTerminal)?
    @ObservationIgnored private var monitor: Task<Void, Never>? { didSet { oldValue?.cancel() } }
    private var monitorGeneration = UUID()
    private var loadGeneration = UUID()
    private var presentationID: UUID?
    private var valid = true

    init(service: any BuildServing, project: Project, session: WorkspaceSession,
         terminalFactory: @escaping () throws -> any BuildTerminal, reveal: @escaping () -> Void) {
        self.service = service; self.project = project; self.session = session
        self.terminalFactory = terminalFactory; self.reveal = reveal
        scheme = project.runScheme ?? ""; simulator = project.runSim ?? ""
    }
    var canRun: Bool { valid && !loading && !starting && !running && schemes.contains(scheme) && simulators.contains { $0.udid == simulator } }
    func adopt(_ project: Project) {
        self.project = project
        guard presentationID == nil, !starting, !running else { return }
        if let scheme = project.runScheme, !scheme.isEmpty { self.scheme = scheme }
        if let simulator = project.runSim, !simulator.isEmpty { self.simulator = simulator }
    }
    fileprivate func beginPresentation(_ id: UUID) -> Bool {
        guard valid, !starting else { return false }
        presentationID = id; loadGeneration = UUID(); loading = false
        return true
    }
    fileprivate func endPresentation(_ id: UUID) {
        guard presentationID == id else { return }
        presentationID = nil; loadGeneration = UUID(); loading = false
    }
    fileprivate func isCurrent(_ id: UUID) -> Bool { valid && presentationID == id }
    static var cachedDestinations: [String: (BuildSchemes, [BuildSimulator])] = [:]
    fileprivate func load(presentation id: UUID) async {
        guard isCurrent(id), !Task.isCancelled, !loading, !starting else { return }
        if schemes.isEmpty, let cached = Self.cachedDestinations[project.id] { apply(cached) }
        let generation = UUID(); loadGeneration = generation
        loading = schemes.isEmpty || simulators.isEmpty; error = nil
        defer { if loadGeneration == generation { loading = false } }
        do {
            let values = try await service.destinations(project: project, session: session)
            try Task.checkCancellation()
            guard isCurrent(id), loadGeneration == generation else { return }
            Self.cachedDestinations[project.id] = values
            apply(values)
        } catch { if isCurrent(id) && loadGeneration == generation && !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func warmDestinations() {
        guard valid, Self.cachedDestinations[project.id] == nil, warming == nil else { return }
        warming = Task { [service, project, session] in
            defer { warming = nil }
            guard let values = try? await service.destinations(project: project, session: session), valid else { return }
            if Self.cachedDestinations[project.id] == nil { Self.cachedDestinations[project.id] = values }
        }
    }
    @ObservationIgnored private var warming: Task<Void, Never>?
    private func apply(_ values: (BuildSchemes, [BuildSimulator])) {
        schemes = values.0.schemes; simulators = values.1
        if !schemes.contains(scheme) {
            let targetName = URL(fileURLWithPath: values.0.target).deletingPathExtension().lastPathComponent
            scheme = schemes.first { $0.caseInsensitiveCompare(targetName) == .orderedSame }
                ?? schemes.first { $0.caseInsensitiveCompare(project.name) == .orderedSame }
                ?? schemes.first ?? ""
        }
        if !simulators.contains(where: { $0.udid == simulator }) { simulator = simulators.first?.udid ?? "" }
    }
    fileprivate func run(presentation id: UUID) async -> Bool {
        guard isCurrent(id), canRun, !Task.isCancelled else { return false }
        let scheme = scheme, simulator = simulator
        starting = true; error = nil
        defer { starting = false }
        do {
            let settings = try await service.settings(project: project, session: session, scheme: scheme, simulator: simulator)
            try Task.checkCancellation()
            guard isCurrent(id), self.scheme == scheme, self.simulator == simulator else { return false }
            let command = try settings.command(scheme: scheme, simulator: simulator)
            try await service.saveDestination(projectID: project.id, scheme: scheme, simulator: simulator)
            try Task.checkCancellation()
            guard isCurrent(id) else { return false }
            let terminal = try terminalFactory()
            self.terminal = terminal
            reveal()
            try await terminal.waitUntilReady()
            try await Task.sleep(for: .seconds(1))
            guard isCurrent(id) else { return false }
            let atShell = try await terminal.atShell()
            try Task.checkCancellation()
            guard isCurrent(id) else { return false }
            if atShell { try await terminal.submit(command) }
            guard isCurrent(id) else { return false }
            // A detached build already running is adopted without injecting a
            // second command. Only this build PTY is polled or interrupted.
            running = true
            let generation = UUID(); monitorGeneration = generation
            monitor = Task { [weak self, weak terminal] in
                while !Task.isCancelled && self?.monitorGeneration == generation {
                    do {
                        try await Task.sleep(for: .milliseconds(1200))
                        guard self?.monitorGeneration == generation, let terminal else { break }
                        if try await terminal.atShell() { break }
                    } catch {
                        if !Task.isCancelled && self?.monitorGeneration == generation { self?.error = error.localizedDescription }
                        break
                    }
                }
                if self?.monitorGeneration == generation { self?.running = false }
            }
            return true
        } catch { if isCurrent(id) && !Task.isCancelled { self.error = error.localizedDescription } }
        return false
    }
    fileprivate func save(presentation id: UUID) async -> Bool {
        guard isCurrent(id), canRun, !Task.isCancelled else { return false }
        let scheme = scheme, simulator = simulator
        starting = true; error = nil
        defer { starting = false }
        do {
            try await service.saveDestination(projectID: project.id, scheme: scheme, simulator: simulator)
            try Task.checkCancellation()
            return isCurrent(id)
        } catch { if isCurrent(id) && !Task.isCancelled { self.error = error.localizedDescription } }
        return false
    }
    func stop() async {
        guard valid, running else { return }
        do { try await terminal?.interrupt() }
        catch { if valid { self.error = error.localizedDescription } }
    }
    func disconnect() {
        valid = false; presentationID = nil; loadGeneration = UUID(); monitorGeneration = UUID()
        monitor = nil; terminal = nil; running = false; loading = false
    }
}

/// One model per sheet; retiring it leaves the cached build and its PTY running.
@MainActor @Observable final class BuildDestinationViewModel {
    enum Action { case started, saved }
    enum Purpose { case run, configure }
    @ObservationIgnored var onAction: (Action) -> Void = { _ in }
    let purpose: Purpose
    private let runtime: BuildWorkspaceViewModel
    private let id = UUID()
    private(set) var retired = false

    init(runtime: BuildWorkspaceViewModel, purpose: Purpose = .run) {
        self.runtime = runtime; self.purpose = purpose
        retired = !runtime.beginPresentation(id)
    }
    private var active: Bool { !retired && runtime.isCurrent(id) }
    var scheme: String {
        get { runtime.scheme }
        set { if active && !runtime.starting { runtime.scheme = newValue } }
    }
    var simulator: String {
        get { runtime.simulator }
        set { if active && !runtime.starting { runtime.simulator = newValue } }
    }
    var schemes: [String] { runtime.schemes }
    var simulators: [BuildSimulator] { runtime.simulators }
    var loading: Bool { active && runtime.loading }
    var starting: Bool { active && runtime.starting }
    var error: String? { runtime.error }
    var canRun: Bool { active && runtime.canRun }
    func load() async { if active { await runtime.load(presentation: id) } }
    func run() async {
        guard active, await runtime.run(presentation: id), active else { return }
        let action = onAction
        retire()
        action(.started)
    }
    func save() async {
        guard active, await runtime.save(presentation: id), active else { return }
        let action = onAction
        retire()
        action(.saved)
    }
    func confirm() async { if purpose == .run { await run() } else { await save() } }
    func retire() {
        retired = true; onAction = { _ in }
        runtime.endPresentation(id)
    }
}

struct BuildDestinationView: View {
    @Bindable var model: BuildDestinationViewModel
    let cancel: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.purpose == .run ? "Run Destination" : "Build Destination").font(.title2.weight(.semibold))
            Picker("Scheme", selection: $model.scheme) {
                ForEach(model.schemes, id: \.self) { Text($0).tag($0) }
            }.disabled(model.starting).accessibilityIdentifier("build-scheme")
            Picker("Simulator", selection: $model.simulator) {
                ForEach(model.simulators) { Text("\($0.name) · \($0.runtime)").tag($0.udid) }
            }.disabled(model.starting).accessibilityIdentifier("build-simulator")
            if model.loading { ProgressView("Loading destinations…") }
            if let error = model.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
            HStack {
                Button("Cancel", role: .cancel, action: cancel).keyboardShortcut(.cancelAction)
                Spacer()
                if model.starting { ProgressView().controlSize(.small) }
                Button(model.purpose == .run ? "Run" : "Save") { Task { await model.confirm() } }
                    .keyboardShortcut(.defaultAction).disabled(!model.canRun)
            }.disabled(model.starting)
        }.padding(24).frame(width: 480)
        .interactiveDismissDisabled(model.starting)
        .task { await model.load() }
    }
}
