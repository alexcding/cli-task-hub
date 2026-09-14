import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("baseline", Path(__file__).with_name("prepare-tauri-baseline.py"))
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)


class TauriBaselineTests(unittest.TestCase):
    def test_rejects_non_fixture_origins(self):
        for value in ("http://127.0.0.1:3000", "http://localhost:43211", "https://example.com",
                      "http://127.0.0.1", "http://127.0.0.1:80", "http://127.0.0.1:43211/api",
                      "http://user@127.0.0.1:43211", "http://127.0.0.1:43211?other=1",
                      "http://127.0.0.1:43211#fragment", "http://127.0.0.1:99999"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                baseline.origin(value)
        self.assertEqual(baseline.origin("http://127.0.0.1:43211/"), "http://127.0.0.1:43211")

    def test_upstream_function_changes_fail_closed(self):
        with self.assertRaises(ValueError):
            baseline.replace_function("fn changed() {\n}\n", "fn expected()", "")
        with self.assertRaises(ValueError):
            baseline.replace_function("fn expected() {\n}\nfn expected() {\n}\n", "fn expected()", "")

    def test_pinned_archive_isolated_without_changing_terminal_logic(self):
        repo = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="th-baseline-test-", dir="/private/tmp") as parent:
            output = Path(parent) / "source"
            result = baseline.stage(repo, output, "http://127.0.0.1:43211")
            self.addCleanup(shutil.rmtree, result["runtimeRoot"])
            self.assertEqual(Path(result["runtimeRoot"]).stat().st_mode & 0o777, 0o700)
            with self.assertRaises(FileExistsError):
                baseline.stage(repo, output, "http://127.0.0.1:43211")
            config = json.loads((output / "src-tauri/tauri.conf.json").read_text())
            self.assertNotIn("beforeDevCommand", config["build"])
            self.assertNotIn("beforeBuildCommand", config["build"])
            self.assertNotIn("externalBin", config["bundle"])
            self.assertNotIn("resources", config["bundle"])
            self.assertEqual(config["plugins"]["updater"]["endpoints"], [])
            self.assertNotEqual(config["identifier"], "tv.accedo.taskhub")
            remote = json.loads((output / "src-tauri/capabilities/remote.json").read_text())
            self.assertEqual(remote["remote"]["urls"], [result["backendOrigin"]])
            lib = (output / "src-tauri/src/lib.rs").read_text()
            self.assertNotIn('.sidecar("taskhub-node")', lib)
            self.assertNotIn("download_and_install", lib)
            for path in result["sourceSHA256"]:
                original = subprocess.check_output(["git", "show", f'{result["sourceRevision"]}:{path}'], cwd=repo)
                actual = (output / path).read_bytes()
                if path not in result["changes"]:
                    self.assertEqual(actual, original, path)
                elif path.endswith("terminals.rs") or path == "crates/taskhub-ptyd/src/lib.rs":
                    signature = ("pub fn sock_path() -> PathBuf" if path.startswith("crates/")
                                 else "pub(crate) fn ptyd_dir(app: &AppHandle) -> PathBuf")
                    self.assertEqual(baseline.replace_function(original.decode(), signature, ""),
                                     baseline.replace_function(actual.decode(), signature, ""))
            daemon = (output / "crates/taskhub-ptyd/src/lib.rs").read_text()
            self.assertIn(json.dumps(result["ptySocket"]), daemon)
            self.assertNotIn('var_os("TASKHUB_PTYD_SOCK")', daemon)
            self.assertNotIn('features = ["terminal-snapshots"]', (output / "src-tauri/Cargo.toml").read_text())


if __name__ == "__main__":
    unittest.main()
