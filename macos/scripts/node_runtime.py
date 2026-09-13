#!/usr/bin/env python3
"""Prepare the pinned official Node runtime for the native macOS bundle."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def verify_archive(path, expected):
    if digest(path) != expected:
        raise ValueError(f"Node archive checksum mismatch: {path}")


def extract_runtime(archive, destination, lock):
    """Only extract the two named regular files, after authenticating the archive."""
    verify_archive(archive, lock["sha256"])
    prefix = lock["archive"].removesuffix(".tar.gz")
    with tarfile.open(archive, "r:gz") as source:
        members = [(source.getmember(prefix + "/bin/node"), "taskhub-node", 512 * 1024 * 1024),
                   (source.getmember(prefix + "/LICENSE"), "LICENSE", 10 * 1024 * 1024)]
        # Validate both before writing either. Never follow archive symlinks or
        # extract an arbitrary archive path into the checkout or application.
        for member, _, limit in members:
            if not member.isfile() or not 0 < member.size <= limit:
                raise ValueError(f"Invalid Node runtime member: {member.name}")
        destination.mkdir(parents=True, exist_ok=True)
        for member, name, _ in members:
            with source.extractfile(member) as data, (destination / name).open("wb") as output:
                shutil.copyfileobj(data, output)
    (destination / "taskhub-node").chmod(0o755)


def prepare(cache, lock):
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / lock["archive"]
    with tempfile.TemporaryDirectory(prefix="prepare-", dir=cache) as temporary:
        temporary = Path(temporary)
        if not archive.exists():
            downloaded = temporary / "download.tar.gz"
            print(f"Downloading official Node {lock['version']} (arm64)", flush=True)
            with urllib.request.urlopen(lock["url"], timeout=30) as response, downloaded.open("wb") as target:
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > 512 * 1024 * 1024:
                        raise ValueError("Node archive exceeds the download limit")
                    target.write(chunk)
            verify_archive(downloaded, lock["sha256"])
            os.replace(downloaded, archive)
        staging = temporary / "runtime"
        extract_runtime(archive, staging, lock)
        binary = staging / "taskhub-node"
        actual = subprocess.check_output([binary, "--version"], text=True).strip()
        if actual != lock["version"]:
            raise ValueError(f"Node version mismatch: {actual}")
        subprocess.run([binary, "--no-warnings", "-e",
                        "const {DatabaseSync}=require('node:sqlite');"
                        "const db=new DatabaseSync(':memory:');"
                        "if(db.prepare('SELECT 42 AS value').get().value!==42)process.exit(1);db.close();"],
                       check=True, timeout=30)
        receipt = {**lock, "binarySHA256": digest(binary), "licenseSHA256": digest(staging / "LICENSE")}
        (staging / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        runtime = cache / "runtime"
        runtime.mkdir(exist_ok=True)
        # Replacement files come from the verified archive each time, so a stale
        # or edited cached binary/receipt cannot bypass the pinned checksum.
        for name in ["taskhub-node", "LICENSE", "receipt.json"]:
            os.replace(staging / name, runtime / name)
    return runtime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path)
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        parser.error("Native runtime packaging currently targets Apple Silicon macOS.")
    script = Path(__file__).resolve()
    lock = json.loads(script.with_name("node-runtime.lock.json").read_text())
    cache = (args.cache_dir or script.parents[1] / ".build" / "node").resolve()
    runtime = prepare(cache, lock)
    print(f"Verified Node runtime: {runtime}")


if __name__ == "__main__":
    main()
