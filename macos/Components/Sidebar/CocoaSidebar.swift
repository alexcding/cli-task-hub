import AppKit
import SwiftUI

// AppKit owns row reuse, keyboard navigation, selection, and menus. SwiftUI only supplies
// snapshots and receives semantic selection/actions. The look follows the web sidebar
// (src/renderer/components/sidebar.js + css/layout.css, css/viewer.css): flat headings, no
// disclosure triangles (a click on the already-selected folder collapses it), a neutral
// rounded highlight, hover-only pin / "+" / close accessories, and the session status glyph.
struct CocoaSidebar: NSViewRepresentable {
    let entries: [SidebarEntry]
    let selection: SidebarDestination
    let pinnedIDs: Set<String>
    let onSelect: (SidebarDestination) -> Void
    let onTogglePin: (String) -> Void
    var onNewSession: (String) -> Void = { _ in }
    var onCloseTab: (String) -> Void = { _ in }
    var onNewTab: () -> Void = {}

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
        outline.style = .plain
        outline.selectionHighlightStyle = .regular
        outline.backgroundColor = .clear
        outline.intercellSpacing = .zero
        outline.indentationPerLevel = 0
        outline.indentationMarkerFollowsCell = false
        outline.allowsEmptySelection = true
        outline.allowsMultipleSelection = false
        outline.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        outline.dataSource = context.coordinator
        outline.delegate = context.coordinator
        outline.contextMenu = { [weak coordinator = context.coordinator] item in coordinator?.menu(for: item) }
        outline.onReselect = { [weak coordinator = context.coordinator] item in coordinator?.reselected(item) }
        outline.onMiddleClick = { [weak coordinator = context.coordinator] item in coordinator?.middleClicked(item) }
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsets(top: 0, left: 0, bottom: 8, right: 0)
        scroll.documentView = outline
        context.coordinator.outline = outline
        context.coordinator.update(self)
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) { context.coordinator.update(self) }

    static func dismantleNSView(_ nsView: NSScrollView, coordinator: Coordinator) { coordinator.stopSpinner() }

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
        private var spinTimer: Timer?
        private var spinFrame = 0
        private var avatarObserver: NSObjectProtocol?

        init(parent: CocoaSidebar, preferences: UserDefaults = .standard) {
            self.parent = parent
            self.preferences = preferences
            collapsed = Set(preferences.stringArray(forKey: "sidebar.collapsed") ?? [])
            super.init()
            avatarObserver = NotificationCenter.default.addObserver(forName: SidebarAvatars.loaded, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refreshVisibleCells() }
            }
        }

        func update(_ value: CocoaSidebar) {
            let changedSelection = parent.selection != value.selection
            parent = value
            guard let outline else { return }
            updating = true
            defer { updating = false }
            if snapshot != value.entries {
                if Self.shape(snapshot) == Self.shape(value.entries) {
                    // Same rows, new state (a busy edge, a title, a pin): update in place, so the
                    // spinner and hover state survive and nothing reloads under the pointer.
                    func apply(_ entry: SidebarEntry) {
                        if let node = nodes[entry.id], node.entry != entry {
                            node.entry = entry
                            let row = outline.row(forItem: node)
                            if row >= 0, let cell = outline.view(atColumn: 0, row: row, makeIfNecessary: false) as? SidebarCellView {
                                configure(cell, node: node, row: row)
                            }
                        }
                        entry.children.forEach(apply)
                    }
                    value.entries.forEach(apply)
                    snapshot = value.entries
                } else {
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
                    for node in roots where !node.children.isEmpty && !collapsed.contains(node.entry.id) {
                        outline.expandItem(node)
                    }
                    if let scrollPosition { outline.enclosingScrollView?.contentView.scroll(to: scrollPosition) }
                }
                syncSpinner()
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

        private struct Shape: Equatable { let id: String; let children: [Shape] }
        private static func shape(_ entries: [SidebarEntry]) -> [Shape] {
            entries.map { Shape(id: $0.id, children: shape($0.children)) }
        }

        private func flatten(_ node: Node) -> [Node] { [node] + node.children.flatMap(flatten) }
        private func children(_ item: Any?) -> [Node] { (item as? Node)?.children ?? roots }
        func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { children(item).count }
        func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { children(item)[index] }
        func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { (item as? Node)?.children.isEmpty == false }
        func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool { (item as? Node)?.entry.destination != nil }
        func outlineView(_ outlineView: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat {
            (item as? Node)?.entry.isHeading == true ? SidebarMetrics.labelHeight : SidebarMetrics.rowHeight
        }
        func outlineView(_ outlineView: NSOutlineView, rowViewForItem item: Any) -> NSTableRowView? {
            let row = SidebarRowView()
            row.selectable = (item as? Node)?.entry.destination != nil
            row.hoverable = (item as? Node).map { $0.entry.destination != nil || $0.entry.role == .tabsHeader } ?? false
            return row
        }
        func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
            guard let node = item as? Node else { return nil }
            let identifier = NSUserInterfaceItemIdentifier("sidebar-cell")
            let cell = outlineView.makeView(withIdentifier: identifier, owner: self) as? SidebarCellView ?? {
                let cell = SidebarCellView()
                cell.identifier = identifier
                return cell
            }()
            configure(cell, node: node, row: outlineView.row(forItem: node))
            return cell
        }

        private func configure(_ cell: SidebarCellView, node: Node, row: Int) {
            guard let outline else { return }
            let nested = outline.parent(forItem: node) != nil
            let expanded = !node.children.isEmpty && outline.isItemExpanded(node)
            cell.onTogglePin = { [weak self] id in self?.parent.onTogglePin(id) }
            cell.onNewSession = { [weak self] id in self?.parent.onNewSession(id) }
            cell.onCloseTab = { [weak self] url in self?.parent.onCloseTab(url) }
        cell.onNewTab = { [weak self] in self?.parent.onNewTab() }
            cell.configure(node.entry, nested: nested, expanded: expanded, spinFrame: spinFrame)
            if row >= 0, let rowView = outline.rowView(atRow: row, makeIfNecessary: false) as? SidebarRowView {
                rowView.selectable = node.entry.destination != nil
                rowView.hoverable = node.entry.destination != nil || node.entry.role == .tabsHeader
                cell.hovered = rowView.hovered
                cell.selected = rowView.isSelected
            }
        }

        private func refreshVisibleCells() {
            guard let outline else { return }
            outline.enumerateAvailableRowViews { _, row in
                guard let node = outline.item(atRow: row) as? Node,
                      let cell = outline.view(atColumn: 0, row: row, makeIfNecessary: false) as? SidebarCellView else { return }
                configure(cell, node: node, row: row)
            }
        }

        // One shared 120ms ticker advances every visible busy row in lockstep, and runs only
        // while at least one session is busy (sidebar.js syncSpinner).
        private func syncSpinner() {
            let anyBusy = snapshot.flatMap(\.descendants).contains {
                if case .session(let status, _) = $0.role { status.busy } else { false }
            }
            if anyBusy, spinTimer == nil {
                let timer = Timer(timeInterval: 0.12, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.tick() }
                }
                RunLoop.main.add(timer, forMode: .common)
                spinTimer = timer
            } else if !anyBusy { stopSpinner() }
        }

        func stopSpinner() { spinTimer?.invalidate(); spinTimer = nil }

        private func tick() {
            spinFrame = (spinFrame + 1) % SidebarGlyphs.frameCount
            outline?.enumerateAvailableRowViews { rowView, _ in
                (rowView.view(atColumn: 0) as? SidebarCellView)?.advanceSpinner(to: spinFrame)
            }
        }

        func outlineViewSelectionDidChange(_ notification: Notification) {
            guard !updating, let outline, let node = outline.item(atRow: outline.selectedRow) as? Node,
                  let destination = node.entry.destination else { return }
            selectedPlacement = node.entry.id
            parent.onSelect(destination)
        }

        // A click on the folder that is already in view collapses / expands its sessions — the
        // web sidebar's projectClick; there is no disclosure caret.
        func reselected(_ node: Node) {
            guard let outline, node.entry.projectID != nil, !node.children.isEmpty else { return }
            if outline.isItemExpanded(node) { outline.animator().collapseItem(node) }
            else { outline.animator().expandItem(node) }
        }

        // A middle-click closes a tab row, as in a browser (sidebar.js onauxclick).
        func middleClicked(_ node: Node) {
            if case .tab(let url) = node.entry.destination { parent.onCloseTab(url) }
        }

        func outlineViewItemDidCollapse(_ notification: Notification) { expansionChanged(notification, collapsed: true) }
        func outlineViewItemDidExpand(_ notification: Notification) { expansionChanged(notification, collapsed: false) }
        private func expansionChanged(_ notification: Notification, collapsed isCollapsed: Bool) {
            guard let outline, let node = notification.userInfo?["NSObject"] as? Node else { return }
            let row = outline.row(forItem: node)
            if row >= 0, let cell = outline.view(atColumn: 0, row: row, makeIfNecessary: false) as? SidebarCellView {
                configure(cell, node: node, row: row)
            }
            guard !updating else { return }
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
                menu.addItem(.separator())
                add("Close Tab", action: #selector(closeTab(_:)))
            }
            return menu.items.isEmpty ? nil : menu
        }

        @objc private func togglePin(_ sender: NSMenuItem) {
            guard let node = sender.representedObject as? Node, case .session(let id) = node.entry.destination else { return }
            parent.onTogglePin(id)
        }
        @objc private func closeTab(_ sender: NSMenuItem) {
            guard let node = sender.representedObject as? Node, case .tab(let url) = node.entry.destination else { return }
            parent.onCloseTab(url)
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

// MARK: - Look

/// css/tokens.css, as dynamic colours: the dark theme is the same palette swap.
enum SidebarPalette {
    private static func dynamic(_ light: UInt32, _ dark: UInt32, alpha: CGFloat = 1) -> NSColor {
        NSColor(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255,
                           blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
        }
    }
    static let navText = dynamic(0x3b3d3f, 0xc9cbce)   // --nav-text
    static let text = dynamic(0x16181d, 0xe8e8e8)      // --text
    static let text2 = dynamic(0x565d68, 0xa2a2a2)     // --text-2
    static let text3 = dynamic(0x9298a3, 0x6e6e6e)     // --text-3
    static let spinClaude = dynamic(0xd97757, 0xd97757)
    static let spinCodex = dynamic(0x39d353, 0x39d353)
    static let success = dynamic(0x16a34a, 0x4ade80)
    static let warn = dynamic(0xd97706, 0xfbbf24)
    static let danger = dynamic(0xdc2626, 0xf87171)
    // html.native-mac row fills: --text at 8% (hover) / 10% (selected) over the glass.
    static let hover = dynamic(0x16181d, 0xe8e8e8, alpha: 0.08)
    static let selected = dynamic(0x16181d, 0xe8e8e8, alpha: 0.10)
}

enum SidebarMetrics {
    static let rowHeight: CGFloat = 32       // .nav-btn / .opentab: 7px padding ×2, 1px borders, 14px text
    static let labelHeight: CGFloat = 31     // .nav-label: 10px top, 4px bottom, 13px text
    static let rowInset: CGFloat = 8         // nav { padding:8px }
    static let padding: CGFloat = 10         // row padding-left/right
    static let nestedPadding: CGFloat = 20   // #project-nav .proj-tabs .opentab
    static let radius: CGFloat = 8           // --rs
}

/// Busy-spinner frames per CLI (sidebar.js SPIN_FRAMES): Claude Code's blooming asterisk for
/// Claude, a braille cycle otherwise; the resting glyph is the full-bloom frame held still.
enum SidebarGlyphs {
    static let frameCount = 10
    static func frames(_ cli: String?) -> [String] {
        cli == "claude" ? ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]
            : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    }
    static func resting(_ cli: String?) -> String { cli == "claude" ? "✻" : "⠿" }
    static func tint(_ cli: String?) -> NSColor {
        switch cli {
        case "claude": SidebarPalette.spinClaude
        case "codex": SidebarPalette.spinCodex
        default: SidebarPalette.text3
        }
    }
}

// MARK: - Views

@MainActor final class SidebarRowView: NSTableRowView {
    var selectable = true { didSet { if oldValue != selectable { needsDisplay = true } } }
    /// Rows that react to the pointer without being selectable: headings with a hover accessory.
    var hoverable = true
    private(set) var hovered = false {
        didSet {
            guard oldValue != hovered else { return }
            needsDisplay = true
            (numberOfColumns > 0 ? view(atColumn: 0) as? SidebarCellView : nil)?.hovered = hovered
        }
    }
    private var tracking: NSTrackingArea?

    override var interiorBackgroundStyle: NSView.BackgroundStyle { .normal }
    override var isSelected: Bool { didSet { (numberOfColumns > 0 ? view(atColumn: 0) as? SidebarCellView : nil)?.selected = isSelected } }

    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area); tracking = area
        super.updateTrackingAreas()
    }
    override func mouseEntered(with event: NSEvent) { hovered = hoverable }
    override func mouseExited(with event: NSEvent) { hovered = false }
    override func prepareForReuse() { super.prepareForReuse(); hovered = false }

    private var plate: NSBezierPath {
        let rect = bounds.insetBy(dx: SidebarMetrics.rowInset, dy: 1)
        return NSBezierPath(roundedRect: rect, xRadius: SidebarMetrics.radius, yRadius: SidebarMetrics.radius)
    }
    override func drawBackground(in dirtyRect: NSRect) {
        guard hovered, selectable, !isSelected else { return }
        SidebarPalette.hover.setFill(); plate.fill()
    }
    override func drawSelection(in dirtyRect: NSRect) {
        guard selectable else { return }
        SidebarPalette.selected.setFill(); plate.fill()
    }
}

