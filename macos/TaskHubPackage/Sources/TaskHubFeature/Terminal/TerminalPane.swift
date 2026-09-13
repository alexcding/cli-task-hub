import SwiftUI
import GhosttyTerminal

struct TerminalPane: View {
    @Environment(\.terminalFont) private var font
    let session: TerminalSession
    let reconnect: () -> Void
    var active = true
    var title = "Terminal"
    private var model: TerminalPaneViewModel { session.presentation }
    private var visible: Bool { model.visible }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(title, systemImage: title == "Build" ? "hammer" : "terminal").labelStyle(.iconOnly).help(title)
                Text(session.status).foregroundStyle(.secondary).lineLimit(1)
                if let pid = session.shellPID {
                    Text("PID \(pid)").monospacedDigit().foregroundStyle(.secondary).accessibilityIdentifier("terminal-shell-pid")
                }
                Spacer()
                Toggle("Show terminal", isOn: Binding(get: { visible }, set: { model.visible = $0 })).toggleStyle(.switch).labelsHidden().help("Show terminal")
                    .accessibilityIdentifier("terminal-visibility")
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
                if !visible {
                    Text("Terminal hidden — shell and output parsing continue.").foregroundStyle(.secondary)
                        .accessibilityIdentifier("terminal-hidden")
                }
            }
            .frame(minHeight: 240)
        }
        .background(.background)
        .onAppear { model.appear(active: active) }
        .onDisappear(perform: model.disappear)
        .onChange(of: active) { _, value in model.setActive(value) }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeOcclusionStateNotification), perform: model.windowOcclusionChanged)
        .onChange(of: font) { _, value in model.setFont(value) }
        .task { await model.start(font: font) }
    }
}
