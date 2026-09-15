import SwiftUI

struct WebBoardView: View {
    let model: WebBoardViewModel
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                if let sprint = model.snapshot?.sprint?.name { Text(sprint).font(.headline) }
                Spacer()
                Picker("Assignee", selection: Bindable(model).assigneeFilter) {
                    Text("All assignees").tag("")
                    Text("Unassigned").tag("__unassigned__")
                    ForEach(model.assignees, id: \.id) { Text($0.name).tag($0.id) }
                }.frame(width: 190)
                if model.loading { ProgressView().controlSize(.small) }
                Button("Refresh Board", systemImage: "arrow.clockwise") { model.reload() }.labelStyle(.iconOnly)
            }
            if let query = model.snapshot?.query, !query.isEmpty { Text(query).font(.caption).foregroundStyle(.secondary) }
            if let error = model.navigation.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
            if let error = model.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
            if model.columns.isEmpty && !model.loading {
                ContentUnavailableView("No Active Sprint", systemImage: "rectangle.3.group")
            } else {
                ScrollView(.horizontal) {
                    LazyHStack(alignment: .top, spacing: 12) {
                        ForEach(model.columns, id: \.self) { column in BoardLane(model: model, column: column) }
                    }.padding(.bottom, 8)
                }
            }
        }
    }
}

private struct BoardLane: View {
    let model: WebBoardViewModel
    let column: String
    var body: some View {
        let tickets = model.tickets(in: column)
        VStack(alignment: .leading, spacing: 8) {
            HStack { Text(column).font(.headline); Spacer(); Text("\(tickets.count)").foregroundStyle(.secondary) }
            // Bound each lane to the viewport. Eager stacks measured every card
            // (and its menus) on tab entry and compressed long lanes to fit.
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(tickets) { ticket in BoardCard(model: model, ticket: ticket) }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .padding(.bottom, 30)
            }
        }.padding(10).frame(width: 280, alignment: .topLeading).frame(maxHeight: .infinity, alignment: .topLeading)
            .background(.quaternary.opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
            .dropDestination(for: String.self) { values, _ in
                guard let key = values.first, let ticket = model.tickets.first(where: { $0.key == key }) else { return false }
                model.move(ticket, to: column); return true
            }
    }
}

private struct BoardCard: View {
    let model: WebBoardViewModel
    let ticket: JiraTicket
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(ticket.summary ?? "").font(.body.weight(.medium)).frame(maxWidth: .infinity, alignment: .leading)
            HStack {
                Button(ticket.key) { model.open(ticket) }.buttonStyle(.link)
                Text([ticket.type, ticket.priority].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Menu(ticket.assignee ?? "Assign") {
                    Button("Unassigned") { model.assign(ticket, to: "") }
                    Divider()
                    ForEach(model.assignees, id: \.id) { person in Button(person.name) { model.assign(ticket, to: person.id) } }
                }
                Menu("Move") {
                    ForEach(model.columns.filter { $0 != ticket.status }, id: \.self) { status in Button(status) { model.move(ticket, to: status) } }
                }
            }
        }.padding(10).background(.background, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator)).draggable(ticket.key)
            .opacity(model.busy.contains(ticket.key) ? 0.55 : 1)
            .contextMenu { Button("Open Ticket") { model.open(ticket) }; Button("Open in Browser") { model.open(ticket, external: true) } }
    }
}
