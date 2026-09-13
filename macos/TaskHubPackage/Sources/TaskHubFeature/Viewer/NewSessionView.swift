import SwiftUI

struct NewSessionView: View {
    @Bindable var model: NewSessionViewModel
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("New Session").font(.title2.weight(.semibold))
            Form {
                Picker("Project", selection: $model.projectID) {
                    Text("Choose a project").tag("")
                    ForEach(model.projects) { Text($0.name).tag($0.id) }
                }
                TextField("Branch or PR/Jira URL", text: Binding(get: { model.draft.branch }, set: model.editBranch)).accessibilityIdentifier("session-branch")
                Toggle("Create a new branch", isOn: $model.draft.createBranch)
                if model.draft.createBranch {
                    Picker("Base branch", selection: $model.draft.base) {
                        Text("Current checkout").tag("")
                        ForEach(model.branches, id: \.self) { Text($0).tag($0) }
                    }
                }
                TextField("Title (optional)", text: $model.draft.title).accessibilityIdentifier("session-title")
                TextField("Page URL (optional)", text: $model.draft.url)
                Button("Use Page Details") { Task { await model.resolve() } }.disabled(!model.canResolve)
                Picker("Agent", selection: $model.draft.agent) {
                    ForEach(SessionAgent.allCases) { Text($0.label).tag($0) }
                }
            }.formStyle(.grouped).frame(height: 370).disabled(model.busy)
            Text("The session uses a linked worktree beside the project workspace. An existing checkout for this branch can be reused.")
                .font(.callout).foregroundStyle(.secondary)
            if let reused = model.draft.reuseWorktree { Text("Reusing \(reused)").font(.caption).textSelection(.enabled) }
            if let error = model.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
            HStack {
                Button("Cancel", role: .cancel, action: cancel).keyboardShortcut(.cancelAction).disabled(model.creating)
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                Button(model.creating ? "Creating…" : "Create Session") { Task { await model.create() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!model.canCreate)
            }
        }.padding(24).frame(width: 520)
        .interactiveDismissDisabled(model.creating)
        .task(id: model.projectID) { await model.loadReferences() }
    }
}
