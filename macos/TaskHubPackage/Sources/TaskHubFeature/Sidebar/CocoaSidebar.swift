import AppKit
import SwiftUI

// AppKit owns row reuse, disclosure controls, keyboard navigation, selection, and
// menus. SwiftUI only supplies snapshots and receives semantic selection/actions.
struct CocoaSidebar: NSViewRepresentable {
    let entries: [SidebarEntry]
    let selection: SidebarDestination
    let pinnedIDs: Set<String>
    let onSelect: (SidebarDestination) -> Void
    let onTogglePin: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeNSView(context: Context) -> NSScrollView {
        let outline = SidebarOutlineView()
        outline.identifier = .init("workspace-sidebar")
        outline.setAccessibilityIdentifier("workspace-sidebar")
        outline.setAccessibilityLabel("Workspace sidebar")
        let column = NSTableColumn(identifier: .init("name"))
        column.resizingMask = .autoresizingMask
        outline.addTableColumn(column)
        outline.outlineTableColumn = column
        outline.headerView = nil
        outline.style = .sourceList
        outline.rowSizeStyle = .medium
        outline.indentationPerLevel = 14
        outline.allowsEmptySelection = true
        outline.allowsMultipleSelection = false
        outline.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        outline.dataSource = context.coordinator
        outline.delegate = context.coordinator
        outline.contextMenu = { [weak coordinator = context.coordinator] item in coordinator?.menu(for: item) }
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.documentView = outline
        context.coordinator.outline = outline
        context.coordinator.update(self)
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) { context.coordinator.update(self) }

    @MainActor final class Node: NSObject {
        var entry: SidebarEntry
        var children: [Node] = []
        init(_ entry: SidebarEntry) { self.entry = entry }
    }

    @MainActor final class Coordinator: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate {
        var parent: CocoaSidebar
        weak var outline: NSOutlineView?
        private var roots: [Node] = []
        private var nodes: [String: Node] = [:]
        private var snapshot: [SidebarEntry] = []
        private var updating = false
        private var selectedPlacement: String?
        private var collapsed: Set<String>
        private let preferences: UserDefaults

        init(parent: CocoaSidebar, preferences: UserDefaults = .standard) {
            self.parent = parent
            self.preferences = preferences
            collapsed = Set(preferences.stringArray(forKey: "sidebar.collapsed") ?? [])
        }

        func update(_ value: CocoaSidebar) {
            let changedSelection = parent.selection != value.selection
            parent = value
            guard let outline else { return }
            updating = true
            defer { updating = false }
            if snapshot != value.entries {
                let scrollPosition = outline.enclosingScrollView?.contentView.bounds.origin
                var retained: [String: Node] = [:]
                func reconcile(_ entry: SidebarEntry) -> Node {
                    let node = nodes[entry.id] ?? Node(entry)
                    node.entry = entry
                    node.children = entry.children.map(reconcile)
                    retained[entry.id] = node
                    return node
                }
                roots = value.entries.map(reconcile)
                nodes = retained
                snapshot = value.entries
                outline.reloadData()
                func expand(_ node: Node) {
                    guard !node.children.isEmpty, !collapsed.contains(node.entry.id) else { return }
                    outline.expandItem(node)
                    node.children.forEach(expand)
                }
                roots.forEach(expand)
                if let scrollPosition { outline.enclosingScrollView?.contentView.scroll(to: scrollPosition) }
            }
            let placed = selectedPlacement.flatMap { nodes[$0] }
            let selected = placed?.entry.destination == value.selection ? placed
                : roots.flatMap(flatten).first { $0.entry.destination == value.selection }
            guard let selected else { outline.deselectAll(nil); return }
            selectedPlacement = selected.entry.id
            if changedSelection {
                var ancestor = outline.parent(forItem: selected)
                while let item = ancestor {
                    outline.expandItem(item)
                    ancestor = outline.parent(forItem: item)
                }
            }
            let row = outline.row(forItem: selected)
            if row >= 0 {
                outline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
                if changedSelection { outline.scrollRowToVisible(row) }
            } else { outline.deselectAll(nil) }
        }

