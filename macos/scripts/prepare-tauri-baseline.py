#!/usr/bin/env python3
"""Stage a pinned, isolated Tauri source tree for full-app terminal comparisons.

Does not build, launch, start a server, or terminate processes. The manifest gives
the private runtime paths and Cargo build arguments. Keep it with measurements.
"""

import argparse
import difflib
import hashlib
import io
import json
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tarfile
import tempfile
from urllib.parse import urlsplit
import uuid


def origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or parsed.port is None or not 1024 <= parsed.port <= 65535
            or parsed.port == 3000):
        raise ValueError("Use an explicit http://127.0.0.1:<private fixture port> origin, excluding port 3000")
    canonical = f"http://127.0.0.1:{parsed.port}"
    if value not in (canonical, canonical + "/"):
        raise ValueError("Use the canonical numeric loopback origin")
    return canonical


def replace_function(source, signature, body):
    # Top-level functions in these pinned files end with an unindented brace.
    # Fail if an upstream change makes the expected signature ambiguous/missing.
    pattern = re.escape(signature) + r" \{\n.*?^\}"
    result, count = re.subn(pattern, lambda _: signature + " {\n" + body + "\n}",
                            source, flags=re.MULTILINE | re.DOTALL)
    if count != 1:
        raise ValueError(f"Expected one function: {signature}; found {count}")
    return result


def isolation_changes(files, backend_origin, runtime, identifier):
    """Return only isolation edits; terminal logic and web assets stay byte-identical."""
    backend_origin = origin(backend_origin)
    changed = {}
    config_path = "src-tauri/tauri.conf.json"
    config = json.loads(files[config_path])
    config.pop("$schema", None)
    config["productName"] = "TaskHub Tauri Baseline"
    config["identifier"] = identifier
    config["build"] = {"frontendDist": "../src/renderer", "devUrl": backend_origin}
    # The registered plugin requires a Config even when no check is scheduled.
    config["plugins"]["updater"]["endpoints"] = []
    config["bundle"] = {"active": False, "icon": config["bundle"]["icon"]}
    changed[config_path] = json.dumps(config, indent=2) + "\n"

    capability_path = "src-tauri/capabilities/remote.json"
    capability = json.loads(files[capability_path])
    capability["remote"]["urls"] = [backend_origin]
    changed[capability_path] = json.dumps(capability, indent=2) + "\n"

    lib_path = "src-tauri/src/lib.rs"
    source = files[lib_path]
    source = replace_function(source, "fn start_backend(handle: &tauri::AppHandle)",
                              '  let _ = handle; // Baseline server is owned by the fixture runner.')
    source = replace_function(source, "fn setup_auto_updates(handle: &tauri::AppHandle)",
                              '  let _ = handle; // Benchmark builds never check or install updates.')
    source = source.replace('"http://localhost:3000"', json.dumps(backend_origin))
    source = source.replace('"127.0.0.1:3000"', json.dumps(backend_origin.removeprefix("http://")))
    source = source.replace('.title("TaskHub")', '.title("TaskHub Tauri Baseline")')
    changed[lib_path] = source
    for name in ("tray", "notify"):
        path = f"src-tauri/src/{name}.rs"
        source = files[path]
        if "http://127.0.0.1:3000" not in source:
            raise ValueError(f"Missing expected backend origin in {path}")
        changed[path] = source.replace("http://127.0.0.1:3000", backend_origin)

    path = "src-tauri/src/terminals.rs"
    changed[path] = replace_function(files[path], "pub(crate) fn ptyd_dir(app: &AppHandle) -> PathBuf",
        f'  let _ = app;\n  PathBuf::from({json.dumps(str(runtime / "tauri-ptyd"))})')
    path = "crates/taskhub-ptyd/src/lib.rs"
    changed[path] = replace_function(files[path], "pub fn sock_path() -> PathBuf",
        f'  PathBuf::from({json.dumps(str(runtime / "tauri.sock"))})')
    for path, source in changed.items():
        if re.search(r'https?://(?:localhost|127\.0\.0\.1):3000', source):
            raise ValueError(f"Production backend origin remains in {path}")
    return changed


