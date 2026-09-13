import SwiftUI
import GhosttyTerminal

struct TerminalPane: View {
    @Environment(\.terminalFont) private var font
    let session: TerminalSession
    let reconnect: () -> Void
    var active = true
    var title = "Terminal"
    private var visible: Bool { session.showsSurface }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(title, systemImage: title == "Build" ? "hammer" : "terminal").labelStyle(.iconOnly).help(title)
                Text(session.status).foregroundStyle(.secondary).lineLimit(1)
                if let pid = session.shellPID {
                    Text("PID \(pid)").monospacedDigit().foregroundStyle(.secondary).accessibilityIdentifier("terminal-shell-pid")
                }
                Spacer()
                Toggle("Show terminal", isOn: Binding(get: { visible }, set: { session.showsSurface = $0 })).toggleStyle(.switch).labelsHidden().help("Show terminal")
                Button("Reattach", systemImage: "arrow.triangle.2.circlepath", action: reconnect).labelStyle(.iconOnly).help("Reattach")
            }.font(.callout).padding(12)
            Divider()
            if let error = session.error {
                Text(error).foregroundStyle(.orange).textSelection(.enabled).padding(10)
            }
            if let error = session.fontError { Text(error).foregroundStyle(.orange).padding(8) }
            ZStack {
                TerminalSurfaceView(context: session.surface)
                    .id(session.surfaceGeneration)
                    .opacity(visible ? 1 : 0)
                    .allowsHitTesting(visible && session.ready)
                if !visible { Text("Terminal hidden — shell and output parsing continue.").foregroundStyle(.secondary) }
            }
            .frame(minHeight: 240)
        }
        .background(.background)
        .onChange(of: visible) { _, shown in
            updateVisibility()
            if shown && active && session.ready { session.surface.requestFocus() }
        }
        .onChange(of: active) { _, _ in updateVisibility() }
        .onChange(of: session.surfaceGeneration) { _, _ in updateVisibility() }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeOcclusionStateNotification)) { notification in
            guard let window = notification.object as? NSWindow,
                  window === session.surface.attachedPlatformView?.window else { return }
            session.surface.isSurfaceVisible = active && visible && window.occlusionState.contains(.visible)
        }
        .onChange(of: font) { _, value in session.setFont(value) }
        .task { session.setFont(font); updateVisibility(); await session.start() }
    }

    private func updateVisibility() {
        session.isActive = active
        let view = session.surface.attachedPlatformView
        let window = view?.window
        session.surface.isSurfaceVisible = active && visible && (window?.occlusionState.contains(.visible) ?? true)
        if (!active || !visible), let view, window?.firstResponder === view {
            window?.makeFirstResponder(nil)
        }
    }
}
