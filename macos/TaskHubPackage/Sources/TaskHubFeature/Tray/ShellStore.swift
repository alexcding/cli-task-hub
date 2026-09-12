import AppKit
import Foundation
import Observation

// Independent tasks keep a slow usage source out of the PR/sidebar refresh path.
@MainActor @Observable public final class ShellStore {
    public let notifications = NotificationStore()
    private(set) var activityNotify: Bool
    private(set) var reviewSound: String
    private(set) var prs: [TrayPR] = []
    private(set) var trayError: String?
    private(set) var trayLoading = false
    private(set) var trayUpdated: Date?
    private(set) var usage: UsageSnapshot?
    private(set) var usageError: String?
    private(set) var usageLoading = false
    public private(set) var appearance: AppAppearance
    private(set) var usageAgent: String
    private(set) var settingsError: String?
    private(set) var acknowledging: Set<String> = []
    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var trayTask: Task<Void, Never>?
    @ObservationIgnored private var usageTask: Task<Void, Never>?
    @ObservationIgnored private var settingsTask: Task<Void, Never>?
    @ObservationIgnored private var settingsWrite: Task<Void, Never>?
    @ObservationIgnored private var refreshPending = false
    @ObservationIgnored private var settingsRevision = 0
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let preferences: UserDefaults
    @ObservationIgnored private var pendingSettings: [String: String]
    @ObservationIgnored private var pendingReviewOpens: [String: (repo: String, number: Int)] = [:]

    public init(preferences: UserDefaults = .standard) {
        self.preferences = preferences
        pendingSettings = preferences.dictionary(forKey: "native.pendingSettings") as? [String: String] ?? [:]
        appearance = AppAppearance(rawValue: preferences.string(forKey: "native.theme") ?? "auto") ?? .system
        usageAgent = preferences.string(forKey: "native.usageAgent") == "codex" ? "codex" : "claude"
        activityNotify = preferences.string(forKey: "native.activityNotify") != "off"
        reviewSound = preferences.string(forKey: "native.reviewSound") ?? "system"
    }

    var pendingReviews: [TrayPR] { prs.filter(\.pendingReview) }
    public var pendingReviewCount: Int { pendingReviews.count }

    public func applyAppearance() {
        switch appearance {
        case .system: NSApp.appearance = nil
        case .light: NSApp.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
        }
    }

    func connect(_ api: APIClient) {
        generation += 1
        self.api = api
        let opened = pendingReviewOpens.values
        pendingReviewOpens.removeAll()
        for review in opened { acknowledgeReview(repo: review.repo, number: review.number) }
        for key in pendingSettings.keys.sorted() {
            if let value = pendingSettings[key] { saveSetting(key, value: value) }
        }
        refresh()
        loadSettings()
    }

    func refresh() {
        refreshPending = true
        guard trayTask == nil, let api else { return }
        trayLoading = true
        trayTask = Task {
            defer { trayTask = nil; trayLoading = false }
            while refreshPending && !Task.isCancelled {
                refreshPending = false
                do {
                    let result: [TrayPR] = try await api.get(Routes.PRS_TRAY)
                    try Task.checkCancellation()
                    var seen: Set<String> = []
                    prs = result.filter { seen.insert($0.id).inserted }
                    notifications.receiveReviews(prs, sound: reviewSound)
                    trayError = nil
                    trayUpdated = Date()
                } catch { if !Task.isCancelled { trayError = error.localizedDescription } }
            }
        }
    }

    func refreshUsage() {
        guard usageTask == nil, let api else { return }
        usageLoading = true
        usageTask = Task {
            defer { usageTask = nil; usageLoading = false }
            do {
                let value: UsageSnapshot = try await api.get(Routes.USAGE)
                try Task.checkCancellation()
                usage = value
                usageError = nil
            } catch { if !Task.isCancelled { usageError = error.localizedDescription } }
        }
    }

    func acknowledge(_ pr: TrayPR) {
        guard pr.pendingReview else { return }
        acknowledgeReview(repo: pr.repo, number: pr.number)
    }

