import SwiftUI

struct GitHistoryView: View {
    @Bindable var model: GitHistoryViewModel
    let appearance: AppAppearance
    let active: Bool
    @FocusState private var finding: Bool
    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) {
              HStack {
                Picker("History scope", selection: $model.scope) {
                    ForEach(GitHistoryScope.allCases) { Text($0.rawValue).tag($0) }
                }.labelsHidden().frame(maxWidth: 220)
                Spacer()
                if model.loading { ProgressView().controlSize(.small) }
                Button("Refresh History", systemImage: "arrow.clockwise", action: model.refresh).labelStyle(.iconOnly).disabled(model.loading)
              }
              TextField("Search loaded commits", text: $model.search).textFieldStyle(.roundedBorder).focused($finding)
            }.padding(10)
            if let error = model.error { Text(error).font(.callout).foregroundStyle(.orange).padding(.horizontal, 10) }
            VSplitView {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.contextLabel).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 10)
                    List(selection: Binding(get: { model.selectedSHA }, set: model.select)) {
                        ForEach(model.rows) { commit in
                            HStack(spacing: 10) {
                                Text(commit.initials).font(.caption.bold()).frame(width: 30, height: 30)
                                    .background(.quaternary, in: Circle()).accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(commit.subject).lineLimit(1).fontWeight(.medium)
                                    if !commit.refs.isEmpty {
                                        Text(commit.refs.map(\.name).joined(separator: " · ")).font(.caption2).foregroundStyle(.tint).lineLimit(1)
                                    }
                                    Text("\(commit.author) · \(commit.dateLabel) · \(commit.short)")
                                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }.tag(commit.sha).accessibilityIdentifier("history-commit-\(commit.sha)")
                        }
                    }.listStyle(.inset).accessibilityIdentifier("git-history-list")
                    if model.rows.isEmpty, !model.loading { Text(model.emptyLabel).foregroundStyle(.secondary).padding(10) }
                    if model.hasMore {
                        Button(model.loadingMore ? "Loading Older Commits…" : "Load Older Commits", action: model.loadMore)
                            .disabled(model.loading || model.loadingMore).padding(.horizontal, 10).padding(.bottom, 8)
                    }
                }.frame(minHeight: 130, idealHeight: 220)
                VStack(alignment: .leading, spacing: 0) {
                    if model.loadingDetail { ProgressView("Loading commit…").padding() }
                    else if let error = model.detailError {
                        Text(error).foregroundStyle(.orange).padding()
                        Button("Retry Commit", action: model.retryDetail).padding(.horizontal)
                    } else if let detail = model.detail {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(detail.meta.subject).font(.headline).lineLimit(2)
                                Spacer()
                                Button("Copy Commit SHA", systemImage: "doc.on.doc", action: model.copySHA).labelStyle(.iconOnly)
                            }
                            Text(detail.meta.authorLabel).font(.caption).foregroundStyle(.secondary)
                            if detail.meta.message != detail.meta.subject {
                                ScrollView { Text(detail.meta.message).font(.callout).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 90)
                            }
                        }.padding(10).textSelection(.enabled)
                        if let patch = model.patch { DiffView(model: patch, appearance: appearance, active: active, title: "Commit Changes").id(detail.meta.sha) }
                    } else {
                        ContentUnavailableView("Select a commit", systemImage: "clock.arrow.circlepath")
                    }
                }.frame(minHeight: 160, maxHeight: .infinity)
            }
        }
        .onChange(of: model.findRequest) { _, _ in finding = true }
        .onAppear { if active { model.show() } }
        .onChange(of: active) { _, value in if value { model.show() } else { model.hide() } }
        .onDisappear { model.hide() }
    }
}
