from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
CHECKER = REPO_ROOT / "docs" / "acceptance-tools" / "check_pkg_contents.py"


def run(*args: str, cwd: Path) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True)


class CheckPkgContentsTests(unittest.TestCase):
    def test_mixed_raw_and_filtered_bytes_pass_and_neither_still_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / "repo"
            package = root / "package"
            report_path = root / "report.json"
            tools = repo / "VideoAutoCut" / "tools"
            fonts = repo / "VideoAutoCut" / "fonts" / "noto-sans-cjk-sc"
            package_tools = package / "tools"
            package_fonts = package / "fonts" / "noto-sans-cjk-sc"
            tools.mkdir(parents=True)
            fonts.mkdir(parents=True)
            package_tools.mkdir(parents=True)
            package_fonts.mkdir(parents=True)

            run("git", "init", "--quiet", cwd=repo)
            run("git", "config", "user.name", "Test User", cwd=repo)
            run("git", "config", "user.email", "test@example.invalid", cwd=repo)
            run("git", "config", "core.autocrlf", "false", cwd=repo)
            (repo / ".gitattributes").write_bytes(b"*.txt text\n*.json -text\n")
            raw_file = tools / "raw_only.txt"
            filtered_file = tools / "filters_only.txt"
            raw_file.write_bytes(b"raw line one\nraw line two\n")
            filtered_file.write_bytes(b"filtered line one\nfiltered line two\n")
            manifest = fonts / "manifest.json"
            manifest.write_bytes(b'{"files":[]}\n')
            run("git", "add", ".", cwd=repo)
            run("git", "commit", "--quiet", "-m", "fixture", cwd=repo)

            # Enabling autocrlf only after the commit models a clone whose existing
            # worktree retains LF while later checkouts can be CRLF.
            run("git", "config", "core.autocrlf", "true", cwd=repo)
            raw_bytes = run("git", "cat-file", "blob", "HEAD:VideoAutoCut/tools/raw_only.txt", cwd=repo).stdout
            filtered_bytes = run(
                "git", "cat-file", "--filters", "HEAD:VideoAutoCut/tools/filters_only.txt", cwd=repo
            ).stdout
            self.assertIn(b"\n", raw_bytes)
            self.assertNotIn(b"\r\n", raw_bytes)
            self.assertIn(b"\r\n", filtered_bytes)

            (package_tools / "raw_only.txt").write_bytes(raw_bytes)
            (package_tools / "filters_only.txt").write_bytes(filtered_bytes)
            (package_fonts / "manifest.json").write_bytes(manifest.read_bytes())

            command = [
                sys.executable,
                "-X",
                "utf8",
                str(CHECKER),
                "--repo",
                str(repo),
                "--head",
                "HEAD",
                "--pkg",
                str(package),
                "--json",
                str(report_path),
            ]
            passed = subprocess.run(command, check=False, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(passed.returncode, 0, passed.stdout + passed.stderr)
            report = json.loads(report_path.read_text(encoding="utf-8"))
            tools_report = report["sections"]["tools"]
            self.assertEqual(tools_report["matched_by"]["tools/raw_only.txt"], "raw")
            self.assertEqual(tools_report["matched_by"]["tools/filters_only.txt"], "filters")
            self.assertEqual(tools_report["match_basis"]["raw"], 1)
            self.assertEqual(tools_report["match_basis"]["filters"], 1)
            self.assertIn("match_basis(raw=1 filters=1", passed.stdout)

            (package_tools / "raw_only.txt").write_bytes(b"neither expected representation\n")
            failed = subprocess.run(command, check=False, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(failed.returncode, 1, failed.stdout + failed.stderr)
            failed_report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(failed_report["sections"]["tools"]["mismatch"], ["tools/raw_only.txt"])
            self.assertIn("MISMATCH tools/raw_only.txt", failed.stdout)


if __name__ == "__main__":
    unittest.main()
