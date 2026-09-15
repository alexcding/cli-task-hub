import AppKit
import SwiftUI
import WebKit

private struct TauriToolbarIcon: View {
    enum Kind { case folder, code, split }
    let kind: Kind

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 24
            context.scaleBy(x: scale, y: scale)
            var path = Path()
            switch kind {
            case .folder:
                path.move(to: .init(x: 2, y: 10)); path.addLine(to: .init(x: 22, y: 10))
                path.move(to: .init(x: 20, y: 20)); path.addCurve(to: .init(x: 22, y: 18), control1: .init(x: 21.1, y: 20), control2: .init(x: 22, y: 19.1))
                path.addLine(to: .init(x: 22, y: 8)); path.addCurve(to: .init(x: 20, y: 6), control1: .init(x: 22, y: 6.9), control2: .init(x: 21.1, y: 6))
                path.addLine(to: .init(x: 12.1, y: 6)); path.addCurve(to: .init(x: 10.4, y: 5.1), control1: .init(x: 11.4, y: 6), control2: .init(x: 10.8, y: 5.7))
                path.addLine(to: .init(x: 9.6, y: 3.9)); path.addCurve(to: .init(x: 7.93, y: 3), control1: .init(x: 9.2, y: 3.3), control2: .init(x: 8.6, y: 3))
                path.addLine(to: .init(x: 4, y: 3)); path.addCurve(to: .init(x: 2, y: 5), control1: .init(x: 2.9, y: 3), control2: .init(x: 2, y: 3.9))
                path.addLine(to: .init(x: 2, y: 18)); path.addCurve(to: .init(x: 4, y: 20), control1: .init(x: 2, y: 19.1), control2: .init(x: 2.9, y: 20)); path.closeSubpath()
            case .code:
                path.move(to: .init(x: 9, y: 17)); path.addLine(to: .init(x: 4, y: 12)); path.addLine(to: .init(x: 9, y: 7))
                path.move(to: .init(x: 15, y: 7)); path.addLine(to: .init(x: 20, y: 12)); path.addLine(to: .init(x: 15, y: 17))
            case .split:
                path.addRoundedRect(in: .init(x: 3, y: 4.5, width: 18, height: 15), cornerSize: .init(width: 3.5, height: 3.5))
                path.move(to: .init(x: 14, y: 4.5)); path.addLine(to: .init(x: 14, y: 19.5))
            }
            context.stroke(path, with: .foreground, style: .init(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
        }
        .frame(width: 18, height: 18)
    }
}

private struct ToolbarBrandIcon: View {
    let name: String?
    let fallback: TauriToolbarIcon.Kind

    var body: some View {
        if let name, let image = Self.load(name) {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(height: 18)
                .clipShape(RoundedRectangle(cornerRadius: 4))
        } else {
            TauriToolbarIcon(kind: fallback)
        }
    }

    private static func load(_ name: String) -> NSImage? {
        let filename = name == "github" ? "github.svg" : "\(name).png"
        let bundled = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources/TaskHubImages")
            .appendingPathComponent(filename)
        if let image = NSImage(contentsOf: bundled) { return image }

        // Xcode development builds do not run the packaging script, so resolve the
        // same committed renderer artwork from the checkout while iterating.
        var directory = URL(fileURLWithPath: #filePath)
        for _ in 0..<8 {
            directory.deleteLastPathComponent()
            let candidate = directory.appendingPathComponent("src/renderer/img").appendingPathComponent(filename)
            if let image = NSImage(contentsOf: candidate) { return image }
        }
        return nil
    }
}

struct BrowserSurface: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}

