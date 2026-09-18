import AppKit
import Foundation
import WebKit

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
    func clearBrowsingData(_ scope: BrowsingDataScope) async {
        switch scope {
        case .history:
            viewer.clearBrowsingHistory()
        case .websiteData:
            // Every embedded page shares WebKit's default store, so one sweep covers them all.
            await WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
            viewer.reloadLivePages()
        }
    }
}
