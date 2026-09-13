import Foundation
import Observation

/// Owns presentation identity and model lifetime, following elevate-ios's
/// route -> model-bearing destination -> rendering view separation.
@MainActor @Observable final class AppCoordinator {
    struct Sheet: Identifiable {
        enum Destination {
            case newProject(ProjectEditorViewModel)
            case newSession(NewSessionViewModel)
            case addPage(AddPageViewModel)
        }
        let id: UUID
        let destination: Destination

        @MainActor var canDismiss: Bool {
            switch destination {
            case .newProject(let model): !model.busy
            case .newSession(let model): !model.creating
            case .addPage: true
            }
        }
    }

    private(set) var sheet: Sheet?
    @ObservationIgnored private let factory: any CreationFlowFactory

    init(factory: any CreationFlowFactory) { self.factory = factory }

    func presentAddPage(openPage: @escaping (String) -> Bool) {
        guard sheet == nil else { return }
        let id = UUID()
        let model = factory.addPage(openPage: { [weak self] address in
            guard self?.sheet?.id == id else { return false }
            return openPage(address)
        }, didOpen: { [weak self] in _ = self?.complete(id) })
        sheet = Sheet(id: id, destination: .addPage(model))
    }

    func presentNewProject(service: any ProjectService, didSave: @escaping (Project) -> Void) {
        guard sheet == nil else { return }
        let id = UUID()
        let model = factory.projectEditor(project: nil, service: service, didSave: { [weak self] project in
            guard self?.complete(id) == true else { return }
            didSave(project)
        }, didDelete: { _ in })
        sheet = Sheet(id: id, destination: .newProject(model))
    }

    func presentNewSession(request: SessionCreationRequest, operations: SessionOperations?,
                           didCreate: @escaping (WorkspaceSession) -> Void) {
        guard sheet == nil else { return }
        let id = UUID()
        let model = factory.newSession(request: request, operations: operations, didCreate: { [weak self] session in
            guard self?.complete(id) == true else { return }
            didCreate(session)
        })
        sheet = Sheet(id: id, destination: .newSession(model))
    }

    func dismissSheet(id: UUID) {
        guard sheet?.id == id, sheet?.canDismiss == true else { return }
        sheet = nil
    }

    private func complete(_ id: UUID) -> Bool {
        guard sheet?.id == id else { return false }
        sheet = nil
        return true
    }
}
