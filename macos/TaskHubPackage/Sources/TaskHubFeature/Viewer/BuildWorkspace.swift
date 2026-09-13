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

@MainActor @Observable final class BuildWorkspaceViewModel {
    var scheme: String
    var simulator: String
    private(set) var schemes: [String] = []
    private(set) var simulators: [BuildSimulator] = []
    private(set) var loading = false
    private(set) var starting = false
    private(set) var running = false
    private(set) var error: String?
    private let api: APIClient
    private let project: Project
    private let session: WorkspaceSession
    private let terminalFactory: () throws -> any BuildTerminal
    private let reveal: () -> Void
    @ObservationIgnored private var terminal: (any BuildTerminal)?
    @ObservationIgnored private var monitor: Task<Void, Never>?
    private var valid = true
    @ObservationIgnored var didStart: () -> Void = {}

    init(api: APIClient, project: Project, session: WorkspaceSession,
         terminalFactory: @escaping () throws -> any BuildTerminal, reveal: @escaping () -> Void) {
        self.api = api; self.project = project; self.session = session
        self.terminalFactory = terminalFactory; self.reveal = reveal
        scheme = project.runScheme ?? ""; simulator = project.runSim ?? ""
    }
    var canRun: Bool { valid && !loading && !starting && !running && schemes.contains(scheme) && simulators.contains { $0.udid == simulator } }
    func load() async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            async let schemes: BuildSchemes = api.get(APIClient.query(Routes.XCODE_SCHEMES,
                ["path": session.worktree, "rel": project.ideTarget ?? ""]), timeout: 100)
            async let simulators: [BuildSimulator] = api.get(Routes.XCODE_SIMULATORS, timeout: 100)
            let values = try await (schemes, simulators)
            try Task.checkCancellation()
            self.schemes = values.0.schemes; self.simulators = values.1
            if !self.schemes.contains(scheme) { scheme = self.schemes.first ?? "" }
            if !self.simulators.contains(where: { $0.udid == simulator }) { simulator = self.simulators.first?.udid ?? "" }
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func run() async {
        guard canRun else { return }
        starting = true; error = nil
        defer { starting = false }
        do {
            let settings: BuildSettings = try await api.get(APIClient.query(Routes.XCODE_BUILD_SETTINGS,
                ["path": session.worktree, "rel": project.ideTarget ?? "", "scheme": scheme, "sim": simulator]), timeout: 100)
            let command = try settings.command(scheme: scheme, simulator: simulator)
            let _: Project = try await api.request(Routes.project(project.id), method: "PUT",
                                                   body: ["runScheme": scheme, "runSim": simulator])
            try Task.checkCancellation()
            guard valid else { return }
            let terminal = try terminalFactory()
            self.terminal = terminal
            reveal()
            try await terminal.waitUntilReady()
            try await Task.sleep(for: .seconds(1))
            guard valid else { return }
            if try await terminal.atShell() { try await terminal.submit(command) }
            // A detached build already running is adopted without injecting a
            // second command. Only this build PTY is polled or interrupted.
            running = true
            monitor?.cancel()
            monitor = Task { [weak self, weak terminal] in
                while !Task.isCancelled {
                    do {
                        try await Task.sleep(for: .milliseconds(1200))
                        guard let terminal else { break }
                        if try await terminal.atShell() { break }
                    } catch { if !Task.isCancelled { self?.error = error.localizedDescription }; break }
                }
                self?.running = false
            }
            didStart()
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func stop() async {
        do { try await terminal?.interrupt() }
        catch { self.error = error.localizedDescription }
    }
    func disconnect() { valid = false; monitor?.cancel(); monitor = nil; running = false }
}

struct BuildDestinationView: View {
    @Bindable var model: BuildWorkspaceViewModel
    let cancel: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Run Destination").font(.title2.weight(.semibold))
            Picker("Scheme", selection: $model.scheme) {
                ForEach(model.schemes, id: \.self) { Text($0).tag($0) }
            }
            Picker("Simulator", selection: $model.simulator) {
                ForEach(model.simulators) { Text("\($0.name) · \($0.runtime)").tag($0.udid) }
            }
            if model.loading { ProgressView("Loading destinations…") }
            if let error = model.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
            HStack {
                Button("Cancel", role: .cancel, action: cancel).keyboardShortcut(.cancelAction)
                Spacer()
                if model.starting { ProgressView().controlSize(.small) }
                Button("Run") { Task { await model.run() } }
                    .keyboardShortcut(.defaultAction).disabled(!model.canRun)
            }.disabled(model.starting)
        }.padding(24).frame(width: 480)
        .interactiveDismissDisabled(model.starting)
        .task { await model.load() }
    }
}
