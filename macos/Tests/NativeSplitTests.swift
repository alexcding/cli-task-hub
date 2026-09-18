import AppKit
import SwiftUI
import Testing

@MainActor private func splitFixture(width: CGFloat = 560)
    -> (NativeSplitView<Text, Text>.Controller, NSWindow) {
    let controller = NativeSplitView<Text, Text>.Controller(
        leading: .init(environment: EnvironmentValues(), content: Text("Leading")),
        trailing: .init(environment: EnvironmentValues(), content: Text("Trailing")))
    controller.show(true, width: width)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
                          styleMask: [.titled], backing: .buffered, defer: false)
    // Programmatic windows release themselves on close, which would over-release the strong
    // reference this fixture hands back.
    window.isReleasedWhenClosed = false
    window.contentViewController = controller
    // Adopting the controller shrinks the window to the panes' minimums, so size it afterwards.
    window.setContentSize(NSSize(width: 1200, height: 800))
    window.layoutIfNeeded()
    return (controller, window)
}

/// Laying the split out drives `viewDidLayout` into `setPosition`, which calls back into the
/// `NSSplitViewDelegate` methods this controller overrides. Overriding one of those and calling
/// `super` on it crashed the app at launch with an unrecognized selector, because
/// `NSSplitViewController` only conforms to the protocol, it does not implement every method.
@MainActor @Test(.timeLimit(.minutes(1))) func nativeSplitLaysOutAtTheStoredWidthWithoutCallingAbsentSuperclassMethods() {
    let (controller, window) = splitFixture(width: 560)
    #expect(controller.splitViewItems.count == 2)
    #expect(!controller.splitViewItems[1].isCollapsed)
    #expect(controller.splitView.bounds.width == 1200)
    #expect(abs(controller.trailingHost.view.frame.width - 560) < 1)
    // Wider than the window allows: the pane is clamped, and the leading minimum is honoured.
    controller.show(true, width: 5000)
    window.layoutIfNeeded()
    #expect(controller.leadingHost.view.frame.width >= 360)
    #expect(controller.trailingHost.view.frame.width >= 320)
    window.close()
}

/// A width the controller asked for itself must not be written back as if the user chose it,
/// or a clamped width overwrites the stored one and ratchets it down.
@MainActor @Test(.timeLimit(.minutes(1))) func nativeSplitDoesNotReportBackTheWidthItAppliedItself() async {
    let (controller, window) = splitFixture(width: 560)
    var reported: [CGFloat] = []
    controller.onWidthChange = { reported.append($0) }
    controller.show(true, width: 400)
    window.layoutIfNeeded()
    // Past the debounce, and a sleep rather than a yield loop so the main queue actually drains.
    try? await Task.sleep(for: .milliseconds(400))
    #expect(reported.isEmpty)
    #expect(abs(controller.trailingHost.view.frame.width - 400) < 1)
    window.close()
}

/// A drag must not be able to collapse the pane. Collapsing leaves an empty column behind with no
/// obvious way back, so it stays the toolbar toggle's job. While the pane is up the item refuses to
/// collapse; once the toggle has hidden it, nothing offers a grab band over the space it left.
@MainActor @Test(.timeLimit(.minutes(1))) func nativeSplitLetsOnlyTheToggleCollapseThePane() async {
    let (controller, window) = splitFixture(width: 560)
    #expect(!controller.splitViewItems[1].canCollapse)
    #expect(controller.splitView(controller.splitView, additionalEffectiveRectOfDividerAt: 0).width > 1)
    controller.show(false, width: 560)
    // Hiding is animated, so wait past the animation before reading the result.
    try? await Task.sleep(for: .milliseconds(500))
    window.layoutIfNeeded()
    #expect(controller.splitViewItems[1].isCollapsed)
    #expect(controller.splitView(controller.splitView, additionalEffectiveRectOfDividerAt: 0) == .zero)
    // Reopening restores the pane, its width, its grab band and its refusal to be dragged shut.
    controller.show(true, width: 560)
    try? await Task.sleep(for: .milliseconds(500))
    window.layoutIfNeeded()
    #expect(!controller.splitViewItems[1].isCollapsed)
    #expect(!controller.splitViewItems[1].canCollapse)
    #expect(abs(controller.trailingHost.view.frame.width - 560) < 1)
    #expect(controller.splitView(controller.splitView, additionalEffectiveRectOfDividerAt: 0).width > 1)
    // And it survives the round trip a second time, from a width the user dragged to.
    controller.show(false, width: 560)
    try? await Task.sleep(for: .milliseconds(500))
    controller.show(true, width: 420)
    try? await Task.sleep(for: .milliseconds(500))
    window.layoutIfNeeded()
    #expect(!controller.splitViewItems[1].isCollapsed)
    #expect(abs(controller.trailingHost.view.frame.width - 420) < 1)
    window.close()
}

/// The other half of the write-back: a width the controller did not ask for is the user's, and it
/// is reported once, after the drag settles.
@MainActor @Test(.timeLimit(.minutes(1))) func nativeSplitReportsAWidthItDidNotApplyItself() async {
    let (controller, window) = splitFixture(width: 560)
    var reported: [CGFloat] = []
    controller.onWidthChange = { reported.append($0) }
    // Let the width the fixture applied stop counting as the controller's own doing.
    try? await Task.sleep(for: .milliseconds(150))
    // What a drag leaves behind: a divider somewhere the controller never put it.
    let total = controller.splitView.bounds.width
    controller.splitView.setPosition(total - controller.splitView.dividerThickness - 700, ofDividerAt: 0)
    window.layoutIfNeeded()
    try? await Task.sleep(for: .milliseconds(400))
    #expect(reported.count == 1)
    #expect(abs((reported.first ?? 0) - 700) < 1)
    window.close()
}
