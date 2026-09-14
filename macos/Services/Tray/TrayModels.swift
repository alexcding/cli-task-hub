import Foundation

struct TrayPR: Decodable, Identifiable, Equatable, Sendable {
    struct CI: Decodable, Equatable, Sendable {
        let status: String?
        let conclusion: String?
    }
    let url: String
    let repo: String
    let number: Int
    let title: String
    let state: String
    let category: String
    let awaitingMyReview: Bool?
    var reviewPending: Bool?
    var requestedAt: String? = nil
    let projectName: String?
    let ci: CI?
    var id: String { "\(repo)#\(number)" }
    var pendingReview: Bool { state == "OPEN" && category == "review" && reviewPending == true }
    var inReviewGroup: Bool { awaitingMyReview ?? (category == "review") }
    var webURL: URL? { safeWebURL(url) }
    var ciLabel: String {
        if ci?.status == "in_progress" { return "CI running" }
        switch ci?.conclusion {
        case "success": return "CI passed"
        case "failure": return "CI failed"
        default: return "No CI status"
        }
    }
}

func safeWebURL(_ value: String) -> URL? {
    guard let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
          url.host != nil, url.user == nil, url.password == nil else { return nil }
    return url
}

func backendTimestamp(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
}

struct TrayTabGroup: Identifiable {
    let title: String
    let tabs: [SavedTab]
    var id: String { title }

    static func make(tabs: [SavedTab], prs: [TrayPR]) -> [Self] {
        let byURL = Dictionary(prs.map { ($0.url, $0) }, uniquingKeysWith: { first, _ in first })
        func group(_ tab: SavedTab) -> String {
            if tab.kind == "jira" { return "Jira" }
            if tab.kind != "github" { return "Web" }
            let review = byURL[tab.url]?.inReviewGroup ?? (tab.category == "review")
            return review ? "Review" : "Mine"
        }
        return ["Mine", "Review", "Jira", "Web"].compactMap { title in
            let rows = tabs.filter { group($0) == title }
            return rows.isEmpty ? nil : Self(title: title, tabs: rows)
        }
    }
}

public enum AppAppearance: String, CaseIterable, Identifiable, Sendable {
    case system = "auto", light, dark
    public var id: String { rawValue }
    var title: String { self == .system ? "System" : rawValue.capitalized }
}

struct UsageSnapshot: Decodable, Equatable, Sendable {
    struct Agent: Decodable, Equatable, Sendable { let tokens: Double; let cost: Double }
    struct Window: Decodable, Equatable, Sendable {
        let usedPct: Double
        let resetsAt: String?
        let label: String?
        var remaining: Double { max(0, min(100, 100 - usedPct)) }
        func paceRemaining(duration: TimeInterval, now: Date) -> Double? {
            guard duration > 0, let resetsAt, let reset = backendTimestamp(resetsAt) else { return nil }
            return max(0, min(100, reset.timeIntervalSince(now) / duration * 100))
        }
    }
    struct Limits: Decodable, Equatable, Sendable {
        let session: Window?
        let weekly: Window?
        let scoped: [Window]?
    }
    let claude: Agent?
    let codex: Agent?
    let limits: Limits?
    let codexLimits: Limits?
    let asOf: String?
}
