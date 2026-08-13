import AppKit

// 把 iOS 那张 1024 方形图标转成 macOS 风格：缩到画布的 ~80%、四角圆角。
// 直接拿方形图去用，在 Dock 和「应用程序」里会比周围的图标显得又大又方，很出戏。
// macOS 的图标规范是内容留白 + 圆角（连续曲率，这里用 1/5 边长的圆角近似）。

let args = CommandLine.arguments
guard args.count >= 3,
      let src = NSImage(contentsOfFile: args[1]) else {
    FileHandle.standardError.write("用法: makeicon <源png> <输出目录>\n".data(using: .utf8)!)
    exit(1)
}
let outDir = URL(fileURLWithPath: args[2])
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

/// iconset 需要的全套尺寸（@1x / @2x）
let specs: [(name: String, px: Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32),
    ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256),
    ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]

for spec in specs {
    let side = CGFloat(spec.px)
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: spec.px, pixelsHigh: spec.px,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
    rep.size = NSSize(width: side, height: side)

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    let inset = side * 0.10                    // 上下左右各留 10%
    let box = NSRect(x: inset, y: inset, width: side - inset * 2, height: side - inset * 2)
    NSBezierPath(roundedRect: box, xRadius: box.width / 5, yRadius: box.width / 5).setClip()
    src.draw(in: box, from: .zero, operation: .copy, fraction: 1.0)

    NSGraphicsContext.restoreGraphicsState()

    if let png = rep.representation(using: .png, properties: [:]) {
        try? png.write(to: outDir.appending(path: "\(spec.name).png"))
    }
}
print("图标已生成 \(specs.count) 个尺寸")
