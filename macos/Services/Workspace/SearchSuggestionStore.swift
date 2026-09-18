import Foundation
import Observation

/// Search-phrase completions for the address bar, from the suggest endpoint Chrome and Firefox
/// use. Keyless and undocumented, so failures are silent and never surface as an error. One
/// request in flight per store, debounced, results cached for the process.
@MainActor @Observable final class SearchSuggestionStore {
    static let shared = SearchSuggestionStore()
    private(set) var results: [String: [String]] = [:]
    @ObservationIgnored private var inFlight: Task<Void, Never>?
    @ObservationIgnored private var fetch: (String) async -> [String]

    init(fetch: ((String) async -> [String])? = nil) {
        self.fetch = fetch ?? Self.fetchFromGoogle
    }

    private static let cacheLimit = 50
    @ObservationIgnored private var order: [String] = []
    /// A failed or empty fetch is retried after a short while, not remembered for the process.
    @ObservationIgnored private var failures: [String: Date] = [:]

    /// Completions already known for `text`. Pure: reading never starts a request.
    func cached(_ text: String) -> [String] { results[Self.key(text)] ?? [] }

    /// Asks for completions when unknown. Debounced: a newer text cancels the pending request.
    func prefetch(_ text: String) {
        let key = Self.key(text)
        guard !key.isEmpty, results[key] == nil else { return }
        if let failed = failures[key], Date().timeIntervalSince(failed) < 30 { return }
        inFlight?.cancel()
        inFlight = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled, let self else { return }
            let phrases = await fetch(key)
            guard !Task.isCancelled else { return }
            store(key, phrases)
        }
    }

    private static func key(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    /// Bounded: the oldest queries fall out once past the limit.
    private func store(_ key: String, _ phrases: [String]) {
        guard !phrases.isEmpty else { failures[key] = Date(); return }
        failures[key] = nil
        results[key] = phrases
        order.removeAll { $0 == key }; order.append(key)
        while order.count > Self.cacheLimit, let oldest = order.first { order.removeFirst(); results[oldest] = nil }
    }

    /// `["<query>", ["<phrase>", ...]]`, the Firefox-client shape.
    static func parse(_ data: Data) -> [String] {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [Any], json.count >= 2,
              let phrases = json[1] as? [String] else { return [] }
        return phrases
    }

    private static func fetchFromGoogle(_ text: String) async -> [String] {
        var components = URLComponents(string: "https://suggestqueries.google.com/complete/search")!
        components.queryItems = [.init(name: "client", value: "firefox"), .init(name: "q", value: text)]
        guard let url = components.url else { return [] }
        var request = URLRequest(url: url); request.timeoutInterval = 3
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return [] }
        return parse(data)
    }
}
