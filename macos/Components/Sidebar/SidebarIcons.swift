import AppKit

// The web sidebar's own glyphs (src/renderer/lib/icons.js + index.html), rendered from the
// same SVG so both shells draw identical marks. Stroke icons are templates tinted by the
// row; brand marks (Jira) keep their colours.
@MainActor enum SidebarIcons {
    private static let stroke = ##"xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round""##
    // .nav-btn .icon svg overrides every nav icon to one 1.9 stroke (layout.css).
    private static let sources: [String: String] = [
        "dashboard": ##"<svg \##(stroke) stroke-width="1.9"><rect x="2" y="3" width="20" height="17" rx="2.5"/><path d="M2 8.5h20"/><path d="M9.5 8.5V20"/></svg>"##,
        "folder": ##"<svg \##(stroke) stroke-width="1.9"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M2 10h20"/></svg>"##,
        "folderOpen": ##"<svg \##(stroke) stroke-width="1.9"><path d="M4 20l2.6-8.3a1 1 0 0 1 .95-.7H22a1 1 0 0 1 .96 1.28l-1.9 6.3a2 2 0 0 1-1.91 1.42H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>"##,
        "plus": ##"<svg \##(stroke) stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>"##,
        "appPlus": ##"<svg \##(stroke) stroke-width="1.9"><path d="M12 5v14M5 12h14"/></svg>"##,
        "bell": ##"<svg \##(stroke) stroke-width="1.9"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z"/><path d="M10 21a2.2 2.2 0 0 0 4 0"/></svg>"##,
        "settings": ##"<svg \##(stroke) stroke-width="1.9"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>"##,
        "globe": ##"<svg \##(stroke) stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/></svg>"##,
        "pin": ##"<svg \##(stroke) stroke-width="1.7"><g transform="rotate(45 12 12)"><path d="M9.4 4h5.2a1.5 1.5 0 0 1 0 3h-.3v3.5l1.3 1.5a1.15 1.15 0 0 1-.86 1.9H8.66A1.15 1.15 0 0 1 7.8 12l1.3-1.5V7H8.8a1.5 1.5 0 0 1 0-3Z"/><path d="M12 13.9v6.3"/></g></svg>"##,
        "pinFilled": ##"<svg \##(stroke) stroke-width="1.7"><g transform="rotate(45 12 12)"><path fill="#000" d="M9.4 4h5.2a1.5 1.5 0 0 1 0 3h-.3v3.5l1.3 1.5a1.15 1.15 0 0 1-.86 1.9H8.66A1.15 1.15 0 0 1 7.8 12l1.3-1.5V7H8.8a1.5 1.5 0 0 1 0-3Z"/><path d="M12 13.9v6.3"/></g></svg>"##,
        "github": ##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#000" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>"##,
        "jira": ##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#2684FF" d="M14.7 7.3 8.5 1.1 7.9.5 3.2 5.2l-2 2a1 1 0 0 0 0 1.4l4 4 .7.7 4.7-4.7 1.4-1.4a1 1 0 0 0 0-.9zM7.9 9.8 5.8 7.7l2.1-2.1L10 7.7 7.9 9.8z"/><path fill="#2684FF" opacity=".6" d="M7.9 5.6a3.5 3.5 0 0 1 0-4.9L3.2 5.2 5.8 7.7 7.9 5.6zM10 7.7 7.9 9.8a3.5 3.5 0 0 1 0 4.9l4.7-4.7L10 7.7z"/></svg>"##,
    ]
    private static var cache: [String: NSImage] = [:]

    /// `size` is the drawn box in points (the web's CSS px).
    static func image(_ name: String, size: CGFloat = 16) -> NSImage? {
        let key = "\(name)@\(size)"
        if let hit = cache[key] { return hit }
        guard let svg = sources[name], let image = NSImage(data: Data(svg.utf8)) else { return nil }
        image.size = NSSize(width: size, height: size)
        image.isTemplate = name != "jira"
        image.accessibilityDescription = name
        cache[key] = image
        return image
    }
}
