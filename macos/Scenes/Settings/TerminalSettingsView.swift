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
        TerminalKeybindsSection(shell: shell)
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

// MARK: - Keybindings

/// Settings → Terminal → Keybindings: Ghostty `keybind` lines the user owns. Each row is one
/// binding in Ghostty's own syntax (`shift+enter=text:\x1b\r`). A row is committed with Return,
/// never on blur: an unfinished draft stays a draft until the user says it is done.
struct TerminalKeybindsSection: View {
    let shell: ShellStore

    /// One row of the editor. Identity is stable across removals so focus and bindings never
    /// point at a neighbour after a delete.
    private struct Row: Identifiable, Equatable {
        let id = UUID()
        var text: String
    }

    @State private var rows: [Row] = []
    @FocusState private var focused: Row.ID?

    var body: some View {
        Section {
            ForEach($rows) { $row in
                HStack(spacing: 8) {
                    TextField("key=action", text: $row.text)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                        .focused($focused, equals: row.id)
                        .onSubmit(commit)
                        .accessibilityIdentifier("settings-terminal-keybind-\(row.id.uuidString)")
                    Button {
                        rows.removeAll { $0.id == row.id }
                        commit()
                    } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Remove keybind")
                }
            }
            HStack {
                Button("Add Keybind") {
                    let row = Row(text: "")
                    rows.append(row)
                    focused = row.id
                }
                .accessibilityIdentifier("settings-terminal-keybind-add")
                Spacer()
                Button("Reset to Defaults") { shell.setTerminalKeybinds(TerminalStyle.defaultKeybinds) }
                    .disabled(shell.terminalKeybinds == TerminalStyle.defaultKeybinds)
            }
        } header: {
            Text("Keybindings")
        } footer: {
            Text("Ghostty keybind syntax: modifiers and key, then “=”, then an action. `text:` sends the bytes that follow, with `\\x1b` escapes; the defaults make Shift+Return insert a newline and Shift+Delete clear the line. Press Return to save a row.")
        }
        .onAppear { rows = shell.terminalKeybinds.map { Row(text: $0) } }
        .onChange(of: shell.terminalKeybinds) { _, next in
            // An external change (sync, reset) replaces the rows; a blank row being typed survives.
            if rows.map(\.text).filter({ !$0.isEmpty }) != next { rows = next.map { Row(text: $0) } }
        }
    }

    /// Saves every row; blank rows are dropped. When the store refuses a malformed row it shows
    /// the reason in the section's error line; the rows reload from what is actually bound so
    /// the list never disagrees with the terminal, and the malformed rows stay at the end to fix.
    private func commit() {
        rows.removeAll { $0.text.trimmingCharacters(in: .whitespaces).isEmpty }
        if !shell.setTerminalKeybinds(rows.map(\.text)) {
            let broken = rows.filter { TerminalStyle.keybindProblem($0.text) != nil }
            rows = shell.terminalKeybinds.map { Row(text: $0) } + broken
        }
    }
}
