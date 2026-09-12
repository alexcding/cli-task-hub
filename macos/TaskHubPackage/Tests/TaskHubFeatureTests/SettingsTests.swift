import Foundation
import Testing
@testable import TaskHubFeature

private actor SettingsFixture: SettingsService {
    var values = ["poll_interval": "60", "jira_base_url": "https://jira.test", "unrelated": "keep"]
    var writes: [[String: String]] = []
    var fails = false
    func fail(_ value: Bool) { fails = value }
    func config() async throws -> [String: String] {
        let result = values
        try await Task.sleep(for: .milliseconds(40))
        if fails { throw BackendError.operation("Settings offline") }
        return result
    }
    func save(_ patch: [String: String]) async throws {
        try await Task.sleep(for: .milliseconds(40))
        if fails { throw BackendError.operation("Save failed") }
        writes.append(patch); values.merge(patch, uniquingKeysWith: { _, new in new })
    }
    func sounds() -> [ReviewSound] { [ReviewSound(name: "Glass", path: "/System/Library/Sounds/Glass.aiff")] }
}

@MainActor @Test(.timeLimit(.minutes(1))) func settingsPreserveDraftsSaveOnlyChangedFieldsAndRecoverAfterFailure() async throws {
    let service = SettingsFixture()
    var callbacks: [[String: String]] = []
    let model = SettingsViewModel(didSave: { callbacks.append($0) })
    model.connect(service); model.refresh()
    while model.loading { try await Task.sleep(for: .milliseconds(10)) }
    #expect(model.loaded && model.draft.jiraBaseURL == "https://jira.test")
    model.draft.pollInterval = "90"
    model.refresh()
    while model.loading { try await Task.sleep(for: .milliseconds(10)) }
    #expect(model.draft.pollInterval == "90" && model.dirty)
    await service.fail(true)
    await model.save()
    #expect(model.error == "Save failed" && model.dirty && callbacks.isEmpty)
    await service.fail(false)
    let save = Task { await model.save() }
    try await Task.sleep(for: .milliseconds(10))
    model.draft.pollInterval = "120"
    await save.value
    #expect(await service.writes == [["poll_interval": "90"]])
    #expect(callbacks == [["poll_interval": "90"]] && model.draft.pollInterval == "120" && model.dirty)
    await model.stop(); model.connect(service)
    await model.save()
    #expect(!model.dirty)
    #expect(await service.values["unrelated"] == "keep")
    model.draft.jiraAPIToken = "unsaved token"
    model.revert()
    #expect(model.draft.jiraAPIToken.isEmpty && !model.dirty)
    await model.stop()
}

@Test func settingsValidateIntervalsAndSiteWithoutAddingUnrelatedConfigKeys() {
    var draft = AppConfigDraft(["unrelated": "keep"])
    draft.pollInterval = "0"
    #expect(draft.validationError != nil)
    draft.pollInterval = "90"; draft.jiraPollInterval = "not a number"
    #expect(draft.validationError != nil)
    draft.jiraPollInterval = "120"; draft.jiraLimit = "0"
    #expect(draft.validationError != nil)
    draft.jiraLimit = "100"
    for raw in ["file:///tmp", "https://user:secret@jira.test", "https://jira.test/?secret=1"] {
        draft.jiraBaseURL = raw; #expect(draft.validationError != nil)
    }
    draft.jiraBaseURL = "https://jira.test/jira"
    #expect(draft.validationError == nil && draft.values["unrelated"] == nil)
}
