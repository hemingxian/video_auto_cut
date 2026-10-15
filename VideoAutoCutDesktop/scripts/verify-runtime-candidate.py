"""Read-only archive audit, then isolated runtime smoke checks. Never publishes.

Only the explicitly selected new extraction directory is written. Existing
runtime installations and account configuration are neither loaded nor changed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import time
import zipfile


REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / "VideoAutoCut"
DEFAULT_VERSION = "0.5.9"
REQUIRED_MODULES = (
    "sentrysearch/sentrysearch/analysis_cache.py",
    "sentrysearch/sentrysearch/qwen_request_worker.py",
    "sentrysearch/sentrysearch/cli.py",
    "sentrysearch/sentrysearch/store.py",
    "sentrysearch/sentrysearch/chunker.py",
    "sentrysearch/sentrysearch/qwen_cloud_embedder.py",
    "tools/template_packaging.py", "tools/subtitle_safe_area.py", "tools/text_layout.py",
    "tools/progress_labels.py", "tools/material_selection_policy.py", "tools/render_segment.py",
    "tools/output_format.py", "tools/prepare_voice.py",
)
DENIED_PREFIXES = (
    "cookies/", "temp/", "video/", "voice_templates/", ".sentrysearch/", ".pytest_cache/",
    "analysis-cache/", "normalization-cache/", "vector-db/", "release-cache/",
    "tools/material_gen/records/", "tools/material_gen/remotion/node_modules/.cache/",
    "tools/material_gen/hyperframes/node_modules/.cache/",
    "sentrysearch/.venv/lib/site-packages/imageio_ffmpeg/binaries/",
)
CODE_SUFFIXES = {".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".json", ".toml", ".md", ".txt"}
TOKEN_PATTERN = re.compile(rb"\b(?:sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")


def sha_stream(handle):
    value = hashlib.sha256()
    for block in iter(lambda: handle.read(1024 * 1024), b""):
        value.update(block)
    return value.hexdigest()


def sha_file(path):
    with open(path, "rb") as handle:
        return sha_stream(handle)


def vendored(rel):
    parts = set(PurePosixPath(rel.lower()).parts)
    return bool(parts & {"node_modules", ".venv", "chrome-headless-shell"})


def expected_sources():
    roots = ["VideoAutoCut/tools", "VideoAutoCut/config", "VideoAutoCut/fonts",
             "VideoAutoCut/sentrysearch/sentrysearch", "VideoAutoCut/sentrysearch/sentrysearch_entry.py",
             "VideoAutoCutApp/prompts"]
    result = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", *roots],
                            cwd=REPO, check=True, capture_output=True, timeout=30)
    sources = {}
    for name in result.stdout.decode("utf-8").split("\0"):
        if not name:
            continue
        path = REPO / name
        if not path.is_file() or {"test", "tests", "__pycache__"} & set(path.parts) or vendored(name):
            continue
        if name.startswith("VideoAutoCutApp/prompts/"):
            rel = "prompts/rust/" + name.removeprefix("VideoAutoCutApp/prompts/")
        else:
            rel = name.removeprefix("VideoAutoCut/")
        sources[rel] = path
    return sources


class Auditor:
    def __init__(self, args):
        self.args = args
        self.report = {"version": args.version, "archive": str(args.archive.resolve()),
                       "destination": str(args.destination.resolve()), "checks": [], "passed": False}

    def check(self, name, action):
        print(f"[runtime audit] {name}", flush=True)
        started = time.monotonic()
        try:
            detail = action()
            self.report["checks"].append({"name": name, "passed": True,
                                          "seconds": round(time.monotonic() - started, 3), "detail": detail})
            return detail
        except Exception as exc:
            self.report["checks"].append({"name": name, "passed": False,
                                          "seconds": round(time.monotonic() - started, 3), "error": str(exc)})
            raise

    def save_report(self):
        self.args.destination.mkdir(parents=True, exist_ok=True)
        path = self.args.destination / "acceptance-report.json"
        path.write_text(json.dumps(self.report, ensure_ascii=False, indent=2), encoding="utf-8")
        lines = [f"# Runtime {self.args.version} isolated acceptance", "",
                 f"Result: {'PASS' if self.report['passed'] else 'FAIL'}", "",
                 f"Archive: `{self.args.archive.resolve()}`", f"Runtime: `{self.args.destination.resolve() / 'VideoAutoCut'}`", ""]
        for item in self.report["checks"]:
            lines.append(f"- {'PASS' if item['passed'] else 'FAIL'} {item['name']} ({item['seconds']}s)")
            if not item["passed"]:
                lines.append(f"  {item['error']}")
        lines += ["", "No user installation was modified; no account configuration was loaded. "
                  "Provider/business-video end-to-end validation is a separate release gate."]
        (self.args.destination / "acceptance-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"[runtime audit] report: {path}", flush=True)

    def archive_identity(self):
        if not self.args.archive.is_file():
            raise FileNotFoundError(f"Candidate does not exist yet: {self.args.archive}; no waiting was attempted")
        digest = sha_file(self.args.archive)
        self.report["archive_sha256"] = digest
        manifest = json.loads(self.args.archive.with_name("manifest.json").read_text(encoding="utf-8-sig"))
        item = next((entry for entry in manifest["versions"] if entry["version"] == self.args.version), None)
        if item is None or item["sha256"] != digest or item["size"] != self.args.archive.stat().st_size:
            raise ValueError("release manifest version/size/SHA does not match the archive")
        return {"sha256": digest, "bytes": self.args.archive.stat().st_size}

    def inspect_archive(self):
        self.sources = expected_sources()
        with zipfile.ZipFile(self.args.archive) as archive:
            files = {}
            blocked = []
            seen = set()
            total = 0
            for item in archive.infolist():
                name = item.filename.replace("\\", "/")
                parts = PurePosixPath(name).parts
                if (not parts or parts[0] != "VideoAutoCut" or ".." in parts or ":" in name
                        or name.startswith("/") or stat.S_ISLNK(item.external_attr >> 16)):
                    raise ValueError(f"unsafe archive path: {name}")
                if item.is_dir():
                    continue
                rel = "/".join(parts[1:])
                low = rel.lower()
                if low in seen:
                    raise ValueError(f"duplicate/case-colliding archive file: {rel}")
                seen.add(low)
                total += item.file_size
                files[rel] = item
                basename = parts[-1].lower()
                env_file = (basename in {".env", "app.env"} or
                            (basename.startswith(".env.") and basename not in {".env.example", ".env.sample", ".env.template"}))
                private_name = bool(re.search(r"^(?:id_rsa|id_ed25519|credentials(?:\.json)?|service[-_]account.*\.json)$", basename))
                owned_db = not vendored(rel) and (basename.endswith((".db", ".sqlite", ".sqlite3", ".log")) or basename in {"downloaded.txt", "videoauto_last_run.log"})
                if (env_file or private_name or owned_db or any(low.startswith(prefix) for prefix in DENIED_PREFIXES)
                        or {"__pycache__", "tests", "test"} & set(part.lower() for part in parts)
                        or basename.endswith((".pyc", ".pyo"))):
                    blocked.append(rel)
                # Only first-party source/config is scanned for concrete secret
                # values; report paths, never matched values or file contents.
                if not vendored(rel) and item.file_size <= 4 * 1024 * 1024 and Path(rel).suffix.lower() in CODE_SUFFIXES | {".env", ".pem", ".key"}:
                    if TOKEN_PATTERN.search(archive.read(item)):
                        blocked.append(rel + " [secret-shaped literal]")
            if total > 50 * 1024 ** 3:
                raise ValueError("archive expands beyond the 50 GiB acceptance bound")
            if blocked:
                raise ValueError("excluded/user/credential paths in package: " + ", ".join(sorted(set(blocked))[:80]))
            missing = [rel for rel in REQUIRED_MODULES if rel not in files]
            mismatched = []
            for rel, source in self.sources.items():
                if rel not in files:
                    missing.append(rel)
                    continue
                with archive.open(files[rel]) as handle:
                    actual = sha_stream(handle)
                if actual != sha_file(source):
                    mismatched.append(rel)
                if rel.endswith(".py"):
                    compile(archive.read(files[rel]), rel, "exec")
            # Stale application source left in the base runtime is a release
            # failure too; third-party package source is checked by smoke imports.
            extra = [rel for rel in files if not vendored(rel) and rel.startswith(("tools/", "sentrysearch/sentrysearch/", "prompts/"))
                     and Path(rel).suffix in {".py", ".js", ".ts", ".jsx", ".tsx", ".md"} and rel not in self.sources]
            if missing or mismatched or extra:
                raise ValueError(f"source mismatch: missing={sorted(set(missing))}; changed={mismatched}; stale={extra[:80]}")
            engine = REPO / "VideoAutoCutApp/target/release/VideoAutoCutEngine.exe"
            with archive.open("VideoAutoCut/VideoAutoCutEngine.exe") as handle:
                if sha_stream(handle) != sha_file(engine):
                    raise ValueError("packaged engine differs from the current release build")
            self.entries = files
            return {"files": len(files), "uncompressed_bytes": total, "matching_owned_sources": len(self.sources),
                    "required_modules": list(REQUIRED_MODULES), "excluded_or_secret_paths": 0}

    def extract(self):
        root = self.args.destination.resolve()
        runtime = root / "VideoAutoCut"
        if runtime.exists():
            raise FileExistsError(f"Refusing to overwrite an existing extraction: {runtime}; choose a new destination")
        root.mkdir(parents=True, exist_ok=True)
        # inspect_archive has already rejected absolute, traversal, duplicate,
        # and symlink entries. Every destination is checked again before writing.
        with zipfile.ZipFile(self.args.archive) as archive:
            for item in archive.infolist():
                target = root.joinpath(*PurePosixPath(item.filename.replace("\\", "/")).parts).resolve()
                if not target.is_relative_to(root):
                    raise ValueError("archive extraction escaped its new destination")
                if item.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(item) as source, target.open("xb") as output:
                        shutil.copyfileobj(source, output, 1024 * 1024)
        self.runtime = runtime
        return {"runtime": str(runtime), "files": len(self.entries)}

    def smoke(self):
        runtime = self.runtime
        scratch = self.args.destination.resolve() / "smoke-data"
        scratch.mkdir()
        for folder in ("home", "config", "temp", "appdata", "localappdata"):
            (scratch / folder).mkdir()
        env = {key: value for key, value in os.environ.items() if key.upper() in {
            "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
        }}
        ffmpeg = runtime / "ffmpeg/bin/ffmpeg.exe"
        ffprobe = ffmpeg.with_name("ffprobe.exe")
        node = runtime / "node-runtime/node.exe"
        python = runtime / "python-3.11.9-embed-amd64/python.exe"
        env.update(PATH=os.pathsep.join([str(ffmpeg.parent), str(node.parent), str(Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32")]),
                   USERPROFILE=str(scratch / "home"), HOME=str(scratch / "home"), APPDATA=str(scratch / "appdata"),
                   LOCALAPPDATA=str(scratch / "localappdata"), TEMP=str(scratch / "temp"), TMP=str(scratch / "temp"),
                   VIDEOAUTO_DATA_ROOT=str(scratch), VIDEOAUTO_CONFIG_ROOT=str(scratch / "config"),
                   PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1",
                   ANONYMIZED_TELEMETRY="False", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                   HYPERFRAMES_NO_TELEMETRY="1", HYPERFRAMES_NO_UPDATE_CHECK="1")
        runs = []
        def run(label, argv, timeout=60):
            print(f"[runtime smoke] {label}", flush=True)
            result = subprocess.run([str(value) for value in argv], cwd=runtime, env=env, capture_output=True,
                                    text=True, encoding="utf-8", errors="replace", timeout=timeout)
            (scratch / f"{label}.log").write_text(result.stdout + "\n" + result.stderr, encoding="utf-8")
            if result.returncode:
                raise RuntimeError(f"{label} failed with exit {result.returncode}; see smoke-data/{label}.log")
            runs.append({"name": label, "exit_code": result.returncode})
            return result.stdout
        run("python-version", [python, "--version"])
        code = """import importlib,json,sys,pathlib
