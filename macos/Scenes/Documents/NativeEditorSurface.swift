import AppKit

@MainActor final class NativeEditorSurface: NSObject, EditorSurface, NSTextViewDelegate {
    private final class CodeTextView: NSTextView {
        var saveRequested: () -> Void = {}

        override func keyDown(with event: NSEvent) {
            if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
               event.charactersIgnoringModifiers?.lowercased() == "s" {
                saveRequested()
                return
            }
            super.keyDown(with: event)
        }
    }

    private(set) var view: NSView?
    var changed: (Bool) -> Void = { _ in }
    var failed: (String) -> Void = { _ in }
    var saveRequested: () -> Void = {} {
        didSet { textView?.saveRequested = saveRequested }
    }

    private weak var textView: CodeTextView?
    private var version = 1
    private var savedVersion = 1
    private var readOnly = false
    private var frozen = false
    private var suppressChanges = false
    private var font = CodeFont(size: 12)

    func load(_ value: FileDocumentSnapshot, path: String) async throws {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder

        let editor = CodeTextView(frame: .zero)
        editor.isRichText = false
        editor.importsGraphics = false
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.isAutomaticSpellingCorrectionEnabled = false
        editor.isContinuousSpellCheckingEnabled = false
        editor.allowsUndo = true
        editor.usesFindPanel = true
        editor.isHorizontallyResizable = true
        editor.isVerticallyResizable = true
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = false
        editor.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainerInset = NSSize(width: 10, height: 10)
        editor.setAccessibilityIdentifier("native-code-editor")
        editor.delegate = self
        editor.saveRequested = saveRequested

        suppressChanges = true
        editor.string = value.content
        editor.undoManager?.removeAllActions()
        version = 1
        savedVersion = 1
        readOnly = value.readOnly
        editor.isEditable = !readOnly
        suppressChanges = false

        scroll.documentView = editor
        textView = editor
        view = scroll
        applyFont()
    }

    func textDidChange(_ notification: Notification) {
        guard !suppressChanges else { return }
        version += 1
        changed(version != savedVersion)
    }

    func snapshot(freeze: Bool) async throws -> EditorBuffer {
        guard let textView else { throw BackendError.operation("The editor is no longer available.") }
        if freeze {
            frozen = true
            textView.isEditable = false
        }
        return EditorBuffer(content: textView.string, version: version, dirty: version != savedVersion)
    }

    func acknowledge(version: Int) async throws -> Bool {
        savedVersion = version
        return self.version != savedVersion
    }

    func unfreeze() async throws {
        frozen = false
        textView?.isEditable = !readOnly
    }

    func setAppearance(_ value: AppAppearance) {
        guard let textView else { return }
        switch value {
        case .light:
            textView.appearance = NSAppearance(named: .aqua)
        case .dark:
            textView.appearance = NSAppearance(named: .darkAqua)
        case .system:
            textView.appearance = nil
        }
        textView.drawsBackground = true
        textView.backgroundColor = .textBackgroundColor
        textView.textColor = .textColor
        textView.insertionPointColor = .textColor
    }

    func setFont(_ value: CodeFont) {
        font = value
        applyFont()
    }

    private func applyFont() {
        guard let textView else { return }
        let selected = (font.family.isEmpty ? nil : NSFont(name: font.family, size: CGFloat(font.size)))
            ?? NSFont.monospacedSystemFont(ofSize: CGFloat(font.size), weight: .regular)
        let selection = textView.selectedRanges
        textView.font = selected
        textView.typingAttributes[.font] = selected
        textView.selectedRanges = selection
    }

    func focus(line: Int, column: Int) {
        guard let textView else { return }
        let value = textView.string as NSString
        var offset = 0
        if line > 1 {
            for _ in 1..<line where offset < value.length {
                var start = 0, end = 0, contentsEnd = 0
                value.getLineStart(&start, end: &end, contentsEnd: &contentsEnd,
                                   for: NSRange(location: offset, length: 0))
                offset = end
            }
        }
        offset = min(value.length, offset + max(0, column - 1))
        textView.setSelectedRange(NSRange(location: offset, length: 0))
        textView.scrollRangeToVisible(NSRange(location: offset, length: 0))
        textView.window?.makeFirstResponder(textView)
    }

    func find() {
        guard let textView else { return }
        let sender = NSMenuItem()
        sender.tag = NSTextFinder.Action.showFindInterface.rawValue
        textView.performTextFinderAction(sender)
    }

    func dispose() {
        textView?.delegate = nil
        textView?.saveRequested = {}
        textView = nil
        view?.removeFromSuperview()
        view = nil
        changed = { _ in }
        failed = { _ in }
        saveRequested = {}
    }
}
