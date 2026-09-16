import AppKit
import SwiftUI

struct LoginItemView: View {
    let model: LoginItemViewModel
    var body: some View {
        Section("Startup") {
            Toggle("Launch at login", isOn: Binding(get: { model.registered }, set: model.setEnabled))
                .disabled(!model.canToggle).accessibilityIdentifier("settings-launch-at-login")
            Text(model.statusText).foregroundStyle(Theme.textSecondary).accessibilityIdentifier("settings-login-item-status")
            if model.changing { ProgressView("Updating login item…").controlSize(.small) }
            if let reason = model.state?.registrationUnavailableReason { Text(reason).font(.caption).foregroundStyle(Theme.textSecondary) }
            if model.needsApproval {
                Button("Open Login Items Settings", action: model.openSystemSettings).disabled(!model.canOpenSystemSettings)
            }
            if let error = model.error { Text(error).foregroundStyle(Theme.danger).textSelection(.enabled) }
        }
    }
}
