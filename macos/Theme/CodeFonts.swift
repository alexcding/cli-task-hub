import CoreText
import Foundation
import Observation
import SwiftUI
import GhosttyTerminal

enum CodeFontKind: String, CaseIterable, Identifiable {
    case term, diff
    var id: String { rawValue }
    var title: String { self == .term ? "Terminal" : "Code and diffs" }
    /// Row label and sub-text as the web Appearance card words them.
    var rowTitle: String { self == .term ? "Terminal font" : "Code font" }
    var rowCaption: String {
        self == .term ? "⌘+ / ⌘− resize the pane in view, ⌘0 resets" : "The code editor & the Changes pane (git diff)"
    }
    var defaultSize: Int { self == .term ? 13 : 12 }
}

struct CodeFont: Codable, Equatable, Sendable {
    let family: String
    let size: Int
    init(family: String = "", size: Int) {
        self.family = Self.validFamily(family) ? family : ""
        self.size = min(24, max(9, size))
    }
    init(_ kind: CodeFontKind, settings: [String: String]) {
        self.init(family: settings["\(kind.rawValue)_font_family"] ?? "",
                  size: Int(settings["\(kind.rawValue)_font_size"] ?? "") ?? kind.defaultSize)
    }
    static func validFamily(_ value: String) -> Bool {
        value.utf8.count <= 256 && value.rangeOfCharacter(from: .controlCharacters.union(.newlines)) == nil
    }
    var json: String { String(decoding: try! JSONEncoder().encode(self), as: UTF8.self) }
    var terminalConfiguration: TerminalConfiguration {
        let config = TerminalConfiguration().fontSize(Float(size))
        return family.isEmpty ? config : config.fontFamily(family)
    }
}

private struct TerminalFontKey: EnvironmentKey { static let defaultValue = CodeFont(size: 13) }
private struct DocumentFontKey: EnvironmentKey { static let defaultValue = CodeFont(size: 12) }
extension EnvironmentValues {
    var terminalFont: CodeFont {
        get { self[TerminalFontKey.self] } set { self[TerminalFontKey.self] = newValue }
    }
    var documentFont: CodeFont {
        get { self[DocumentFontKey.self] } set { self[DocumentFontKey.self] = newValue }
    }
}

protocol CodeFontCatalog: Sendable { func families() async -> [String] }
actor InstalledCodeFontCatalog: CodeFontCatalog {
    func families() -> [String] {
        let names = CTFontManagerCopyAvailableFontFamilyNames() as? [String] ?? []
        return names.filter { name in
            CodeFont.validFamily(name) && CTFontGetSymbolicTraits(CTFontCreateWithName(name as CFString, 13, nil)).contains(.traitMonoSpace)
        }
    }
}

@MainActor @Observable final class FontSettingsViewModel {
    private(set) var families: [String] = []
    private(set) var loading = false
    @ObservationIgnored private let catalog: any CodeFontCatalog
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    init(catalog: any CodeFontCatalog) { self.catalog = catalog }
    func refresh() {
        guard task == nil else { return }
        loading = true
        let generation = generation
        task = Task {
            defer { if self.generation == generation { task = nil; loading = false } }
            let result = await catalog.families()
            if !Task.isCancelled && self.generation == generation { families = result }
        }
    }
    func cancelRead() -> Task<Void, Never>? {
        let pending = task; generation = UUID(); task?.cancel(); task = nil; loading = false; return pending
    }
    func stop() async { await cancelRead()?.value }
}

struct FontSettingsView: View {
    let model: FontSettingsViewModel
    let shell: ShellStore
    // Rows for a grouped Form; the caller owns the Section.
    var body: some View {
        ForEach(CodeFontKind.allCases) { kind in
            let font = shell.font(kind)
            SettingsRow(title: kind.rowTitle, caption: kind.rowCaption) {
                VStack(alignment: .trailing, spacing: 6) {
                    Picker(kind.rowTitle, selection: Binding(get: { shell.font(kind).family }, set: { shell.setFont(kind, family: $0) })) {
                        Text("Default").tag("")
                        ForEach(model.families, id: \.self) { Text($0).tag($0) }
                        if !font.family.isEmpty && !model.families.contains(font.family) {
                            Text("\(font.family) (not available here)").tag(font.family)
                        }
                    }.labelsHidden().frame(maxWidth: 240)
                        .accessibilityIdentifier("settings-\(kind.rawValue)-font-family")
                    HStack(spacing: 8) {
                        // Keep the kind in the label: the two steppers are otherwise identical to
                        // VoiceOver and to `staticTexts[…]` in TaskHubUITests.
                        Stepper("\(kind.title) size: \(font.size)", value: Binding(get: { shell.font(kind).size }, set: { shell.setFont(kind, size: $0) }), in: 9...24)
                            .fixedSize().accessibilityIdentifier("settings-\(kind.rawValue)-font-size")
                        Button("Reset") { shell.setFont(kind, size: kind.defaultSize) }
                            .buttonStyle(.borderless).disabled(font.size == kind.defaultSize)
                            .accessibilityIdentifier("settings-\(kind.rawValue)-font-reset")
                    }
                    Text("let greeting = \"Hello, 日本語 👋\"")
                        .font(font.family.isEmpty ? .system(size: CGFloat(font.size), design: .monospaced)
                                                 : .custom(font.family, size: CGFloat(font.size)))
                        .lineLimit(1).foregroundStyle(.secondary)
                }
            }
        }
        HStack {
            Text("Defaults use each renderer’s monospace font. Unavailable saved families are kept and fall back locally.")
                .font(.caption).foregroundStyle(.secondary)
            Spacer()
            Button("Refresh Font List", action: model.refresh).disabled(model.loading)
        }
    }
}