@MainActor final class SidebarCellView: NSTableCellView {
    var onTogglePin: (String) -> Void = { _ in }
    var onNewSession: (String) -> Void = { _ in }
    var onCloseTab: (String) -> Void = { _ in }
    var onNewTab: () -> Void = {}
    var hovered = false { didSet { if oldValue != hovered { applyState() } } }
    var selected = false { didSet { if oldValue != selected { applyState() } } }

    private let icon = NSImageView()
    private let glyph = NSTextField(labelWithString: "")
    private let title = NSTextField(labelWithString: "")
    private let badge = NSView()
    private let accessory = SidebarAccessoryButton()
    private var entry = SidebarEntry(id: "", title: "", symbol: "")
    private var nested = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        title.lineBreakMode = .byTruncatingTail
        title.cell?.truncatesLastVisibleLine = true
        title.maximumNumberOfLines = 1
        glyph.alignment = .center
        glyph.font = NSFont.monospacedSystemFont(ofSize: 14.7, weight: .bold)
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.wantsLayer = true
        badge.wantsLayer = true
        badge.layer?.cornerRadius = 3.5
        badge.layer?.borderWidth = 1.5
        accessory.target = self
        accessory.action = #selector(accessoryPressed)
        [icon, glyph, title, badge, accessory].forEach(addSubview)
        textField = title
        imageView = icon
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(_ entry: SidebarEntry, nested: Bool, expanded: Bool, spinFrame: Int) {
        self.entry = entry
        self.nested = nested
        title.stringValue = entry.title
        toolTip = entry.tooltip ?? (entry.detail.isEmpty ? entry.title : entry.detail)
        setAccessibilityIdentifier(entry.id)
        icon.isHidden = false; glyph.isHidden = true; badge.isHidden = true; accessory.isHidden = true
        icon.layer?.cornerRadius = 0
        alphaValue = 1
        switch entry.role {
        case .label:
            icon.isHidden = true
            title.font = .systemFont(ofSize: 13, weight: .medium)
        case .tabsHeader:
            icon.isHidden = true
            title.font = .systemFont(ofSize: 13, weight: .medium)
            accessory.image = SidebarIcons.image("plus", size: 16)
            accessory.toolTip = "New tab"
            accessory.setAccessibilityLabel("New tab")
        case .nav:
            icon.image = SidebarIcons.image(entry.symbol)
            title.font = .systemFont(ofSize: 14)
        case .project(let canCreate):
            icon.image = SidebarIcons.image(expanded ? "folderOpen" : "folder")
            title.font = .systemFont(ofSize: 14)
            if canCreate {
                accessory.image = SidebarIcons.image("plus", size: 16)
                accessory.toolTip = "New session on a new worktree"
                accessory.setAccessibilityLabel("New session")
            }
        case .session(let status, let pinned):
            icon.isHidden = true
            glyph.isHidden = !status.live && !status.busy
            glyph.stringValue = status.busy ? SidebarGlyphs.frames(status.cli)[spinFrame % SidebarGlyphs.frameCount]
                : SidebarGlyphs.resting(status.cli)
            glyph.textColor = status.busy ? SidebarGlyphs.tint(status.cli) : SidebarPalette.text3
            title.font = .systemFont(ofSize: 14)
            alphaValue = status.live || status.busy ? 1 : 0.82
            accessory.image = SidebarIcons.image(pinned ? "pinFilled" : "pin", size: 18)
            accessory.toolTip = pinned ? "Unpin session" : "Pin session to the top"
            accessory.setAccessibilityLabel(accessory.toolTip)
        case .tab(let tab):
            title.font = .systemFont(ofSize: 14)
            configureTabIcon(tab)
            accessory.image = SidebarIcons.image("close", size: 13)
            accessory.toolTip = "Close tab"
            accessory.setAccessibilityLabel("Close tab")
        }
        applyState()
    }

