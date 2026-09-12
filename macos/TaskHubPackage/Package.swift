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
    ],
    dependencies: [
        .package(url: "https://github.com/Lakr233/libghostty-spm.git", exact: "1.6.20260909"),
    ],
    targets: [
        // Targets are the basic building blocks of a package, defining a module or a test suite.
        // Targets can depend on other targets in this package and products from dependencies.
        .target(
            name: "TaskHubFeature",
            dependencies: [.product(name: "GhosttyTerminal", package: "libghostty-spm")]
        ),
        .testTarget(
            name: "TaskHubFeatureTests",
            dependencies: [
                "TaskHubFeature"
            ]
        ),
    ]
)
