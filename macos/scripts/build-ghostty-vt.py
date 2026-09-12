#!/usr/bin/env python3
"""Build the pinned headless snapshot runtime without installing global tools."""
import argparse
import hashlib
import json
import platform
import subprocess
import urllib.request
from pathlib import Path


def run(*args, cwd=None):
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--zig", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--local-cache", type=Path)
    parser.add_argument("--global-cache", type=Path)
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        parser.error("The native TaskHub runtime currently targets Apple Silicon macOS.")
    lock = json.loads(Path(__file__).with_name("ghostty-vt.lock.json").read_text())
    build = Path(__file__).resolve().parents[1] / ".build" / "ghostty-vt"
    build.mkdir(parents=True, exist_ok=True)
    source = (args.source or build / "source").resolve()
    if not source.exists():
        run("git", "clone", "--filter=blob:none", "--no-checkout", lock["repository"], source)
        run("git", "switch", "--detach", lock["revision"], cwd=source)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    if revision != lock["revision"]:
        parser.error("Source checkout does not match ghostty-vt.lock.json; use a fresh build directory.")
    run("git", "diff", "--exit-code", "HEAD", "--", cwd=source)
    zig = args.zig
    if zig is None:
        tools = build / "tools"
        tools.mkdir(exist_ok=True)
        archive = tools / "zig.tar.xz"
        zig = tools / f"zig-aarch64-macos-{lock['zigVersion']}" / "zig"
        if not zig.exists():
            with urllib.request.urlopen(lock["zigURL"]) as response, archive.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if hashlib.sha256(archive.read_bytes()).hexdigest() != lock["zigSHA256"]:
                parser.error("Zig toolchain checksum mismatch.")
            run("tar", "-xJf", archive, "-C", tools)
    zig = zig.resolve()
    version = subprocess.check_output([str(zig), "version"], text=True).strip()
    if version != lock["zigVersion"]:
        parser.error("Zig version does not match ghostty-vt.lock.json.")
    output = (args.output or build / "runtime").resolve()
    run(zig, "build", "-Demit-lib-vt", "-Demit-exe=false", "-Demit-macos-app=false",
        "-Demit-xcframework=false", "-Doptimize=ReleaseFast", "--prefix", output,
        "--cache-dir", (args.local_cache or build / "local-cache").resolve(),
        "--global-cache-dir", (args.global_cache or build / "global-cache").resolve(), cwd=source)
    if not (output / "lib" / "libghostty-vt.a").is_file():
        parser.error("The build did not produce the static snapshot library.")
    (output / "taskhub-ghostty-revision").write_text(revision + "\n")
    print(f"Pinned terminal snapshot runtime: {output}")


if __name__ == "__main__":
    main()