    private func configureTabIcon(_ tab: SidebarTabIcon) {
        switch tab.kind {
        case "github":
            if let avatar = SidebarAvatars.image(login: tab.login, frozen: tab.avatar) {
                icon.image = avatar
                icon.layer?.cornerRadius = 10
                icon.layer?.masksToBounds = true
            } else {
                icon.image = SidebarIcons.image("github", size: 20)
            }
            let color: NSColor? = switch tab.ci {
            case .none: nil
            case .running: SidebarPalette.warn
            case .success: SidebarPalette.success
            case .failure: SidebarPalette.danger
            }
            if let color {
                badge.isHidden = false
                badge.layer?.backgroundColor = color.cgColor
                badge.layer?.borderColor = NSColor.windowBackgroundColor.cgColor
            }
        case "jira": icon.image = SidebarIcons.image("jira", size: 20)
        default: icon.image = SidebarIcons.image("globe", size: 20)
        }
    }

    func advanceSpinner(to frame: Int) {
        guard case .session(let status, _) = entry.role, status.busy else { return }
        glyph.stringValue = SidebarGlyphs.frames(status.cli)[frame % SidebarGlyphs.frameCount]
    }

    private var stopped: Bool {
        if case .session(let status, _) = entry.role { return !status.live && !status.busy }
        return false
    }

