import AppKit
import GhosttyTerminal

// The package's SwiftUI state does not adopt its URL delegate. Interpose at
// its supported platform-view factory, forwarding every state/lifecycle/input
// callback the state currently adopts. The emulator and its input path stay intact.
@MainActor final class WorkspaceTerminalView: TerminalView,
    TerminalSurfaceOpenURLDelegate, TerminalSurfaceTitleDelegate,
    TerminalSurfaceGridResizeDelegate, TerminalSurfaceFocusDelegate,
    TerminalSurfaceCloseDelegate, TerminalSurfaceBellDelegate,
    TerminalSurfaceDesktopNotificationDelegate, TerminalSurfacePwdDelegate,
    TerminalSurfaceScrollbarDelegate, TerminalSurfaceCommandFinishedDelegate,
    TerminalSurfaceLifecycleDelegate, TerminalSurfaceTextSelectionRequestDelegate,
    TerminalSurfaceClipboardConfirmationDelegate {
    private weak var recipient: (any TerminalSurfaceViewDelegate)?
    var openLink: (String, String?) -> Void = { _, _ in }
    private(set) var directory: String?

    override var delegate: (any TerminalSurfaceViewDelegate)? {
        get { recipient }
        set { recipient = newValue; super.delegate = newValue == nil ? nil : self }
    }
    func terminalDidRequestOpenURL(_ url: String, kind: TerminalOpenURLKind) {
        // Returning through this delegate suppresses Ghostty's /usr/bin/open
        // fallback even when the host refuses an unsupported URI scheme.
        openLink(url, directory)
    }
    func terminalDidChangeTitle(_ title: String) { (recipient as? any TerminalSurfaceTitleDelegate)?.terminalDidChangeTitle(title) }
    func terminalDidResize(_ size: TerminalGridMetrics) { (recipient as? any TerminalSurfaceGridResizeDelegate)?.terminalDidResize(size) }
    func terminalDidChangeFocus(_ focused: Bool) { (recipient as? any TerminalSurfaceFocusDelegate)?.terminalDidChangeFocus(focused) }
    func terminalDidClose(processAlive: Bool) { (recipient as? any TerminalSurfaceCloseDelegate)?.terminalDidClose(processAlive: processAlive) }
    func terminalDidRingBell() { (recipient as? any TerminalSurfaceBellDelegate)?.terminalDidRingBell() }
    func terminalDidRequestDesktopNotification(title: String, body: String) {
        (recipient as? any TerminalSurfaceDesktopNotificationDelegate)?.terminalDidRequestDesktopNotification(title: title, body: body)
    }
    func terminalDidChangeWorkingDirectory(_ path: String) {
        if path.hasPrefix("/"), !path.contains("\0") { directory = path }
        (recipient as? any TerminalSurfacePwdDelegate)?.terminalDidChangeWorkingDirectory(path)
    }
    func terminalDidUpdateScrollbar(_ scrollbar: TerminalScrollbar) { (recipient as? any TerminalSurfaceScrollbarDelegate)?.terminalDidUpdateScrollbar(scrollbar) }
    func terminalDidFinishCommand(exitCode: Int?, durationNanos: UInt64) {
        (recipient as? any TerminalSurfaceCommandFinishedDelegate)?.terminalDidFinishCommand(exitCode: exitCode, durationNanos: durationNanos)
    }
    func terminalDidAttachSurface(_ surface: TerminalSurface) { (recipient as? any TerminalSurfaceLifecycleDelegate)?.terminalDidAttachSurface(surface) }
    func terminalDidDetachSurface() { (recipient as? any TerminalSurfaceLifecycleDelegate)?.terminalDidDetachSurface() }
    func terminalDidRequestTextSelection(_ request: TerminalTextSelectionRequest) {
        (recipient as? any TerminalSurfaceTextSelectionRequestDelegate)?.terminalDidRequestTextSelection(request)
    }
    func terminalDidRequestClipboardConfirmation(_ request: TerminalClipboardConfirmationRequest) {
        if let recipient = recipient as? any TerminalSurfaceClipboardConfirmationDelegate {
            recipient.terminalDidRequestClipboardConfirmation(request)
        } else { request.respond(allow: false) }
    }
}
