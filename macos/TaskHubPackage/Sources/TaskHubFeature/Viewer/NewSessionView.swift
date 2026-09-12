import SwiftUI

struct NewSessionView: View {
    let store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var projectID = ""
    @State private var draft = SessionDraft()
    @State private var branches: [String] = []
    @State private var loading = false
    @State private var creating = false
    @State private var error: String?
    private var project: Project? { store.projects.first { $0.id == projectID } }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("New Session").font(.title2.weight(.semibold))
            Form {
                Picker("Project", selection: $projectID) {
                    Text("Choose a project").tag("")
                    ForEach(store.projects) { Text($0.name).tag($0.id) }
                }
                TextField("Branch", text: $draft.branch).accessibilityIdentifier("session-branch")
                Toggle("Create a new branch", isOn: $draft.createBranch)
                if draft.createBranch {
                    Picker("Base branch", selection: $draft.base) {
                        Text("Current checkout").tag("")
                        ForEach(branches, id: \.self) { Text($0).tag($0) }
                    }
                }
                TextField("Title (optional)", text: $draft.title)
                TextField("Page URL (optional)", text: $draft.url)
                Picker("Agent", selection: $draft.agent) {
                    ForEach(SessionAgent.allCases) { Text($0.label).tag($0) }
                }
            }.formStyle(.grouped).frame(height: 340).disabled(creating)
            Text("The session uses a linked worktree beside the project workspace. An existing checkout for this branch can be reused.")
                .font(.callout).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction).disabled(creating)
                Spacer()
                if loading || creating { ProgressView().controlSize(.small) }
                Button(creating ? "Creating…" : "Create Session") { create() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(creating || loading || project == nil || draft.branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 520)
        .interactiveDismissDisabled(creating)
        .onAppear {
            if case .project(let id) = store.selection { projectID = id }
            else if case .session(let id) = store.selection { projectID = store.sessions.first { $0.id == id }?.projectId ?? "" }
            else if store.projects.count == 1 { projectID = store.projects[0].id }
        }
        .task(id: projectID) {
            branches = []; draft.base = ""; error = nil
            guard let project, let operations = store.sessionOperations else { return }
            loading = true
            defer { loading = false }
            do {
                let refs = try await operations.references(project)
                try Task.checkCancellation()
                branches = refs.branches.map(\.name)
                draft.base = branches.contains("develop") ? "develop" : refs.defaultBranch
                if !draft.base.isEmpty && !branches.contains(draft.base) { branches.append(draft.base) }
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }

    private func create() {
        guard let project, let operations = store.sessionOperations else { error = "Connect before creating a session."; return }
        creating = true; error = nil
        Task {
            defer { creating = false }
            do { store.createdSession(try await operations.create(project: project, draft: draft)); dismiss() }
            catch { self.error = error.localizedDescription }
        }
    }
}
