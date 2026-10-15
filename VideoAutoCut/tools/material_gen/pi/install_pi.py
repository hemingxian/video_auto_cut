#!/usr/bin/env python3
"""把 pi 装进本目录，供打包脚本连同整棵 `tools/` 拷进运行包。

用法（仓库根或任意目录都行，脚本自己算路径）：

    python VideoAutoCut/tools/material_gen/pi/install_pi.py            # 装 + 自检
    python VideoAutoCut/tools/material_gen/pi/install_pi.py --check    # 只自检，不装

要点：

* **`--omit=optional` 是必需的**。pi 自带 `npm-shrinkwrap.json`，写死了 26 个平台的
  `@esbuild/*` 和 10 个 `@mariozechner/clipboard-*` 可选依赖，Windows npm 会全部装下来：
  实测 13,678 文件 /（`du` 磁盘占用）约 421MB；加 `--omit=optional` 后约 13,548 文件 /
  117.8MB（字节总和；`du` 磁盘占用约 137MB）——只差 130 个文件，差出来的全是别的平台的二进制。
* **`dist/bundle/` 不自包含**，装完必须留着 `node_modules/`：只留 dist/ 启动会报
  `ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/chord'`
  （来自 `dist/bundle/chunks/chunk-JVUZSMYM.js`）。所以自检里把 chord 也当必查项。
* **chord 在哪儿不能写死路径**。pi 自带 `npm-shrinkwrap.json`，npm 按它把依赖装进 pi 包
  自己的 `node_modules/` 里**不提升**：Windows 实测 chord 落在
  `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/chord`，
  顶层 `node_modules/@earendil-works/` 下只有 `pi-coding-agent`。提升与否随 npm 版本和
  已有依赖树而变，所以自检**首选交给 node 按运行时规则解析**
  （`createRequire(cli.js).resolve('@earendil-works/chord/package.json')`），
  解析得到什么就是 cli.js 运行时真正会加载的那份；找不到 node 才退回两处路径检查。
* npm 会提示 3 个包的 install script 不在 allowScripts：`@google/genai`（no-op）、
  `esbuild`（postinstall 下载 `downloaded-@esbuild-…-esbuild.exe`）、`protobufjs`。
  精简安装下剩的 5 个原生产物不影响本线路（pi 只用 cli.js 那条通路）。
* npm 在 Windows 上是 `npm.cmd`，这里用 `subprocess.run(..., shell=False)` 直接跑它。
  参数里没有换行，不会踩到 `pi.cmd` 那个「cmd 在第一个换行处截断参数」的坑。
  换 npm 用 `MATERIAL_AGENT_NPM_EXE` 指到具体可执行文件。
  node 同理：`node.exe` 是真可执行文件，不是 `.cmd` shim，直接 list 参数启动即可。

node_modules **不入库**（2026-09-18 定），随视频引擎运行包一起打包分发：
打包前先跑本脚本现装，再跑 `--check`。HyperFrames 渲染器同口径，见
`tools/material_gen/hyperframes/install_hyperframes.py`。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

PI_PACKAGE = "@earendil-works/pi-coding-agent"
PI_VERSION = "0.85.1"

PI_DIR = Path(__file__).resolve().parent
NODE_MODULES = PI_DIR / "node_modules"
PACKAGE_DIR = NODE_MODULES / "@earendil-works" / "pi-coding-agent"
CLI_JS = PACKAGE_DIR / "dist" / "bundle" / "cli.js"

# bundle 不自包含的证据：唯一依赖 esbuild 的包，缺了它 cli.js 起不来。
CHORD_SPECIFIER = "@earendil-works/chord/package.json"
# shrinkwrap 布局（Windows 实测）：装在 pi 包自己的 node_modules 里，没提升。
NESTED_CHORD_DIR = PACKAGE_DIR / "node_modules" / "@earendil-works" / "chord"
# 提升布局：npm 把它提到顶层时在这儿。两处都只是 node 解析不了时的兜底。
HOISTED_CHORD_DIR = NODE_MODULES / "@earendil-works" / "chord"

# 「运行根」＝ `tools/` 的上级：仓库里是 `VideoAutoCut/`，运行包里是解压出来的那个根目录。
# parents[0]=pi → [1]=material_gen → [2]=tools → [3]=运行根。与
# `material_agent_select.runtime_root()` 同一基点，所以这里找到的 node 就是跑 pi 的那个。
RUNTIME_ROOT_PARTS_UP = 3
NODE_ENV_VARS = ("MATERIAL_AGENT_NODE_EXE", "VIDEOAUTO_NODE_EXE")
BUNDLED_NODE_PARTS = (
    ("node-runtime", "node.exe"),
    ("node-runtime", "node"),
    ("node", "node.exe"),
    ("node", "node"),
)
# 单行，免得 Windows 上参数里出现换行。
NODE_RESOLVE_SCRIPT = (
    "const {createRequire} = require('module'); "
    "console.log(createRequire(process.argv[1]).resolve('" + CHORD_SPECIFIER + "'))"
)


def runtime_root() -> Path:
    return Path(__file__).resolve().parents[RUNTIME_ROOT_PARTS_UP]


def npm_executable() -> str:
    """npm 的可执行文件。Windows 上 `shutil.which` 给的是 `npm.cmd`，直接跑即可。"""
    configured = os.environ.get("MATERIAL_AGENT_NPM_EXE", "").strip()
    if configured:
        if Path(configured).is_file():
            return configured
        raise SystemExit(f"MATERIAL_AGENT_NPM_EXE 指向的文件不存在：{configured}")
    found = shutil.which("npm")
    if not found:
        raise SystemExit(
            "PATH 上找不到 npm。请装 Node.js（pi 需要 Node 运行），"
            "或用 MATERIAL_AGENT_NPM_EXE 指向 npm 可执行文件（Windows 上是 npm.cmd）。"
        )
    return found


def node_executable() -> str | None:
    """跑 cli.js 的那个 node，找不到返回 None（自检退回路径检查，不报错）。

    顺序与 `material_agent_select.node_executable()` 一致：
    MATERIAL_AGENT_NODE_EXE → VIDEOAUTO_NODE_EXE → 运行根 node-runtime/ → node/ → PATH。
    """
    for name in NODE_ENV_VARS:
        configured = os.environ.get(name, "").strip()
        if configured and Path(configured).is_file():
            return configured
    root = runtime_root()
    for parts in BUNDLED_NODE_PARTS:
        candidate = root.joinpath(*parts)
        if candidate.is_file():
            return str(candidate)
    return shutil.which("node")


def resolve_chord_with_node(node: str, cli_js: Path) -> tuple[Path | None, str]:
    """用 node 自己的解析规则找 chord。返回 (解析到的 package.json, 失败说明)。"""
    command = [node, "-e", NODE_RESOLVE_SCRIPT, str(cli_js)]
    try:
        completed = subprocess.run(
            command, shell=False, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
    except OSError as error:
        return None, f"跑不起来 {node}：{error}"
    if completed.returncode != 0:
        lines = [line.strip() for line in (completed.stderr or completed.stdout or "").splitlines() if line.strip()]
        # node 的报错尾巴是版本号那几行，挑第一条带 Error 的，没有就挑第一行。
        detail = next((line for line in lines if "Error" in line), lines[0] if lines else "无输出")
        return None, f"node 退出码 {completed.returncode}：{detail}"
    printed = [line.strip() for line in (completed.stdout or "").splitlines() if line.strip()]
    if not printed:
        return None, "node 没有输出解析结果"
    resolved = Path(printed[-1])
    if not resolved.exists():
        return None, f"node 解析出 {resolved}，但该路径不存在"
    return resolved, ""


def check_chord() -> tuple[bool, list[str], str]:
    """自检 chord。返回 (是否通过, 要打印的信息行, 不通过时的问题描述)。"""
    node = node_executable()
    if node:
        resolved, error = resolve_chord_with_node(node, CLI_JS)
        if resolved is not None:
            return True, [f"✓ chord         {resolved}（node 解析：{node}）"], ""
        return False, [], (
            f"node 解析不到 {CHORD_SPECIFIER}（node：{node}，入口：{CLI_JS}）：{error}"
            "——dist/bundle 不自包含，缺它 cli.js 会报 "
            "ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/chord'"
        )
    lines = ["· 未找到 node，按路径检查"]
    for candidate in (NESTED_CHORD_DIR, HOISTED_CHORD_DIR):
        if candidate.is_dir():
            return True, lines + [f"✓ chord         {candidate}"], ""
    return False, lines, (
        f"两处都找不到 chord：{NESTED_CHORD_DIR}（shrinkwrap 嵌套布局）与 "
        f"{HOISTED_CHORD_DIR}（提升布局）——dist/bundle 不自包含，缺它 cli.js 会报 "
        "ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/chord'"
    )


def measure(directory: Path) -> tuple[int, int]:
    """(文件数, 总字节)。symlink 按自身算，不跟随，免得重复计数。"""
    files = 0
    total = 0
    for root, _dirs, names in os.walk(directory):
        for name in names:
            path = Path(root) / name
            files += 1
            try:
                total += path.lstat().st_size
            except OSError:
                pass
    return files, total


def human(size: int) -> str:
    """十进制 MB，与本脚本/README 里的对照值（字节总和口径）同口径。"""
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1000 or unit == "GB":
            return f"{value:.1f} {unit}"
        value /= 1000
    return f"{value:.1f} GB"


def install() -> None:
    npm = npm_executable()
    command = [
        npm, "install",
        "--prefix", str(PI_DIR),
        "--no-save",
        "--omit=dev",
        "--omit=optional",
        f"{PI_PACKAGE}@{PI_VERSION}",
    ]
    print(f"[install_pi] {' '.join(command)}")
    completed = subprocess.run(command, shell=False)
    if completed.returncode != 0:
        raise SystemExit(f"[install_pi] npm install 失败，退出码 {completed.returncode}")


def check() -> None:
    problems: list[str] = []
    if not CLI_JS.is_file():
        problems.append(f"找不到 cli.js：{CLI_JS}")
    package_json = PACKAGE_DIR / "package.json"
    if not package_json.is_file():
        problems.append(f"找不到 package.json：{package_json}")
    else:
        try:
            version = json.loads(package_json.read_text(encoding="utf-8")).get("version")
        except (OSError, ValueError) as error:
            problems.append(f"读不了 {package_json}：{error}")
        else:
            if version != PI_VERSION:
                problems.append(f"版本不对：装到的是 {version}，要求 {PI_VERSION}")
    chord_ok, chord_lines, chord_problem = check_chord()
    if not chord_ok:
        problems.append(chord_problem)
    if problems:
        for line in chord_lines:
            print(f"[install_pi] {line}")
        for problem in problems:
            print(f"[install_pi] ✗ {problem}", file=sys.stderr)
        print(
            "[install_pi] 自检不通过。先跑 "
            "`python VideoAutoCut/tools/material_gen/pi/install_pi.py` 装一次。",
            file=sys.stderr,
        )
        raise SystemExit(1)

    files, total = measure(NODE_MODULES)
    print(f"[install_pi] ✓ cli.js        {CLI_JS}")
    print(f"[install_pi] ✓ version       {PI_VERSION}")
    for line in chord_lines:
        print(f"[install_pi] {line}")
    print(f"[install_pi] ✓ node_modules  {files} 个文件 / {total} 字节（{human(total)}）")
    print("[install_pi] 参考：精简安装（--omit=optional）约 13,548 个文件 / 117.8MB"
          "（字节总和；`du` 磁盘占用约 137MB）；若接近 13,678 个文件 /（`du`）421MB "
          "说明可选依赖被装进来了，删掉 node_modules 重装。")


def use_utf8_output() -> None:
    """把 stdout/stderr 切成 UTF-8。

    中文 Windows 的 locale 编码是 gbk，stdout 重定向到文件时（`… --check > out.txt`）
    Python 按 gbk 编码输出，本脚本的 `✓` 会当场 `UnicodeEncodeError` 并退出 1——
    在控制台直接跑却没事（控制台走 UTF-8）。2026-09-21 Windows 实测。
    输出文案一个字不改，只换编码；`errors="replace"` 保证再冷门的字符也不会把脚本打断。
    **必须是 `main()` 的第一句**：`reconfigure` 只影响之后写出的字节，之前打过的行不会回改。
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 —— 换个编码失败不值得把装组件这件事拦下来
            pass


def main(argv: list[str] | None = None) -> int:
    use_utf8_output()
    parser = argparse.ArgumentParser(
        description=f"把 {PI_PACKAGE}@{PI_VERSION} 装进 {PI_DIR}（精简安装，供运行包自带）",
    )
    parser.add_argument("--check", action="store_true", help="只跑自检，不执行 npm install")
    args = parser.parse_args(argv)
    if not args.check:
        install()
    check()
    return 0


if __name__ == "__main__":
    sys.exit(main())
