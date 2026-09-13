import Foundation

enum ProjectSaveSource: Equatable { case configuration, workflows, automation }

struct ProjectFeatureServices {
    let projects: any ProjectService
    let tickets: any JiraService
    let workflows: any WorkflowService
    let automation: any AutomationService
    let baseURL: URL
}

@MainActor protocol ProjectFeatureFactory {
    func project(_ project: Project, services: ProjectFeatureServices,
                 openPage: @escaping (OpenPageRequest) async throws -> Void) -> ProjectPageViewModel
}

@MainActor struct NativeProjectFeatureFactory: ProjectFeatureFactory {
    let creation: any CreationFlowFactory
    let desktop: any DesktopActions
    let copy: (String) -> Void

    func project(_ project: Project, services: ProjectFeatureServices,
                 openPage: @escaping (OpenPageRequest) async throws -> Void) -> ProjectPageViewModel {
        let editor = creation.projectEditor(project: project, service: services.projects)
        let board = WebBoardViewModel(projectID: project.id, baseURL: services.baseURL, openPage: openPage,
                                     openBrowser: { desktop.openBrowser($0) })
        let tickets = JiraTicketsViewModel(project: project, service: services.tickets, openPage: openPage,
                                          openBrowser: { desktop.openBrowser($0) }, copy: copy)
        let workflows = WorkflowEditorViewModel(project: project, service: services.workflows)
        let automation = AutomationViewModel(project: project, service: services.automation)
        return ProjectPageViewModel(project: project, service: services.projects, editor: editor, board: board,
                                    tickets: tickets, workflows: workflows, automation: automation)
    }
}
