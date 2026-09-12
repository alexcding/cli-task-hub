import AppKit

@MainActor enum WorkspaceTab: Identifiable {
    case page(BrowserPage), file(EditorDocumentViewModel)
    nonisolated var id: String { switch self { case .page(let page): page.id; case .file(let file): file.id } }
    @MainActor var title: String { switch self { case .page(let page): page.title.isEmpty ? page.url : page.title; case .file(let file): file.title } }
    @MainActor var dirty: Bool { if case .file(let file) = self { file.dirty } else { false } }
}

enum WorkspaceVisit: Identifiable {
    case page(WebPageRecord), file(FileDocumentRecord)
    var id: String { switch self { case .page(let page): page.id; case .file(let file): file.id } }
    var title: String { switch self { case .page(let page): page.title.isEmpty ? page.url : page.title; case .file(let file): file.path } }
}

@MainActor enum EditorCloseCoordinator {
    enum Choice { case save, discard, cancel }
    static func confirm(_ documents: [EditorDocumentViewModel],
                        choose: (EditorDocumentViewModel) async -> Choice = present) async -> Bool {
        var locked: [EditorDocumentViewModel] = []
        var unsaved: [EditorDocumentViewModel] = []
        do {
            for document in documents {
                if try await document.beginClose() { unsaved.append(document) }
                locked.append(document)
            }
        } catch {
            for document in locked { await document.cancelClose() }
            return false
        }
        for document in unsaved {
            var approved = false
            while !approved {
                switch await choose(document) {
                case .save: approved = await document.save()
                case .discard: approved = true
                case .cancel:
                    for document in locked { await document.cancelClose() }
                    return false
                }
            }
        }
        // Caller disposes all approved documents synchronously before yielding.
        return true
    }
    private static func present(_ document: EditorDocumentViewModel) async -> Choice {
        let alert = NSAlert()
        alert.messageText = "Save changes to “\(document.title)” before closing?"
        alert.informativeText = document.error.map { "\($0)\n\nYour changes have not been discarded." } ?? "Your changes will be lost if you discard them."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Discard")
        alert.addButton(withTitle: "Cancel").keyEquivalent = "\u{1b}"
        let response: NSApplication.ModalResponse
        if let window = NSApp.keyWindow { response = await alert.beginSheetModal(for: window) }
        else { response = alert.runModal() }
        switch response { case .alertFirstButtonReturn: return .save; case .alertSecondButtonReturn: return .discard; default: return .cancel }
    }
}
