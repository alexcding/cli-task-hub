import SwiftUI
import GhosttyTerminal

struct TerminalPane: View {
    let session: TerminalSession
    let reconnect: () -> Void
    @State private var visible = true

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label("Terminal", systemImage: "terminal")
                Text(session.status).foregroundStyle(.secondary)
                if let pid = session.shellPID { Text("PID \(pid)").monospacedDigit().foregroundStyle(.secondary) }
                Spacer()
                Toggle("Show terminal", isOn: $visible).toggleStyle(.switch)
                Button("Reattach", action: reconnect)
            }.font(.callout).padding(12)
            Divider()
            if let error = session.error {
                Text(error).foregroundStyle(.orange).textSelection(.enabled).padding(10)
            }
            ZStack {
                TerminalSurfaceView(context: session.surface)
                    .opacity(visible ? 1 : 0)
                    .allowsHitTesting(visible && session.ready)
                if !visible { Text("Terminal hidden — shell and output parsing continue.").foregroundStyle(.secondary) }
            }
            .frame(minHeight: 240)
        }
        .background(.background)
        .onChange(of: visible) { _, shown in
            session.surface.isSurfaceVisible = shown
            if shown { session.surface.requestFocus() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeOcclusionStateNotification)) { notification in
            guard let window = notification.object as? NSWindow,
                  window === session.surface.attachedPlatformView?.window else { return }
            session.surface.isSurfaceVisible = visible && window.occlusionState.contains(.visible)
        }
        .task { await session.start() }
    }
}
