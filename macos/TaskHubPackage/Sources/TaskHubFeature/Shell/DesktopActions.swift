import AppKit

@MainActor protocol DesktopActions {
    @discardableResult func openBrowser(_ url: URL) -> Bool
    func reveal(_ url: URL)
}

@MainActor struct NativeDesktopActions: DesktopActions {
    func openBrowser(_ url: URL) -> Bool { NSWorkspace.shared.open(url) }
    func reveal(_ url: URL) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
}
