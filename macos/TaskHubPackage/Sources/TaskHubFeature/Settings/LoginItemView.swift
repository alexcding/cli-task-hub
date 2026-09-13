import AppKit
import SwiftUI

struct LoginItemView: View {
    let model: LoginItemViewModel
    var body: some View {
        Section("Startup") {
            Toggle("Launch at login", isOn: Binding(get: { model.registered }, set: model.setEnabled))
                .disabled(!model.canToggle).accessibilityIdentifier("settings-launch-at-login")
            Text(model.statusText).foregroundStyle(.secondary).accessibilityIdentifier("settings-login-item-status")
            if model.changing { ProgressView("Updating login item…").controlSize(.small) }
            if let reason = model.state?.registrationUnavailableReason { Text(reason).font(.caption).foregroundStyle(.secondary) }
            if model.needsApproval { Button("Open Login Items Settings", action: model.openSystemSettings) }
            if let error = model.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
        }
    }
}
