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
        .onChange(of: page.url) { _, _ in model.synchronizeAddress() }
        .onChange(of: editingAddress) { _, value in model.setEditingAddress(value) }
        .onDisappear { model.setEditingAddress(false) }
        .onChange(of: context.findVisible) { _, value in if value { finding = true } }
        .onExitCommand { context.findVisible = false }
    }
}

struct SessionWorkspaceView: View {
    let context: WorkspaceContext
    let store: AppStore
    let active: Bool
    @State private var restarting = false
    @State private var removal: SessionRemovalViewModel?
    @State private var destination: BuildWorkspaceViewModel?
    private var session: WorkspaceSession? { store.sessions.first { "task:\($0.id)" == context.id } }
    private var terminal: TerminalSession? { store.terminals[context.id] }
    private var showsBuild: Bool { session != nil && context.pane == .build }
    private var showsTerminal: Bool { session != nil || context.id == "scratch" }
    private var showsChanges: Bool { session != nil && context.pane == .diff }
    private var showsPage: Bool { !showsTerminal || showsChanges || (!showsBuild && context.pane == .term && context.activeID != nil) }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                if let session {
                    Label(session.label, systemImage: "terminal").labelStyle(.titleAndIcon).font(.headline).lineLimit(1)
                    Text(session.branch).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                    Button("Reveal Worktree", systemImage: "folder") {
                        store.revealWorktree(session)
                    }.labelStyle(.iconOnly)
                    if let title = store.workspaceLaunch.editorLabel(store.projects.first { $0.id == session.projectId }) {
                        Button(title, systemImage: "curlybraces") {
                            Task { await store.workspaceLaunch.openEditor(session: session, project: store.projects.first { $0.id == session.projectId }) }
                        }.disabled(store.workspaceLaunch.opening.contains(context.id) || store.changingSessions.contains(session.id))
                    }
                    if let title = store.workspaceLaunch.gitClientLabel(store.shell.gitClient) {
                        Button(title, systemImage: "arrow.triangle.branch") {
                            Task { await store.workspaceLaunch.openGitClient(session: session, id: store.shell.gitClient, custom: store.shell.gitClientCommand) }
                        }.disabled(store.workspaceLaunch.opening.contains(context.id) || store.changingSessions.contains(session.id))
                    }
                } else if context.id == "scratch" {
                    Text("Terminal").font(.headline)
                } else {
                    Text(context.activeDocument?.title ?? context.activePage?.title ?? "Workspace").font(.headline).lineLimit(1)
                    Button("Create Session", systemImage: "terminal.badge.plus") { store.perform(.newSession) }
                        .disabled(!store.canPerform(.newSession))
                }
                Spacer()
                Menu("History", systemImage: "clock.arrow.circlepath") {
                    if context.visits.isEmpty { Text("No closed or visited pages") }
                    ForEach(context.visits.reversed()) { record in
                        Button(record.title) {
                            switch record { case .page(let page): context.open(page.url, title: page.title)
                            case .file(let file): context.openFile(file.path) }
                        }
                    }
                }
                Button("Open File", systemImage: "doc.badge.plus") { store.viewer.openFile(in: context) }
                Button("Add Page", systemImage: "plus") { store.addPage(in: context) }
                if session != nil {
                    Button(showsChanges ? "Hide Changes" : "Show Changes", systemImage: "arrow.triangle.branch") {
                        if let session { store.showChanges(for: session, context: context) }
                    }.disabled(store.connection != "Connected")
                    if let session, store.projects.first(where: { $0.id == session.projectId })?.ide == "xcode" {
                        if let model = store.buildModels[context.id], model.running {
                            Button("Stop Build", systemImage: "stop.fill") { Task { await model.stop() } }
                        } else {
                            Button("Run…", systemImage: "play.fill") { destination = store.buildModel(for: session, context: context) }
                                .disabled(store.changingSessions.contains(session.id))
                        }
                    }
                    if store.terminals["build:\(context.sourceURL)"] != nil {
                        Button(showsBuild ? "Show Context" : "Show Build", systemImage: "hammer") {
                            context.setPane(showsBuild ? .term : .build)
                        }
                    }
                    Button("Remove Session", systemImage: "trash") {
                        if let session { removal = store.removalModel(for: session) }
                    }.disabled(store.connection != "Connected" || (session.map { store.changingSessions.contains($0.id) } ?? true))
                    if terminal?.agentBusy == true { ProgressView().controlSize(.small).help("Agent working") }
                    Button("Restart Session", systemImage: "arrow.counterclockwise") { restarting = true }
                        .disabled(session.map { store.changingSessions.contains($0.id) } ?? true)
                }
                if showsTerminal {
                    Button(showsPage ? "Hide Context Pane" : "Show Context Pane", systemImage: "rectangle.righthalf.inset.filled") {
                        context.setPane(context.pane == .term ? .off : .term)
                    }.disabled(context.activeID == nil)
                }
            }.labelStyle(.iconOnly).padding(12)
            if let workflow = store.workflowModel(in: context), !workflow.recipes.isEmpty || workflow.running {
                WorkflowRunView(model: workflow, openHookSettings: store.openWorkflowHookSettings)
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
            if let error = store.workspaceLaunch.errors[context.id] {
                Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled).padding(8)
                    .accessibilityIdentifier("workspace-launch-error")
            }
            Divider()
            WorkspaceSplit(showsLeft: showsTerminal, showsRight: showsPage, showsBuild: showsBuild) {
                if showsTerminal {
                    ZStack {
                        if let terminal {
                            TerminalPane(session: terminal, reconnect: store.reattachTerminal, active: active && showsTerminal)
                                .id(terminal.id)
                        } else {
                            VStack(spacing: 12) {
                                Text(context.id == "scratch" ? "Open an interactive shell." : "Open this session’s shell in its worktree.").foregroundStyle(.secondary)
                                Button("Open Terminal", systemImage: "terminal", action: store.openTerminal).buttonStyle(.borderedProminent)
                            }.frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                    // The emulator remains mounted across page and build selection.
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .opacity(showsTerminal ? 1 : 0).allowsHitTesting(showsTerminal)
                    .accessibilityHidden(!showsTerminal).clipped()
                }
            } right: {
                ZStack {
                    if showsChanges {
                        VStack(spacing: 0) {
                            Picker("Review section", selection: Binding(get: { context.reviewSection }, set: context.setReviewSection)) {
                                ForEach(ReviewSection.allCases) { Text($0.rawValue).tag($0) }
                            }.pickerStyle(.segmented).labelsHidden().padding(8)
                            if context.reviewSection == .history, let model = store.historyModels[context.id] {
                                GitHistoryView(model: model, appearance: store.shell.appearance, active: active)
                            } else if context.reviewSection == .changes, let model = store.diffModels[context.id] {
                                DiffView(model: model, appearance: store.shell.appearance, active: active)
                            }
                        }
                    } else if let document = context.activeDocument {
                        EditorDocumentView(model: document, appearance: store.shell.appearance, active: active && showsPage && !context.restoring).id(document.id)
                    } else if let page = context.activePage { BrowserPane(page: page, context: context, model: page.controls).id(page.id) }
                    else if session == nil {
                        ContentUnavailableView("No open pages", systemImage: "globe", description: Text("Add a page or reopen one from History."))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } build: {
                if let build = store.terminals["build:\(context.sourceURL)"] {
                    TerminalPane(session: build, reconnect: { store.reattachTerminal(key: "build:\(context.sourceURL)") }, active: active && showsBuild, title: "Build")
                        .id(build.id).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { prepareChanges() }
        .onChange(of: context.reviewSection) { _, _ in prepareChanges() }
        .onChange(of: store.dashboard.projects) { _, _ in prepareChanges() }
        .onChange(of: context.pane) { _, _ in prepareChanges() }
        .onChange(of: store.connection) { _, _ in prepareChanges() }
        .onChange(of: active) { _, _ in prepareChanges() }
        .confirmationDialog("Restart this session?", isPresented: $restarting, titleVisibility: .visible) {
            Button("Restart Session", role: .destructive) { if let session { store.restartSession(session) } }
        } message: {
            Text("This stops the session’s shell and any command it is running. The worktree is kept. The agent resumes its saved conversation when an ID is available.")
        }
        .sheet(isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } })) {
            if let removal { SessionRemovalView(model: removal) }
        }
        .sheet(isPresented: Binding(get: { destination != nil }, set: { if !$0 { destination = nil } })) {
            if let destination { BuildDestinationView(model: destination) }
        }
    }

    private func prepareChanges() {
        if active, showsChanges, let session { store.prepareChanges(for: session, context: context) }
    }
}
