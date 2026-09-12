import AppKit
import SwiftUI

// AppKit owns pane geometry and collapse. Hosting views render into those bounds
// without feeding their ideal sizes back into the split controller's constraints.
struct WorkspaceSplit<Left: View, Right: View>: NSViewControllerRepresentable {
    let showsLeft: Bool
    let showsRight: Bool
    @ViewBuilder var left: () -> Left
    @ViewBuilder var right: () -> Right

    final class Controller: NSSplitViewController {
        let leftHost: NSHostingController<Left>
        let rightHost: NSHostingController<Right>
        init(left: Left, right: Right) {
            leftHost = NSHostingController(rootView: left)
            rightHost = NSHostingController(rootView: right)
            super.init(nibName: nil, bundle: nil)
            leftHost.sizingOptions = []; rightHost.sizingOptions = []
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func viewDidLoad() {
            super.viewDidLoad()
            splitView.isVertical = true
            splitView.dividerStyle = .thin
            for host in [leftHost as NSViewController, rightHost] {
                let item = NSSplitViewItem(viewController: host)
                item.canCollapse = true
                item.minimumThickness = 180
                addSplitViewItem(item)
            }
        }
        func show(left: Bool, right: Bool) {
            _ = view
            // Expand the destination first, so the split never has zero visible panes.
            if left, splitViewItems[0].isCollapsed { splitViewItems[0].isCollapsed = false }
            if right, splitViewItems[1].isCollapsed { splitViewItems[1].isCollapsed = false }
            if !left, !splitViewItems[0].isCollapsed { splitViewItems[0].isCollapsed = true }
            if !right, !splitViewItems[1].isCollapsed { splitViewItems[1].isCollapsed = true }
        }
    }
    func makeNSViewController(context: Context) -> Controller {
        let controller = Controller(left: left(), right: right())
        controller.show(left: showsLeft, right: showsRight)
        return controller
    }
    func updateNSViewController(_ controller: Controller, context: Context) {
        controller.leftHost.rootView = left()
        controller.rightHost.rootView = right()
        controller.show(left: showsLeft, right: showsRight)
    }
}
