import SwiftUI

/// The web app's `.theme-row`: title plus explanatory sub-text on the left, the control on the
/// right. Every native settings row goes through this so a section reads like the matching
/// `.card` in `src/renderer/index.html`.
struct SettingsRow<Content: View>: View {
    let title: String
    var caption: String?
    @ViewBuilder var content: Content

    var body: some View {
        LabeledContent {
            content
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let caption {
                    Text(caption).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// The web `.card-header`: a section title with an action pinned to its right (the Database card's
/// Refresh button, and the CLI/Resource equivalents).
struct SettingsSectionHeader<Trailing: View>: View {
    let title: String
    var busy = false
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            if busy { ProgressView().controlSize(.small) }
            trailing
        }
    }
}

/// The web `.input-reveal`: a secret field with an eye button that flips it to plain text.
struct RevealableSecureField: View {
    let prompt: String
    @Binding var text: String
    @State private var revealed = false

    var body: some View {
        HStack(spacing: 6) {
            Group {
                if revealed { TextField(prompt, text: $text) } else { SecureField(prompt, text: $text) }
            }
            Button { revealed.toggle() } label: { Image(systemName: revealed ? "eye.slash" : "eye") }
                .buttonStyle(.borderless).help(revealed ? "Hide" : "Reveal")
                .accessibilityLabel(revealed ? "Hide token" : "Reveal token")
        }
    }
}

/// A status row shaped like the web `.hook-row`: a fixed-width name, a state label, then actions.
struct SettingsStatusRow<Actions: View>: View {
    let title: String
    let status: String
    var statusIdentifier: String?
    var busy = false
    @ViewBuilder var actions: Actions

    var body: some View {
        HStack(spacing: 8) {
            Text(title).frame(width: 150, alignment: .leading)
            Text(status).foregroundStyle(.secondary).accessibilityIdentifier(statusIdentifier ?? "")
            Spacer()
            if busy { ProgressView().controlSize(.small) }
            actions
        }
    }
}
