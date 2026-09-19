import SwiftUI

/// Safari's compact tab layout: every web tab sits inside one pill, and the selected tab is a
/// raised glass capsule that doubles as the address bar. Its close button is at the leading edge,
/// the site icon and host are centred, reload is trailing; clicking the host edits the address.
/// There is no second row for the browser: back/forward lead the pill, New Tab and Recently
/// Closed trail it.
struct BrowserCompactTabBar: View {
    let context: WorkspaceContext
    let model: SessionWorkspaceViewModel
    @FocusState private var editingAddress: Bool
    /// Keyboard highlight in the suggestion list; nil means Enter submits the typed text.
    @State private var highlighted: Int?
    /// The empty-state tab the bar opened itself: unlike Cmd-T it must not take the keyboard.
    @State private var fillerTabID: String?
    private var searchSuggestions = SearchSuggestionStore.shared
    /// The raised capsule is one view that glides between tab slots, as Safari's does.
    @Namespace private var slots

    private var pages: [BrowserPage] { context.pageTabs.compactMap { if case .page(let page) = $0 { page } else { nil } } }
    private var active: BrowserPage? { context.activePage }

    var body: some View {
        HStack(spacing: 8) {
            if model.offersPageSession, model.fillsTitleBar {
                Button("Create Session", systemImage: "terminal", action: model.createSession)
                    .disabled(!model.canCreateSession)
                    .help("Start an agent session for this page in its project")
                    .padding(.horizontal, 12)
                    .barGlass(iconOnly: false)
            }
            NavigationCluster(controls: active?.controls)
            Spacer(minLength: 0)
            tabPill
            Spacer(minLength: 0)
            // The 32pt square is the label, not a frame around the button, so the whole capsule
            // takes the click rather than the 14pt glyph alone.
            Button(action: model.newTab) {
                Label("New Tab", systemImage: "plus")
                    .labelStyle(SquareIconLabelStyle())
                    .frame(width: Theme.Size.largeControl, height: Theme.Size.largeControl)
                    .contentShape(Rectangle())
            }
            .help("Open a new web tab")
            .barGlass()
        }
        .padding(.horizontal, 12)
        .frame(height: 56)
        // Above the web view beneath, or the list would render under it.
        .zIndex(1)
        .overlay(alignment: .top) {
            if let controls = active?.controls, editingAddress, !suggestions.isEmpty {
                AddressSuggestions(items: suggestions, highlighted: highlighted) { pick($0, controls) }
                    .padding(.top, 52)
            }
        }
        .onChange(of: suggestions.map(\.id)) { _, _ in highlighted = nil }
        // Fetching is driven from here, once per keystroke, never from the body.
        .onChange(of: active?.controls.address) { _, text in
            if editingAddress, let text, webAddress(text) == nil { searchSuggestions.prefetch(text) }
        }
        // On the whole row, so the pill's re-centring animates with its contents: opening a tab
        // moves the existing tabs left as the new one slides in from the right. Keyed on the tab
        // list only: selecting a tab switches instantly, with no glide.
        .animation(.snappy(duration: 0.3), value: pages.map(\.id))
        .animation(.snappy(duration: 0.25), value: active?.controls.canGoForward == true)
        // A browser panel always has a page to type into: a blank tab showing this panel's history
        // is the empty state, never a pill with nothing in it. Keyed on presentability too, so a
        // refusal while a sheet is up is retried once the sheet goes away.
        .onChange(of: needsBlankTab, initial: true) { _, needed in
            if needed { model.newTab(); fillerTabID = context.activePage?.id }
        }
        .onAppear { synchronizeEditing() }
        .onChange(of: context.activeID) { _, _ in synchronizeEditing() }
        .onChange(of: editingAddress) { _, value in
            active?.controls.setEditingAddress(value)
            if !value { highlighted = nil }
        }
        // The reverse: a model that ends editing (the start page opening a site) releases the field.
        .onChange(of: active?.controls.editingAddress) { _, value in if value == false { editingAddress = false } }
        // A hidden workspace stays mounted, and opacity does not drop first responder: release the
        // field when this workspace leaves the screen, or the terminal shown instead loses keystrokes.
        .onChange(of: model.isActive) { _, visible in if !visible { editingAddress = false } }
        .onDisappear { active?.controls.setEditingAddress(false) }
    }