    private func applyState() {
        let lit = hovered || selected
        let color: NSColor = switch entry.role {
        case .label, .tabsHeader: SidebarPalette.text3
        case .session where stopped: SidebarPalette.text3
        default: lit ? SidebarPalette.text : SidebarPalette.navText
        }
        title.textColor = color
        icon.contentTintColor = lit ? SidebarPalette.text : SidebarPalette.navText
        switch entry.role {
        case .project(let canCreate): accessory.isHidden = !(hovered && canCreate)
        case .session, .tab, .tabsHeader: accessory.isHidden = !hovered
        default: accessory.isHidden = true
        }
        needsLayout = true
    }

    @objc private func accessoryPressed() {
        if entry.role == .tabsHeader { onNewTab() }
        else if let id = entry.sessionID { onTogglePin(id) }
        else if let id = entry.projectID { onNewSession(id) }
        else if let id = entry.destination?.tabID { onCloseTab(id) }
    }

    override func layout() {
        super.layout()
        let height = bounds.height
        let inset = SidebarMetrics.rowInset
        let left = inset + (nested ? SidebarMetrics.nestedPadding : SidebarMetrics.padding)
        let right = bounds.width - inset - SidebarMetrics.padding
        func centered(_ x: CGFloat, _ size: CGFloat) -> NSRect {
            NSRect(x: x, y: ((height - size) / 2).rounded(), width: size, height: size)
        }
        var titleX = left
        switch entry.role {
        case .label, .tabsHeader:
            title.sizeToFit()
            let titleHeight = title.frame.height
            // The heading's "+" sits in the same trailing slot as a project row's, centred on the title.
            let titleY = height - 4 - titleHeight
            accessory.frame = NSRect(x: right - 18, y: (titleY + (titleHeight - 18) / 2).rounded(), width: 18, height: 18)
            let titleRight = accessory.isHidden ? bounds.width - inset - 16 : right - 18 - 6
            title.frame = NSRect(x: inset + 8, y: titleY, width: max(0, titleRight - inset - 8), height: titleHeight)
            return
        case .nav, .project:
            icon.frame = centered(left, 16)
            titleX = left + 16 + 8
        case .session:
            glyph.sizeToFit()
            let glyphHeight = glyph.frame.height
            glyph.frame = NSRect(x: left - 2, y: ((height - glyphHeight) / 2).rounded(), width: 20, height: glyphHeight)
            titleX = left + 16 - 2 + 8
        case .tab:
            icon.frame = centered(left, 20)
            badge.frame = NSRect(x: icon.frame.maxX - 5, y: icon.frame.maxY - 6, width: 7, height: 7)
            titleX = left + 20 + 8
        }
        // .task-pin: a 20px slot pulled 4px into the padding; .proj-add: an 18px slot.
        let slot: CGFloat = entry.sessionID != nil ? 20 : 18
        let slotX = right - slot + (entry.sessionID != nil ? 4 : 0)
        accessory.frame = centered(slotX, slot)
        let titleRight = accessory.isHidden ? right : slotX - 6
        title.sizeToFit()
        let titleHeight = title.frame.height
        title.frame = NSRect(x: titleX, y: ((height - titleHeight) / 2).rounded(), width: max(0, titleRight - titleX), height: titleHeight)
    }

