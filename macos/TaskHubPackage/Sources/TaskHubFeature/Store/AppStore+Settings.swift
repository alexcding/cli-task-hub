import Foundation

extension AppStore: SettingsCoordinating {
    func applySettingsSave(_ patch: [String: String]) async {
        if patch["jira_base_url"] != nil || patch["jira_api_token"] != nil {
            for model in projectModels.values { await model.tickets?.invalidateSite() }
        }
    }
}