struct BrowserPane: View {
    let page: BrowserPage
    let context: WorkspaceContext
    @Bindable var model: BrowserControlsViewModel
    let showsCreateSession: Bool
    let canCreateSession: Bool
    let createSession: () -> Void
    @FocusState private var editingAddress: Bool
    @FocusState private var finding: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button("Back", systemImage: "chevron.left", action: model.back).disabled(!model.canGoBack)
                Button("Forward", systemImage: "chevron.right", action: model.forward).disabled(!model.canGoForward)
                Button(model.loading ? "Stop Loading" : "Reload Page", systemImage: model.loading ? "xmark" : "arrow.clockwise", action: model.toggleLoading)
                TextField("Page address", text: $model.address).textFieldStyle(.roundedBorder).focused($editingAddress)
                    .onSubmit { if model.submitAddress() { editingAddress = false } }
                Button("Open in Browser", systemImage: "arrow.up.right.square", action: model.openExternally)
                    .disabled(!model.canOpenExternally)
                if showsCreateSession {
                    Divider().frame(height: 18)
                    Button("Create Session", systemImage: "terminal", action: createSession)
                        .disabled(!canCreateSession)
                }
            }.labelStyle(.iconOnly).padding(8)
            if context.findVisible {
                HStack {
                    TextField("Find in page", text: Binding(get: { context.findText }, set: { context.findText = $0 }))
                        .focused($finding).onSubmit { model.find(context.findText) }
                    if model.found == false { Text("No match").font(.caption).foregroundStyle(.secondary) }
                    Button("Previous Match", systemImage: "chevron.up") { model.find(context.findText, backwards: true) }
                    Button("Next Match", systemImage: "chevron.down") { model.find(context.findText) }
                    Button("Close Find", systemImage: "xmark") { context.findVisible = false }
                }.labelStyle(.iconOnly).padding(8)
            }
            if let error = model.error {
                HStack { Text(error).font(.callout); Spacer(); Button("Retry", action: model.retry) }
                    .padding(10).foregroundStyle(.orange)
            }
            Divider()
            if let view = page.webView {
                BrowserSurface(webView: view)
                    .accessibilityHidden(page.dialogs.request != nil)
            }
            else { ContentUnavailableView("Page suspended", systemImage: "globe", description: Text("Select this tab to reload it.")) }
        }
        .onAppear(perform: model.synchronizeAddress)
        .onChange(of: editingAddress) { _, value in model.setEditingAddress(value) }
        .onDisappear { model.setEditingAddress(false) }
        .onChange(of: context.findVisible) { _, value in if value { finding = true } }
        .onExitCommand { context.findVisible = false }
    }
}

struct SessionWorkspaceView: View {
    let context: WorkspaceContext
    let model: SessionWorkspaceViewModel

    var body: some View {
        VStack(spacing: 0) {
            if let error = context.error { Text(error).font(.caption).foregroundStyle(.orange).padding(8) }
            if let error = model.launchError {
                Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled).padding(8)
                    .accessibilityIdentifier("workspace-launch-error")
            }
            primaryContent
        }
    }

    @ViewBuilder private var primaryContent: some View {
        if model.showsTerminal {
            terminalContent
        } else {
            VStack(spacing: 0) {
                Divider()
                SessionWorkspaceContextContent(context: context, model: model)
            }
        }
    }

    @ViewBuilder private var terminalContent: some View {
        if let terminal = model.terminal {
            TerminalPane(session: terminal).id(terminal.id)
        } else if model.session != nil {
            ProgressView("Opening Terminal…")
        } else {
            VStack(spacing: 12) {
                Text(model.terminalPrompt).foregroundStyle(.secondary)
                Button("Open Terminal", systemImage: "terminal", action: model.openTerminal).buttonStyle(.borderedProminent)
            }
        }
    }

}

struct SessionWorkspaceInspectorContent: View {
    let context: WorkspaceContext
    let model: SessionWorkspaceViewModel

    @ViewBuilder var body: some View {
        if model.showsBuild, let build = model.buildTerminal {
            TerminalPane(session: build).id(build.id)
        } else {
            SessionWorkspaceContextContent(context: context, model: model)
        }
    }
}

private struct SessionWorkspaceContextContent: View {
    let context: WorkspaceContext
    let model: SessionWorkspaceViewModel

    var body: some View {
        VStack(spacing: 0) {
            if model.showsTerminal {
                webContextToolbar
                Divider()
            }
            contextBody
        }
    }

