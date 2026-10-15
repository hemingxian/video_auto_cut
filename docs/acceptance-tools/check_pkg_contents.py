#!/usr/bin/env python3
"""验收辅助（只读）：解压后的运行包 vs 仓库 FINAL_HEAD，逐文件核 SHA-256。

用法（Windows 仓库根目录）：
    python docs\\acceptance-tools\\check_pkg_contents.py --repo . --head <FINAL_HEAD> --pkg <解压目录>\\VideoAutoCut

对照口径 = `VideoAutoCutDesktop/scripts/pack-runtime.ts` 的 `syncRepoScripts()`：
仓库 VideoAutoCut/tools -> 包内 tools/，config -> config/，sentrysearch/sentrysearch -> 同名，
sentrysearch_entry.py，fonts/noto-sans-cjk-sc（按 manifest 只拷 manifest + 字体文件），
VideoAutoCutApp/prompts -> prompts/rust。期望值同时接受 FINAL_HEAD 的原始 Git blob 字节，或
`git cat-file --filters <head>:<path>` 按当前仓库检出规则转换后的字节。打包拷的是**工作区**文件；
若 clone 后才启用 `core.autocrlf`，工作区可能同时保留 LF 与 CRLF，因此两种口径都需要接受并报告。

输出：
1. 每个目录的 tracked 文件数 / 相同 / 不同 / 包内缺失 / 按打包规则排除；**mismatch 与缺失必须都是 0**。
2. 包内 tools/ 有而 FINAL_HEAD 没有的全部文件：安装产物（node_modules、chrome-headless-shell）只按目录计数，
   其余（0.5.14 底包残留 / Windows 工作区未跟踪文件）逐个列出。
3. 包内不得出现 config/app.env、config/auth.json、config/device.json、.env。
退出码：有 mismatch / 缺失 / 禁止文件时为 1，否则 0（多出的非安装产物文件只列出，不判失败，由人决定）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path, PurePosixPath

# 与 pack-runtime.ts 保持一致
EXCLUDED_PREFIXES = ["cookies", "temp", "video", "analysis-cache", "normalization-cache", "vector-db",
                     ".sentrysearch", "config/app.env", "config/auth.json", "config/device.json",
                     "voice_templates", "tools/material_gen/records",
                     "tools/material_gen/remotion/node_modules/.cache",
                     "tools/material_gen/hyperframes/node_modules/.cache",
                     "sentrysearch/.venv/Lib/site-packages/imageio_ffmpeg/binaries"]
EXCLUDED_NAMES = {".env", "app.env", "auth.json", "device.json", "downloaded.txt", "VideoAuto_last_run.log"}
EXCLUDED_DIRS = {"__pycache__", ".pytest_cache", "tests", "test"}
FORBIDDEN = ["config/app.env", "config/auth.json", "config/device.json", ".env"]
MAPPINGS = [("VideoAutoCut/tools", "tools"), ("VideoAutoCut/config", "config"),
            ("VideoAutoCut/sentrysearch/sentrysearch", "sentrysearch/sentrysearch"),
            ("VideoAutoCut/sentrysearch/sentrysearch_entry.py", "sentrysearch/sentrysearch_entry.py"),
            ("VideoAutoCut/fonts/noto-sans-cjk-sc", "fonts/noto-sans-cjk-sc"),
            ("VideoAutoCutApp/prompts", "prompts/rust")]
INSTALL_MARKERS = ("/node_modules/", "/chrome-headless-shell/")


def excluded(rel: str) -> bool:
    parts = PurePosixPath(rel).parts
    if parts and (parts[-1] in EXCLUDED_NAMES or any(p in EXCLUDED_DIRS for p in parts)):
        return True
    if rel.endswith((".pyc", ".pyo")):
        return True
    return any(rel == p or rel.startswith(p + "/") for p in EXCLUDED_PREFIXES)


def git(repo: Path, *args: str) -> bytes:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True).stdout


def matching_basis(actual: bytes, raw: bytes, filtered: bytes) -> str | None:
    """Return the accepted Git byte basis, preserving the distinction in reports."""
    actual_sha = hashlib.sha256(actual).digest()
    raw_matches = actual_sha == hashlib.sha256(raw).digest()
    filtered_matches = actual_sha == hashlib.sha256(filtered).digest()
    if raw_matches and filtered_matches:
        return "raw+filters"
    if raw_matches:
        return "raw"
    if filtered_matches:
        return "filters"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--pkg", type=Path, required=True, help="解压目录里的 VideoAutoCut 目录")
    ap.add_argument("--json", type=Path, help="另存明细 JSON")
    args = ap.parse_args()
    head = git(args.repo, "rev-parse", args.head).decode().strip()
    tracked = git(args.repo, "-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", head).decode("utf-8").splitlines()
    font_manifest = json.loads(git(args.repo, "show", f"{head}:VideoAutoCut/fonts/noto-sans-cjk-sc/manifest.json"))
    font_files = {"manifest.json", *(entry["file"] for entry in font_manifest["files"])}
    report: dict = {"head": head, "sections": {}, "extra_tools": [], "install_products": {}, "forbidden": []}
    bad = 0
    tracked_pkg_paths: set[str] = set()
    for repo_prefix, pkg_prefix in MAPPINGS:
        stats = {"tracked": 0, "same": 0, "mismatch": [], "missing": [], "excluded": [],
                 "match_basis": {"raw": 0, "filters": 0, "raw+filters": 0}, "matched_by": {}}
        for path in tracked:
            if not (path == repo_prefix or path.startswith(repo_prefix + "/")):
                continue
            rel_inside = path[len(repo_prefix):].lstrip("/")
            pkg_rel = pkg_prefix + ("/" + rel_inside if rel_inside else "")
            if pkg_prefix.startswith("fonts/") and PurePosixPath(rel_inside).name not in font_files:
                continue                               # stageBundledFonts 只拷 manifest 列出的文件
            stats["tracked"] += 1
            if excluded(pkg_rel):
                stats["excluded"].append(pkg_rel)
                continue
            tracked_pkg_paths.add(pkg_rel)
            target = args.pkg / pkg_rel
            if not target.is_file():
                stats["missing"].append(pkg_rel)
                continue
            raw = git(args.repo, "cat-file", "blob", f"{head}:{path}")
            filtered = git(args.repo, "cat-file", "--filters", f"{head}:{path}")
            basis = matching_basis(target.read_bytes(), raw, filtered)
            if basis:
                stats["same"] += 1
                stats["match_basis"][basis] += 1
                stats["matched_by"][pkg_rel] = basis
            else:
                stats["mismatch"].append(pkg_rel)
        bad += len(stats["mismatch"]) + len(stats["missing"])
        report["sections"][pkg_prefix] = stats
        print(f"[{pkg_prefix}] tracked={stats['tracked']} same={stats['same']} "
              f"mismatch={len(stats['mismatch'])} missing={len(stats['missing'])} "
              f"excluded_by_rule={len(stats['excluded'])} "
              f"match_basis(raw={stats['match_basis']['raw']} filters={stats['match_basis']['filters']} "
              f"raw+filters={stats['match_basis']['raw+filters']})")
        for rel in stats["mismatch"]:
            print(f"   MISMATCH {rel}")
        for rel in stats["missing"]:
            print(f"   MISSING  {rel}")
    tools_root = args.pkg / "tools"
    for file in sorted(p for p in tools_root.rglob("*") if p.is_file()):
        rel = "tools/" + file.relative_to(tools_root).as_posix()
        if rel in tracked_pkg_paths:
            continue
        marker = next((m for m in INSTALL_MARKERS if m in "/" + rel), None)
        if marker:
            key = rel.split(marker)[0] + marker.rstrip("/")
            report["install_products"][key] = report["install_products"].get(key, 0) + 1
        else:
            report["extra_tools"].append(rel)
    print("[tools 安装产物（不在 FINAL_HEAD，按目录计数）]")
    for key, count in sorted(report["install_products"].items()):
        print(f"   {key}: {count} 个文件")
    print(f"[tools 其它多出的文件（底包残留 / 工作区未跟踪），共 {len(report['extra_tools'])} 个]")
    for rel in report["extra_tools"]:
        print(f"   EXTRA {rel}")
    for rel in FORBIDDEN:
        if (args.pkg / rel).exists():
            report["forbidden"].append(rel)
            print(f"   FORBIDDEN {rel}")
    bad += len(report["forbidden"])
    if args.json:
        args.json.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"RESULT mismatch+missing+forbidden={bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