    override func resizeSubviews(withOldSize oldSize: NSSize) { super.resizeSubviews(withOldSize: oldSize); needsLayout = true }
    override var isFlipped: Bool { true }
}

/// The hover pin / "+": invisible until the row is hovered (the cell hides it), a muted glyph
/// that darkens under the pointer — no plate of its own inside the row's highlight.
@MainActor final class SidebarAccessoryButton: NSButton {
    private var tracking: NSTrackingArea?
    private var pointed = false { didSet { contentTintColor = pointed ? SidebarPalette.text : SidebarPalette.text3.withAlphaComponent(0.8) } }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        isBordered = false
        bezelStyle = .regularSquare
        imagePosition = .imageOnly
        imageScaling = .scaleNone
        title = ""
        contentTintColor = SidebarPalette.text3.withAlphaComponent(0.8)
        focusRingType = .none
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area); tracking = area
        super.updateTrackingAreas()
    }
    override func mouseEntered(with event: NSEvent) { pointed = true }
    override func mouseExited(with event: NSEvent) { pointed = false }
    override var isHidden: Bool { didSet { if isHidden { pointed = false } } }
}

@MainActor final class SidebarOutlineView: NSOutlineView {
    var contextMenu: ((CocoaSidebar.Node) -> NSMenu?)?
    var onReselect: ((CocoaSidebar.Node) -> Void)?
    var onMiddleClick: ((CocoaSidebar.Node) -> Void)?

