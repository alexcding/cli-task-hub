import Foundation
import Observation
import Testing
@testable import TaskHubFeature

@MainActor @Observable private final class TrayRuntimeFixture: TrayCoordinating {
    var state = TrayState(connection: "Connected", canNavigate: true)
    var refreshes = 0
    var acknowledged: [TrayPR] = []
    var selected: [SidebarDestination] = []
    func trayState() -> TrayState { state }
    func refreshTray() { refreshes += 1 }
    func acknowledgeTrayReview(_ review: TrayPR) {
        acknowledged.append(review)
        state.acknowledging.insert(review.id)
    }
    func selectTrayDestination(_ destination: SidebarDestination) { selected.append(destination) }
}

@MainActor private final class TrayFactoryFixture: TrayFeatureFactory {
    var models: [TrayViewModel] = []
    func tray(service: any TrayServing, shell: ShellStore) -> TrayViewModel {
        let model = TrayViewModel(service: service, shell: shell)
        models.append(model); return model
    }
}

@MainActor private final class TrayWindowFixture {
    var events: [String] = []
    var presentation: TrayPresentation {
        .init(openWindow: { self.events.append("window") }, dismiss: { self.events.append("dismiss") })
    }
}

@MainActor private func trayShell() -> ShellStore {
    ShellStore(preferences: UserDefaults(suiteName: "tray-model-\(UUID().uuidString)")!)
}

private func trayReview(_ number: Int, url: String? = nil, category: String = "review") -> TrayPR {
    TrayPR(url: url ?? "https://example.test/pr/\(number)", repo: "fixture/repo", number: number,
           title: "Review \(number)", state: "OPEN", category: category, awaitingMyReview: true,
           reviewPending: true, projectName: nil, ci: nil)
}

@MainActor @Test func trayCoordinatorOwnsActivationAndWindowAndRejectsHiddenOrUnownedActions() {
    let runtime = TrayRuntimeFixture(), window = TrayWindowFixture()
    let model = TrayViewModel(service: runtime, shell: trayShell())
    let coordinator = TrayCoordinator(model: model, runtime: runtime, desktop: ProjectPageActions(), presentation: window.presentation)
    model.refresh(); model.openWindow()
    #expect(runtime.refreshes == 0 && window.events.isEmpty)
    coordinator.setActive(true); coordinator.setActive(true)
    #expect(runtime.refreshes == 1 && model.active)
    model.refresh(); #expect(runtime.refreshes == 2)
    coordinator.isOwned = { false }
    model.openWindow(); model.refresh()
    #expect(runtime.refreshes == 2 && window.events.isEmpty)
    coordinator.isOwned = { true }
    model.openWindow(); model.openWindow()
    #expect(window.events == ["window"] && !model.active)
    coordinator.setActive(true); coordinator.setActive(false); model.openWindow()
    #expect(window.events == ["window"])
}

@MainActor @Test func trayReviewsUseCurrentPendingRowsAndAcknowledgeOnlySuccessfulBrowserOpens() {
    let runtime = TrayRuntimeFixture(), window = TrayWindowFixture(), desktop = ProjectPageActions()
    let first = trayReview(1), reviewed = trayReview(2, category: "other")
    runtime.state.reviews = [first, reviewed]
    runtime.state.tabs = [SavedTab(kind: "github", title: reviewed.title, url: reviewed.url, category: "other")]
    let model = TrayViewModel(service: runtime, shell: trayShell())
    let coordinator = TrayCoordinator(model: model, runtime: runtime, desktop: desktop, presentation: window.presentation)
    coordinator.setActive(true)
    #expect(model.pendingReviews.map(\.number) == [1])
    #expect(model.tabGroups.first?.title == "Review") // Broader review orbit is preserved for tabs.
    model.openReview(reviewed); model.openReview(trayReview(99))
    #expect(desktop.browsers.isEmpty && runtime.acknowledged.isEmpty)
    desktop.browserSucceeds = false; model.openReview(first)
    #expect(runtime.acknowledged.isEmpty && window.events.isEmpty && model.active)
    #expect(model.actionError == "macOS could not open the browser.")
    model.refresh(); #expect(model.actionError != nil)
    let current = trayReview(1, url: "https://example.test/pr/current")
    runtime.state.reviews[0] = current
    desktop.browserSucceeds = true
    model.openReview(first) // Re-resolve an old row through its identity.
    #expect(desktop.browsers.last?.absoluteString == current.url)
    #expect(runtime.acknowledged == [current] && window.events == ["dismiss"] && !model.active && model.actionError == nil)
    coordinator.setActive(true); model.openReview(first)
    #expect(desktop.browsers.count == 2 && runtime.acknowledged.count == 1)
    runtime.state.acknowledging = []; runtime.state.reviews = [trayReview(1, url: "file:///tmp/private")]
    model.openReview(first)
    #expect(desktop.browsers.count == 2)
    runtime.state.reviews = []; model.openReview(first)
    #expect(desktop.browsers.count == 2)
}

