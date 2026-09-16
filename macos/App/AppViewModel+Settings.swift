import AppKit
import Foundation

extension AppViewModel: SettingsCoordinating {
    func activateSettings() {
        // Reached from AppViewModel.init() via installSettings, which runs before NSApplication
        // finishes wiring NSApp — an implicitly-unwrapped nil there traps on launch.
        settings?.applicationActiveChanged(NSApp?.isActive ?? false)
        shell.loadSettings(); shell.notifications.refreshAuthorization()
    }
    func applySettingsSave(_ patch: [String: String]) async {
        if patch["jira_base_url"] != nil || patch["jira_api_token"] != nil {
            for model in projectModels.values { await model.tickets?.invalidateSite() }
        }
    }
}
