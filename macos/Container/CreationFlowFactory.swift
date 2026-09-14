import Foundation

struct SessionCreationRequest {
    let projects: [Project]
    let selectedProject: String
    let agent: SessionAgent
    let pageURL: String?
}

/// The composition boundary for creation flows. Views never resolve services or
/// construct models; a coordinator requests one model for each presentation.
@MainActor protocol CreationFlowFactory {
    func projectEditor(project: Project?, service: any ProjectService) -> ProjectEditorViewModel
    func newSession(request: SessionCreationRequest, operations: (any SessionCreating)?) -> NewSessionViewModel
    func addPage(openPage: @escaping (String) -> Bool) -> AddPageViewModel
}

@MainActor struct NativeCreationFlowFactory: CreationFlowFactory {
    var chooseFolder: () async -> String? = NativeFolderPicker.choose

    func addPage(openPage: @escaping (String) -> Bool) -> AddPageViewModel {
        AddPageViewModel(openPage: openPage)
    }

    func projectEditor(project: Project?, service: any ProjectService) -> ProjectEditorViewModel {
        ProjectEditorViewModel(project: project, service: service, chooseFolder: chooseFolder)
    }

    func newSession(request: SessionCreationRequest, operations: (any SessionCreating)?) -> NewSessionViewModel {
        let model = NewSessionViewModel(projects: request.projects, selectedProject: request.selectedProject,
                                        operations: operations)
        model.draft.agent = request.agent
        if let url = request.pageURL {
            model.draft.url = url
            if SessionPage.parse(url) != nil { model.draft.branch = url }
        }
        return model
    }
}
