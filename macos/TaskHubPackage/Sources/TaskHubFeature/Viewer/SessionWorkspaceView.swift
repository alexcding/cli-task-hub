import AppKit
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
    @State private var address = ""
    @FocusState private var editingAddress: Bool
    @FocusState private var finding: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button("Back", systemImage: "chevron.left", action: page.back).disabled(!page.canGoBack)
                Button("Forward", systemImage: "chevron.right", action: page.forward).disabled(!page.canGoForward)
                Button(page.loading ? "Stop Loading" : "Reload Page", systemImage: page.loading ? "xmark" : "arrow.clockwise") {
                    if page.loading { page.stop() } else { page.reload() }
                }
                TextField("Page address", text: $address).textFieldStyle(.roundedBorder).focused($editingAddress)
                    .onSubmit { page.navigate(address); editingAddress = false }
                Button("Open in Browser", systemImage: "arrow.up.right.square") {
                    if let url = safeWebURL(page.url) { NSWorkspace.shared.open(url) }
                }
            }.labelStyle(.iconOnly).padding(8)
            if context.findVisible {
                HStack {
                    TextField("Find in page", text: Binding(get: { context.findText }, set: { context.findText = $0 }))
                        .focused($finding).onSubmit { page.find(context.findText) }
                    if page.found == false { Text("No match").font(.caption).foregroundStyle(.secondary) }
                    Button("Previous Match", systemImage: "chevron.up") { page.find(context.findText, backwards: true) }
                    Button("Next Match", systemImage: "chevron.down") { page.find(context.findText) }
                    Button("Close Find", systemImage: "xmark") { context.findVisible = false }
                }.labelStyle(.iconOnly).padding(8)
            }
            if let error = page.error {
                HStack { Text(error).font(.callout); Spacer(); Button("Retry", action: page.reload) }
                    .padding(10).foregroundStyle(.orange)
            }
            Divider()
            if let view = page.webView { BrowserSurface(webView: view) }
            else { ContentUnavailableView("Page suspended", systemImage: "globe", description: Text("Select this tab to reload it.")) }
        }
        .onAppear { address = page.url }
        .onChange(of: page.url) { _, value in if !editingAddress { address = value } }
        .onChange(of: context.findVisible) { _, value in if value { finding = true } }
        .onExitCommand { context.findVisible = false }
    }
}

struct SessionWorkspaceView: View {
    let context: WorkspaceContext
    let store: AppStore
    let active: Bool
    @State private var addingPage = false
    @State private var restarting = false
    @State private var address = "https://"
    private var session: WorkspaceSession? { store.sessions.first { "task:\($0.id)" == context.id } }
    private var terminal: TerminalSession? { store.terminals[context.id] }
    private var showsTerminal: Bool { session != nil && (context.activePage == nil || context.pane == .term) }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                if let session {
                    Label(session.label, systemImage: "terminal").labelStyle(.titleAndIcon).font(.headline).lineLimit(1)
                    Text(session.branch).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                    Button("Reveal Worktree", systemImage: "folder") {
                        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: session.worktree)])
                    }.labelStyle(.iconOnly)
                } else { Text(context.activePage?.title ?? "Web page").font(.headline).lineLimit(1) }
                Spacer()
                Menu("History", systemImage: "clock.arrow.circlepath") {
                    if context.history.isEmpty { Text("No closed or visited pages") }
                    ForEach(context.history.reversed()) { record in
                        Button(record.title.isEmpty ? record.url : record.title) { context.open(record.url, title: record.title) }
                    }
                }
                Button("Add Page", systemImage: "plus") { addingPage = true }
                if session != nil {
                    if terminal?.agentBusy == true { ProgressView().controlSize(.small).help("Agent working") }
                    Button("Restart Session", systemImage: "arrow.counterclockwise") { restarting = true }
                        .disabled(session.map { store.changingSessions.contains($0.id) } ?? true)
                    Button(showsTerminal ? "Hide Terminal Pane" : "Show Terminal Pane", systemImage: "rectangle.righthalf.inset.filled") {
                        context.setPane(context.pane == .term ? .off : .term)
                    }.disabled(context.activePage == nil)
                }
            }.labelStyle(.iconOnly).padding(12)
            if !context.pages.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        ForEach(context.pages) { page in
                            HStack(spacing: 6) {
                                Button { context.select(page) } label: {
                                    Text(page.title.isEmpty ? page.url : page.title).lineLimit(1).frame(maxWidth: 190)
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
            Divider()
            WorkspaceSplit(showsLeft: context.activePage != nil || session == nil, showsRight: showsTerminal) {
                ZStack {
                    if let page = context.activePage { BrowserPane(page: page, context: context).id(page.id) }
                    else if session == nil {
                        ContentUnavailableView("No open pages", systemImage: "globe", description: Text("Add a page or reopen one from History."))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } right: {
                if session != nil {
                    ZStack {
                        if let terminal {
                            TerminalPane(session: terminal, reconnect: store.reattachTerminal, active: active && showsTerminal)
                                .id(terminal.id)
                        } else {
                            VStack(spacing: 12) {
                                Text("Open this session’s shell in its worktree.").foregroundStyle(.secondary)
                                Button("Open Terminal", systemImage: "terminal", action: store.openTerminal).buttonStyle(.borderedProminent)
                            }.frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                    // The view remains mounted when the right pane is hidden.
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .opacity(showsTerminal ? 1 : 0).allowsHitTesting(showsTerminal)
                    .accessibilityHidden(!showsTerminal).clipped()
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .sheet(isPresented: $addingPage) {
            VStack(alignment: .leading, spacing: 16) {
                Text("Add Page").font(.headline)
                TextField("HTTP or HTTPS address", text: $address).textFieldStyle(.roundedBorder)
                HStack {
                    Button("Cancel", role: .cancel) { addingPage = false }.keyboardShortcut(.cancelAction)
                    Spacer()
                    Button("Open") {
                        if context.open(address.trimmingCharacters(in: .whitespacesAndNewlines)) != nil { addingPage = false; address = "https://" }
                    }.keyboardShortcut(.defaultAction).disabled(safeWebURL(address.trimmingCharacters(in: .whitespacesAndNewlines)) == nil)
                }
            }.padding(24).frame(width: 440)
        }
        .confirmationDialog("Restart this session?", isPresented: $restarting, titleVisibility: .visible) {
            Button("Restart Session", role: .destructive) { if let session { store.restartSession(session) } }
        } message: {
            Text("This stops the session’s shell and any command it is running. The worktree is kept. The agent resumes its saved conversation when an ID is available.")
        }
    }
}
