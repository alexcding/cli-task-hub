import SwiftUI

/// Two panes side by side with a draggable divider. The trailing pane keeps a fixed
/// width the user can drag; the leading pane takes the rest. Hiding the trailing pane
/// gives the leading pane the whole width.
struct ResizableSplitView<Leading: View, Trailing: View>: View {
    let showsTrailing: Bool
    @Binding var trailingWidth: CGFloat
    var minTrailing: CGFloat = 320
    var minLeading: CGFloat = 360
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let trailing: () -> Trailing

    @State private var dragStartWidth: CGFloat?
    @State private var cursorPushed = false

    var body: some View {
        GeometryReader { geometry in
            let maxTrailing = max(minTrailing, geometry.size.width - minLeading)
            let width = min(max(trailingWidth, minTrailing), maxTrailing)
            HStack(spacing: 0) {
                leading().frame(maxWidth: .infinity, maxHeight: .infinity)
                if showsTrailing {
                    divider(width: width, maxTrailing: maxTrailing)
                    trailing().frame(width: width).frame(maxHeight: .infinity)
                }
            }
        }
    }

    private func divider(width: CGFloat, maxTrailing: CGFloat) -> some View {
        Rectangle()
            .fill(Color(nsColor: .separatorColor))
            .frame(width: 1)
            .overlay {
                // A wider invisible hit area so the 1pt line is easy to grab.
                Color.clear.frame(width: 9).contentShape(Rectangle())
                    .onHover(perform: setCursor)
                    .onDisappear { setCursor(false) }
                    .gesture(
                        DragGesture(minimumDistance: 1, coordinateSpace: .global)
                            .onChanged { value in
                                // Seed from the width on screen, not the stored one: storage may
                                // hold a value the current window cannot fit.
                                let start = dragStartWidth ?? width
                                dragStartWidth = start
                                trailingWidth = min(max(start - value.translation.width, minTrailing), maxTrailing)
                            }
                            .onEnded { _ in dragStartWidth = nil }
                    )
            }
    }

    private func setCursor(_ resizing: Bool) {
        guard resizing != cursorPushed else { return }
        cursorPushed = resizing
        if resizing { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
    }
}
