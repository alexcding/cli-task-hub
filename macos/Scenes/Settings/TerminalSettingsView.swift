import SwiftUI

/// Settings → Terminal: the font, the glyph rendering and the colour theme of the Ghostty
/// surface. These settings are the whole of its configuration; nothing is read from a Ghostty
/// config file or inherited from an installed Ghostty app.
struct TerminalSettingsView: View {
    let fonts: FontSettingsViewModel
    let shell: ShellStore

    var body: some View {
        FontSettingsView(model: fonts, shell: shell, kinds: [.term])
        rendering
        theme
        if let error = shell.settingsError {
            Section { Text(error).foregroundStyle(Theme.danger) }
        }
    }

    // MARK: - Rendering

    @ViewBuilder private var rendering: some View {
        Section("Rendering") {
            SettingsRow(title: "Font smoothing",
                        caption: "Thickens glyphs the way the standalone Ghostty app does. Off renders noticeably thinner, especially for light weights on a dark background.") {
                Toggle("Font smoothing", isOn: Binding(get: { shell.terminalFontThicken }, set: shell.setTerminalFontThicken))
                    .labelsHidden().accessibilityIdentifier("settings-terminal-thicken")
            }
            if shell.terminalFontThicken {
                LabeledContent {
                    VStack(spacing: 1) {
                        Slider(value: Binding(get: { Double(shell.terminalFontThickenStrength) },
                                              set: { shell.setTerminalFontThickenStrength(Int($0.rounded())) }),
                               in: Double(TerminalStyle.thickenStrengthRange.lowerBound)...Double(TerminalStyle.thickenStrengthRange.upperBound),
                               step: 1)
                            .accessibilityIdentifier("settings-terminal-thicken-strength")
                            .accessibilityValue("\(shell.terminalFontThickenStrength), default \(TerminalStyle.defaultThickenStrength)")
                        SliderDefaultMarker(value: Double(TerminalStyle.defaultThickenStrength),
                                            range: Double(TerminalStyle.thickenStrengthRange.lowerBound)...Double(TerminalStyle.thickenStrengthRange.upperBound))
                    }
                } label: {
                    Text("Smoothing strength: \(shell.terminalFontThickenStrength)")
                    Text("Low values thicken subtly; high values read as bold.")
                }
            }
        }
    }

    // MARK: - Theme

    /// One theme per appearance, so the terminal follows the app between light and dark the same
    /// way the rest of the window does. Default is the palette the terminal package ships with.
    @ViewBuilder private var theme: some View {
        Section("Theme") {
            themeRow(title: "Dark", identifier: "dark", selection: shell.terminalDarkTheme) { shell.setTerminalTheme(dark: $0) }
            themeRow(title: "Light", identifier: "light", selection: shell.terminalLightTheme) { shell.setTerminalTheme(light: $0) }
        }
    }

    @ViewBuilder
    private func themeRow(title: String, identifier: String, selection: String,
                          set: @escaping (String) -> Void) -> some View {
        SettingsRow(title: title) {
            Picker(title, selection: Binding(get: { selection }, set: set)) {
                Text("Default").tag("")
                ForEach(TerminalStyle.themeNames, id: \.self) { Text($0).tag($0) }
            }
            .labelsHidden().accessibilityIdentifier("settings-terminal-theme-\(identifier)")
        }
    }
}
