import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from node_runtime import digest, extract_runtime


class NodeRuntimeTests(unittest.TestCase):
    def archive(self, root, *, license_kind=tarfile.REGTYPE, include_license=True, extra=False):
        archive = root / "runtime.tar.gz"
        with tarfile.open(archive, "w:gz") as target:
            for name, data in [("node-test/bin/node", b"runtime fixture"),
                               ("node-test/LICENSE", b"license fixture")]:
                if name.endswith("LICENSE") and not include_license:
                    continue
                member = tarfile.TarInfo(name)
                if name.endswith("LICENSE"):
                    member.type = license_kind
                    if license_kind == tarfile.SYMTYPE:
                        member.linkname = "../../outside"
                        target.addfile(member)
                        continue
                member.size = len(data)
                target.addfile(member, io.BytesIO(data))
            if extra:
                member = tarfile.TarInfo("../../outside")
                member.size = 6
                target.addfile(member, io.BytesIO(b"escape"))
        return archive, {"archive": "node-test.tar.gz", "sha256": digest(archive)}

    def test_extracts_only_verified_runtime_and_license(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive, lock = self.archive(root, extra=True)
            destination = root / "stage" / "runtime"
            extract_runtime(archive, destination, lock)
            self.assertEqual(set(path.name for path in destination.iterdir()), {"taskhub-node", "LICENSE"})
            self.assertEqual((destination / "taskhub-node").read_bytes(), b"runtime fixture")
            self.assertEqual((destination / "taskhub-node").stat().st_mode & 0o777, 0o755)
            self.assertFalse((root / "outside").exists())

    def test_checksum_failure_preserves_existing_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive, lock = self.archive(root)
            destination = root / "runtime"
            destination.mkdir()
            (destination / "taskhub-node").write_bytes(b"old runtime")
            lock["sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                extract_runtime(archive, destination, lock)
            self.assertEqual((destination / "taskhub-node").read_bytes(), b"old runtime")

    def test_symlink_license_fails_before_writing_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive, lock = self.archive(root, license_kind=tarfile.SYMTYPE)
            destination = root / "runtime"
            with self.assertRaisesRegex(ValueError, "Invalid Node runtime member"):
                extract_runtime(archive, destination, lock)
            self.assertFalse(destination.exists())

    def test_missing_license_fails_before_writing_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive, lock = self.archive(root, include_license=False)
            destination = root / "runtime"
            with self.assertRaises(KeyError):
                extract_runtime(archive, destination, lock)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
