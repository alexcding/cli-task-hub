import AppKit

public enum ShellCommand: String, Sendable {
    case overview, terminal, sidebar, refresh, tray, hide, biggerFont, smallerFont, resetFont
}

// Editing commands use AppKit's responder chain, so the focused terminal,
// text field, or WebKit document owns copy/paste/undo rather than a global handler.
@MainActor public final class NativeMenus: NSObject, NSMenuItemValidation {
    private let perform: (ShellCommand) -> Void
    private let enabled: (ShellCommand) -> Bool

    public init(perform: @escaping (ShellCommand) -> Void, enabled: @escaping (ShellCommand) -> Bool) {
        self.perform = perform; self.enabled = enabled
    }

    public func install() {
        let main = NSMenu()
        func menu(_ title: String) -> NSMenu {
            let result = NSMenu(title: title)
            let item = main.addItem(withTitle: title, action: nil, keyEquivalent: "")
            item.submenu = result
            return result
        }
        func action(_ menu: NSMenu, _ title: String, _ selector: Selector, _ key: String = "",
                    _ modifiers: NSEvent.ModifierFlags = [.command]) {
            let item = menu.addItem(withTitle: title, action: selector, keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers
        }
        func command(_ menu: NSMenu, _ title: String, _ value: ShellCommand, _ key: String = "",
                     _ modifiers: NSEvent.ModifierFlags = [.command]) {
            let item = menu.addItem(withTitle: title, action: #selector(dispatch(_:)), keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers
            item.representedObject = value.rawValue
            item.target = self
        }
        let app = menu("TaskHub")
        action(app, "About TaskHub", #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
        app.addItem(.separator())
        command(app, "Appearance & Notifications…", .tray, ",")
        app.addItem(.separator())
        let services = app.addItem(withTitle: "Services", action: nil, keyEquivalent: "")
        services.submenu = NSMenu(title: "Services")
        NSApp.servicesMenu = services.submenu
        app.addItem(.separator())
        action(app, "Hide TaskHub", #selector(NSApplication.hide(_:)), "h")
        action(app, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
        action(app, "Show All", #selector(NSApplication.unhideAllApplications(_:)))
        app.addItem(.separator())
        command(app, "Hide Window (Keep Running)", .hide, "q")
        let file = menu("File")
        command(file, "Open Terminal", .terminal, "n", [.command, .shift])
        action(file, "Close Window", #selector(NSWindow.performClose(_:)), "w")
        let edit = menu("Edit")
        action(edit, "Undo", Selector(("undo:")), "z")
        action(edit, "Redo", Selector(("redo:")), "z", [.command, .shift])
        edit.addItem(.separator())
        action(edit, "Cut", #selector(NSText.cut(_:)), "x")
        action(edit, "Copy", #selector(NSText.copy(_:)), "c")
        action(edit, "Paste", #selector(NSText.paste(_:)), "v")
        action(edit, "Select All", #selector(NSText.selectAll(_:)), "a")
        let view = menu("View")
        command(view, "Refresh", .refresh, "r")
        command(view, "Reviews & Usage", .tray, "u", [.command, .shift])
        view.addItem(.separator())
        action(view, "Show / Hide Sidebar", #selector(NSSplitViewController.toggleSidebar(_:)), "s", [.command, .option])
        view.addItem(.separator())
        command(view, "Bigger Terminal Font", .biggerFont, "=")
        command(view, "Smaller Terminal Font", .smallerFont, "-")
        command(view, "Reset Terminal Font", .resetFont, "0")
        let go = menu("Go")
        command(go, "Overview", .overview, "1")
        command(go, "Terminal", .terminal, "2")
        go.addItem(.separator())
        command(go, "Focus Sidebar", .sidebar, "s", [.command, .control])
        command(go, "Focus Terminal", .terminal, "t", [.command, .control])
        let window = menu("Window")
        action(window, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
        action(window, "Zoom", #selector(NSWindow.performZoom(_:)))
        action(window, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
        NSApp.windowsMenu = window
        NSApp.mainMenu = main
    }

    @objc private func dispatch(_ item: NSMenuItem) {
        guard let raw = item.representedObject as? String, let command = ShellCommand(rawValue: raw) else { return }
        perform(command)
    }

    public func validateMenuItem(_ item: NSMenuItem) -> Bool {
        guard let raw = item.representedObject as? String, let command = ShellCommand(rawValue: raw) else { return true }
        return enabled(command)
    }
}
