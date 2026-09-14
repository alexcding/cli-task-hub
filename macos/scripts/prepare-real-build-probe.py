#!/usr/bin/env python3
"""Copy an XcodeBuildMCP sample into the isolated UI fixture and add launch reporting."""
import json
from pathlib import Path
import shutil
import sys
import uuid


def prepare(directory: Path, template: Path):
    directory = directory.resolve()
    template = template.resolve()
    if not directory.name.startswith("taskhub-browser-ui."):
        raise ValueError("Expected an isolated browser UI fixture directory")
    if not (template / "TaskHubBuildProbe.xcworkspace").is_dir():
        raise ValueError("Scaffold TaskHubBuildProbe with XcodeBuildMCP first")
    target = directory / "sidebar-2"
    shutil.copytree(template, target, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(".git", ".build", ".swiftpm", ".xcodebuildmcp"))
    identifier = "com.alexcding.taskhub.acceptance.buildprobe.b" + uuid.uuid4().hex
    config = target / "Config/Shared.xcconfig"
    config.write_text(config.read_text() + "\nPRODUCT_BUNDLE_IDENTIFIER = " + identifier + "\n")
    base = (directory / "ready").read_text().strip()
    endpoint = base + "/fixture/real-build-report"
    source = target / "TaskHubBuildProbePackage/Sources/TaskHubBuildProbeFeature/ContentView.swift"
    source.write_text('''import Foundation
import SwiftUI

private actor BuildProbeReporter {
    func run() async {
        while !Task.isCancelled {
            do {
                var request = URLRequest(url: URL(string: ENDPOINT)!)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "bundleID": Bundle.main.bundleIdentifier ?? "",
                    "pid": ProcessInfo.processInfo.processIdentifier
                ])
                _ = try await URLSession.shared.data(for: request)
                try await Task.sleep(for: .seconds(1))
            } catch {
                if Task.isCancelled { return }
                print("TaskHub build probe report: \\(error.localizedDescription)")
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}

public struct ContentView: View {
    private let reporter = BuildProbeReporter()
    public init() {}
    public var body: some View {
        Text("TaskHub build workflow is running")
            .accessibilityIdentifier("taskhub-build-probe")
            .task { await reporter.run() }
    }
}
'''.replace("ENDPOINT", json.dumps(endpoint)))
    # The fixture only talks to its own loopback server, never a remote service.
    plist = target / "Config/Probe-Info.plist"
    import plistlib
    plist.write_bytes(plistlib.dumps({"NSAppTransportSecurity": {"NSAllowsLocalNetworking": True}}))
    with config.open("a") as file:
        file.write("INFOPLIST_FILE = Config/Probe-Info.plist\n")
    (directory / "build-probe.json").write_text(json.dumps({"bundleID": identifier, "workspace": str(target)}))
    print(identifier)


if __name__ == "__main__":
    prepare(Path(sys.argv[1]), Path(sys.argv[2]))