    /// A tab is never wider than this; below it, tabs split the available width equally.
    static let maxTabWidth: CGFloat = 400
    /// Safari's compact bar: a 36pt field inside a 40pt pill, 15pt text.
    static let pillHeight: CGFloat = 40
    static let tabHeight: CGFloat = 36
    static let tabFont = Font.system(size: 15)
    static let placeholderFont = Font.system(size: 13)

    /// The outer pill hugs its tabs, each an equal share of the row up to `maxTabWidth`.
    @ViewBuilder private var tabPill: some View {
        if pages.isEmpty {
            // Momentarily empty while the blank tab is created; holds the row's shape.
            Capsule().fill(Theme.surfaceHover)
                .overlay(Capsule().strokeBorder(Theme.border, lineWidth: Theme.Size.hairline))
                .frame(maxWidth: Self.maxTabWidth).frame(height: Self.pillHeight)
        } else {
            HStack(spacing: 2) {
                ForEach(pages) { page in
                    // One view for both states, so selecting a tab fades its parts in place instead
                    // of swapping two views and letting the title jump.
                    CompactTab(page: page, active: page.id == context.activeID, workspaceActive: model.isActive,
                               autoFocus: page.id != fillerTabID,
                               moveHighlight: moveHighlight, submitHighlighted: { submitHighlighted(page.controls) },
                               // A lone blank tab has nothing to close: closing it would only make another.
                               closable: !(pages.count == 1 && page.controls.isBlank), editing: $editingAddress,
                               select: { model.selectTab(.page(page)) }, close: { model.closeTab(.page(page)) })
                    .frame(maxWidth: Self.maxTabWidth)
                    .background { Color.clear.matchedGeometryEffect(id: page.id, in: slots) }
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .background {
                // Drawn once behind the row and matched to the selected slot, so it re-flows with
                // the tab widths when tabs open or close.
                if let activeID = context.activeID, pages.contains(where: { $0.id == activeID }) {
                    ActiveTabCapsule()
                        .matchedGeometryEffect(id: activeID, in: slots, isSource: false)
                }
            }
            .padding(2)
            .frame(height: Self.pillHeight)
            .background(Theme.surfaceHover, in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.border, lineWidth: Theme.Size.hairline))
        }
    }

    /// Leaving a tab drops any address focus so it does not carry over. A blank tab takes focus
    /// itself when its address field appears in `CompactTab`, once that field exists: a focus binding set before
    /// the bound view is mounted is silently reset.
    /// One flat list: the typed text as a search, pages this panel has visited that match the text
    /// (newest first, web pages only), pages visited in other panels that match, then Google's
    /// phrase completions. The full history is the blank tab's start page; here it is only a filter.
    private var suggestions: [AddressSuggestion] {
        // Focusing the field selects the page's own address; offering that page back is noise.
        guard let controls = active?.controls, controls.addressEdited else { return [] }
        let text = controls.address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return [] }
        let searching = webAddress(text) == nil
        var history: [AddressSuggestion] = []
        var seen: Set<String> = []
        for visit in context.pageVisits.reversed() {
            guard case .page(let record) = visit, seen.insert(record.url).inserted,
                  record.url.localizedCaseInsensitiveContains(text) || record.title.localizedCaseInsensitiveContains(text)
            else { continue }
            let host = URL(string: record.url)?.host ?? record.url
            history.append(.init(id: record.url, title: record.title.isEmpty ? host : record.title, detail: host, url: record.url, kind: .history))
            if history.count >= 4 { break }
        }
        // Excluding this panel's whole history, not only the matches shown: a page cut off by the
        // cap above must not reappear as if it were from another panel.
        for entry in context.globalHistory?.matching(text, excluding: seen.union(context.history.map(\.url)), limit: 3) ?? [] {
            history.append(.init(id: entry.url, title: entry.displayTitle, detail: entry.host, url: entry.url, kind: .history))
        }
        guard searching else { return history }
        // Safari's order: one suggested site, then four searches led by the typed text, then history.
        var items: [AddressSuggestion] = []
        let completions = searchSuggestions.cached(text)
        if let site = completions.first(where: \.isSite), let url = webAddress(site.text), let host = url.host {
            let name = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
            items.append(.init(id: "site:" + site.text, title: site.title.isEmpty ? name : site.title,
                               detail: site.title.isEmpty ? "" : name, url: url.absoluteString, kind: .site))
            history.removeAll { $0.url == url.absoluteString }
        }
        if let url = BrowserControlsViewModel.searchURL(for: text) {
            items.append(.init(id: "search", title: text, detail: "", url: url.absoluteString, kind: .typed))
        }
        for phrase in completions.lazy.filter({ !$0.isSite }).map(\.text).filter({ $0.caseInsensitiveCompare(text) != .orderedSame }).prefix(3) {
            guard let url = BrowserControlsViewModel.searchURL(for: phrase) else { continue }
            items.append(.init(id: "google:" + phrase, title: phrase, detail: "", url: url.absoluteString, kind: .google))
        }
        items += history
        return items
    }

