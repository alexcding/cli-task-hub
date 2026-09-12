// Run from the repository root: swift macos/scripts/generate-app-icon.swift
// Render the editable Flow mark into every native macOS icon size.
import AppKit

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .deletingLastPathComponent()
let source = root.appendingPathComponent("Branding/flow-mark.svg")
let destination = root.appendingPathComponent("TaskHub/Assets.xcassets/AppIcon.appiconset")
guard let image = NSImage(contentsOf: source) else {
    fatalError("Cannot load \(source.path)")
}
var entries: [[String: String]] = []
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let filename = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0,
            bitsPerPixel: 0
        )!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        NSGraphicsContext.current?.imageInterpolation = .high
        let width = Double(pixels) * 0.88
        let height = width * image.size.height / image.size.width
        image.draw(in: NSRect(x: (Double(pixels) - width) / 2,
                              y: (Double(pixels) - height) / 2,
                              width: width, height: height),
                   from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        try bitmap.representation(using: .png, properties: [:])!
            .write(to: destination.appendingPathComponent(filename))
        entries.append(["filename": filename, "idiom": "mac",
                        "size": "\(size)x\(size)", "scale": "\(scale)x"])
    }
}
let contents: [String: Any] = ["images": entries,
                               "info": ["author": "xcode", "version": 1]]
var json = try JSONSerialization.data(withJSONObject: contents,
                                      options: [.prettyPrinted, .sortedKeys])
json.append(0x0A)
try json.write(to: destination.appendingPathComponent("Contents.json"))
print("Generated \(entries.count) Flow app icons from \(source.path)")
