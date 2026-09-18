import Foundation
import GhosttyTerminal
import GhosttyTheme

/// Everything a terminal surface is configured from, resolved in one place.
///
/// The surface is configured from these settings alone: no Ghostty config file is read, and
/// nothing is inherited from an installed Ghostty app. What the tab shows is what runs.
struct TerminalStyle: Equatable, Sendable {
    var font = CodeFont(size: 13)
    /// Re-applies CoreText font smoothing when glyphs are rasterised. Defaults on: without it
    /// libghostty renders noticeably thinner than the standalone Ghostty app, which is the
    /// state this setting exists to correct.
    var thicken = true
    var thickenStrength = defaultThickenStrength
    /// Theme names from the compiled catalogue. Empty means the package default pair.
    var darkTheme = ""
    var lightTheme = ""

    struct Resolved {
        var configuration = TerminalConfiguration()
        var theme = TerminalTheme.default
        /// Everything that did not apply, in the order it was found. Surfaced in Settings and
        /// above the pane; never fatal, because a bad theme name must not cost you a shell.
        var issues: [String] = []
    }

    func resolve() -> Resolved {
        var resolved = Resolved()
        var configuration = TerminalConfiguration().fontSize(Float(font.size))
        if !font.family.isEmpty { configuration = configuration.fontFamily(font.family) }
        configuration = configuration.fontThicken(thicken)
        if thicken { configuration = configuration.fontThickenStrength(thickenStrength) }
        resolved.configuration = configuration

        var theme = TerminalTheme.default
        for (name, isDark) in [(darkTheme, true), (lightTheme, false)] where !name.isEmpty {
            guard let match = GhosttyThemeCatalog.theme(named: name) else {
                resolved.issues.append("No terminal theme named \(name).")
                continue
            }
            if isDark { theme.dark = match.toTerminalConfiguration() } else { theme.light = match.toTerminalConfiguration() }
        }
        resolved.theme = theme
        return resolved
    }

    /// Theme names offered by the pickers, alphabetical. Computed once: the catalogue runs to
    /// several hundred entries and this is read inside a Picker's ForEach.
    static let themeNames: [String] = GhosttyThemeCatalog.allThemes.map(\.name).sorted()

    /// Whether the catalogue has this theme. A direct lookup, not a scan of `themeNames`.
    static func hasTheme(_ name: String) -> Bool { GhosttyThemeCatalog.theme(named: name) != nil }

    static let thickenStrengthRange: ClosedRange<Int> = 0...255
    static let defaultThickenStrength = 10

    /// Ghostty rejects a strength outside 0...255, and a rejected line fails the whole config.
    static func clampThickenStrength(_ value: Int) -> Int {
        min(thickenStrengthRange.upperBound, max(thickenStrengthRange.lowerBound, value))
    }
    static func clampThickenStrength(_ value: String?) -> Int {
        guard let value, let parsed = Int(value) else { return defaultThickenStrength }
        return clampThickenStrength(parsed)
    }
}
