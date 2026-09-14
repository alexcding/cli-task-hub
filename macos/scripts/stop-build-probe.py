#!/usr/bin/env python3
"""Clean up only the uniquely identified simulator app from a real-build fixture."""
import json
from pathlib import Path
import re
import subprocess
import sys


def stop(directory: Path, simulator: str):
    directory = directory.resolve()
    if not directory.name.startswith("taskhub-browser-ui."):
        raise ValueError("Expected an isolated browser UI fixture")
    identifier = json.loads((directory / "build-probe.json").read_text())["bundleID"]
    if not re.fullmatch(r"com\.alexcding\.taskhub\.acceptance\.buildprobe\.b[0-9a-f]{32}", identifier):
        raise ValueError("Expected this fixture's unique probe bundle identifier")
    if not re.fullmatch(r"[0-9A-Fa-f-]{36}", simulator):
        raise ValueError("Expected a simulator UDID")
    result = subprocess.run(["xcodebuildmcp", "simulator", "stop", "--simulator-id", simulator,
                             "--bundle-id", identifier, "--output", "json"], capture_output=True, text=True)
    output = result.stdout + result.stderr
    if "found nothing to terminate" in output:
        print("Build probe already stopped")
        return
    response = json.loads(result.stdout)
    if result.returncode or response.get("didError"):
        raise RuntimeError(output)
    print("Stopped isolated build probe")


if __name__ == "__main__":
    stop(Path(sys.argv[1]), sys.argv[2])
