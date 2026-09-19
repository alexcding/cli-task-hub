import SwiftUI

/// What a blank tab shows in place of a web view, one section at a time: the bookmarks as icon
/// tiles, or every page visited in any panel as a searchable list. There is one history, shared
/// by every panel. Clicking either loads it in this tab.
struct BrowserStartPage: View {
    enum Section: String, CaseIterable {
        case bookmarks = "Bookmarks", history = "History"
    }

    let context: WorkspaceContext
    let controls: BrowserControlsViewModel
    /// The section last chosen, in any tab.
    @AppStorage("browser.startPageSection") private var storedSection = Section.bookmarks
    /// The section this tab shows; nil until it appears and reads the stored choice.
    @State private var section: Section?
    @State private var query = ""
    @State private var confirmingClear = false

    private var bookmarks: [BrowserBookmark] { context.bookmarks?.bookmarks ?? [] }

    private var entries: [BrowserHistoryEntry] {
        guard let history = context.globalHistory else { return [] }
        return query.trimmingCharacters(in: .whitespaces).isEmpty ? history.entries : history.matching(query, limit: Int.max)
    }

    var body: some View {
        let section = section ?? storedSection
        VStack(alignment: .leading, spacing: 12) {
            CapsulePicker(options: Section.allCases.map { ($0.rawValue, $0) },
                          selection: Binding(get: { section }, set: { self.section = $0; storedSection = $0 }))
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("start-page-section")
            .overlay(alignment: .trailing) { if section == .history { historyMenu } }
            if section == .history { searchField }
            switch section {
            case .bookmarks: bookmarkTiles
            case .history: historyList
            }
        }
        .padding(24)
        .readableColumn()
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.paneBackground)
        .onAppear {
            // With nothing bookmarked yet the history is the useful page; the stored choice stands.
            if self.section == nil { self.section = bookmarks.isEmpty && !entries.isEmpty ? .history : storedSection }
        }
    }

    @ViewBuilder private var bookmarkTiles: some View {
        if bookmarks.isEmpty {
            placeholder("No bookmarks yet", hint: "Pages you bookmark appear here.")
        } else {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 92, maximum: 112), spacing: 8, alignment: .top)], spacing: 12) {
                    ForEach(bookmarks) { bookmark in
                        StartPageTile(record: WebPageRecord(id: bookmark.url, url: bookmark.url, title: bookmark.title),
                                      open: { open(bookmark.url) }, remove: { context.bookmarks?.remove(url: bookmark.url) })
                    }
                }
                .accessibilityLabel("Bookmarks")
            }
        }
    }

    @ViewBuilder private var historyList: some View {
        if entries.isEmpty {
            if query.isEmpty {
                placeholder("No history yet", hint: "Pages you visit appear here.")
            } else {
                placeholder("No pages match \u{201C}\(query)\u{201D}", hint: nil)
            }
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(entries) { entry in
                        StartPageRow(entry: entry, open: { open(entry.url) }, remove: { context.globalHistory?.remove(url: entry.url) })
                    }
                }
                .accessibilityLabel("History")
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.textTertiary)
            TextField("Search history", text: $query).textFieldStyle(.plain)
                .accessibilityIdentifier("history-search")
            if !query.isEmpty {
                Button("Clear", systemImage: "xmark.circle.fill") { query = "" }
                    .labelStyle(.iconOnly).buttonStyle(.plain).foregroundStyle(Theme.textTertiary)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: Theme.Size.largeControl + 6)
        .background(Theme.surfaceHover, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.border, lineWidth: Theme.Size.hairline))
    }

    /// The rarely used, destructive history actions, kept out of the way behind an ellipsis.
    private var historyMenu: some View {
        Menu("History Options", systemImage: "ellipsis") {
            Button("Clear History…", role: .destructive) { confirmingClear = true }
                .disabled(context.globalHistory?.entries.isEmpty != false)
        }
        .labelStyle(.iconOnly).menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .foregroundStyle(Theme.textSecondary)
        .accessibilityIdentifier("history-options")
        .confirmationDialog("Clear all browsing history?", isPresented: $confirmingClear, titleVisibility: .visible) {
            Button("Clear History", role: .destructive) { context.globalHistory?.clear() }
        } message: {
            Text("Every page visited in any panel is forgotten. Open tabs stay open.")
        }
    }

    private func placeholder(_ title: String, hint: String?) -> some View {
        VStack(spacing: 5) {
            Text(title).font(Theme.Typography.emptyTitle).foregroundStyle(Theme.textSecondary)
            if let hint { Text(hint).font(Theme.Typography.emptyHint).foregroundStyle(Theme.textTertiary) }
        }
        .frame(maxWidth: .infinity).padding(.top, 60)
    }

    private func open(_ url: String) {
        // Not typed: end editing first, or the address bar treats the URL as text to suggest for.
        controls.setEditingAddress(false)
        controls.address = url
        controls.submitAddress()
    }
}