    private var webContextToolbar: some View {
        HStack(spacing: 8) {
            Menu("Add to this panel", systemImage: "plus") {
                Button("Add Page", action: model.addPage)
                Button("Open File", action: model.openFile)
                Divider()
                Menu("History") {
                    if context.visits.isEmpty { Text("No closed or visited pages") }
                    ForEach(context.visits.reversed()) { record in
                        Button(record.title) { model.reopen(record) }
                    }
                }
            }
            .labelStyle(.iconOnly)
            if !context.tabs.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        ForEach(context.tabs) { page in
                            HStack(spacing: 6) {
                                Button { model.selectTab(page) } label: {
                                    Text((page.dirty ? "● " : "") + page.title).lineLimit(1).frame(maxWidth: 190)
                                }.buttonStyle(.plain)
                                Button("Close \(page.title)", systemImage: "xmark") { model.closeTab(page) }
                                    .labelStyle(.iconOnly).buttonStyle(.plain)
                            }
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(context.activeID == page.id ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.08),
                                        in: RoundedRectangle(cornerRadius: 6))
                        }
                    }
                }
            }
            Spacer(minLength: 4)
        }
        .padding(.horizontal, 12)
        .frame(height: 52)
    }

    @ViewBuilder private var contextBody: some View {
        if model.showsChanges {
            VStack(spacing: 0) {
                Picker("Review section", selection: Binding(get: { context.reviewSection }, set: context.setReviewSection)) {
                    ForEach(ReviewSection.allCases) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented).labelsHidden().padding(8)
                if context.reviewSection == .history, let history = model.history { GitHistoryView(model: history) }
                else if context.reviewSection == .changes, let diff = model.diff { DiffView(model: diff) }
            }
        } else if let document = context.activeDocument {
            EditorDocumentView(model: document).id(document.id)
        } else if let page = context.activePage {
            BrowserPane(page: page, context: context, model: page.controls,
                        showsCreateSession: !model.showsTerminal, canCreateSession: model.canCreateSession,
                        createSession: model.createSession).id(page.id)
        } else {
            ContentUnavailableView("No open pages", systemImage: "globe", description: Text("Add a page or reopen one from History."))
        }
    }
}

struct SessionWorkspaceLeadingToolbar: View {
    let model: SessionWorkspaceViewModel

    var body: some View {
        HStack(spacing: 5) {
            if model.session != nil { terminalLaunchControls }
            if let workflow = model.workflow {
                if model.session != nil { toolbarDivider }
                workflowControls(workflow)
            }
        }
        .padding(.leading, 4)
        .controlSize(.small)
        .imageScale(.medium)
    }

    private var terminalLaunchControls: some View {
        HStack(spacing: 6) {
            Button {
                if model.gitClientLabel == nil { model.reveal() } else { model.openGitClient() }
            } label: {
                ToolbarBrandIcon(name: model.gitClientID, fallback: .folder)
            }
            .buttonStyle(.borderless)
            .help(model.gitClientLabel ?? "Reveal Worktree")
            .disabled(model.gitClientLabel != nil && !model.canOpenExternal)
            if let title = model.editorLabel {
                toolbarDivider
                Button(action: model.openEditor) {
                    ToolbarBrandIcon(name: model.editorID, fallback: .code)
                }
                .buttonStyle(.borderless)
                .help(title)
                .disabled(!model.canOpenExternal)
            }
            if model.showsBuildActions {
                toolbarDivider
                if model.build?.running == true {
                    Button("Stop Build", systemImage: "stop.fill") { Task { await model.stopBuild() } }
                        .labelStyle(.iconOnly)
                } else {
                    Button("Run \(model.runScheme)", systemImage: "play.fill", action: model.run)
                        .labelStyle(.iconOnly)
                        .help("Build and run \(model.runScheme)")
                        .disabled(!model.canRun)
                }
                Button(action: model.run) {
                    HStack(spacing: 3) {
                        Text(model.runScheme).lineLimit(1)
                        Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                    }
                }
                    .help("Project scheme")
                    .disabled(!model.canRun)
            }
        }
    }

    private func workflowControls(_ workflow: WorkflowRunViewModel) -> some View {
        HStack(spacing: 5) {
            Button(workflow.running ? "Stop Workflow" : "Run Workflow",
                   systemImage: workflow.running ? "stop.fill" : "bolt") {
                Task {
                    if workflow.running { await workflow.stop() }
                    else { await workflow.run() }
                }
            }
            .labelStyle(.iconOnly)
            .disabled(workflow.running ? workflow.stopping : !workflow.canRun)
            Picker("Workflow", selection: Binding(get: { workflow.selectedID }, set: { workflow.selectedID = $0 })) {
                ForEach(workflow.recipes, id: \.id) {
                    Text($0.name.isEmpty ? "Untitled workflow" : $0.name).tag($0.id)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 180)
            .disabled(workflow.running)
        }
    }

    private var toolbarDivider: some View {
        Divider().frame(height: 16)
    }
}

struct SessionWorkspaceInspectorToolbarButton: View {
    let model: SessionWorkspaceViewModel

    var body: some View {
        Toggle(isOn: Binding(
            get: { model.showsTerminal && (model.showsPage || model.showsBuild) },
            set: model.setInspectorPresented
        )) {
            TauriToolbarIcon(kind: .split)
        }
        .toggleStyle(.button)
        .help(model.showsPage || model.showsBuild ? "Hide Context Pane" : "Show Context Pane")
        .disabled(!model.canToggleContext)
    }
}