    public func acknowledgeReview(repo: String, number: Int) {
        let id = "\(repo)#\(number)"
        guard let api else {
            // A notification click can launch the app before backend readiness.
            pendingReviewOpens[id] = (repo, number)
            return
        }
        guard acknowledging.insert(id).inserted else { return }
        let currentGeneration = generation
        Task {
            defer { if generation == currentGeneration { acknowledging.remove(id) } }
            do {
                try await api.acknowledgeReview(repo: repo, number: number)
                guard generation == currentGeneration else { return }
                if let index = prs.firstIndex(where: { $0.id == id }) { prs[index].reviewPending = false }
                refresh()
            } catch { if generation == currentGeneration { trayError = "Could not mark review opened: \(error.localizedDescription)" } }
        }
    }

    func setActivityNotify(_ enabled: Bool) {
        activityNotify = enabled
        let value = enabled ? "on" : "off"
        preferences.set(value, forKey: "native.activityNotify")
        saveSetting("activityNotify", value: value)
    }

    func setReviewSound(_ value: String) {
        reviewSound = value
        preferences.set(value, forKey: "native.reviewSound")
        saveSetting("reviewSound", value: value)
    }

    public func setAppearance(_ value: AppAppearance) {
        appearance = value
        applyAppearance()
        preferences.set(value.rawValue, forKey: "native.theme")
        saveSetting("theme", value: value.rawValue)
    }

    func setUsageAgent(_ value: String) {
        usageAgent = value == "codex" ? "codex" : "claude"
        preferences.set(usageAgent, forKey: "native.usageAgent")
        saveSetting("usageAgent", value: usageAgent)
    }

    private func saveSetting(_ key: String, value: String) {
        pendingSettings[key] = value
        preferences.set(pendingSettings, forKey: "native.pendingSettings")
        settingsRevision += 1
        let revision = settingsRevision
        guard let api else { settingsError = "Preference saved locally; connect to sync it."; return }
        let previous = settingsWrite
        settingsWrite = Task {
            await previous?.value // Preserve rapid user changes in their original order.
            do {
                try Task.checkCancellation()
                try await api.setSetting(key, value: value)
                if pendingSettings[key] == value {
                    pendingSettings.removeValue(forKey: key)
                    preferences.set(pendingSettings, forKey: "native.pendingSettings")
                }
                if settingsRevision == revision {
                    settingsError = pendingSettings.isEmpty ? nil : "Some preferences are saved locally; reconnect to sync them."
                }
            } catch { if !Task.isCancelled && settingsRevision == revision { settingsError = error.localizedDescription } }
        }
    }

    func loadSettings() {
        guard settingsTask == nil, let api else { return }
        let revision = settingsRevision
        settingsTask = Task {
            defer { settingsTask = nil }
            // Wait for our writes before accepting a snapshot of the settings.
            await settingsWrite?.value
            do {
                let settings: [String: String?] = try await api.get(Routes.SETTINGS)
                try Task.checkCancellation()
                guard revision == settingsRevision else { return }
                if pendingSettings["theme"] == nil {
                    appearance = AppAppearance(rawValue: (settings["theme"] ?? nil) ?? "auto") ?? .system
                }
                if pendingSettings["usageAgent"] == nil {
                    usageAgent = (settings["usageAgent"] ?? nil) == "codex" ? "codex" : "claude"
                }
                if pendingSettings["activityNotify"] == nil { activityNotify = (settings["activityNotify"] ?? nil) != "off" }
                if pendingSettings["reviewSound"] == nil { reviewSound = (settings["reviewSound"] ?? nil) ?? "system" }
                preferences.set(appearance.rawValue, forKey: "native.theme")
                preferences.set(usageAgent, forKey: "native.usageAgent")
                preferences.set(activityNotify ? "on" : "off", forKey: "native.activityNotify")
                preferences.set(reviewSound, forKey: "native.reviewSound")
                applyAppearance()
                if pendingSettings.isEmpty { settingsError = nil }
            } catch { if !Task.isCancelled { settingsError = error.localizedDescription } }
        }
    }

    func stop() async {
        generation += 1
        acknowledging.removeAll()
        trayTask?.cancel(); usageTask?.cancel(); settingsTask?.cancel()
        await trayTask?.value; await usageTask?.value; await settingsTask?.value
        await settingsWrite?.value
        await notifications.stop()
        trayTask = nil; usageTask = nil; settingsTask = nil; settingsWrite = nil
        api = nil
    }
}
