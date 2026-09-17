import SwiftUI

/// Placeholder screens for sidebar selections that have no dedicated scene. They read
/// live state from the root model so pins and titles stay current.

struct RootTerminalPlaceholderView: View {
    let model: RootViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Open an interactive shell.").foregroundStyle(.secondary)
            Button("Open native terminal", systemImage: "terminal", action: model.openTerminal)
                .buttonStyle(.borderedProminent)
        }
    }
}

struct RootSessionPlaceholderView: View {
    let id: String
    let model: RootViewModel

    var body: some View {
        if let session = model.session(id) {
            VStack(alignment: .leading, spacing: 16) {
                Text(session.title).font(.headline)
                LabeledContent("Worktree", value: session.worktree)
                LabeledContent("Branch", value: session.branch)
                HStack {
                    Button("Open Terminal", systemImage: "terminal", action: model.openTerminal)
                        .buttonStyle(.borderedProminent)
                    Button(session.pinned ? "Unpin Session" : "Pin Session", systemImage: "pin") { model.togglePin(session.id) }
                }
            }.textSelection(.enabled)
        } else {
            Text("Session is not available.").foregroundStyle(.secondary)
        }
    }
}

struct RootTabPlaceholderView: View {
    let id: String
    let model: RootViewModel

    var body: some View {
        let url = model.tab(id)?.url ?? ""
        VStack(alignment: .leading, spacing: 16) {
            Text(url).textSelection(.enabled).foregroundStyle(.secondary)
            if let address = model.browserAddress(url) {
                Button("Open in Browser") { model.openBrowser(address) }
            }
        }
    }
}
