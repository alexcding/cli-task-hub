import AppKit
import SwiftUI
import WebKit

private struct TauriToolbarIcon: View {
    enum Kind { case code, split, branch }
    let kind: Kind

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 24
            context.scaleBy(x: scale, y: scale)
            var path = Path()
            switch kind {
            case .code:
                path.move(to: .init(x: 9, y: 17)); path.addLine(to: .init(x: 4, y: 12)); path.addLine(to: .init(x: 9, y: 7))
                path.move(to: .init(x: 15, y: 7)); path.addLine(to: .init(x: 20, y: 12)); path.addLine(to: .init(x: 15, y: 17))
            case .split:
                path.addRoundedRect(in: .init(x: 3, y: 4.5, width: 18, height: 15), cornerSize: .init(width: 3.5, height: 3.5))
                path.move(to: .init(x: 14, y: 4.5)); path.addLine(to: .init(x: 14, y: 19.5))
            case .branch:
                path.move(to: .init(x: 6, y: 3)); path.addLine(to: .init(x: 6, y: 15))
                path.addEllipse(in: .init(x: 15, y: 3, width: 6, height: 6))
                path.addEllipse(in: .init(x: 3, y: 15, width: 6, height: 6))
                path.move(to: .init(x: 18, y: 9)); path.addCurve(to: .init(x: 9, y: 18), control1: .init(x: 18, y: 13.97), control2: .init(x: 13.97, y: 18))
            }
            context.stroke(path, with: .foreground, style: .init(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
        }
        .frame(width: 18, height: 18)
    }
}

private struct ToolbarBrandIcon: View {
    let name: String?
    let fallback: TauriToolbarIcon.Kind
    var height: CGFloat = 18

    var body: some View {
        if let name, let image = Self.load(name) {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(height: height)
                .clipShape(RoundedRectangle(cornerRadius: 4))
        } else {
            TauriToolbarIcon(kind: fallback)
        }
    }