def stage(repo, output, backend_origin):
    backend_origin = origin(backend_origin)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    # Pin the archive before any edits; no ignored build output or local data is copied.
    archive = subprocess.check_output(["git", "archive", revision, "src-tauri", "crates", "src", "build/tray-jira.png"], cwd=repo)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(output, filter="data")
    runtime = Path(tempfile.mkdtemp(prefix="th-compare-", dir="/private/tmp"))
    for child in ("backend", "tauri-ptyd", "native"):
        (runtime / child).mkdir(mode=0o700)
    if len(str(runtime / "tauri.sock").encode()) >= 104:
        raise ValueError("Private socket exceeds macOS path limit")
    identifier = "tv.accedo.taskhub.benchmark.b" + uuid.uuid4().hex
    paths = ["src-tauri/tauri.conf.json", "src-tauri/capabilities/remote.json",
             "src-tauri/src/lib.rs", "src-tauri/src/tray.rs", "src-tauri/src/notify.rs",
             "src-tauri/src/terminals.rs", "crates/taskhub-ptyd/src/lib.rs"]
    before = {path: (output / path).read_text() for path in paths}
    after = isolation_changes(before, backend_origin, runtime, identifier)
    patches = []
    hashes = {}
    for path, source in after.items():
        (output / path).write_text(source)
        patches.extend(difflib.unified_diff(before[path].splitlines(keepends=True), source.splitlines(keepends=True),
                                            fromfile="a/" + path, tofile="b/" + path))
        hashes[path] = {"before": hashlib.sha256(before[path].encode()).hexdigest(),
                        "after": hashlib.sha256(source.encode()).hexdigest()}
    (output / "isolation.patch").write_text("".join(patches))
    # A complete post-edit inventory makes future measurements traceable to the
    # exact copied code, including xterm and its addons, bridge, and PTY crate.
    inventory = {str(path.relative_to(output)): hashlib.sha256(path.read_bytes()).hexdigest()
                 for root in ("src-tauri", "crates", "src", "build")
                 for path in sorted((output / root).rglob("*")) if path.is_file()}
    manifest = {"schemaVersion": 1, "sourceRevision": revision, "backendOrigin": backend_origin,
                "sourceRoot": str(output), "runtimeRoot": str(runtime), "bundleIdentifier": identifier,
                "backendDataDir": str(runtime / "backend"), "ptyDirectory": str(runtime / "tauri-ptyd"),
                "ptySocket": str(runtime / "tauri.sock"), "changes": hashes, "sourceSHA256": inventory,
                "buildArguments": ["cargo", "build", "--release", "--locked", "--bin", "taskhub",
                                   "--manifest-path", str(output / "src-tauri/Cargo.toml"),
                                   "--target-dir", str(output / "target")],
                "limitations": ["Preparation only; backend identity/readiness must be verified before launch.",
                                "Tauri uses xterm scrollback=4000 and no terminal-snapshots feature; record native retention separately.",
                                "No performance or terminal acceptance evidence is produced by staging."]}
    (output / "baseline.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def bundle(output):
    manifest = json.loads((output / "baseline.json").read_text())
    for name, expected in manifest["sourceSHA256"].items():
        if hashlib.sha256((output / name).read_bytes()).hexdigest() != expected:
            raise ValueError(f"Staged source changed since preparation: {name}")
    executable = output / "target/release/taskhub"
    data = executable.read_bytes()
    for key in ("backendOrigin", "bundleIdentifier", "ptyDirectory", "ptySocket"):
        if manifest[key].encode() not in data:
            raise ValueError(f"Release binary does not contain its private {key}")
    app = output / "TaskHub Tauri Baseline.app"
    app.mkdir(exist_ok=False)
    contents = app / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    (contents / "Resources").mkdir()
    shutil.copy2(executable, contents / "MacOS/taskhub")
    shutil.copy2(output / "src-tauri/icons/icon.icns", contents / "Resources/icon.icns")
    with (contents / "Info.plist").open("wb") as file:
        plistlib.dump({"CFBundleExecutable": "taskhub", "CFBundleIdentifier": manifest["bundleIdentifier"],
                      "CFBundleName": "TaskHub Tauri Baseline", "CFBundleDisplayName": "TaskHub Tauri Baseline",
                      "CFBundlePackageType": "APPL", "CFBundleVersion": "1.0.0",
                      "CFBundleShortVersionString": "1.0.0", "CFBundleIconFile": "icon.icns",
                      "NSPrincipalClass": "NSApplication", "NSHighResolutionCapable": True,
                      "LSMinimumSystemVersion": "14.0"}, file)
    subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True)
    subprocess.run(["codesign", "--verify", "--strict", str(app)], check=True)
    record = {"appPath": str(app), "sourceRevision": manifest["sourceRevision"],
              "executableSHA256": hashlib.sha256((contents / "MacOS/taskhub").read_bytes()).hexdigest(),
              "baselineManifestSHA256": hashlib.sha256((output / "baseline.json").read_bytes()).hexdigest(),
              "rustVersion": subprocess.check_output(["rustc", "--version"], text=True).strip()}
    (output / "build.json").write_text(json.dumps(record, indent=2) + "\n")
    return record


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--origin", help="Stage a new source copy for this private backend")
    mode.add_argument("--bundle", action="store_true", help="Package and ad-hoc sign the already built source copy")
    parser.add_argument("--output", type=Path, required=True, help="Staging directory (must be new unless bundling)")
    args = parser.parse_args()
    if args.bundle:
        print(json.dumps(bundle(args.output.absolute()), indent=2))
    else:
        result = stage(Path(__file__).resolve().parents[2], args.output.absolute(), args.origin)
        print(json.dumps({key: result[key] for key in ("sourceRevision", "sourceRoot", "runtimeRoot", "buildArguments")}, indent=2))
