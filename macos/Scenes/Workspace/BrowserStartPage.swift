import SwiftUI

/// What a blank tab shows in place of a web view: the pages this panel has visited, newest
/// first, as favicon tiles, then the pages visited in every other panel as a list. Clicking
/// either loads it in this tab.
struct BrowserStartPage: View {
    let context: WorkspaceContext
    let controls: BrowserControlsViewModel
    /// The full-history screen replaces the start page in this tab until Back is pressed.
    @State private var showingAll = false
    @State private var query = ""

    /// How many other-panel pages the start page lists before deferring to the full history.
    static let othersLimit = 10

    /// Pages seen anywhere but in this panel, so nothing appears twice on the page.
    private func others(excluding recent: [WebPageRecord]) -> [BrowserHistoryEntry] {
        context.globalHistory?.recent(excluding: Set(recent.map(\.url)), limit: Self.othersLimit) ?? []
    }

    private var recent: [WebPageRecord] {
        var seen: Set<String> = []
        return context.pageVisits.reversed().compactMap { visit -> WebPageRecord? in
            guard case .page(let record) = visit, seen.insert(record.url).inserted else { return nil }
            return record
        }
    }

    var body: some View {
        Group {
            if showingAll, let history = context.globalHistory {
                BrowserHistoryScreen(history: history, query: $query, back: { showingAll = false }, open: open)
            } else {
                startPage
            }
        }
        .background(Theme.paneBackground)
    }

    private var startPage: some View {
        // Once per pass: both scan the whole history.
        let recent = recent, others = others(excluding: recent)
        return ScrollView {
            if recent.isEmpty && others.isEmpty {
                VStack(spacing: 5) {
                    Text("No history yet").font(Theme.Typography.emptyTitle).foregroundStyle(Theme.textSecondary)
                    Text("Pages you visit appear here.").font(Theme.Typography.emptyHint).foregroundStyle(Theme.textTertiary)
                }
                .frame(maxWidth: .infinity).padding(.top, 80)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    if !recent.isEmpty {
                        Text("History").font(.title3.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 120, maximum: 160), spacing: 12)], spacing: 12) {
                            ForEach(recent) { record in
                                StartPageTile(record: record) { open(record.url) }
                            }
                        }
                    }
                    if !others.isEmpty {
                        Text(recent.isEmpty ? "History" : "Other History")
                            .font(.title3.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                            .padding(.top, recent.isEmpty ? 0 : 16)
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(others) { entry in
                                StartPageRow(entry: entry) { open(entry.url) }
                            }
                        }
                        .accessibilityLabel("Other history")
                    }
                    if context.globalHistory?.entries.isEmpty == false {
                        Button("Show All History", systemImage: "clock.arrow.circlepath") { query = ""; showingAll = true }
                            .buttonStyle(.link)
                            .padding(.top, 8)
                            .accessibilityIdentifier("show-all-history")
                    }
                }
                .padding(24)
                .readableColumn()
            }
        }
    }

    private func open(_ url: String) {
        // Not typed: end editing first, or the address bar treats the URL as text to suggest for.
        controls.setEditingAddress(false)
        controls.address = url
        controls.submitAddress()
    }
}

/// Every page visited in any panel, newest first, with a search field that filters by title
/// or address. Reached from the start page's Show All History button.
private struct BrowserHistoryScreen: View {
    let history: BrowserHistoryStore
    @Binding var query: String
    let back: () -> Void
    let open: (String) -> Void
    @FocusState private var searching: Bool
    @State private var backHovering = false
    @State private var confirmingClear = false

    private var entries: [BrowserHistoryEntry] {
        query.trimmingCharacters(in: .whitespaces).isEmpty ? history.entries : history.matching(query, limit: Int.max)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Button(action: back) {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.left").font(.body.weight(.semibold))
                        Text("History").font(.title3.weight(.semibold))
                    }
                    .foregroundStyle(backHovering ? Color.primary : Theme.textSecondary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { backHovering = $0 }
                .help("Back to the start page")
                .accessibilityLabel("Back to start page")
                Spacer(minLength: 8)
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Theme.textTertiary)
                    TextField("Search history", text: $query).textFieldStyle(.plain).focused($searching)
                        .accessibilityIdentifier("history-search")
                    if !query.isEmpty {
                        Button("Clear", systemImage: "xmark.circle.fill") { query = "" }
                            .labelStyle(.iconOnly).buttonStyle(.plain).foregroundStyle(Theme.textTertiary)
                    }
                }
                .padding(.horizontal, 8).padding(.vertical, 5)
                .frame(maxWidth: 280)
                .background(Theme.surfaceHover, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: Theme.Size.hairline))
                Button("Clear History") { confirmingClear = true }
                    .disabled(history.entries.isEmpty)
                    .accessibilityIdentifier("clear-history")
                    .confirmationDialog("Clear all browsing history?", isPresented: $confirmingClear, titleVisibility: .visible) {
                        Button("Clear History", role: .destructive) { history.clear() }
                    } message: {
                        Text("Every page visited in any panel is forgotten. Open tabs stay open.")
                    }
            }
            if entries.isEmpty {
                Text(query.isEmpty ? "No history yet" : "No pages match \u{201C}\(query)\u{201D}")
                    .font(Theme.Typography.emptyTitle).foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity).padding(.top, 60)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(entries) { entry in
                            StartPageRow(entry: entry, open: { open(entry.url) }, remove: { history.remove(url: entry.url) })
                        }
                    }
                    .accessibilityLabel("All history")
                }
            }
        }
        .padding(24)
        .readableColumn()
        .onAppear { searching = true }
    }
}

/// One line of the other-panels list: favicon, title, host and when it was last visited.
private struct StartPageRow: View {
    let entry: BrowserHistoryEntry
    let open: () -> Void
    /// Forgets this page. Only the full-history screen offers it; the start page list does not.
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
    @State private var hovering = false

    private var host: String { URL(string: record.url)?.host ?? record.url }

    var body: some View {
        Button(action: open) {
            VStack(spacing: 8) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12).fill(Theme.surfaceHover)
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.border, lineWidth: Theme.Size.hairline))
                    FaviconImage(url: record.url, size: 32)
                }
                .frame(height: 72)
                Text(record.title.isEmpty ? host : record.title).font(.callout).lineLimit(1)
                Text(host).font(.caption).foregroundStyle(Theme.textTertiary).lineLimit(1)
            }
            .padding(8)
            .frame(maxWidth: .infinity)
            .background(hovering ? Theme.surfaceHover : .clear, in: RoundedRectangle(cornerRadius: 14))
            .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(record.url)
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}