@MainActor @Test func trayTabSelectionUsesCurrentInventoryAndPreservesCompetingPresentations() {
    let runtime = TrayRuntimeFixture(), window = TrayWindowFixture()
    let tab = SavedTab(kind: "web", title: "Context", url: "https://example.test/context")
    runtime.state.tabs = [tab]
    let model = TrayViewModel(service: runtime, shell: trayShell())
    let coordinator = TrayCoordinator(model: model, runtime: runtime, desktop: ProjectPageActions(), presentation: window.presentation)
    coordinator.setActive(true); model.openTab(tab)
    #expect(runtime.selected == [.tab(tab.url)] && window.events == ["window"] && !model.active)
    runtime.state.sessions = [.init(id: "prepared", projectId: "p", workspace: "/tmp", worktree: "/tmp/prepared",
        title: "Prepared", branch: "prepared", url: tab.url, createdAt: nil, pinned: false)]
    coordinator.setActive(true); runtime.state.canNavigate = false; model.openTab(tab)
    #expect(runtime.selected.count == 1 && window.events.count == 1 && model.active)
    runtime.state.canNavigate = true; model.openTab(tab)
    #expect(runtime.selected.last == .session("prepared") && window.events.count == 2)
    coordinator.setActive(true); runtime.state.tabs = []; model.openTab(tab)
    #expect(runtime.selected.count == 2 && model.active)
    let invalid = SavedTab(kind: "web", title: "Invalid", url: "file:///tmp/private")
    runtime.state.tabs = [invalid]; model.openTab(invalid)
    #expect(runtime.selected.count == 2 && window.events.count == 2)
}

@MainActor @Test func trayFactoryReplacementRetiresCallbacksAndDoesNotRetainRuntimeOrRoot() {
    let factory = TrayFactoryFixture(), desktop = ProjectPageActions(), window = TrayWindowFixture(), shell = trayShell()
    var runtime: TrayRuntimeFixture? = TrayRuntimeFixture()
    weak var retainedRuntime = runtime
    var root: AppCoordinator? = AppCoordinator(factory: NativeCreationFlowFactory(chooseFolder: { nil }))
    weak var retainedRoot = root
    let old = root!.makeTray(factory: factory, runtime: runtime!, shell: shell, desktop: desktop, presentation: window.presentation)
    old.setActive(true)
    let stale = old.model.onAction
    let fresh = root!.makeTray(factory: factory, runtime: runtime!, shell: shell, desktop: desktop, presentation: window.presentation)
    #expect(factory.models.count == 2 && fresh.model.shell === shell && old.retired && old.model.retired)
    old.setActive(true); old.model.refresh(); stale(.openWindow)
    #expect(runtime?.refreshes == 1 && window.events.isEmpty && !old.model.active)
    fresh.setActive(true)
    #expect(runtime?.refreshes == 2)
    runtime = nil
    #expect(retainedRuntime == nil && !fresh.model.available)
    fresh.model.openWindow()
    #expect(window.events.isEmpty)
    root = nil
    #expect(retainedRoot == nil)
    fresh.handle(.openWindow)
    #expect(window.events.isEmpty)
}