root=pathlib.Path.cwd().resolve()
sys.path.insert(0,str(root/'tools'))
names=['chromadb','dashscope','requests','dotenv','numpy','PIL','sentrysearch.analysis_cache','sentrysearch.qwen_request_worker','sentrysearch.cli','template_packaging','subtitle_safe_area','text_layout','material_selection_policy']
paths={}
for name in names:
 m=importlib.import_module(name); p=pathlib.Path(m.__file__).resolve(); assert p.is_relative_to(root),(name,str(p)); paths[name]=str(p.relative_to(root))
print(json.dumps(paths,ensure_ascii=False))
"""
        run("python-imports", [python, "-c", code])
        run("ffmpeg-version", [ffmpeg, "-version"])
        run("node-version", [node, "--version"])
        help_text = run("engine-help", [runtime / "VideoAutoCutEngine.exe", "--help"])
        for flag in ("--material-manifest", "--project-name"):
            if flag not in help_text:
                raise ValueError(f"engine help missing {flag}")
        sample = scratch / "sample.mp4"
        run("ffmpeg-encode", [ffmpeg, "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1",
                              "-c:v", "libx264", "-pix_fmt", "yuv420p", sample])
        info = json.loads(run("ffprobe-media", [ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", sample]))
        if (info["streams"][0]["width"], info["streams"][0]["height"]) != (320, 180):
            raise ValueError("FFmpeg smoke output has wrong dimensions")
        font_dir = runtime / "fonts/noto-sans-cjk-sc"
        manifest = json.loads((font_dir / "manifest.json").read_text(encoding="utf-8-sig"))
        if manifest["license"] != "SIL Open Font License 1.1" or manifest["family"] != "Noto Sans CJK SC":
            raise ValueError("bundled font family/license mismatch")
        for item in manifest["files"]:
            path = font_dir / item["file"]
            if path.stat().st_size != item["size"] or sha_file(path) != item["sha256"]:
                raise ValueError(f"bundled font manifest mismatch: {item['file']}")
        hf = runtime / "tools/material_gen/hyperframes"
        for name, version in (("hyperframes", "0.7.3"), ("gsap", "3.14.2")):
            if json.loads((hf / "node_modules" / name / "package.json").read_text(encoding="utf-8"))["version"] != version:
                raise ValueError(f"template dependency version mismatch: {name}")
        template_code = """import json,sys,pathlib