    private func pick(_ item: AddressSuggestion, _ controls: BrowserControlsViewModel) {
        controls.address = item.url
        if controls.submitAddress() { editingAddress = false }
    }

    /// Down/Up move the highlight; Enter on a highlight opens it. Returns whether the key was used.
    func moveHighlight(_ delta: Int) -> Bool {
        let count = suggestions.count
        guard count > 0 else { return false }
        // Positions -1 (none) through count-1, wrapping: shift to 0-based, step, wrap, shift back.
        let next = ((highlighted ?? -1) + 1 + delta + count + 1) % (count + 1) - 1
        highlighted = next == -1 ? nil : next
        return true
    }
    func submitHighlighted(_ controls: BrowserControlsViewModel) -> Bool {
        guard let index = highlighted, suggestions.indices.contains(index) else { return false }
        pick(suggestions[index], controls); return true
    }

    // Not while restoring: a blank tab opened before the saved snapshot lands would mark the
    // context edited and the saved tabs would be skipped.
    private var needsBlankTab: Bool { pages.isEmpty && model.canOpenTab && !context.restoring }

    private func synchronizeEditing() {
        if active?.controls.isBlank != true { editingAddress = false }
    }
}

/// Safari's history cluster: Back alone, widening to Back, a hairline and Forward only while
/// there is a page to go forward to. One glass capsule around both, drawn with the same
/// `barGlass` as New Tab so the two read as the same material. Always present, disabled with no
/// page, so the row never shifts.
private struct NavigationCluster: View {
    let controls: BrowserControlsViewModel?

    private var showsForward: Bool { controls?.canGoForward == true }

    var body: some View {
        HStack(spacing: 0) {
            HoverCircleButton("Back", systemImage: "chevron.left", enabled: controls?.canGoBack == true) { controls?.back() }
            if showsForward {
                Divider().frame(height: 16)
                HoverCircleButton("Forward", systemImage: "chevron.right", enabled: true) { controls?.forward() }
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }
        }
        // Alone, Back is exactly its 32pt circle; the inset only appears once Forward joins.
        .padding(.horizontal, showsForward ? 2 : 0)
        .barGlass()
    }
}

/// One arrow in the history cluster: a 32pt circle that tints on hover, as Safari's do.
private struct HoverCircleButton: View {
    let title: String
    let systemImage: String
    let enabled: Bool
    let action: () -> Void
    @State private var hovering = false

    init(_ title: String, systemImage: String, enabled: Bool, action: @escaping () -> Void) {
        self.title = title; self.systemImage = systemImage; self.enabled = enabled; self.action = action
    }

    var body: some View {
        // The circle is the button's label, so the whole 32pt disc takes the click, not just the
        // chevron glyph inside it.
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .labelStyle(.iconOnly)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(enabled ? Theme.textSecondary : Theme.textTertiary.opacity(0.6))
                .frame(width: Theme.Size.largeControl, height: Theme.Size.largeControl)
                .background(hovering && enabled ? Theme.border.opacity(0.6) : .clear, in: Circle())
                .contentShape(Circle())
        }
            .buttonStyle(.plain)
            .disabled(!enabled)
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

/// The suggestion list's panel: Liquid Glass on macOS 26, the window surface with a hairline before it.
private extension View {
    @ViewBuilder func suggestionGlass() -> some View {
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        if #available(macOS 26.0, *) {
            glassEffect(.regular, in: shape)
        } else {
            background(Color(nsColor: .windowBackgroundColor), in: shape)
                .overlay(shape.strokeBorder(Theme.border, lineWidth: Theme.Size.hairline))
                .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
        }
    }
}

