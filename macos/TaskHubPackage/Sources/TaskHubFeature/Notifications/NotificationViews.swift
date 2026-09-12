import SwiftUI

struct NotificationPreferencesView: View {
    let shell: ShellStore
    var sounds: [ReviewSound] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Notifications").font(.headline)
            Text(shell.notifications.permission.label).font(.caption).foregroundStyle(.secondary)
            if shell.notifications.permission == .notDetermined {
                Button("Enable Notifications") { shell.notifications.enable() }
                    .disabled(shell.notifications.requesting)
            } else if shell.notifications.permission == .denied {
                Text("Allow TaskHub Native in System Settings → Notifications.").font(.caption)
            }
            Toggle("Activity alerts", isOn: Binding(get: { shell.activityNotify }, set: shell.setActivityNotify))
            Picker("Review sound", selection: Binding(get: { shell.reviewSound }, set: shell.setReviewSound)) {
                Text("Glass (default)").tag("system")
                Text("None").tag("off")
                ForEach(sounds) { Text($0.name).tag($0.path) }
                if !["system", "off"].contains(shell.reviewSound) && !sounds.contains(where: { $0.path == shell.reviewSound }) {
                    Text(URL(fileURLWithPath: shell.reviewSound).deletingPathExtension().lastPathComponent)
                        .tag(shell.reviewSound)
                }
            }
            if let error = shell.notifications.error { Text(error).font(.caption).foregroundStyle(.orange) }
        }
    }
}

struct RecentActivityView: View {
    let notifications: NotificationStore
    var body: some View {
        if !notifications.recent.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Recent activity").font(.headline)
                ForEach(notifications.recent) { notice in
                    VStack(alignment: .leading, spacing: 3) {
                        if notice.url != nil {
                            Button(notice.title) { notifications.open(notice) }.buttonStyle(.link)
                        } else { Text(notice.title).fontWeight(.medium) }
                        if !notice.body.isEmpty { Text(notice.body).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
        }
    }
}

struct ActivityToastView: View {
    let notifications: NotificationStore
    var body: some View {
        if let notice = notifications.toast {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "bell")
                Button { notifications.open(notice) } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(notice.title).fontWeight(.semibold)
                        if !notice.body.isEmpty { Text(notice.body).font(.callout).lineLimit(3) }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain)
                Button("Dismiss activity", systemImage: "xmark", action: notifications.dismissToast)
                    .labelStyle(.iconOnly).buttonStyle(.plain)
            }
            .padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
            .accessibilityIdentifier("activity-toast")
        }
    }
}