    // No disclosure triangles: a project folder collapses by clicking it again.
    override func frameOfOutlineCell(atRow row: Int) -> NSRect { .zero }

    override func mouseDown(with event: NSEvent) {
        let row = row(at: convert(event.locationInWindow, from: nil))
        let wasSelected = row >= 0 && row == selectedRow
        super.mouseDown(with: event)
        if wasSelected, event.clickCount == 1, let node = item(atRow: row) as? CocoaSidebar.Node { onReselect?(node) }
    }

    override func otherMouseUp(with event: NSEvent) {
        let row = row(at: convert(event.locationInWindow, from: nil))
        guard event.buttonNumber == 2, row >= 0, let node = item(atRow: row) as? CocoaSidebar.Node else {
            super.otherMouseUp(with: event); return
        }
        onMiddleClick?(node)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let row = row(at: convert(event.locationInWindow, from: nil))
        guard row >= 0, let node = item(atRow: row) as? CocoaSidebar.Node else { return nil }
        return contextMenu?(node)
    }
}

/// GitHub avatars for PR tab rows: the data URI frozen onto the tab when there is one, else
/// github.com/<login>.png fetched once and kept for the process. A finished fetch posts
/// `loaded` so visible rows swap the octicon for the face.
@MainActor enum SidebarAvatars {
    static let loaded = Notification.Name("SidebarAvatars.loaded")
    private static var images: [String: NSImage] = [:]
    private static var pending: Set<String> = []
    private static var failures: [String: Date] = [:]

    static func image(login: String?, frozen: String?) -> NSImage? {
        if let frozen, !frozen.isEmpty {
            if let hit = images[frozen] { return hit }
            if let comma = frozen.firstIndex(of: ","), frozen.hasPrefix("data:"),
               let data = Data(base64Encoded: String(frozen[frozen.index(after: comma)...])), let image = NSImage(data: data) {
                images[frozen] = image
                return image
            }
        }
        guard let login, !login.isEmpty else { return nil }
        if let hit = images[login] { return hit }
        // A failed fetch may retry after a minute — not on every row refresh (a busy edge
        // reconfigures the row), and not never (a transient error must not stick for the process).
        if let failed = failures[login], Date().timeIntervalSince(failed) < 60 { return nil }
        guard let encoded = login.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "https://github.com/\(encoded).png?size=40"),
              pending.insert(login).inserted else { return nil }
        Task {
            defer { pending.remove(login) }
            guard let (data, response) = try? await URLSession.shared.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200, let image = NSImage(data: data) else {
                failures[login] = Date()
                return
            }
            failures[login] = nil
            images[login] = image
            NotificationCenter.default.post(name: loaded, object: nil)
        }
        return nil
    }
}