/// The bar's chrome buttons share one look: 32pt tall, icon-only at 20pt, plain buttons over a
/// Liquid Glass capsule on macOS 26 and a tinted bordered capsule before it.
private extension View {
    @ViewBuilder func barGlass(iconOnly: Bool = true) -> some View {
        let base = labelStyle(iconOnly ? AnyLabelStyle(SquareIconLabelStyle()) : AnyLabelStyle(.titleAndIcon))
            .buttonStyle(.plain)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(Theme.textSecondary)
            .frame(height: Theme.Size.largeControl)
        if #available(macOS 26.0, *) {
            base.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            base.background(Theme.surfaceHover, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.border, lineWidth: Theme.Size.hairline))
        }
    }
}

/// The raised background of the selected tab: Liquid Glass on macOS 26, a lifted capsule before.
private struct ActiveTabCapsule: View {
    var body: some View {
        if #available(macOS 26.0, *) {
            Color.clear.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            Capsule().fill(Color(nsColor: .controlBackgroundColor))
                .shadow(color: .black.opacity(0.12), radius: 2, y: 1)
        }
    }
}

/// One tab in the pill. Unselected: icon and title, a close button on hover. Selected: close,
/// icon and host, reload, and the address field over the label while editing. Both states share
/// the same slots, so the label never moves; only what fills the slots crossfades.
private struct CompactTab: View {
    let page: BrowserPage
    let active: Bool
    /// Hidden workspaces stay mounted; opacity does not stop a field from taking first responder.
    let workspaceActive: Bool
    let autoFocus: Bool
    let moveHighlight: (Int) -> Bool
    let submitHighlighted: () -> Bool
    let closable: Bool
    @FocusState.Binding var editing: Bool
    let select: () -> Void
    let close: () -> Void
    @State private var hovering = false
    @State private var hoveringClose = false

    private var controls: BrowserControlsViewModel { page.controls }
    private var isEditing: Bool { active && editing }
    private var showsClose: Bool { closable && (active || hovering) }
    /// Safari shows the page title on an unselected tab and the host on the selected one.
    private var label: String {
        if controls.isBlank { return active ? "" : "New Tab" }
        if active { return URL(string: page.url)?.host ?? (page.title.isEmpty ? page.url : page.title) }
        return page.title.isEmpty ? (URL(string: page.url)?.host ?? page.url) : page.title
    }

    var body: some View {
        @Bindable var controls = controls
        HStack(spacing: 4) {
            Button("Close \(page.title)", systemImage: "xmark.circle.fill", action: close)
                .labelStyle(.iconOnly).buttonStyle(.plain)
                .font(.system(size: 17))
                .foregroundStyle(hoveringClose ? Theme.textSecondary : Theme.textTertiary)
                .onHover { hoveringClose = $0 }
                .frame(width: 24, height: 24)
                .help("Close tab")
                .opacity(showsClose ? 1 : 0)
                .allowsHitTesting(showsClose)
                .accessibilityHidden(!showsClose)
            ZStack {
                Button(action: { if active { editing = true } else { select() } }) {
                    HStack(spacing: 6) {
                        if FaviconStore.host(of: page.url) != nil { FaviconImage(url: page.url, size: 16) }
                        Text(label.isEmpty ? "Search or enter website name" : label)
                            .font(label.isEmpty ? BrowserCompactTabBar.placeholderFont : BrowserCompactTabBar.tabFont)
                            .lineLimit(1)
                            .foregroundStyle(label.isEmpty ? Theme.textTertiary : active ? .primary : Theme.textSecondary)
                            .contentTransition(.interpolate)
                    }
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(page.url)
                .accessibilityLabel(label.isEmpty ? "Edit address" : label)
                .accessibilityHint(active ? "Edit address" : "Select tab")
                .opacity(isEditing ? 0 : 1)
                .allowsHitTesting(!isEditing)
                if active {
                    // Mounted for the whole time the tab is selected, never inserted on demand: a
                    // focus binding set before its field exists is silently reset. Nothing here may
                    // depend on the typed text; a modifier flipping on the first character rebuilds
                    // the field and drops first responder mid-word.
                    TextField("", text: $controls.address,
                              prompt: Text("Search or enter website name").font(BrowserCompactTabBar.placeholderFont))
                        .textFieldStyle(.plain)
                        .font(BrowserCompactTabBar.tabFont)
                        .multilineTextAlignment(.leading)
                        .padding(.leading, 26)
                        .overlay(alignment: .leading) {
                            Image(systemName: "magnifyingglass").foregroundStyle(Theme.textTertiary).padding(.leading, 4)
                        }
                        .focused($editing)
                        .onKeyPress(.downArrow) { moveHighlight(1) ? .handled : .ignored }
                        .onKeyPress(.upArrow) { moveHighlight(-1) ? .handled : .ignored }
                        .onSubmit { if submitHighlighted() || controls.submitAddress() { editing = false } }
                        .onExitCommand { editing = false }
                        .opacity(isEditing ? 1 : 0)
                        .allowsHitTesting(isEditing)
                        .accessibilityHidden(!isEditing)
                }
            }
            Button(controls.loading ? "Stop Loading" : "Reload Page",
                   systemImage: controls.loading ? "xmark" : "arrow.clockwise", action: controls.toggleLoading)
                .labelStyle(.iconOnly).buttonStyle(.plain)
                .font(.system(size: 15))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 24, height: 24)
                .opacity(active && !controls.isBlank ? 1 : 0)
                .allowsHitTesting(active && !controls.isBlank)
                .accessibilityHidden(!(active && !controls.isBlank))
        }
        .padding(.horizontal, 6)
        .frame(height: BrowserCompactTabBar.tabHeight)
        .background(hovering && !active ? Theme.border.opacity(0.5) : .clear, in: Capsule())
        // Safari's focus ring while the address is being edited.
        .overlay { if isEditing { Capsule().strokeBorder(Theme.accent.opacity(0.6), lineWidth: 3).padding(-1) } }
        .onHover { hovering = $0 }
        .accessibilityAddTraits(active ? .isSelected : [])
        .accessibilityAction(named: "Close \(page.title)", close)
        .animation(.easeInOut(duration: 0.15), value: active)
        .animation(.easeOut(duration: 0.12), value: hovering)
        .onAppear { takeFocusIfBlank() }
        .onChange(of: active) { _, _ in takeFocusIfBlank() }
        .onChange(of: workspaceActive) { _, _ in takeFocusIfBlank() }
    }

