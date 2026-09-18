import AppKit
import Foundation
import GhosttyTerminal
import Testing

@Test func terminalStyleRendersSmoothingAndFontTogether() {
    let rendered = TerminalStyle().resolve().configuration.rendered
    #expect(rendered.contains("font-size = 13"))
    // Smoothing is on by default: without it libghostty renders thinner than the Ghostty app.
    #expect(rendered.contains("font-thicken = true"))
    #expect(rendered.contains("font-thicken-strength = 10"))

    let custom = TerminalStyle(font: CodeFont(family: "Menlo", size: 18), thicken: true, thickenStrength: 40)
    let customRendered = custom.resolve().configuration.rendered
    #expect(customRendered.contains("font-family = Menlo"))
    #expect(customRendered.contains("font-size = 18"))
    #expect(customRendered.contains("font-thicken-strength = 40"))

    // Strength is meaningless with smoothing off, so it is not emitted at all.
    let off = TerminalStyle(thicken: false).resolve().configuration.rendered
    #expect(off.contains("font-thicken = false"))
    #expect(!off.contains("font-thicken-strength"))
}

@Test func terminalStyleClampsSmoothingStrengthToWhatGhosttyAccepts() {
    // A strength outside 0...255 is a config diagnostic, and one bad line fails the whole config.
    #expect(TerminalStyle.clampThickenStrength("300") == TerminalStyle.thickenStrengthRange.upperBound)
    #expect(TerminalStyle.clampThickenStrength("-4") == TerminalStyle.thickenStrengthRange.lowerBound)
    #expect(TerminalStyle.clampThickenStrength("40") == 40)
    #expect(TerminalStyle.clampThickenStrength("not a number") == TerminalStyle.defaultThickenStrength)
    #expect(TerminalStyle.clampThickenStrength(nil) == TerminalStyle.defaultThickenStrength)
}

@Test func terminalStyleResolvesCatalogueThemesAndReportsUnknownOnes() throws {
    let named = TerminalStyle(darkTheme: "Xcode Dark", lightTheme: "Xcode Light").resolve()
    #expect(named.issues.isEmpty)
    #expect(named.theme.dark != TerminalTheme.default.dark)
    #expect(named.theme.light != TerminalTheme.default.light)
    #expect(named.theme.dark.rendered.contains("background"))

    // An unknown name is reported and leaves that side on the default, rather than failing the
    // whole configuration and costing the pane its colours.
    let unknown = TerminalStyle(darkTheme: "No Such Theme").resolve()
    #expect(unknown.issues.count == 1)
    #expect(unknown.issues[0].contains("No Such Theme"))
    #expect(unknown.theme.dark == TerminalTheme.default.dark)

    // Empty means the package default pair, not a lookup of "".
    let empty = TerminalStyle().resolve()
    #expect(empty.issues.isEmpty)
    #expect(empty.theme == TerminalTheme.default)

    #expect(TerminalStyle.themeNames.contains("Xcode Dark"))
    #expect(TerminalStyle.themeNames == TerminalStyle.themeNames.sorted())
}

/// The keys are only useful if libghostty actually accepts them. `prepareConfig` rejects a config
/// whose diagnostics are non-empty and records the reason, so a surface that comes up with no
/// issue and the keys present in its rendered config is proof they were parsed, not just emitted.
@MainActor @Test func terminalSurfaceAcceptsTheSmoothingKeysItIsGiven() {
    _ = NSApplication.shared
    let resolved = TerminalStyle(font: CodeFont(size: 13)).resolve()
    let state = TerminalViewState(theme: resolved.theme, terminalConfiguration: resolved.configuration)
    let rendered = state.renderedConfig
    #expect(rendered.contains("font-thicken = true"))
    #expect(rendered.contains("font-thicken-strength = 10"))
    #expect(state.controller.lastConfigurationIssue == nil)

    // And the same for a theme drawn from the catalogue, whose palette is the largest thing we
    // hand over: 16 colours plus background, foreground, cursor and selection.
    let themed = TerminalStyle(darkTheme: "Xcode Dark").resolve()
    let themedState = TerminalViewState(theme: themed.theme, terminalConfiguration: themed.configuration)
    themedState.adopt(terminalColorScheme: .dark)
    #expect(themedState.controller.lastConfigurationIssue == nil)
    #expect(themedState.renderedConfig.contains("palette = "))
}
