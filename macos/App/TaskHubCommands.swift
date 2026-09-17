import SwiftUI

/// SwiftUI owns the menu bar; standard editing items retain the responder chain.
struct TaskHubCommands: Commands {
    let model: AppViewModel
    let perform: (ShellCommand) -> Void
    let canCheckForUpdates: Bool

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            command("Check for Updates…", .checkForUpdates)
        }
        CommandGroup(replacing: .appSettings) {
            command("Settings…", .settings, key: ",")
        }
        CommandGroup(replacing: .newItem) {
            command("New Project…", .newProject)
            command("New Session…", .newSession, key: "n")
            command("Open Terminal", .terminal, key: "n", modifiers: [.command, .shift])
            command("New Tab", .newTab, key: "t")
            command("Open File…", .openFile, key: "o")
            command("Open Page in Browser", .openPageInBrowser, key: "o", modifiers: [.command, .shift])
        }
        CommandGroup(replacing: .saveItem) {
            command("Save File", .saveFile, key: "s")
            command("Close Tab / Window", .closePage, key: "w")
        }
        CommandGroup(after: .pasteboard) {
            command("Find in Page…", .findPage, key: "f")
        }
        CommandGroup(replacing: .toolbar) {
            command("Refresh", .refresh, key: "r")
            command("Reviews & Usage", .tray, key: "u", modifiers: [.command, .shift])
            Divider()
            command("Bigger Code Font", .biggerFont, key: "=")
            command("Smaller Code Font", .smallerFont, key: "-")
            command("Reset Code Font", .resetFont, key: "0")
            Divider()
            command("Zoom Page In", .zoomIn, key: "=", modifiers: [.command, .option])
            command("Zoom Page Out", .zoomOut, key: "-", modifiers: [.command, .option])
            command("Reset Page Zoom", .resetZoom, key: "0", modifiers: [.command, .option])
        }
        SidebarCommands()
        CommandMenu("Go") {
            command("Overview", .overview, key: "1")
            command("Terminal", .terminal, key: "2")
            command("Activity", .activity, key: "3")
            command("Back", .back, key: "[")
            command("Forward", .forward, key: "]")
            command("Next Page", .nextPage, key: "]", modifiers: [.command, .shift])
            command("Previous Page", .previousPage, key: "[", modifiers: [.command, .shift])
            Divider()
            command("Focus Sidebar", .sidebar, key: "s", modifiers: [.command, .control])
            command("Focus Terminal", .terminal, key: "t", modifiers: [.command, .control])
        }
    }

    @ViewBuilder private func command(_ title: String, _ command: ShellCommand,
                                      key: KeyEquivalent? = nil,
                                      modifiers: EventModifiers = .command) -> some View {
        let button = Button(title) { perform(command) }
            .disabled(command == .checkForUpdates ? !canCheckForUpdates : !model.canPerform(command))
        if let key { button.keyboardShortcut(key, modifiers: modifiers) }
        else { button }
    }
}
