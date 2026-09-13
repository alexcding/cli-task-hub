import SwiftUI
import WebKit

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
                TextField("Page address", text: $model.address).textFieldStyle(.roundedBorder).focused($editingAddress)
                    .onSubmit { if model.submitAddress() { editingAddress = false } }
                Button("Open in Browser", systemImage: "arrow.up.right.square", action: model.openExternally)
                    .disabled(!model.canOpenExternally)
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
            if let view = page.webView { BrowserSurface(webView: view) }
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
            HStack {
                if let session = model.session {
                    Label(session.label, systemImage: "terminal").labelStyle(.titleAndIcon).font(.headline).lineLimit(1)
                    Text(session.branch).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                    Button("Reveal Worktree", systemImage: "folder", action: model.reveal).labelStyle(.iconOnly)
                    if let title = model.editorLabel {
                        Button(title, systemImage: "curlybraces", action: model.openEditor).disabled(!model.canOpenExternal)
                    }
                    if let title = model.gitClientLabel {
                        Button(title, systemImage: "arrow.triangle.branch", action: model.openGitClient).disabled(!model.canOpenExternal)
                    }
                } else {
                    Text(model.workspaceTitle).font(.headline).lineLimit(1)
                    if !model.showsTerminal {
                        Button("Create Session", systemImage: "terminal.badge.plus", action: model.createSession)
                            .disabled(!model.canCreateSession)
                    }
                }
                Spacer()
                Menu("History", systemImage: "clock.arrow.circlepath") {
                    if context.visits.isEmpty { Text("No closed or visited pages") }
                    ForEach(context.visits.reversed()) { record in
                        Button(record.title) { model.reopen(record) }
                    }
                }
                Button("Open File", systemImage: "doc.badge.plus", action: model.openFile)
                Button("Add Page", systemImage: "plus", action: model.addPage)
                if model.session != nil {
                    Button(model.showsChanges ? "Hide Changes" : "Show Changes", systemImage: "arrow.triangle.branch", action: model.toggleChanges)
                        .disabled(!model.canShowChanges)
                    if model.showsBuildActions {
                        if model.build?.running == true {
                            Button("Stop Build", systemImage: "stop.fill") { Task { await model.stopBuild() } }
                        } else {
                            Button("Run…", systemImage: "play.fill", action: model.run).disabled(!model.canRun)
                        }
                    }
                    if model.buildTerminal != nil {
                        Button(model.showsBuild ? "Show Context" : "Show Build", systemImage: "hammer", action: model.toggleBuild)
                    }
                    Button("Remove Session", systemImage: "trash", action: model.remove).disabled(!model.canRemove)
                    if model.terminal?.agentBusy == true { ProgressView().controlSize(.small).help("Agent working") }
                    Button("Restart Session", systemImage: "arrow.counterclockwise", action: model.restart).disabled(!model.canRestart)
                }
                if model.showsTerminal {
                    Button(model.showsPage ? "Hide Context Pane" : "Show Context Pane", systemImage: "rectangle.righthalf.inset.filled", action: model.toggleContext)
                        .disabled(!model.canToggleContext)
                }
            }.labelStyle(.iconOnly).padding(12)
            if let workflow = model.workflow {
                WorkflowRunView(model: workflow, openHookSettings: model.openHookSettings)
            }
            if !context.tabs.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        ForEach(context.tabs) { page in
                            HStack(spacing: 6) {
                                Button { context.select(page) } label: {
                                    Text((page.dirty ? "● " : "") + page.title).lineLimit(1).frame(maxWidth: 190)
                                }.buttonStyle(.plain)
                                Button("Close \(page.title)", systemImage: "xmark") { context.close(page) }
                                    .labelStyle(.iconOnly).buttonStyle(.plain)
                            }.padding(.horizontal, 10).padding(.vertical, 7)
                                .background(context.activeID == page.id ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.08),
                                            in: RoundedRectangle(cornerRadius: 6))
                        }
                    }.padding(.horizontal, 12).padding(.bottom, 8)
                }.frame(height: 40)
            }
            if let error = context.error { Text(error).font(.caption).foregroundStyle(.orange).padding(8) }
            if let error = model.launchError {
                Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled).padding(8)
                    .accessibilityIdentifier("workspace-launch-error")
            }
            Divider()
            WorkspaceSplit(showsLeft: model.showsTerminal, showsRight: model.showsPage, showsBuild: model.showsBuild) {
                if model.showsTerminal {
                    ZStack {
                        if let terminal = model.terminal {
                            TerminalPane(session: terminal, reconnect: model.reconnectTerminal)
                                .id(terminal.id)
                        } else {
                            VStack(spacing: 12) {
                                Text(model.terminalPrompt).foregroundStyle(.secondary)
                                Button("Open Terminal", systemImage: "terminal", action: model.openTerminal).buttonStyle(.borderedProminent)
                            }.frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                    // The emulator remains mounted across page and build selection.
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .opacity(model.showsTerminal ? 1 : 0).allowsHitTesting(model.showsTerminal)
                    .accessibilityHidden(!model.showsTerminal).clipped()
                }
            } right: {
                ZStack {
                    if model.showsChanges {
                        VStack(spacing: 0) {
                            Picker("Review section", selection: Binding(get: { context.reviewSection }, set: context.setReviewSection)) {
                                ForEach(ReviewSection.allCases) { Text($0.rawValue).tag($0) }
                            }.pickerStyle(.segmented).labelsHidden().padding(8)
                            if context.reviewSection == .history, let history = model.history {
                                GitHistoryView(model: history)
                            } else if context.reviewSection == .changes, let diff = model.diff {
                                DiffView(model: diff)
                            }
                        }
                    } else if let document = context.activeDocument {
                        EditorDocumentView(model: document).id(document.id)
                    } else if let page = context.activePage { BrowserPane(page: page, context: context, model: page.controls).id(page.id) }
                    else if model.session == nil {
                        ContentUnavailableView("No open pages", systemImage: "globe", description: Text("Add a page or reopen one from History."))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } build: {
                if let build = model.buildTerminal {
                    TerminalPane(session: build, reconnect: model.reconnectBuild, title: "Build")
                        .id(build.id).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
