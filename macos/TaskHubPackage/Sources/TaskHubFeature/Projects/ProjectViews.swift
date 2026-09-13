import SwiftUI

struct ProjectEditorView: View {
    @Bindable var model: ProjectEditorViewModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Form {
                Section("Project") {
                    TextField("Name", text: $model.draft.name).accessibilityIdentifier("project-name")
                    HStack {
                        TextField("Workspace folder", text: $model.draft.workspace).accessibilityIdentifier("project-workspace")
                        Button("Choose…") { Task { await model.pickFolder() } }
                    }
                    HStack {
                        TextField("GitHub repository", text: $model.draft.repo).help("owner/repo or a GitHub URL")
                        Button("Detect") { Task { await model.detectRepository() } }.disabled(model.draft.workspace.isEmpty)
                    }
                }
                Section("Jira") {
                    TextField("Project key", text: $model.draft.jiraProjectKey)
                    TextField("Saved JQL", text: $model.draft.jql, axis: .vertical).lineLimit(2...4)
                }
                Section("Editor") {
                    Picker("IDE", selection: $model.draft.ide) {
                        ForEach(model.ideChoices) { Text($0.title).tag($0.id) }
                    }
                    if model.draft.ide == "custom" {
                        TextField("Command template", text: $model.draft.ideCmd)
                        Text("Use {path} for the checkout location.").font(.caption).foregroundStyle(.secondary)
                    }
                    TextField("Relative launch target", text: $model.draft.ideTarget)
                    Text("For example, App/App.xcworkspace. Leave blank to detect the Xcode target.").font(.caption).foregroundStyle(.secondary)
                }
            }.formStyle(.grouped).disabled(model.busy)
            if let error = model.error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).textSelection(.enabled)
            }
            HStack {
                if model.id != nil {
                    Button("Delete Project…", role: .destructive) { model.confirmingDelete = true }.disabled(model.busy)
                    Spacer()
                    if model.saved && !model.dirty { Text("Saved").foregroundStyle(.secondary) }
                    Button("Revert", action: model.revert).disabled(!model.dirty || model.busy)
                } else { Spacer() }
                if model.busy { ProgressView().controlSize(.small) }
                Button(model.id == nil ? "Create Project" : "Save Project") { Task { await model.save() } }
                    .buttonStyle(.borderedProminent).disabled(!model.canSave)
            }
        }
        .alert("Delete this project?", isPresented: $model.confirmingDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete Project", role: .destructive) { Task { await model.delete(confirmed: true) } }
        } message: {
            Text("This removes the project configuration and PR/Jira links. Sessions remain under Sessions, and workspace folders and running terminals are kept.")
        }
    }
}

struct NewProjectSheet: View {
    @Bindable var model: ProjectEditorViewModel
    let cancel: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("New Project").font(.title2.bold())
                Spacer()
                Button("Cancel", action: cancel).disabled(model.busy).keyboardShortcut(.cancelAction)
            }
            ProjectEditorView(model: model)
        }.padding(24).frame(width: 600, height: 560).interactiveDismissDisabled(model.busy)
    }
}

struct ProjectPageView: View {
    @Bindable var model: ProjectPageViewModel
    let actions: DashboardViewModel
    let appearance: AppAppearance
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker("Project section", selection: $model.section) {
                ForEach(ProjectSection.allCases) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented).labelsHidden()
            switch model.section {
            case .tickets:
                if let tickets = model.tickets { JiraTicketsView(model: tickets) }
            case .board:
                if let board = model.board { WebBoardView(model: board, appearance: appearance) }
            case .settings: ProjectEditorView(model: model.editor)
            case .automation:
                if let automation = model.automation { AutomationView(model: automation) }
            case .workflows:
                if let workflows = model.workflows { WorkflowEditorView(model: workflows) }
            case .prs:
                HStack {
                    TextField("Search project pull requests", text: $model.search).textFieldStyle(.roundedBorder)
                    Picker("State", selection: $model.state) {
                        Text("Open").tag("open"); Text("Merged").tag("merged"); Text("All").tag("all")
                    }.frame(width: 140)
                    if model.loading { ProgressView().controlSize(.small) }
                }
                if let error = model.error {
                    Text(error).foregroundStyle(.orange).textSelection(.enabled)
                    Button("Retry pull requests") { Task { await model.refresh() } }
                }
                if let error = actions.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(model.warnings.enumerated()), id: \.offset) { _, message in
                            Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                        }
                        if model.rows.isEmpty && !model.loading {
                            Text(model.project.repo.isEmpty ? "Configure a GitHub repository in Settings to track pull requests." : "No matching pull requests.")
                                .foregroundStyle(.secondary).padding(.vertical, 20)
                        }
                        ForEach(model.rows) { row in
                            DashboardCard(row: row, opening: actions.opening.contains(row.id),
                                          open: { Task { await actions.open(row) } },
                                          external: { actions.openExternally(row) }, copy: { actions.copyLink(row) })
                            Divider()
                        }
                    }
                }
            }
        }.task { await model.refresh() }
        .onDisappear(perform: model.cancelRefresh)
    }
}
