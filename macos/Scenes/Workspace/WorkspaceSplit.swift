import AppKit
import SwiftUI

// AppKit owns pane geometry and collapse. Hosting views render into those bounds
// without feeding their ideal sizes back into the split controller's constraints.
struct WorkspaceSplit<Left: View, Right: View, Build: View>: NSViewControllerRepresentable {
    let showsLeft: Bool
    let showsRight: Bool
    let showsBuild: Bool
    @ViewBuilder var left: () -> Left
    @ViewBuilder var right: () -> Right
    @ViewBuilder var build: () -> Build

    final class Controller: NSSplitViewController {
        let leftHost: NSHostingController<Left>
        let rightHost: NSHostingController<Right>
        let buildHost: NSHostingController<Build>
        private var presentation: [Bool]?
        private var leftFraction: CGFloat = 0.5
        private var needsBalance = false
        init(left: Left, right: Right, build: Build) {
            leftHost = NSHostingController(rootView: left)
            rightHost = NSHostingController(rootView: right)
            buildHost = NSHostingController(rootView: build)
            super.init(nibName: nil, bundle: nil)
            leftHost.sizingOptions = []; rightHost.sizingOptions = []; buildHost.sizingOptions = []
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func viewDidLoad() {
            super.viewDidLoad()
            splitView.isVertical = true
            splitView.dividerStyle = .thin
            for host in [leftHost as NSViewController, rightHost, buildHost] {
                let item = NSSplitViewItem(viewController: host)
                item.canCollapse = true
                item.collapseBehavior = .preferResizingSiblingsWithFixedSplitView
                item.minimumThickness = 180
                addSplitViewItem(item)
            }
        }
        override func viewDidLayout() {
            super.viewDidLayout()
            guard needsBalance, splitView.bounds.width > 361 else { return }
            needsBalance = false
            let width = splitView.bounds.width - splitView.dividerThickness
            // Honor both pane minima so setPosition cannot collapse a pane.
            splitView.setPosition(min(max(width * leftFraction, 180), width - 180), ofDividerAt: 0)
        }
        func show(left: Bool, right: Bool, build: Bool) {
            _ = view
            let next = [left, right, build]
            guard next != presentation else { return }
            if let previous = presentation, previous[0], previous[1] || previous[2],
               splitView.bounds.width > 361 {
                leftFraction = leftHost.view.frame.width / (splitView.bounds.width - splitView.dividerThickness)
            }
            presentation = next
            needsBalance = left && (right || build)
            // Expand the destination first, so the split never has zero visible panes.
            if left, splitViewItems[0].isCollapsed { splitViewItems[0].isCollapsed = false }
            if right, splitViewItems[1].isCollapsed { splitViewItems[1].isCollapsed = false }
            if build, splitViewItems[2].isCollapsed { splitViewItems[2].isCollapsed = false }
            if !left, !splitViewItems[0].isCollapsed { splitViewItems[0].isCollapsed = true }
            if !right, !splitViewItems[1].isCollapsed { splitViewItems[1].isCollapsed = true }
            if !build, !splitViewItems[2].isCollapsed { splitViewItems[2].isCollapsed = true }
            view.needsLayout = true
        }
    }
    func makeNSViewController(context: Context) -> Controller {
        let controller = Controller(left: left(), right: right(), build: build())
        controller.show(left: showsLeft, right: showsRight, build: showsBuild)
        return controller
    }
    func updateNSViewController(_ controller: Controller, context: Context) {
        controller.leftHost.rootView = left()
        controller.rightHost.rootView = right()
        controller.buildHost.rootView = build()
        controller.show(left: showsLeft, right: showsRight, build: showsBuild)
    }
}
