import Foundation
import Observation
import Testing
@testable import TaskHubFeature

@MainActor private final class RecordingDesktop: DesktopActions {
    var opens: [URL] = []
    var reveals: [URL] = []
    var succeeds = true
    func openBrowser(_ url: URL) -> Bool { opens.append(url); return succeeds }
    func reveal(_ url: URL) { reveals.append(url) }
}

@MainActor @Observable private final class ControlledBrowser: BrowserControlling {
    var url = "https://example.test/original"
    var loading = false
    var canGoBack = false
    var canGoForward = false
    var error: String?
    var found: Bool?
    var navigations: [String] = []
    var actions: [String] = []
    func navigate(_ address: String) { navigations.append(address) }
    func back() { actions.append("back") }
    func forward() { actions.append("forward") }
    func reload() { actions.append("reload") }
    func stop() { actions.append("stop") }
    func zoom(_ delta: Double?) { actions.append("zoom:\(delta.map { String($0) } ?? "reset")") }
    func find(_ text: String, backwards: Bool) { actions.append("find:\(backwards):\(text)") }
}

@MainActor @Test func browserControlsPreserveAddressEditsValidateNavigationAndOpenCommittedURL() {
    let page = ControlledBrowser(), desktop = RecordingDesktop()
    let model = BrowserControlsViewModel(page: page)
    let coordinator = BrowserControlsCoordinator(desktop: desktop)
    defer { withExtendedLifetime(coordinator) {} }
    coordinator.bind(model, page: page, isOwned: { true })
    model.active = true
    model.setEditingAddress(true)
    model.address = "  https://example.test/draft  "
    page.url = "https://example.test/redirect"
    model.synchronizeAddress()
    #expect(model.address == "  https://example.test/draft  ")
    model.openExternally()
    #expect(desktop.opens.map(\.absoluteString) == [page.url])
    for invalid in ["file:///tmp/private", "javascript:alert(1)", "https://user:password@example.test", "not a URL"] {
        model.address = invalid
        #expect(!model.submitAddress() && model.error == "Enter an HTTP or HTTPS address.")
        #expect(model.address == invalid && page.navigations.isEmpty)
    }
    model.address = "  https://example.test/accepted\n"
    model.retry()
    #expect(page.navigations == ["https://example.test/accepted"] && model.error == nil)
    #expect(model.address == "https://example.test/accepted")
    model.setEditingAddress(false)
    #expect(model.address == page.url)
    desktop.succeeds = false
    model.openExternally()
    #expect(model.error == "Could not open this page in the default browser.")
    desktop.succeeds = true
    model.retry()
    #expect(model.error == nil && desktop.opens.count == 3 && page.actions.isEmpty)
    page.url = "about:blank"
    #expect(!model.canOpenExternally)
    model.openExternally()
    #expect(desktop.opens.count == 3)
}

@MainActor @Test func browserControlsForwardLoadingFindAndNavigationWithoutRetainingClosedPage() {
    var page: ControlledBrowser? = ControlledBrowser()
    weak var released = page
    let model = BrowserControlsViewModel(page: page!)
    let coordinator = BrowserControlsCoordinator(desktop: RecordingDesktop())
    defer { withExtendedLifetime(coordinator) {} }
    coordinator.bind(model, page: page!, isOwned: { true })
    model.active = true
    page?.loading = true
    model.toggleLoading()
    page?.loading = false
    model.toggleLoading()
    model.back(); model.forward(); model.zoom(0.1); model.zoom(nil)
    model.find("quokka"); model.find("quokka", backwards: true)
    page?.error = "Network unavailable"
    #expect(model.error == "Network unavailable")
    model.retry()
    #expect(page?.actions == ["stop", "reload", "back", "forward", "zoom:0.1", "zoom:reset", "find:false:quokka", "find:true:quokka", "reload"])
    page?.canGoBack = true; page?.canGoForward = true; page?.found = false
    #expect(model.canGoBack && model.canGoForward && model.found == false)
    page = nil
    #expect(released == nil && !model.canGoBack && !model.canOpenExternally)
    #expect(!model.submitAddress())
    model.toggleLoading(); model.openExternally() // A retained UI action cannot revive the page.
}

@MainActor @Test func browserFactoryKeepsDesktopInjectionAcrossNewAndRestoredContexts() throws {
    let desktop = RecordingDesktop(), factory = BrowserPageFactory(desktop: desktop)
    var context: WorkspaceContext? = WorkspaceContext(id: "context", sourceURL: "https://example.test/root", title: "Root", pageFactory: factory)
    var page = try #require(context?.activePage)
    let controls = page.controls
    #expect(page.controls === controls)
    controls.active = true
    controls.openExternally()
    _ = context?.open("https://example.test/second")
    context?.activePage?.controls.active = true
    context?.activePage?.controls.openExternally()
    let snapshot = try #require(context?.snapshot)
    context?.apply(snapshot)
    controls.openExternally(); controls.reload()
    #expect(desktop.opens.count == 2 && page.webView == nil, "Retained controls cannot revive a replaced page")
    context?.activePage?.controls.active = true
    context?.activePage?.controls.openExternally()
    let restored = WorkspaceContext(id: "restored", sourceURL: "", title: "", snapshot: snapshot, pageFactory: factory)
    restored.activePage?.controls.active = true
    restored.activePage?.controls.openExternally()
    #expect(desktop.opens.map(\.absoluteString) == ["https://example.test/root", "https://example.test/second", "https://example.test/second", "https://example.test/second"])
    #expect(restored.pages.allSatisfy { $0.webView == nil })
    // Controls survive eviction but do not retain a page removed from its context.
    weak var removed = page
    page = try #require(restored.activePage)
    context = nil
    #expect(removed == nil && !controls.canOpenExternally)
}

@MainActor @Test func browserControlsCoordinatorRejectsHiddenRemovedReboundAndOrphanedActions() {
    let page = ControlledBrowser(), desktop = RecordingDesktop()
    let model = BrowserControlsViewModel(page: page)
    var owned = true, allowed = true
    let coordinator = BrowserControlsCoordinator(desktop: desktop, canPerform: { allowed })
    defer { withExtendedLifetime(coordinator) {} }
    coordinator.bind(model, page: page, isOwned: { owned })
    model.onAction?(.openExternally)
    #expect(desktop.opens.isEmpty)
    model.active = true
    model.openExternally()
    #expect(desktop.opens.count == 1)
    allowed = false
    model.openExternally(); model.reload()
    #expect(desktop.opens.count == 1 && page.actions.isEmpty)
    allowed = true; owned = false
    model.openExternally(); model.onAction?(.navigate(URL(string: "https://example.test/removed")!))
    #expect(desktop.opens.count == 1 && page.navigations.isEmpty)
    owned = true
    let oldAction = model.onAction
    let replacementDesktop = RecordingDesktop()
    var replacement: BrowserControlsCoordinator? = BrowserControlsCoordinator(desktop: replacementDesktop)
    replacement?.bind(model, page: page, isOwned: { owned })
    oldAction?(.openExternally)
    model.openExternally()
    #expect(desktop.opens.count == 1 && replacementDesktop.opens.count == 1)
    model.onAction?(.navigate(URL(fileURLWithPath: "/tmp/private")))
    #expect(page.navigations.isEmpty)
    model.setEditingAddress(true); model.address = "https://example.test/draft"
    model.active = false
    #expect(!model.editingAddress && model.address == page.url && !model.canOpenExternally)
    model.onAction?(.reload)
    #expect(page.actions.isEmpty)
    model.active = true; replacement = nil
    model.openExternally()
    #expect(replacementDesktop.opens.count == 1)
}
