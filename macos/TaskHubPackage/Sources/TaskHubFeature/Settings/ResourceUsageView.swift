import AppKit
import SwiftUI

struct ResourceUsageView: View {
    let model: ResourceUsageViewModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Process resources").font(.headline)
                Spacer()
                if model.loading { ProgressView().controlSize(.small) }
                Button("Refresh Resources", action: model.refresh).disabled(model.loading)
            }
            HStack(spacing: 24) {
                Text("Listed memory: \(model.memory)").accessibilityIdentifier("resources-memory")
                Text("Listed CPU: \(model.cpu)").accessibilityIdentifier("resources-cpu")
            }.monospacedDigit()
            Text("CPU updates every 3 seconds while this view is active; 100% means one CPU core. Memory is resident size and may count shared pages more than once.")
                .font(.caption).foregroundStyle(.secondary)
            Text("Includes the app, connected backend, PTY helper and their descendants. macOS-managed WebKit/GPU processes outside these trees are excluded. Totals cover only listed processes.")
                .font(.caption).foregroundStyle(.secondary)
            if let error = model.error {
                Text(error).foregroundStyle(.orange)
                if model.updatedAt != nil { Text("Showing the last successful sample.").foregroundStyle(.secondary) }
            }
            ForEach(model.notes, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
            Table(model.rows) {
                TableColumn("Component") { Text($0.process.group.rawValue) }.width(85)
                TableColumn("Process") { Text($0.process.name) }
                TableColumn("PID") { Text(String($0.process.pid)).monospacedDigit() }.width(65)
                TableColumn("Memory") { Text($0.memory).monospacedDigit() }.width(90)
                TableColumn("CPU") { Text($0.cpu).monospacedDigit() }.width(90)
            }.accessibilityIdentifier("resources-processes")
            if let date = model.updatedAt {
                Text("Sampled \(date.formatted(date: .omitted, time: .standard))").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
