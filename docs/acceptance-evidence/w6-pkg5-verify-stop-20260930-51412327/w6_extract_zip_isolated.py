#!/usr/bin/env python3
"""Safely extract the isolated W6 archive while preserving partial failure evidence."""

from __future__ import annotations

import json
import os
import shutil
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

AUDIT = Path(r"D:\autocut\video-auto-cut\VideoAutoCutDesktop\node_modules\.tmp\w6-51412327-pkg5-verify-20260930")


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: w6_extract_zip_isolated.py <archive> <destination>")
    lock = json.loads((AUDIT / "SOURCE-LOCK.json").read_text(encoding="utf-8"))
    archive = Path(sys.argv[1]).resolve(strict=True)
    destination = Path(sys.argv[2]).resolve()
    expected_archive = Path(lock["worktree_zip"]).resolve(strict=True)
    expected_destination = (AUDIT / "extracted").resolve()
    if archive != expected_archive:
        raise SystemExit(f"archive is not the locked isolated pkg5: {archive}")
    if destination != expected_destination:
        raise SystemExit(f"destination is not the fixed audit extraction path: {destination}")
    if destination.exists():
        raise SystemExit(f"destination already exists: {destination}")
    destination.mkdir(parents=True)
    files = directories = 0
    try:
        with zipfile.ZipFile(archive) as package:
            for info in package.infolist():
                name = info.filename.replace("\\", "/")
                pure = PurePosixPath(name)
                if not name or pure.is_absolute() or ".." in pure.parts or ":" in pure.parts[0]:
                    raise RuntimeError(f"unsafe zip path: {info.filename}")
                unix_mode = (info.external_attr >> 16) & 0xFFFF
                if unix_mode and stat.S_ISLNK(unix_mode):
                    raise RuntimeError(f"symlink entry is forbidden: {info.filename}")
                target = destination.joinpath(*pure.parts).resolve()
                if os.path.commonpath((str(destination), str(target))) != str(destination):
                    raise RuntimeError(f"zip path escapes destination: {info.filename}")
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    directories += 1
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.open(info) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                files += 1
    except BaseException:
        print(f"extraction failed; partial evidence preserved at: {destination}", file=sys.stderr)
        raise
    print(json.dumps({"archive": str(archive), "destination": str(destination), "files": files, "directories": directories}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
