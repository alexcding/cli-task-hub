// swift-tools-version: 6.1
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "TaskHubFeature",
    platforms: [.macOS(.v14)],
    products: [
        // Products define the executables and libraries a package produces, making them visible to other packages.
        .library(
            name: "TaskHubFeature",
            targets: ["TaskHubFeature"]
        ),
        .executable(name: "TaskHubTerminalStress", targets: ["TaskHubTerminalStress"]),
    ],
    dependencies: [
        // Generated from the locked upstream revisions and maintained patches.
        // Prepare with macos/scripts/build-ghostty-native.py before resolving.
        .package(name: "GhosttyKit", path: "../.build/ghostty-native/package"),
    ],
    targets: [
        .executableTarget(name: "TaskHubTerminalStress", dependencies: ["TaskHubFeature"]),
        // Targets are the basic building blocks of a package, defining a module or a test suite.
        // Targets can depend on other targets in this package and products from dependencies.
        .target(
            name: "TaskHubFeature",
            dependencies: [.product(name: "GhosttyTerminal", package: "GhosttyKit")]
        ),
        .testTarget(
            name: "TaskHubFeatureTests",
            dependencies: [
                "TaskHubFeature"
            ]
        ),
    ]
)
