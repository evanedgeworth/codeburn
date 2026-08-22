// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CodeBurnMenubar",
    platforms: [
        // macOS 14 (Sonoma) is the floor: matches Info.plist LSMinimumSystemVersion,
        // the CLI install guard (MIN_MACOS_MAJOR=14), and mac/README. The earlier .v15
        // bump for NSAttributedString(attachment:) was a misdiagnosis, that initializer
        // is AppKit since macOS 10.0, so the binary's minos must not exclude Sonoma users.
        .macOS(.v14)
    ],
    products: [
        .executable(name: "CodeBurnMenubar", targets: ["CodeBurnMenubar"])
    ],
    dependencies: [
        // The standalone macOS 26.2 Command Line Tools bundle omits the
        // _Testing_Foundation module metadata required by Testing.framework.
        // Pin the official package to the installed Swift 6.2.3 toolchain.
        .package(url: "https://github.com/swiftlang/swift-testing.git", exact: "6.2.3")
    ],
    targets: [
        .executableTarget(
            name: "CodeBurnMenubar",
            path: "Sources/CodeBurnMenubar",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency")
            ]
        ),
        .testTarget(
            name: "CodeBurnMenubarTests",
            dependencies: [
                "CodeBurnMenubar",
                .product(name: "Testing", package: "swift-testing")
            ],
            path: "Tests/CodeBurnMenubarTests"
        )
    ]
)
