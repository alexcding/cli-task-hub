import Foundation

@MainActor protocol PageActionServing {
    func openPage(_ request: OpenPageRequest) async throws
    func openBrowser(_ url: URL) -> Bool
    func copyLink(_ value: String)
}

@MainActor struct NativePageActionService: PageActionServing {
    let open: (OpenPageRequest) async throws -> Void
    let desktop: any DesktopActions
    let copy: (String) -> Void

    func openPage(_ request: OpenPageRequest) async throws { try await open(request) }
    func openBrowser(_ url: URL) -> Bool { desktop.openBrowser(url) }
    func copyLink(_ value: String) { copy(value) }
}