    /// Deferred one turn: the field is inserted in the same update that makes the tab active, and
    /// a focus binding set before the focus system has registered its field is silently dropped.
    private func takeFocusIfBlank() {
        guard autoFocus, active, workspaceActive, controls.isBlank else { return }
        Task { @MainActor in
            if active, workspaceActive, controls.isBlank { editing = true }
        }
    }
}

struct AddressSuggestion: Identifiable, Equatable {
    enum Kind { case typed, history, site, google }
    let id: String
    let title: String
    let detail: String
    let url: String
    let kind: Kind
    var isSearch: Bool { kind == .typed || kind == .google }
    /// The section a row sits under; the suggested site leads the list with none.
    var heading: String? {
        switch kind {
        case .site: nil
        case .typed, .google: "Google Suggestions"
        case .history: "History"
        }
    }
}

/// Safari's completion list under the address: the suggested site, then the searches and the
/// history under their own headings. Headings are not rows: `highlighted` indexes `items` only.
private struct AddressSuggestions: View {
    let items: [AddressSuggestion]
    let highlighted: Int?
    let pick: (AddressSuggestion) -> Void
    private static let iconSide: CGFloat = 28

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if let heading = item.heading, index == 0 || items[index - 1].heading != heading {
                    Text(heading).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textTertiary)
                        .padding(.horizontal, 10).padding(.top, index == 0 ? 4 : 8).padding(.bottom, 2)
                }
                Button { pick(item) } label: {
                    HStack(spacing: 10) {
                        Group {
                            if item.isSearch {
                                Image(systemName: "magnifyingglass").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.textSecondary)
                                    .frame(width: Self.iconSide, height: Self.iconSide)
                                    .background(Theme.surfaceHover, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                            } else {
                                FaviconImage(url: item.url, size: Self.iconSide, fallbackSize: 15)
                            }
                        }
                        .frame(width: Self.iconSide, height: Self.iconSide)
                        if item.isSearch || item.detail.isEmpty || item.detail == item.title {
                            Text(item.title).lineLimit(1)
                        } else {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.title).lineLimit(1)
                                Text(item.detail).font(.system(size: 12)).lineLimit(1).foregroundStyle(Theme.textTertiary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .font(BrowserCompactTabBar.tabFont)
                    .padding(.horizontal, 10)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .background(highlighted == index ? Theme.accentBackground : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(8)
        .frame(width: 560)
        .suggestionGlass()
        .accessibilityLabel("Address suggestions")
    }
}

/// Type-erased label style, so one modifier can pick between two.
private struct AnyLabelStyle: LabelStyle {
    private let make: (Configuration) -> AnyView
    init<S: LabelStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}
