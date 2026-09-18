import SwiftUI

/// What a blank tab shows in place of a web view: the pages this panel has visited, newest
/// first, as favicon tiles. Clicking one loads it in this tab.
struct BrowserStartPage: View {
    let context: WorkspaceContext
    let controls: BrowserControlsViewModel

    private var recent: [WebPageRecord] {
        var seen: Set<String> = []
        return context.pageVisits.reversed().compactMap { visit -> WebPageRecord? in
            guard case .page(let record) = visit, seen.insert(record.url).inserted else { return nil }
            return record
        }
    }

    var body: some View {
        ScrollView {
            if recent.isEmpty {
                VStack(spacing: 5) {
                    Text("No history yet").font(Theme.Typography.emptyTitle).foregroundStyle(Theme.textSecondary)
                    Text("Pages you visit in this panel appear here.").font(Theme.Typography.emptyHint).foregroundStyle(Theme.textTertiary)
                }
                .frame(maxWidth: .infinity).padding(.top, 80)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    Text("History").font(.title3.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 120, maximum: 160), spacing: 12)], spacing: 12) {
                        ForEach(recent) { record in
                            StartPageTile(record: record) { open(record) }
                        }
                    }
                }
                .padding(24)
                .readableColumn()
            }
        }
        .background(Theme.paneBackground)
    }

    private func open(_ record: WebPageRecord) {
        // Not typed: end editing first, or the address bar treats the URL as text to suggest for.
        controls.setEditingAddress(false)
        controls.address = record.url
        controls.submitAddress()
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
