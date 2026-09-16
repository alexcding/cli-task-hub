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
    static let sizeRange: ClosedRange<Int> = 9...20
}

struct CodeFont: Codable, Equatable, Sendable {
    let family: String
    let size: Int
    init(family: String = "", size: Int) {
        self.family = Self.validFamily(family) ? family : ""
        self.size = min(CodeFontKind.sizeRange.upperBound, max(CodeFontKind.sizeRange.lowerBound, size))
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

/// One `Section` per font kind, so a family and its size read as one group instead of two rows
/// that happen to sit near each other. Every row goes through `SettingsRow`/`LabeledContent`, so
/// the Form owns the alignment.
struct FontSettingsView: View {
    let model: FontSettingsViewModel
    let shell: ShellStore
    var body: some View {
        ForEach(CodeFontKind.allCases) { kind in
            let font = shell.font(kind)
            Section(kind.rowTitle) {
                SettingsRow(title: "Family", caption: kind.rowCaption) {
                    Picker(kind.rowTitle, selection: Binding(get: { shell.font(kind).family }, set: { shell.setFont(kind, family: $0) })) {
                        Text("Default").tag("")
                        ForEach(model.families, id: \.self) { Text($0).tag($0) }
                        if !font.family.isEmpty && !model.families.contains(font.family) {
                            Text("\(font.family) (not available here)").tag(font.family)
                        }
                    }.labelsHidden().accessibilityIdentifier("settings-\(kind.rawValue)-font-family")
                }
                LabeledContent {
                    VStack(spacing: 1) {
                        Slider(value: Binding(get: { Double(shell.font(kind).size) },
                                              set: { shell.setFont(kind, size: Int($0.rounded())) }),
                               in: Double(CodeFontKind.sizeRange.lowerBound)...Double(CodeFontKind.sizeRange.upperBound),
                               step: 1)
                            .accessibilityIdentifier("settings-\(kind.rawValue)-font-size")
                            .accessibilityValue("\(font.size), default \(kind.defaultSize)")
                        SliderDefaultMarker(value: Double(kind.defaultSize),
                                            range: Double(CodeFontKind.sizeRange.lowerBound)...Double(CodeFontKind.sizeRange.upperBound))
                    }
                    // Only the code font claims ⌘0: AppViewModel.fontTarget hard-returns .diff while
                    // Settings → Appearance is showing, so ⌘0 cannot reach the terminal size here.
                    .help(kind == .diff ? "Default \(kind.defaultSize) · ⌘0 resets" : "Default \(kind.defaultSize)")
                } label: {
                    // Keep the kind in the label: the two rows are otherwise identical to
                    // VoiceOver and to `staticTexts[…]` in TaskHubUITests.
                    Text("\(kind.title) size: \(font.size)")
                }
                // The sample gets its own full-width row so longer strings are not clipped.
                Text("let greeting = \"Hello, 日本語 👋\"")
                    .font(font.family.isEmpty ? .system(size: CGFloat(font.size), design: .monospaced)
                                              : .custom(font.family, size: CGFloat(font.size)))
                    .lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
        Section {
            LabeledContent {
                Button("Refresh Font List", action: model.refresh).disabled(model.loading)
            } label: {
                Text("Installed fonts")
                Text("Defaults use each renderer’s monospace font. Unavailable saved families are kept and fall back locally.")
            }
        }
    }
}