        private func flatten(_ node: Node) -> [Node] { [node] + node.children.flatMap(flatten) }
        private func children(_ item: Any?) -> [Node] { (item as? Node)?.children ?? roots }
        func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { children(item).count }
        func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { children(item)[index] }
        func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { (item as? Node)?.children.isEmpty == false }
        func outlineView(_ outlineView: NSOutlineView, isGroupItem item: Any) -> Bool { (item as? Node)?.entry.isGroup ?? false }
        func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool { (item as? Node)?.entry.destination != nil }
        func outlineView(_ outlineView: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat { (item as? Node)?.entry.isGroup == true ? 26 : 32 }

        func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
            guard let node = item as? Node else { return nil }
            let identifier = NSUserInterfaceItemIdentifier("sidebar-cell")
            let cell: NSTableCellView
            if let reused = outlineView.makeView(withIdentifier: identifier, owner: self) as? NSTableCellView { cell = reused }
            else {
                cell = NSTableCellView()
                cell.identifier = identifier
                let icon = NSImageView()
                let label = NSTextField(labelWithString: "")
                label.lineBreakMode = .byTruncatingTail
                icon.translatesAutoresizingMaskIntoConstraints = false
                label.translatesAutoresizingMaskIntoConstraints = false
                cell.addSubview(icon); cell.addSubview(label)
                cell.imageView = icon; cell.textField = label
                NSLayoutConstraint.activate([
                    icon.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2),
                    icon.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
                    icon.widthAnchor.constraint(equalToConstant: 17), icon.heightAnchor.constraint(equalToConstant: 17),
                    label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 7),
                    label.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -6),
                    label.centerYAnchor.constraint(equalTo: cell.centerYAnchor)
                ])
            }
            cell.textField?.stringValue = node.entry.title
            cell.textField?.font = .systemFont(ofSize: node.entry.isGroup ? 11 : 13, weight: node.entry.isGroup ? .semibold : .regular)
            cell.textField?.textColor = node.entry.isGroup ? .secondaryLabelColor : .labelColor
            cell.imageView?.image = NSImage(systemSymbolName: node.entry.symbol, accessibilityDescription: nil)
            cell.imageView?.contentTintColor = node.entry.isGroup ? .secondaryLabelColor : .controlAccentColor
            cell.toolTip = node.entry.detail.isEmpty ? node.entry.title : node.entry.detail
            cell.setAccessibilityIdentifier(node.entry.id)
            return cell
        }

        func outlineViewSelectionDidChange(_ notification: Notification) {
            guard !updating, let outline, let node = outline.item(atRow: outline.selectedRow) as? Node,
                  let destination = node.entry.destination else { return }
            selectedPlacement = node.entry.id
            parent.onSelect(destination)
        }

        func outlineViewItemDidCollapse(_ notification: Notification) { saveExpansion(notification, collapsed: true) }
        func outlineViewItemDidExpand(_ notification: Notification) { saveExpansion(notification, collapsed: false) }
        private func saveExpansion(_ notification: Notification, collapsed isCollapsed: Bool) {
            guard !updating, let node = notification.userInfo?["NSObject"] as? Node else { return }
            if isCollapsed { collapsed.insert(node.entry.id) } else { collapsed.remove(node.entry.id) }
            preferences.set(Array(collapsed).sorted(), forKey: "sidebar.collapsed")
        }

        func menu(for node: Node) -> NSMenu? {
            guard let destination = node.entry.destination else { return nil }
            let menu = NSMenu()
            func add(_ title: String, action: Selector) {
                let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
                item.target = self; item.representedObject = node
                menu.addItem(item)
            }
            if case .session(let id) = destination {
                add(parent.pinnedIDs.contains(id) ? "Unpin Session" : "Pin Session", action: #selector(togglePin(_:)))
            }
            if node.entry.detail.hasPrefix("/") {
                add("Reveal in Finder", action: #selector(reveal(_:)))
                add("Copy Path", action: #selector(copyDetail(_:)))
            } else if case .tab = destination {
                add("Open in Browser", action: #selector(openBrowser(_:)))
                add("Copy Link", action: #selector(copyDetail(_:)))
            }
            return menu.items.isEmpty ? nil : menu
        }

        @objc private func togglePin(_ sender: NSMenuItem) {
            guard let node = sender.representedObject as? Node, case .session(let id) = node.entry.destination else { return }
            parent.onTogglePin(id)
        }
        @objc private func reveal(_ sender: NSMenuItem) {
            guard let node = sender.representedObject as? Node else { return }
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: node.entry.detail)])
        }
        @objc private func copyDetail(_ sender: NSMenuItem) {
            guard let node = sender.representedObject as? Node else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(node.entry.detail, forType: .string)
        }
        @objc private func openBrowser(_ sender: NSMenuItem) {
            guard let node = sender.representedObject as? Node, let url = URL(string: node.entry.detail),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
            NSWorkspace.shared.open(url)
        }
    }
}

@MainActor final class SidebarOutlineView: NSOutlineView {
    var contextMenu: ((CocoaSidebar.Node) -> NSMenu?)?
    override func menu(for event: NSEvent) -> NSMenu? {
        let row = row(at: convert(event.locationInWindow, from: nil))
        guard row >= 0, let node = item(atRow: row) as? CocoaSidebar.Node else { return nil }
        return contextMenu?(node)
    }
}
