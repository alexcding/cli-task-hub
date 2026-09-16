import AppKit
import SwiftUI

/// Mirrors the web Settings page (`src/renderer/index.html` → `#page-settings`): the same four
/// tabs, in the same order, with one card per web `.card` and one `SettingsRow` per `.theme-row`.
struct SettingsView: View {
    @Bindable var model: SettingsViewModel
    let shell: ShellStore
    let viewer: ViewerStore

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
            case .appearance: appearance
            case .clis: clis
            case .jira: jira
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

    // MARK: - Appearance

    @ViewBuilder private var appearance: some View {
            Section("Theme") {
                SettingsRow(title: "Appearance", caption: "Use light, dark, or match your system") {
                    Picker("Theme", selection: Binding(get: { shell.appearance }, set: shell.setAppearance)) {
                        ForEach(AppAppearance.allCases) { Text($0.title).tag($0) }
                    }.labelsHidden().accessibilityIdentifier("settings-theme")
                }
            }
            FontSettingsView(model: model.fonts, shell: shell)
            NotificationPreferencesView(shell: shell, sounds: model.sounds)
            Section("Git client") {
                SettingsRow(title: "Open in git client",
                            caption: "Adds a button beside the worktree to open the branch in your git app") {
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
        if let error = shell.settingsError {
            Section { Text(error).foregroundStyle(Theme.danger) }
        }
    }

    // MARK: - CLIs

    @ViewBuilder private var clis: some View {
            CLIIntegrationSection(model: model.clis)
            Section("Default agent") {
                SettingsRow(title: "New session agent",
                            caption: "What a project's ＋ dialog starts a new session with") {
                    Picker("Default session agent", selection: Binding(get: { shell.defaultAgent }, set: shell.setDefaultAgent)) {
                        ForEach(SessionAgent.allCases) { Text($0.label).tag($0) }
                    }.labelsHidden().accessibilityIdentifier("settings-default-agent")
                }
            }
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
                saveRow
            }.disabled(!model.loaded || model.saving)
    }

    // MARK: - Jira

    @ViewBuilder private var jira: some View {
            Section("JIRA Tickets") {
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
            LoginItemView(model: model.loginItem)
            Section("Memory") {
                SettingsRow(title: "Pages kept in memory",
                            caption: "Older background pages reload when selected; unsent web forms may be lost. macOS memory pressure also suspends background pages. Editors, terminals and the Sprint board are kept.") {
                    Stepper("\(shell.remotePageLimit)",
                            value: Binding(get: { shell.remotePageLimit }, set: shell.setRemotePageLimit),
                            in: RemotePageRetention.range)
                        .accessibilityIdentifier("settings-remote-page-limit")
                }
                Text("Loaded: \(viewer.livePageCount) · Suspended: \(viewer.suspendedPageCount)")
                    .accessibilityIdentifier("settings-remote-page-counts")
                Text("This is a page-count limit, not a memory budget in MB. The web app's GB budget is a separate setting.")
                    .font(.caption).foregroundStyle(Theme.textSecondary)
                HStack {
                    Spacer()
                    Button("Suspend Background Pages", action: viewer.suspendBackgroundPages)
                        .disabled(viewer.backgroundPageCount == 0)
                }
            }
            ResourceUsageView(model: model.resources)
            DiagnosticsView(model: model.diagnostics)
    }

    // MARK: - Shared save row

    /// CLIs → Polling and Jira both edit one `AppConfigDraft` and share one Save, exactly as the
    /// web tabs share `saveConfig()`: a save from either tab sends every changed key.
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
