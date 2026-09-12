import Foundation
import Testing
@testable import TaskHubFeature

private actor DashboardFixture: DashboardService {
    var failing = false
    var reads = 0
    func setFailure() { failing = true }
    func snapshot() async throws -> [DashboardProject] {
        reads += 1
        if failing { throw BackendError.operation("Fixture offline") }
        return try JSONDecoder().decode([DashboardProject].self, from: Data(#"""
        [{"id":"p","name":"Native","repo":"o/r","lastSynced":"2026-09-12T12:00:00Z","prs":[
          {"number":1,"title":"My draft","url":"https://github.com/o/r/pull/1","state":"OPEN","category":"mine","isDraft":true,"ci":{"status":"queued","conclusion":"failure"}},
          {"number":2,"title":"Reviewed already","url":"https://github.com/o/r/pull/2","state":"OPEN","category":"other","awaitingMyReview":true,"reviewDecision":"APPROVED","ci":{"status":"completed","conclusion":"failure"}},
          {"number":3,"title":"Not in orbit","url":"https://github.com/o/r/pull/3","state":"OPEN","category":"review","awaitingMyReview":false},
          {"number":4,"title":"Legacy requested","url":"https://github.com/o/r/pull/4","state":"OPEN","category":"review"},
          {"number":5,"title":"Closed","url":"https://github.com/o/r/pull/5","state":"CLOSED","category":"mine"},
          {"number":6,"title":"Unsafe","url":"file:///tmp/local","state":"OPEN","category":"mine"},
          {"repo":"o/broken","error":"Sync unavailable"}
        ]}]
        """#.utf8))
    }
}

@MainActor @Test func dashboardGroupsReviewOrbitFiltersAndRetainsSnapshotOnFailure() async throws {
    let service = DashboardFixture()
    var opened: OpenPageRequest?
    var copied = ""
    let model = DashboardViewModel(openPage: { opened = $0 }, openBrowser: { _ in false }, copy: { copied = $0 })
    model.connect(service)
    while model.loading { try await Task.sleep(for: .milliseconds(10)) }
    #expect(model.mine.map(\.pr.number) == [1])
    #expect(model.reviews.map(\.pr.number) == [2, 4])
    #expect(model.mine[0].ciLabel == "CI running")
    #expect(model.reviews[0].reviewLabel == "Approved")
    #expect(model.warnings == ["Native: Sync unavailable"])
    model.filter = .failing
    #expect(model.visibleRows.map(\.pr.number) == [2])
    model.filter = .drafts
    #expect(model.visibleRows.map(\.pr.number) == [1])
    model.filter = .all; model.search = "reviewed"
    let row = try #require(model.visibleRows.first)
    await model.open(row)
    #expect(opened?.category == "review" && opened?.url == row.url.absoluteString)
    model.copyLink(row)
    #expect(copied == row.url.absoluteString)
    model.openExternally(row)
    #expect(model.error != nil)
    await service.setFailure()
    model.refresh()
    while model.loading { try await Task.sleep(for: .milliseconds(10)) }
    #expect(model.visibleRows == [row])
    #expect(model.updated != nil && model.error == "Fixture offline")
    await model.stop()
}

@MainActor @Test func dashboardOpenFailurePreservesNavigationAndAllowsRetry() async throws {
    let service = DashboardFixture()
    var fail = true
    var opened = 0
    let model = DashboardViewModel(openPage: { _ in
        if fail { throw BackendError.operation("No backend") }
        opened += 1
    }, openBrowser: { _ in true }, copy: { _ in })
    model.connect(service)
    while model.loading { try await Task.sleep(for: .milliseconds(10)) }
    let row = try #require(model.mine.first)
    await model.open(row)
    #expect(opened == 0 && model.error?.contains("No backend") == true && model.opening.isEmpty)
    fail = false
    await model.open(row)
    #expect(opened == 1 && model.error == nil)
    await model.stop()
}