/// One line of the history list: favicon, title, host and when it was last visited.
private struct StartPageRow: View {
    let entry: BrowserHistoryEntry
    let open: () -> Void
    /// Forgets this page, from the row's delete button or its context menu.
    var remove: (() -> Void)? = nil
    @State private var hovering = false

    private var visited: String? {
        guard entry.visited > .distantPast else { return nil }
        return entry.visited.formatted(.relative(presentation: .named))
    }

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                FaviconImage(url: entry.url, size: 24)
                Text(entry.displayTitle).font(.body).lineLimit(1)
                Text(entry.host).font(.body).foregroundStyle(Theme.textTertiary).lineLimit(1)
                Spacer(minLength: 8)
                if let visited {
                    Text(visited).font(.callout).foregroundStyle(Theme.textTertiary).lineLimit(1)
                }
                if let remove {
                    Button("Delete", systemImage: "xmark.circle.fill", action: remove)
                        .labelStyle(.iconOnly).buttonStyle(.plain).foregroundStyle(Theme.textTertiary)
                        .opacity(hovering ? 1 : 0)
                        .help("Remove from history")
                        .accessibilityLabel("Remove \(entry.displayTitle) from history")
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(hovering ? Theme.surfaceHover : .clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(entry.url)
        .contextMenu {
            if let remove { Button("Remove from History", action: remove) }
        }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

private struct StartPageTile: View {
    let record: WebPageRecord
    let open: () -> Void
    /// Set for a bookmark tile, which can be removed from its context menu.
    var remove: (() -> Void)?
    @State private var hovering = false

    private var store: FaviconStore { .shared }

    private var host: String { URL(string: record.url)?.host ?? record.url }

    /// A touch icon is artwork made to fill a tile; a small favicon sits centred on the tile instead.
    private static func fillsTile(_ image: NSImage) -> Bool {
        (image.representations.map(\.pixelsWide).max() ?? 0) >= 96
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        Button(action: open) {
            VStack(spacing: 8) {
                ZStack {
                    shape.fill(Theme.surfaceHover)
                    if let image = store.image(forURL: record.url), Self.fillsTile(image) {
                        Image(nsImage: image).resizable().interpolation(.high).scaledToFit()
                    } else {
                        FaviconImage(url: record.url, size: 32)
                    }
                }
                .frame(width: 64, height: 64)
                .clipShape(shape)
                .overlay(shape.strokeBorder(Theme.border, lineWidth: Theme.Size.hairline))
                .scaleEffect(hovering ? 1.05 : 1)
                Text(record.title.isEmpty ? host : record.title)
                    .font(.callout).lineLimit(2).multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, alignment: .top)
            }
            .padding(8)
            .frame(maxWidth: .infinity)
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(record.url)
        .contextMenu { if let remove { Button("Remove Bookmark", action: remove) } }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}
