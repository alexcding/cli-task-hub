import SwiftUI

struct DiffView: View {
    @Bindable var model: DiffViewModel
    var title = "Changes"
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(title, systemImage: "arrow.triangle.branch").font(.headline).lineLimit(1)
                if let branch = model.snapshot?.branch { Text(branch).foregroundStyle(.secondary).lineLimit(1) }
                Spacer()
                if model.actions != nil {
                    Button("Commit and Push…", systemImage: "arrow.up.circle", action: model.requestActions).disabled(model.actions?.busy == true)
                }
                if model.loading || model.actions?.busy == true { ProgressView().controlSize(.small) }
                Button("Refresh Changes", systemImage: "arrow.clockwise", action: model.refresh)
                    .labelStyle(.iconOnly).disabled(model.loading || model.actions?.busy == true)
            }.padding(10)
            if let error = model.error {
                HStack { Text(error).font(.callout).foregroundStyle(.orange); Spacer(); Button("Reload Changes", action: model.reload) }.padding(10)
            }
            Divider()
            NativeDiffBody(model: model)
        }
        .sheet(isPresented: Binding(get: { model.coordinator.showsActions }, set: { if !$0 { model.coordinator.dismissActions() } })) {
            if let actions = model.actions { GitChangesSheet(model: actions) }
        }
        .sheet(item: Binding(get: { model.coordinator.discardProposal }, set: { if $0 == nil { model.coordinator.dismissDiscard() } })) { proposal in
            if let actions = model.actions { DiscardChangeSheet(model: actions, proposal: proposal) }
        }
    }
}

private struct NativeDiffBody: View {
    let model: DiffViewModel
    var body: some View {
        if model.loading && model.snapshot == nil { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
        else if model.files.isEmpty && model.snapshot?.untracked.isEmpty != false { ContentUnavailableView("No Changes", systemImage: "checkmark.circle") }
        else {
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(model.files) { file in
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(spacing: 8) {
                                Button(file.path) { model.open(path: file.path, line: 1) }.buttonStyle(.link)
                                Text("+\(file.additions)").foregroundStyle(.green); Text("−\(file.deletions)").foregroundStyle(.red)
                            }.font(.system(size: CGFloat(model.font.size), weight: .semibold, design: .monospaced))
                                .padding(.horizontal, 10).padding(.vertical, 7).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary)
                            ForEach(file.lines.prefix(2_000)) { line in NativeDiffRow(model: model, file: file, line: line) }
                            if file.lines.count > 2_000 { Text("Diff truncated: \(file.lines.count - 2_000) more lines").foregroundStyle(.secondary).padding(8) }
                        }.clipShape(RoundedRectangle(cornerRadius: 7)).overlay(RoundedRectangle(cornerRadius: 7).stroke(.separator))
                    }
                    if let untracked = model.snapshot?.untracked, !untracked.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Untracked Files").font(.headline)
                            ForEach(untracked, id: \.self) { path in Button(path) { model.open(path: path, line: 1) }.buttonStyle(.link) }
                        }.padding(10)
                    }
                }.padding(12).frame(minWidth: 700, alignment: .leading)
            }
        }
    }
}

private struct NativeDiffRow: View {
    let model: DiffViewModel
    let file: NativeDiffFile
    let line: NativeDiffLine
    private var background: Color {
        switch line.kind { case .addition: .green.opacity(0.13); case .deletion: .red.opacity(0.13); case .metadata: .blue.opacity(0.08); case .context: .clear }
    }
    var body: some View {
        HStack(spacing: 0) {
            Text(line.oldLine.map(String.init) ?? "").frame(width: 44, alignment: .trailing)
            Text(line.newLine.map(String.init) ?? "").frame(width: 44, alignment: .trailing)
            Text(line.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            if line.beginsBlock, let selection = line.selection, model.actions != nil {
                Button("Discard Block", systemImage: "trash") { model.discard(selection) }.labelStyle(.iconOnly).buttonStyle(.borderless).padding(.horizontal, 5)
            }
        }.font(.system(size: CGFloat(model.font.size), design: .monospaced))
            .foregroundStyle(line.kind == .metadata ? .secondary : .primary).padding(.vertical, 1).background(background)
            .contentShape(Rectangle()).onTapGesture(count: 2) { model.open(path: file.path, line: line.newLine ?? line.oldLine) }
    }
}
