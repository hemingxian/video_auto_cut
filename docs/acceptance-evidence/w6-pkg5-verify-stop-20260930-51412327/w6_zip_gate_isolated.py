#!/usr/bin/env python3
"""Enforce exact runtime zip exclusions for the source-locked isolated package."""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path, PurePosixPath

AUDIT = Path(r"D:\autocut\video-auto-cut\VideoAutoCutDesktop\node_modules\.tmp\w6-51412327-pkg5-verify-20260930")
EXCLUDED_PREFIXES = (
    "cookies", "temp", "video", "analysis-cache", "normalization-cache", "vector-db", ".sentrysearch",
    "config/app.env", "config/auth.json", "config/device.json", "voice_templates",
    "tools/material_gen/records", "tools/material_gen/remotion/node_modules/.cache",
    "tools/material_gen/hyperframes/node_modules/.cache",
    "sentrysearch/.venv/Lib/site-packages/imageio_ffmpeg/binaries",
)
EXCLUDED_NAMES = {".env", "app.env", "auth.json", "device.json", "downloaded.txt", "VideoAuto_last_run.log"}
EXCLUDED_DIRS = {"__pycache__", ".pytest_cache", "tests", "test"}


def runtime_relative(name: str) -> str:
    normalized = name.replace("\\", "/").strip("/")
    if normalized == "VideoAutoCut":
        return ""
    if not normalized.startswith("VideoAutoCut/"):
        return f"__outside_runtime__/{normalized}"
    return normalized[len("VideoAutoCut/"):]


def excluded(rel: str) -> bool:
    parts = PurePosixPath(rel).parts
    if parts and (parts[-1] in EXCLUDED_NAMES or any(part in EXCLUDED_DIRS for part in parts)):
        return True
    if rel.endswith((".pyc", ".pyo")):
        return True
    return any(rel == prefix or rel.startswith(prefix + "/") for prefix in EXCLUDED_PREFIXES)


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: w6_zip_gate_isolated.py <archive> <json-output>")
    lock = json.loads((AUDIT / "SOURCE-LOCK.json").read_text(encoding="utf-8"))
    archive = Path(sys.argv[1]).resolve(strict=True)
    output = Path(sys.argv[2]).resolve()
    if archive != Path(lock["worktree_zip"]).resolve(strict=True):
        raise SystemExit(f"archive is not the locked isolated pkg5: {archive}")
    if output != (AUDIT / "zip-entry-gate.json").resolve():
        raise SystemExit(f"output is not the fixed receipt: {output}")
    if output.exists():
        raise SystemExit(f"refusing to overwrite: {output}")
    probes: list[str] = []
    forbidden: list[str] = []
    outside: list[str] = []
    with zipfile.ZipFile(archive) as package:
        entries = package.namelist()
        for name in entries:
            rel = runtime_relative(name)
            if rel.startswith("__outside_runtime__/"):
                outside.append(name)
            elif rel:
                if "/material_gen/records/" in "/" + rel or "/node_modules/.cache/" in "/" + rel or "_probe_w6" in rel:
                    probes.append(name)
                if excluded(rel.rstrip("/")):
                    forbidden.append(name)
    receipt = {
        "archive": str(archive), "entry_count": len(entries),
        "probe_match_count": len(probes), "probe_matches": probes[:100],
        "excluded_rule_match_count": len(forbidden), "excluded_rule_matches": forbidden[:100],
        "outside_runtime_count": len(outside), "outside_runtime": outside[:100],
    }
    output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, ensure_ascii=False))
    return 1 if probes or forbidden or outside else 0


if __name__ == "__main__":
    raise SystemExit(main())
