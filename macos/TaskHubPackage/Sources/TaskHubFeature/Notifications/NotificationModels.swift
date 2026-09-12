import Foundation

struct ReviewAnnouncementTracker {
    private var seeded = false
    private var markers: [String: String] = [:]

    mutating func consume(_ prs: [TrayPR]) -> [TrayPR] {
        let pending = prs.filter(\.pendingReview)
        let fresh = pending.filter { markers[$0.id] != ($0.requestedAt.flatMap { $0.isEmpty ? nil : $0 } ?? "pending") }
        markers = Dictionary(pending.map { ($0.id, $0.requestedAt.flatMap { $0.isEmpty ? nil : $0 } ?? "pending") },
                             uniquingKeysWith: { first, _ in first })
        defer { seeded = true }
        return seeded ? fresh : []
    }
}

public struct ActivityEvent: Codable, Equatable, Sendable {
    struct Payload: Codable, Equatable, Sendable {
        struct PR: Codable, Equatable, Sendable {
            let number: Int?
            let title: String?
            let url: String?
        }
        let repo: String?
        let pr: PR?
        let key: String?
        let transition: String?
        let version: String?
        let project: String?
        let error: String?
        let detail: String?
    }
    let type: String
    let payload: Payload?
    let created_at: String?

    var message: NativeNotice {
        let p = payload
        let repo = p?.repo?.split(separator: "/").last.map(String.init) ?? "repository"
        let prBody = "#\(p?.pr?.number.map(String.init) ?? "?") \(p?.pr?.title ?? "")".trimmingCharacters(in: .whitespaces)
        let title: String
        let body: String
        var url: String?
        switch type {
        case "pr_opened", "pr_merged", "pr_closed":
            title = "Pull request \(type.dropFirst(3)) in \(repo)"; body = prBody; url = p?.pr?.url
        case "jira_transitioned":
            title = "\(p?.key ?? "Ticket") → \(p?.transition ?? "?")"
            body = p?.version.map { "Fix Version \($0)" } ?? ""
        case "jira_version_created": title = "Fix Version \(p?.version ?? "?") created"; body = p?.project ?? ""
        case "jira_fixversion_set": title = "Fix Version \(p?.version ?? "?") set"; body = p?.key ?? ""
        case "jira_transition_failed": title = "Failed to transition \(p?.key ?? "ticket")"; body = p?.error ?? ""
        case "jira_fixversion_failed": title = "Failed to set Fix Version"; body = p?.error ?? ""
        case "sync_failed": title = "Sync failed for \(repo)"; body = p?.error ?? ""
        default: title = type.isEmpty ? "Activity" : type.replacingOccurrences(of: "_", with: " ").capitalized
            body = p?.error ?? p?.detail ?? ""
        }
        return NativeNotice(kind: .activity, title: title, body: body, url: url.flatMap(safeWebURL)?.absoluteString)
    }
}

struct NativeNotice: Identifiable, Equatable, Sendable {
    enum Kind: String, Sendable { case review, activity }
    var id = UUID().uuidString
    let kind: Kind
    let title: String
    let body: String
    var url: String?
    var repo: String?
    var number: Int?
}

enum NotificationPermission: String, Sendable {
    case notDetermined, denied, authorized, unavailable
    var label: String {
        switch self {
        case .notDetermined: "Notifications are not enabled"
        case .denied: "Notifications are disabled in System Settings"
        case .authorized: "Notifications enabled"
        case .unavailable: "Notification status unavailable"
        }
    }
}

struct NotificationAccess: Sendable {
    var permission: NotificationPermission
    var soundAllowed = false
}

@MainActor protocol NotificationDelivery: AnyObject {
    func access() async -> NotificationAccess
    func requestAuthorization() async throws
    func deliver(_ notice: NativeNotice) async throws
    func playReviewSound(_ path: String) throws
}
