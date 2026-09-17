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
        // same committed artwork from the checkout while iterating.
        var directory = URL(fileURLWithPath: #filePath)
        for _ in 0..<8 {
            directory.deleteLastPathComponent()
            let candidate = directory.appendingPathComponent("macos/Resources/ProviderImages")
                .appendingPathComponent(filename)
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
    @FocusState private var editingAddress: Bool
    @FocusState private var finding: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button("Back", systemImage: "chevron.left", action: model.back).disabled(!model.canGoBack)
                Button("Forward", systemImage: "chevron.right", action: model.forward).disabled(!model.canGoForward)
                Button(model.loading ? "Stop Loading" : "Reload Page", systemImage: model.loading ? "xmark" : "arrow.clockwise", action: model.toggleLoading)
                TextField("Page address", text: $model.address).capsuleField().focused($editingAddress)
                    .onSubmit { if model.submitAddress() { editingAddress = false } }
            }.glassIconButtons().padding(8)
            if context.findVisible {
                HStack {
                    TextField("Find in page", text: Binding(get: { context.findText }, set: { context.findText = $0 }))
                        .capsuleField()
                        .focused($finding).onSubmit { model.find(context.findText) }
                    if model.found == false { Text("No match").font(.caption).foregroundStyle(.secondary) }
                    Button("Previous Match", systemImage: "chevron.up") { model.find(context.findText, backwards: true) }
                    Button("Next Match", systemImage: "chevron.down") { model.find(context.findText) }
                    Button("Close Find", systemImage: "xmark") { context.findVisible = false }
                }.glassIconButtons().padding(8)
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
        .onAppear {
            model.synchronizeAddress()
            if model.isBlank { editingAddress = true }
        }
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

    // One width shared by every session; show/hide is per session via its context pane.
    @AppStorage("workspace.contextPaneWidth") private var contextPaneWidth: Double = 560

    @ViewBuilder private var primaryContent: some View {
        if model.showsTerminal {
            ResizableSplitView(showsTrailing: model.showsPage || model.showsBuild,
                               trailingWidth: Binding(
                                   get: { CGFloat(contextPaneWidth) },
                                   set: { contextPaneWidth = Double($0) })) {
                terminalContent
            } trailing: {
                SessionWorkspaceContextPane(context: context, model: model)
            }
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

struct SessionWorkspaceContextPane: View {
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
            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(context.tabs) { page in
                        ContextTabChip(title: page.title, dirty: page.dirty, active: context.activeID == page.id,
                                       select: { model.selectTab(page) }, close: { model.closeTab(page) })
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
            BrowserPane(page: page, context: context, model: page.controls).id(page.id)
        } else {
            ContentUnavailableView("No open pages", systemImage: "globe", description: Text("Add a page or reopen one from History."))
        }
    }
}

/// One page chip. The close button shows on the active chip and on whichever chip the pointer is
/// over, at the trailing edge on top of the title; the title fades out beneath it.
private struct ContextTabChip: View {
    let title: String
    let dirty: Bool
    let active: Bool
    let select: () -> Void
    let close: () -> Void
    @State private var hovering = false
    @State private var hoveringClose = false

    private var showsClose: Bool { hovering || active }
    private var fill: Color { active ? Theme.accentBackground : Theme.surfaceHover }

    var body: some View {
        Button(action: select) {
            Text((dirty ? "● " : "") + title)
                .lineLimit(1)
                // The minimum keeps a short title centred clear of the close button's fade.
                .frame(minWidth: 52, maxWidth: 190)
                .mask {
                    HStack(spacing: 0) {
                        Color.black
                        LinearGradient(colors: [.black, .black.opacity(showsClose ? 0 : 1)], startPoint: .leading, endPoint: .trailing)
                            .frame(width: 18)
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 6)
                .background(fill, in: RoundedRectangle(cornerRadius: 6))
                .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? .isSelected : [])
        .accessibilityAction(named: "Close \(title)", close)
        .overlay(alignment: .trailing) {
            Button("Close \(title)", systemImage: "xmark", action: close)
                .labelStyle(.iconOnly).buttonStyle(.plain)
                .imageScale(.small)
                .foregroundStyle(hoveringClose ? Theme.textSecondary : Theme.textTertiary)
                .frame(width: 18, height: 18)
                .background(hoveringClose ? Theme.border : Color.clear, in: Circle())
                .onHover { hoveringClose = $0 }
                .padding(.trailing, 5)
                .opacity(showsClose ? 1 : 0)
                .allowsHitTesting(showsClose)
                .accessibilityHidden(!showsClose)
                .help("Close tab")
        }
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: showsClose)
    }
}

/// The git client (or Finder) button that opens the session's worktree.
struct SessionWorkspaceGitClientButton: View {
    let model: SessionWorkspaceViewModel

    var body: some View {
        Button {
            if model.gitClientLabel == nil { model.reveal() } else { model.openGitClient() }
        } label: {
            ToolbarBrandIcon(name: model.gitClientID, fallback: .folder)
        }
        .buttonStyle(.plain)
        .controlSize(.small)
        .imageScale(.medium)
        .help(model.gitClientLabel ?? "Reveal Worktree")
        .disabled(model.gitClientLabel != nil && !model.canOpenExternal)
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
            if let title = model.editorLabel {
                Button(action: model.openEditor) {
                    ToolbarBrandIcon(name: model.editorID, fallback: .code)
                }
                .buttonStyle(.borderless)
                .help(title)
                .disabled(!model.canOpenExternal)
            }
            if model.showsBuildActions {
                if model.editorLabel != nil { toolbarDivider }
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

struct SessionWorkspaceContextToggle: View {
    let model: SessionWorkspaceViewModel

    var body: some View {
        // A plain button, not a toggle: no pressed-state fill while the pane is shown.
        Button {
            model.setContextPresented(!(model.showsPage || model.showsBuild))
        } label: {
            Image(systemName: "sidebar.trailing")
        }
        .help(model.showsPage || model.showsBuild ? "Hide Context Pane" : "Show Context Pane")
        .disabled(!model.canToggleContext)
    }
}
