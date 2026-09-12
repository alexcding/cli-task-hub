import Foundation
import Observation

@MainActor @Observable public final class NotificationStore {
    private(set) var permission: NotificationPermission = .unavailable
    private(set) var error: String?
    private(set) var requesting = false
    private(set) var recent: [NativeNotice] = []
    private(set) var toast: NativeNotice?
    @ObservationIgnored public var isMainWindowFocused: () -> Bool = { false }
    @ObservationIgnored var onOpen: (NativeNotice) -> Void = { _ in }
    @ObservationIgnored private var delivery: (any NotificationDelivery)?
    @ObservationIgnored private var reviewTracker = ReviewAnnouncementTracker()
    @ObservationIgnored private var activityKeys: [Data] = []
    @ObservationIgnored private var tasks: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var toastTask: Task<Void, Never>?

    func configure(_ delivery: any NotificationDelivery) {
        self.delivery = delivery
        refreshAuthorization()
    }

    public func refreshAuthorization() {
        guard let delivery else { return }
        enqueue { [weak self] in
            let access = await delivery.access()
            if !Task.isCancelled { self?.permission = access.permission }
        }
    }

    func enable() {
        guard !requesting, let delivery else { return }
        requesting = true
        enqueue { [weak self] in
            guard let self else { return }
            defer { requesting = false }
            do {
                try await delivery.requestAuthorization()
                permission = await delivery.access().permission
                error = nil
            } catch { self.error = error.localizedDescription }
        }
    }

    func previewSound(_ sound: String) {
        guard sound != "off", let delivery else { return }
        do { try delivery.playReviewSound(sound); error = nil }
        catch { self.error = error.localizedDescription }
    }

    func receiveReviews(_ prs: [TrayPR], sound: String) {
        let fresh = reviewTracker.consume(prs)
        guard !fresh.isEmpty else { return }
        let notices = fresh.map {
            NativeNotice(kind: .review, title: "Review requested", body: "PR #\($0.number) \($0.title)",
                         url: $0.webURL?.absoluteString, repo: $0.repo, number: $0.number)
        }
        deliver(notices, reviewSound: sound)
    }

    func receiveActivity(_ event: ActivityEvent, enabled: Bool) {
        // The server has no replay IDs. Deduplicate recent identical timestamped
        // events, bounded independently of the visible recent activity list.
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        if event.created_at != nil, let key = try? encoder.encode(event) {
            if activityKeys.contains(key) { return }
            activityKeys.append(key)
            if activityKeys.count > 256 { activityKeys.removeFirst(activityKeys.count - 256) }
        }
        let notice = event.message
        recent.insert(notice, at: 0)
        if recent.count > 20 { recent.removeLast(recent.count - 20) }
        guard enabled else { return }
        if isMainWindowFocused() { showToast(notice) }
        else { deliver([notice]) }
    }

    private func deliver(_ notices: [NativeNotice], reviewSound: String? = nil) {
        guard let delivery else { return }
        enqueue { [weak self] in
            guard let self else { return }
            let access = await delivery.access()
            guard !Task.isCancelled else { return }
            permission = access.permission
            guard access.permission == .authorized else { return }
            var delivered = false
            for notice in notices {
                do {
                    try Task.checkCancellation()
                    try await delivery.deliver(notice)
                    delivered = true
                    error = nil
                } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            }
            if !Task.isCancelled, delivered, access.soundAllowed, let reviewSound, reviewSound != "off" {
                do { try delivery.playReviewSound(reviewSound) }
                catch { self.error = "Could not play review sound: \(error.localizedDescription)" }
            }
        }
    }

    // Used if focus changed between receiving an activity event and the OS callback.
    func showToast(_ notice: NativeNotice) {
        toastTask?.cancel()
        toast = notice
        toastTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(8)) } catch { return }
            self?.toast = nil
        }
    }

    func dismissToast() { toastTask?.cancel(); toastTask = nil; toast = nil }
    func open(_ notice: NativeNotice) { onOpen(notice); dismissToast() }

    private func enqueue(_ action: @escaping @MainActor () async -> Void) {
        let id = UUID()
        tasks[id] = Task { [weak self] in
            await action()
            self?.tasks.removeValue(forKey: id)
        }
    }

    func waitForDelivery() async {
        for task in Array(tasks.values) { await task.value }
    }

    func stop() async {
        dismissToast()
        let pending = Array(tasks.values)
        pending.forEach { $0.cancel() }
        for task in pending { await task.value }
        tasks.removeAll()
        // Keep review markers across a backend reconnect. Failed reads never seed
        // or clear the tracker, so recovery cannot re-alert every pending review.
    }
}
