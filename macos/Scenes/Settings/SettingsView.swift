import AppKit
import SwiftUI

struct SettingsView: View {
    @Bindable var model: SettingsViewModel
    let shell: ShellStore
    let viewer: ViewerStore
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker("Settings section", selection: $model.section) {
                ForEach(SettingsSection.allCases) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented)
            switch model.section {
            case .clis: CLISettingsView(model: model.clis)
            case .diagnostics: DiagnosticsView(model: model.diagnostics)
            case .resources: ResourceUsageView(model: model.resources)
            case .general:
                Form {
                    LoginItemView(model: model.loginItem)
                    Section("Appearance") {
                        Picker("Theme", selection: Binding(get: { shell.appearance }, set: shell.setAppearance)) {
                            ForEach(AppAppearance.allCases) { Text($0.title).tag($0) }
                        }.accessibilityIdentifier("settings-theme")
                        Picker("Default session agent", selection: Binding(get: { shell.defaultAgent }, set: shell.setDefaultAgent)) {
                            ForEach(SessionAgent.allCases) { Text($0.label).tag($0) }
                        }.accessibilityIdentifier("settings-default-agent")
                    }
                    Section {
                        NotificationPreferencesView(shell: shell, sounds: model.sounds)
                        Button("Preview Sound") { shell.notifications.previewSound(shell.reviewSound) }.disabled(shell.reviewSound == "off")
                    }
                    Section("External Git client") {
                        Picker("Git client", selection: Binding(get: { shell.gitClient }, set: shell.setGitClient)) {
                            Text("None").tag("")
                            ForEach(ExternalTool.gitClients) { Text($0.name).tag($0.id) }
                            Text("Custom").tag("custom")
                            if !shell.gitClient.isEmpty && shell.gitClient != "custom" && !ExternalTool.gitClients.contains(where: { $0.id == shell.gitClient }) {
                                Text("Unavailable (\(shell.gitClient))").tag(shell.gitClient)
                            }
                        }.accessibilityIdentifier("settings-git-client")
                        if shell.gitClient == "custom" {
                            TextField("Command template", text: Binding(get: { shell.gitClientCommandDraft }, set: { shell.gitClientCommandDraft = $0 }))
                                .accessibilityIdentifier("settings-git-client-command").onSubmit(shell.saveGitClientCommand)
                            Text("Use {path} for the checkout. Quotes group arguments; shell expansion and pipelines are not supported.")
                                .font(.caption).foregroundStyle(.secondary)
                            HStack {
                                Button("Revert Command", action: shell.revertGitClientCommand).disabled(!shell.gitClientCommandDirty)
                                Button("Save Command", action: shell.saveGitClientCommand).disabled(!shell.gitClientCommandDirty)
                            }
                            if let error = shell.gitClientCommandError { Text(error).foregroundStyle(.orange) }
                        }
                    }
                    FontSettingsView(model: model.fonts, shell: shell)
                    Section("Browser memory") {
                        Stepper("Retain up to \(shell.remotePageLimit) browser pages",
                            value: Binding(get: { shell.remotePageLimit }, set: shell.setRemotePageLimit), in: RemotePageRetention.range)
                            .accessibilityIdentifier("settings-remote-page-limit")
                        Text("Loaded: \(viewer.livePageCount) · Suspended: \(viewer.suspendedPageCount)")
                            .accessibilityIdentifier("settings-remote-page-counts")
                        Text("Older background pages reload when selected; unsent web forms may be lost. macOS memory pressure also suspends background pages. Editors, terminals and the Sprint board are kept.")
                            .font(.caption).foregroundStyle(.secondary)
                        Text("This is a page-count limit, not a memory limit in MB. The web app’s separate memory budget is unchanged.")
                            .font(.caption).foregroundStyle(.secondary)
                        Button("Suspend Background Pages", action: viewer.suspendBackgroundPages).disabled(viewer.backgroundPageCount == 0)
                    }
                }.formStyle(.grouped)
                if let error = shell.settingsError { Text(error).foregroundStyle(.orange) }
            case .connections:
                Form {
                    Section("GitHub") {
                        TextField("PR polling interval (seconds)", text: $model.draft.pollInterval).accessibilityIdentifier("settings-poll-interval")
                    }
                    Section("Jira") {
                        TextField("Site URL (blank to detect)", text: $model.draft.jiraBaseURL).accessibilityIdentifier("settings-jira-site")
                        SecureField("API token", text: $model.draft.jiraAPIToken)
                        TextField("Jira polling interval (seconds)", text: $model.draft.jiraPollInterval)
                        TextField("Ticket limit", text: $model.draft.jiraLimit)
                    }
                }.formStyle(.grouped).disabled(!model.loaded || model.saving)
                if let message = model.draft.validationError { Text(message).foregroundStyle(.orange) }
                HStack {
                    Button("Revert Settings", action: model.revert).disabled(!model.dirty || model.saving)
                    Spacer()
                    if model.saved && !model.dirty { Text("Settings saved").foregroundStyle(.secondary) }
                    if model.saving { ProgressView().controlSize(.small) }
                    Button("Save Settings") { Task { await model.save() } }.disabled(!model.canSave).buttonStyle(.borderedProminent)
                }
            }
            if let error = model.error {
                Text(error).foregroundStyle(.orange).textSelection(.enabled)
                Button("Retry Settings", action: model.refresh)
            }
            if model.loading && !model.loaded { ProgressView("Loading settings…") }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in model.applicationActiveChanged(true) }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in model.applicationActiveChanged(false) }
    }
}
