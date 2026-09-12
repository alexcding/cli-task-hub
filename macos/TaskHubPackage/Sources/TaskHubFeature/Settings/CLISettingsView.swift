import SwiftUI

struct CLISettingsView: View {
    let model: CLISettingsViewModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Command-line tools").font(.headline)
                Spacer()
                if model.probing { ProgressView().controlSize(.small) }
                Button("Check CLIs", action: model.refresh).disabled(model.probing)
            }
            Text("TaskHub uses your installed tools and their existing sign-in sessions.").foregroundStyle(.secondary)
            ForEach(ManagedCLI.allCases) { cli in
                HStack {
                    Text(cli.title).fontWeight(.medium).frame(width: 140, alignment: .leading)
                    Text(model.label(cli)).foregroundStyle(.secondary).accessibilityIdentifier("cli-status-\(cli.rawValue)")
                    Spacer()
                    if model.availability[cli.rawValue]?.present == false {
                        Button("Installation Guide") { model.openGuide(cli) }
                    }
                    if cli.loginCommand != nil {
                        Button("Copy Login Command") { model.copyLogin(cli) }.help(cli.loginCommand ?? "")
                    }
                }.padding(.vertical, 6)
            }
            if let error = model.probeError { Text(error).foregroundStyle(.orange) }
            Divider().padding(.vertical, 8)
            Text("Agent hooks").font(.headline)
            Text("Hooks report when an agent starts and finishes a turn. TaskHub merges its entries into the agent's configuration and removes only its own entries.")
                .foregroundStyle(.secondary)
            ForEach(ManagedCLI.allCases.filter(\.supportsHooks)) { cli in
                HStack {
                    Text(cli.title).fontWeight(.medium).frame(width: 140, alignment: .leading)
                    Text(model.hookLabel(cli)).foregroundStyle(.secondary).accessibilityIdentifier("hook-status-\(cli.rawValue)")
                    Spacer()
                    if model.changing == cli { ProgressView().controlSize(.small) }
                    Button(model.hooks[cli.rawValue] == "installed" ? "Remove Hooks" : "Install Hooks") {
                        Task { await model.toggleHook(cli) }
                    }.disabled(!model.canChange(cli)).accessibilityIdentifier("hook-toggle-\(cli.rawValue)")
                }.padding(.vertical, 6)
            }
            if let error = model.hookError { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
            if let message = model.message { Text(message).foregroundStyle(.secondary) }
            Spacer(minLength: 0)
        }.onAppear { model.refresh() }
    }
}