root=pathlib.Path.cwd();sys.path.insert(0,str(root/'tools'))
from text_layout import register_bundled_fonts
from template_packaging import render_overlay
register_bundled_fonts()
output=render_overlay({'card_type':'title','card_content':'运行包验收 Runtime verification'},640,360,1.0,pathlib.Path(sys.argv[1]))
assert output is not None and output.is_file()
print(json.dumps({'output':str(output),'bytes':output.stat().st_size},ensure_ascii=False))
"""
        run("template-render", [python, "-c", template_code, scratch / "template"], timeout=240)
        return {"runs": runs, "font_manifest_verified": True, "template_render_verified": True,
                "isolated_data_root": str(scratch)}

    def execute(self):
        try:
            self.check("archive manifest SHA and size", self.archive_identity)
            self.check("archive paths, exclusions, secrets and source hashes", self.inspect_archive)
            self.check("extract into a new isolated directory", self.extract)
            self.check("packaged Python, FFmpeg, fonts and template rendering", self.smoke)
            self.report["passed"] = True
        finally:
            self.save_report()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default=DEFAULT_VERSION)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--destination", type=Path)
    args = parser.parse_args()
    args.archive = args.archive or REPO / f"VideoAutoCutDesktop/runtime-release/VideoAutoCut-runtime-{args.version}.zip"
    args.destination = args.destination or REPO / f".e2e-runtime/candidate-{args.version}"
    if args.destination.resolve() in (REPO.resolve(), SOURCE.resolve()) or not args.destination.resolve().is_relative_to((REPO / ".e2e-runtime").resolve()):
        parser.error("destination must be a new subdirectory inside this repository's .e2e-runtime")
    try:
        Auditor(args).execute()
    except Exception as exc:
        print(f"[runtime audit] FAIL: {exc}", file=sys.stderr)
        return 1
    print("[runtime audit] PASS", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
