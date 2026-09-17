import AppKit
import Observation
import SwiftUI

/// Site icons for web tabs, keyed by host. `/favicon.ico` on the site is tried first, then
/// DuckDuckGo's icon service for sites that declare their icon only in HTML. Images live
/// for the process; a finished fetch posts `SidebarAvatars.loaded` so AppKit rows refresh,
/// and `images` is observable so SwiftUI toolbars update on their own.
@MainActor @Observable final class FaviconStore {
    static let shared = FaviconStore()
    private(set) var images: [String: NSImage] = [:]
    @ObservationIgnored private var pending: Set<String> = []
    @ObservationIgnored private var failures: [String: Date] = [:]

    static func host(of url: String) -> String? {
        guard let components = URL(string: url), let host = components.host, !host.isEmpty,
              ["http", "https"].contains(components.scheme ?? "") else { return nil }
        return host.lowercased()
    }

    func image(forURL url: String) -> NSImage? { Self.host(of: url).flatMap(image(host:)) }

    func image(host: String) -> NSImage? {
        if let hit = images[host] { return hit }
        // A failed fetch may retry after a minute, not on every row refresh and not never.
        if let failed = failures[host], Date().timeIntervalSince(failed) < 60 { return nil }
        guard pending.insert(host).inserted else { return nil }
        Task {
            defer { pending.remove(host) }
            if let image = await Self.fetch(host) {
                failures[host] = nil
                images[host] = image
                NotificationCenter.default.post(name: SidebarAvatars.loaded, object: nil)
            } else {
                failures[host] = Date()
            }
        }
        return nil
    }

    private static func fetch(_ host: String) async -> NSImage? {
        let candidates = ["https://\(host)/favicon.ico", "https://icons.duckduckgo.com/ip3/\(host).ico"]
        for candidate in candidates {
            guard let url = URL(string: candidate),
                  let (data, response) = try? await URLSession.shared.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200, data.count < 512 * 1024,
                  let image = NSImage(data: data), image.size.width > 0 else { continue }
            return image
        }
        return nil
    }
}

/// The favicon for `url` at toolbar size, or a globe until one has loaded.
struct FaviconImage: View {
    let url: String
    var size: CGFloat = 16
    private var store = FaviconStore.shared

    init(url: String, size: CGFloat = 16) { self.url = url; self.size = size }

    var body: some View {
        if let image = store.image(forURL: url) {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: 3))
        } else {
            Image(systemName: "globe").font(.system(size: size - 2)).foregroundStyle(.secondary)
                .frame(width: size, height: size)
        }
    }
}
