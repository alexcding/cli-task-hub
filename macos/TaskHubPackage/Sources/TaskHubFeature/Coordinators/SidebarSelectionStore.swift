import Foundation

@MainActor protocol SidebarSelectionPersisting {
    func load() -> SidebarDestination?
    func save(_ destination: SidebarDestination)
}

@MainActor final class TransientSidebarSelectionStore: SidebarSelectionPersisting {
    private var value: SidebarDestination?
    init(_ value: SidebarDestination? = nil) { self.value = value }
    func load() -> SidebarDestination? { value }
    func save(_ destination: SidebarDestination) { value = destination }
}

@MainActor struct UserDefaultsSidebarSelectionStore: SidebarSelectionPersisting {
    let preferences: UserDefaults
    init(preferences: UserDefaults = .standard) { self.preferences = preferences }
    func load() -> SidebarDestination? {
        guard let data = preferences.data(forKey: "sidebar.selection") else { return nil }
        return try? JSONDecoder().decode(SidebarDestination.self, from: data)
    }
    func save(_ destination: SidebarDestination) {
        if let data = try? JSONEncoder().encode(destination) { preferences.set(data, forKey: "sidebar.selection") }
    }
}
