import SwiftUI
import GhosttyTerminal

struct TerminalPane: View {
    let session: TerminalSession
    private var model: TerminalPaneViewModel { session.presentation }
    private var visible: Bool { model.visible }

    var body: some View {
        VStack(spacing: 0) {
            if let error = session.error {
                Text(error).foregroundStyle(.orange).textSelection(.enabled).padding(10)
            }
            if let error = session.fontError { Text(error).foregroundStyle(.orange).padding(8) }
            ZStack {
                TerminalSurfaceView(context: session.surface)
                    .id(session.surfaceGeneration)
                    .opacity(visible ? 1 : 0)
                    .allowsHitTesting(visible && session.ready)
            }
            .frame(minHeight: 240)
        }
        .background(.background)
        .onAppear(perform: model.appear)
        .onDisappear(perform: model.disappear)
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeOcclusionStateNotification), perform: model.windowOcclusionChanged)
        .task { await model.start() }
    }
}
