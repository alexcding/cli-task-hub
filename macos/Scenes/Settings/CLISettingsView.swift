import SwiftUI

/// The web CLIs tab's "CLI integration" card. A Section for a grouped Form; the caller owns the
/// Form so every settings tab shares one card style. Kept separate from the hooks card because the
/// web tab puts "Default agent" between the two.
struct CLIIntegrationSection: View {
    let model: CLISettingsViewModel
    var body: some View {
        Section {
            Text("TaskHub uses your installed tools and their existing sign-in sessions.")
                .font(.caption).foregroundStyle(Theme.textSecondary)
            ForEach(ManagedCLI.allCases) { cli in
                SettingsStatusRow(title: cli.title, status: model.label(cli), tone: tone(cli),
                                  statusIdentifier: "cli-status-\(cli.rawValue)") {
                    if model.availability[cli.rawValue]?.present == false {
                        Button("Install") { model.openGuide(cli) }
                    }
                    if cli.loginCommand != nil {
                        Button("Copy Login Command") { model.copyLogin(cli) }.help(cli.loginCommand ?? "")
                    }
                }
            }
            if let error = model.probeError { Text(error).foregroundStyle(Theme.danger) }
            if let error = model.actionError { Text(error).foregroundStyle(Theme.danger) }
        } header: {
            SettingsSectionHeader(title: "CLI integration", busy: model.probing) {
                Button("Refresh", action: model.refresh).disabled(model.probing)
                    .accessibilityIdentifier("cli-refresh")
            }
        }
    }


    /// Mirrors `CLIAvailability.label(for:)`. `authed` is only probed for CLIs that have a
    /// sign-in check (gh/acli), so nil means "not applicable" or "couldn't tell" — a warning tint
    /// there would contradict the "Installed" label sitting next to it.
    private func tone(_ cli: ManagedCLI) -> ThemeTone {
        guard let state = model.availability[cli.rawValue], state.present else { return .neutral }
        switch state.authed {
        case true: return .success
        case false: return .warning
        default: return cli.supportsHooks ? .success : .neutral
        }
    }
}

/// The web CLIs tab's "Workflow hooks" card.
struct WorkflowHooksSection: View {
    let model: CLISettingsViewModel
    var body: some View {
        Section("Workflow hooks") {
            Text("Hooks report when an agent starts and finishes a turn. TaskHub merges its entries into the agent's configuration and removes only its own entries.")
                .font(.caption).foregroundStyle(Theme.textSecondary)
            ForEach(ManagedCLI.allCases.filter(\.supportsHooks)) { cli in
                SettingsStatusRow(title: cli.title, status: model.hookLabel(cli),
                                  tone: model.hooks[cli.rawValue] == "installed" ? .success : .neutral,
                                  statusIdentifier: "hook-status-\(cli.rawValue)", busy: model.changing == cli) {
                    Button(model.hooks[cli.rawValue] == "installed" ? "Remove hook" : "Install hook") {
                        model.requestToggleHook(cli)
                    }.disabled(!model.canChange(cli)).accessibilityIdentifier("hook-toggle-\(cli.rawValue)")
                }
            }
            if let error = model.hookError { Text(error).foregroundStyle(Theme.danger).textSelection(.enabled) }
            if let message = model.message { Text(message).foregroundStyle(Theme.textSecondary) }
        }
    }
}
