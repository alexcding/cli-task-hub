import AppKit
import SwiftUI

/// Five tabs, one card per group, one `SettingsRow` per setting.
struct SettingsView: View {
    @Bindable var model: SettingsViewModel
    let shell: ShellStore
    @State private var confirmingClear: BrowsingDataScope?

    var body: some View {
        Form {
            // The tab picker is the Form's first section, so it takes the same inset the grouped
            // style gives every other section instead of sitting outside it at a different edge.
            Section {
                Picker("Settings section", selection: $model.section) {
                    ForEach(SettingsSection.allCases) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented).labelsHidden()
            }
            switch model.section {
            case .general: general
            case .terminal: TerminalSettingsView(fonts: model.fonts, shell: shell)
            case .editor: EditorSettingsView(fonts: model.fonts, shell: shell)
            case .clis: clis
            case .system: system
            }
            if let error = model.error {
                Section {
                    Text(error).foregroundStyle(Theme.danger).textSelection(.enabled)
                    Button("Retry Settings", action: model.refresh)
                }
            }
            if model.loading && !model.loaded {
                Section { ProgressView("Loading settings…") }
            }
        }
        .formStyle(.grouped)
        .readableColumn()
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in model.applicationActiveChanged(true) }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in model.applicationActiveChanged(false) }
    }

    // MARK: - General

    @ViewBuilder private var general: some View {
            Section("Appearance") {
                SettingsRow(title: "Appearance") {
                    Picker("Theme", selection: Binding(get: { shell.appearance }, set: shell.setAppearance)) {
                        ForEach(AppAppearance.allCases) { Text($0.title).tag($0) }
                    }.labelsHidden().accessibilityIdentifier("settings-theme")
                }
            }
            LoginItemView(model: model.loginItem)
            Section("Default agent") {
                SettingsRow(title: "New session agent") {
                    Picker("Default session agent", selection: Binding(get: { shell.defaultAgent }, set: shell.setDefaultAgent)) {
                        ForEach(SessionAgent.allCases) { Text($0.label).tag($0) }
                    }.labelsHidden().accessibilityIdentifier("settings-default-agent")
                }
            }
            NotificationPreferencesView(shell: shell, sounds: model.sounds)
            Section("Git client") {
                SettingsRow(title: "Open in git client") {
                    Picker("Git client", selection: Binding(get: { shell.gitClient }, set: shell.setGitClient)) {
                        Text("None").tag("")
                        ForEach(ExternalTool.gitClients) { Text($0.name).tag($0.id) }
                        Text("Custom…").tag("custom")
                        if !shell.gitClient.isEmpty && shell.gitClient != "custom" && !ExternalTool.gitClients.contains(where: { $0.id == shell.gitClient }) {
                            Text("Unavailable (\(shell.gitClient))").tag(shell.gitClient)
                        }
                    }.labelsHidden().accessibilityIdentifier("settings-git-client")
                }
                if shell.gitClient == "custom" {
                    SettingsRow(title: "Command template",
                                caption: "Use {path} for the checkout. Quotes group arguments; shell expansion and pipelines are not supported.") {
                        TextField("Command template", text: Binding(get: { shell.gitClientCommandDraft }, set: { shell.gitClientCommandDraft = $0 }))
                            .accessibilityIdentifier("settings-git-client-command").onSubmit(shell.saveGitClientCommand)
                    }
                    HStack {
                        Spacer()
                        Button("Revert Command", action: shell.revertGitClientCommand).disabled(!shell.gitClientCommandDirty)
                        Button("Save Command", action: shell.saveGitClientCommand).disabled(!shell.gitClientCommandDirty)
                    }
                    if let error = shell.gitClientCommandError { Text(error).foregroundStyle(Theme.danger) }
                }
            }
            browser
            // Appearance, the agent and the git client all save through the shell store.
            if let error = shell.settingsError {
                Section { Text(error).foregroundStyle(Theme.danger) }
            }
    }

    /// One row per scope; each button asks first because both clears are immediate and cannot
    /// be undone. The notice below reports the last clear that landed.
    @ViewBuilder private var browser: some View {
        Section("Browser") {
            ForEach(BrowsingDataScope.allCases) { scope in
                SettingsRow(title: scope.title) {
                    Button(scope.buttonTitle) { confirmingClear = scope }
                        .disabled(model.clearingBrowsingData != nil)
                        .accessibilityIdentifier("settings-clear-\(scope.rawValue)")
                }
            }
            if model.clearingBrowsingData != nil { ProgressView().controlSize(.small) }
            if let notice = model.browsingDataNotice {
                Text(notice).foregroundStyle(Theme.textSecondary).accessibilityIdentifier("settings-browsing-data-notice")
            }
        }
        .confirmationDialog(confirmingClear.map { "Clear \($0.title.lowercased())?" } ?? "",
                            isPresented: Binding(get: { confirmingClear != nil }, set: { if !$0 { confirmingClear = nil } }),
                            titleVisibility: .visible, presenting: confirmingClear) { scope in
            Button(scope == .history ? "Clear History" : "Clear Cookies", role: .destructive) { model.clearBrowsingData(scope) }
            Button("Cancel", role: .cancel) {}
        } message: { scope in
            Text(scope == .history ? "Removes every visited page from the start page and address suggestions."
                                   : "Removes cookies, caches and site storage for the embedded browser. Open pages will be signed out.")
        }
    }

    // MARK: - CLIs

    @ViewBuilder private var clis: some View {
            CLIIntegrationSection(model: model.clis)
            WorkflowHooksSection(model: model.clis)
            Section("Polling") {
                Text("The GitHub and Jira CLIs poll on independent loops.")
                    .font(.caption).foregroundStyle(Theme.textSecondary)
                SettingsRow(title: "GitHub poll interval", caption: "Seconds between PR refreshes. Minimum 15.") {
                    TextField("60", text: $model.draft.pollInterval)
                        .accessibilityIdentifier("settings-poll-interval")
                }
                SettingsRow(title: "Jira poll interval", caption: "Seconds between ticket refreshes. Minimum 30.") {
                    TextField("120", text: $model.draft.jiraPollInterval)
                        .accessibilityIdentifier("settings-jira-poll-interval")
                }
            }.disabled(!model.loaded || model.saving)
            Section("Jira") {
                SettingsRow(title: "Jira site URL", caption: "Leave blank to use the site acli is signed in to.") {
                    TextField("auto-detected from acli", text: $model.draft.jiraBaseURL).accessibilityIdentifier("settings-jira-site")
                }
                SettingsRow(title: "Result limit", caption: "How many tickets a sync fetches at most.") {
                    TextField("100", text: $model.draft.jiraLimit)
                        .accessibilityIdentifier("settings-jira-limit")
                }
                SettingsRow(title: "API token", caption: "Create one at id.atlassian.com. Stored with your other settings.") {
                    RevealableSecureField(prompt: "API token", text: $model.draft.jiraAPIToken).accessibilityIdentifier("settings-jira-token")
                }
                saveRow
            }.disabled(!model.loaded || model.saving)
    }

    // MARK: - System

    @ViewBuilder private var system: some View {
            ResourceUsageView(model: model.resources)
            DiagnosticsView(model: model.diagnostics)
    }

    // MARK: - Shared save row

    /// CLIs → Polling and Jira both edit one `AppConfigDraft` and share one Save: a save sends
    /// every changed key from both groups.
    @ViewBuilder private var saveRow: some View {
        if let message = model.draft.validationError { Text(message).foregroundStyle(Theme.danger) }
        HStack {
            Button("Revert", action: model.revert).disabled(!model.dirty || model.saving)
                .accessibilityIdentifier("settings-revert")
            Spacer()
            if model.saved && !model.dirty { Text("Settings saved").foregroundStyle(Theme.textSecondary) }
            if model.saving { ProgressView().controlSize(.small) }
            Button("Save") { Task { await model.save() } }
                .disabled(!model.canSave).buttonStyle(.borderedProminent)
                .accessibilityIdentifier("settings-save")
        }
    }
}