    private static func load(_ name: String) -> NSImage? {
        let filename = "\(name).png"
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
    let model: BrowserControlsViewModel
    @FocusState private var finding: Bool

    var body: some View {
        VStack(spacing: 0) {
            // Navigation and the address live in the compact tab bar above this pane.
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
            if model.isBlank {
                // Safari's start page: a blank tab shows where this panel has been.
                BrowserStartPage(context: context, controls: model)
            } else if let view = page.webView {
                BrowserSurface(webView: view)
                    .accessibilityHidden(page.dialogs.request != nil)
            }
            else { ContentUnavailableView("Page suspended", systemImage: "globe", description: Text("Select this tab to reload it.")) }
        }
        .onAppear { model.synchronizeAddress() }
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

    // One share of the split for every session, 60% by default as in the Tauri app; show/hide
    // is per session via its context pane.
    @AppStorage("workspace.contextPaneFraction") private var contextPaneFraction: Double = 0.6

    @ViewBuilder private var primaryContent: some View {
        if model.showsTerminal {
            NativeSplitView(showsTrailing: model.showsPage || model.showsBuild,
                            trailingFraction: Binding(
                                get: { CGFloat(contextPaneFraction) },
                                set: { contextPaneFraction = Double($0) })) {
                terminalContent
            } trailing: {
                SessionWorkspaceContextPane(context: context, model: model)
            }
        } else {
            VStack(spacing: 0) {
                if !model.fillsTitleBar { Divider() }
                SessionWorkspaceContextContent(context: context, model: model)
            }
            .ignoresSafeArea(.container, edges: model.fillsTitleBar ? .top : [])
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
            if model.mode == .browser, !model.showsChanges {
                // Safari's compact layout: the tab bar is the address bar, so the browser needs no second row.
                BrowserCompactTabBar(context: context, model: model)
                Divider()
            } else if model.mode == .files, !model.showsChanges {
                FilesCompactTabBar(context: context, model: model)
                Divider()
            }
            contextBody
        }
    }

    @ViewBuilder private var contextBody: some View {
        if model.showsChanges {
            // The Tauri review layout: the diff fills the pane, and one footer carries the
            // Changes/History switch and the commit action.
            VStack(spacing: 0) {
                Group {
                    if context.reviewSection == .history, let history = model.history { GitHistoryView(model: history) }
                    else if context.reviewSection == .changes, let diff = model.diff { DiffView(model: diff, showsHeader: false) }
                    else { Color.clear }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
                Divider()
                ReviewFooter(context: context, diff: model.diff)
            }
        } else if model.mode == .files, let document = context.activeDocument {
            EditorDocumentView(model: document, togglePreview: model.toggleEditorPreview).id(document.id)
        } else if model.mode == .browser, let page = context.activePage {
            BrowserPane(page: page, context: context, model: page.controls).id(page.id)
        } else {
            BlankPane(context: context, model: model)
        }
    }
}

private struct ReviewFooter: View {
    let context: WorkspaceContext
    let diff: DiffViewModel?

    var body: some View {
        HStack(spacing: 10) {
            Picker("Review section", selection: Binding(get: { context.reviewSection }, set: context.setReviewSection)) {
                ForEach(ReviewSection.allCases) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented).labelsHidden().fixedSize()
            if context.reviewSection == .changes, let diff {
                let busy = diff.loading || diff.actions?.busy == true
                if let branch = diff.snapshot?.branch {
                    Label(branch, systemImage: "arrow.triangle.branch").foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 4)
                if busy { ProgressView().controlSize(.small) }
                Button("Refresh Changes", systemImage: "arrow.clockwise", action: diff.refresh)
                    .labelStyle(.iconOnly).buttonStyle(.borderless).disabled(busy)
                if diff.actions != nil {
                    Button("Commit and Push…", systemImage: "arrow.up.circle", action: diff.requestActions)
                        .disabled(diff.actions?.busy == true)
                }
            } else {
                Spacer(minLength: 4)
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 44)
        .accessibilityIdentifier("workspace-review-footer")
    }
}

struct SessionWorkspaceModePicker: View {
    let model: SessionWorkspaceViewModel

    var body: some View {
        Picker("Panel", selection: Binding(get: { model.mode }, set: model.selectMode)) {
            ForEach(WorkspaceMode.allCases.filter { $0 != .diff || model.session != nil }) { mode in
                Image(systemName: mode.symbol).help(mode.title).tag(mode)
                    .disabled(!model.canSelectMode(mode))
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        .accessibilityIdentifier("workspace-mode-picker")
    }
}

/// The right pane with nothing in it, as the Tauri app drew it: a real surface that names what
/// the pane is for, not a void. It gives the open/close animation something to resize.
struct BlankPane: View {
    let context: WorkspaceContext
    let model: SessionWorkspaceViewModel

    private var hint: Text {
        switch model.mode {
        case .files: return Text("Search this worktree from the tab above, or use the folder to browse it.").foregroundColor(Theme.textTertiary)
        case .diff, .browser: return Text("Use ＋ to open a web page.").foregroundColor(Theme.textTertiary)
        }
    }
    private var root: String? {
        (model.session?.worktree).flatMap { $0.isEmpty ? nil : $0.hasSuffix("/") ? $0 : $0 + "/" }
    }
    /// Only this session's worktree: a context outlives and is shared between sessions, and another
    /// worktree's files are not a way back to anything here. Until the session names its worktree,
    /// nothing is listed.
    private var recentFiles: [FileDocumentRecord] {
        guard model.mode == .files else { return [] }
        let root = root
        let files = context.fileVisits.reversed().compactMap { visit -> FileDocumentRecord? in
            guard case .file(let file) = visit, root.map(file.path.hasPrefix) ?? false else { return nil }
            return file
        }
        return Array(files.prefix(12))
    }

    var body: some View {
        Group {
            if recentFiles.isEmpty { empty } else { recent }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.paneBackground)
    }

    private var empty: some View {
        VStack(spacing: 5) {
            Text(model.mode == .files ? "No file open" : "Nothing open in this panel")
                .font(Theme.Typography.emptyTitle)
                .foregroundStyle(Theme.textSecondary)
            hint.font(Theme.Typography.emptyHint).multilineTextAlignment(.center)
        }
        .frame(maxWidth: 260)
        .padding(24)
    }

    // The browser start page's History, for files: same heading, rows and column.
    private var recent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("Recent Files").font(.title3.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(recentFiles) { file in
                        RecentFileRow(file: file, root: root) { model.reopen(.file(file)) }
                    }
                }
                .accessibilityLabel("Recent Files")
            }
            .padding(24)
            .readableColumn()
            .frame(maxWidth: .infinity)
        }
    }
}

private struct RecentFileRow: View {
    let file: FileDocumentRecord
    let root: String?
    let open: () -> Void
    @State private var hovering = false

    /// The folder inside the worktree; empty for a file at its top.
    private var folder: String {
        let relative = root.map { file.path.hasPrefix($0) ? String(file.path.dropFirst($0.count)) : file.path } ?? file.path
        return (relative as NSString).deletingLastPathComponent
    }

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                Image(systemName: "doc.text").font(.system(size: 17)).foregroundStyle(Theme.textTertiary).frame(width: 24)
                Text(file.title).font(.body).lineLimit(1)
                Text(folder).font(.body).foregroundStyle(Theme.textTertiary).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 8)
            }
            .padding(.horizontal, 12).frame(height: 44)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(hovering ? Theme.surfaceHover : .clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(file.path)
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

/// The branch button that opens the session's worktree in the git client (or Finder).
struct SessionWorkspaceGitClientButton: View {
    let model: SessionWorkspaceViewModel

    var body: some View {
        Button {
            if model.gitClientLabel == nil { model.reveal() } else { model.openGitClient() }
        } label: {
            TauriToolbarIcon(kind: .branch)
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
        .padding(.horizontal, 8)
        .controlSize(.regular)
        .imageScale(.medium)
    }

    private var terminalLaunchControls: some View {
        HStack(spacing: 6) {
            if let title = model.editorLabel {
                Button(action: model.openEditor) {
                    ToolbarBrandIcon(name: model.editorID, fallback: .code, height: 22)
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
                Button(action: model.configureRun) {
                    HStack(spacing: 3) {
                        Text(model.runScheme).lineLimit(1)
                        Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                    }
                }
                    .help("Choose the scheme and simulator")
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
