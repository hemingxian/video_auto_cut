#!/usr/bin/env python3
"""把 HyperFrames 渲染器装进本目录，供打包脚本连同整棵 `tools/` 拷进运行包。

用法（仓库根或任意目录都行，脚本自己算路径）：

    python VideoAutoCut/tools/material_gen/hyperframes/install_hyperframes.py          # 装 + 自检
    python VideoAutoCut/tools/material_gen/hyperframes/install_hyperframes.py --check  # 只自检，不装

口径与 `tools/material_gen/pi/install_pi.py` 完全一致（2026-09-18 定）：
**node_modules 不入代码仓库，随视频引擎运行包一起打包分发；打包前先跑本脚本现装。**

要点：

* **自检直接调用 `tools/template_packaging.py::renderer_dependencies()`**，不另写一套探测。
  运行时怎么找，自检就怎么找——所以 `VIDEOAUTO_NODE_EXE` / `HYPERFRAMES_CLI` /
  `HYPERFRAMES_GSAP` / `HYPERFRAMES_BROWSER_PATH` 这几个覆盖键与运行时天然同步，
  也不会出现「打包机 PATH 上有 node 所以自检绿、运行包里没有 node-runtime 所以合成红」
  这种假绿：`renderer_dependencies` 只认运行根下的 `node-runtime/node.exe` 或 `node/node.exe`，
  **不走 PATH**。
* **不能加 `--omit=optional`。** hyperframes 的原生依赖（sharp / esbuild / onnxruntime-node）
  全部是按平台拆分的 optional 包：omit 掉之后 Windows 上少装 `@img/sharp-win32-x64` 等
  718 个文件，`cli.js` 连 lint 都起不来（`Could not load the "sharp" module using the
  win32-x64 runtime`），而且 esbuild 会 fallback 去自己下一份 10.6MB 的二进制塞进运行包。
  2026-09-18 Windows 实测。`--omit=dev` 保留。
  npm 11 会提示 esbuild / onnxruntime-node / sharp 的 install 脚本「not yet covered by
  allowScripts」没执行——**不用管，也不用加 `--foreground-scripts`**（那只改输出是否实时显示，
  不影响脚本跑不跑）：sharp 0.33+ 的 Windows 运行库就是 `@img/sharp-win32-x64` 这个预编译
  optional 包，装上它就能 require，install 脚本只在需要现编 libvips 时才有用。真装没装成，
  由下面的自检真跑来判，不靠猜。
* **自检要真跑，不能只看文件在不在。** 2026-09-18 就是这么漏的：`--omit=optional` 装出来的
  hyperframes 四个文件路径全在、`--check` 报绿，实际渲染时 sharp 加载失败。所以 `--check`
  末尾会 ① 用 cli.js 的解析规则 `require('sharp')`，② 对一个内置的最小分页 composition
  真跑一次 `cli.js lint`（带 `HYPERFRAMES_NO_TELEMETRY` / `HYPERFRAMES_NO_UPDATE_CHECK`，
  否则遗留的后台子进程会占住临时目录）。
* **`--runtime-root PATH`**：自检的 node 与 chrome 从这个目录的运行时布局找，cli 与 gsap
  仍然只认本目录装的那份。仓库工作区里没有 `node-runtime`，不带这个参数时 `--check` 必红；
  打包前想在仓库里自检，就把它指向已安装的底包。
* **chrome-headless-shell 不由 npm install 装**：它要么在本目录 `chrome-headless-shell/`，
  要么蹭 remotion 的 `node_modules/.remotion/…`。缺它默认只告警（`--require-browser`
  可以升成硬失败），因为 remotion 那份是 remotion 自己 `npm install` 的副产物，不归本脚本管。
  判定办法：先按真实环境跑一次 `renderer_dependencies`；不过就把
  `HYPERFRAMES_BROWSER_PATH` 临时指到一个确定存在的文件再跑一次——第二次过了，
  说明缺的**只有**浏览器。
* 版本钉在本目录 `package.json` 的 dependencies 上，脚本不抄第二份。装用 `npm ci`
  按 `package-lock.json` 严格还原；锁文件缺失时退回 `npm install`。
* npm 在 Windows 上是 `npm.cmd`，这里 `subprocess.run(..., shell=False)` 直接跑它；
  参数里没有换行，不会踩 `pi.cmd` 那个「cmd 在第一个换行处截断参数」的坑。
  换 npm 用 `MATERIAL_AGENT_NPM_EXE` 指到具体可执行文件。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HF_DIR = Path(__file__).resolve().parent
NODE_MODULES = HF_DIR / "node_modules"

# 「运行根」＝ `tools/` 的上级：仓库里是 `VideoAutoCut/`，运行包里是解压出来的那个根目录。
# parents[0]=hyperframes → [1]=material_gen → [2]=tools → [3]=运行根。与
# `template_packaging.render_overlay()` 传给 `renderer_dependencies` 的基点同一个。
RUNTIME_ROOT_PARTS_UP = 3
TOOLS_DIR = Path(__file__).resolve().parents[2]


def runtime_root() -> Path:
    return Path(__file__).resolve().parents[RUNTIME_ROOT_PARTS_UP]


def renderer_dependencies():
    """运行时那份探测函数。延迟 import：装之前它也能正常载入（纯 stdlib 依赖）。"""
    sys.path.insert(0, str(TOOLS_DIR))
    from template_packaging import renderer_dependencies as resolve  # noqa: PLC0415

    return resolve


def required_versions() -> dict[str, str]:
    """从本目录 package.json 读钉死的版本，不在脚本里抄第二份。"""
    try:
        data = json.loads((HF_DIR / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SystemExit(f"[install_hyperframes] 读不了 {HF_DIR / 'package.json'}：{error}")
    dependencies = data.get("dependencies")
    if not isinstance(dependencies, dict) or not dependencies:
        raise SystemExit(f"[install_hyperframes] {HF_DIR / 'package.json'} 里没有 dependencies")
    return {name: str(value).lstrip("^~") for name, value in dependencies.items()}


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
            "PATH 上找不到 npm。请装 Node.js，或用 MATERIAL_AGENT_NPM_EXE "
            "指向 npm 可执行文件（Windows 上是 npm.cmd）。"
        )
    return found


def local_component_overrides() -> dict[str, str]:
    """`--runtime-root` 模式：node 与 chrome 从 root 找，cli 与 gsap 只认本目录装的那份。

    不钉住 cli/gsap 的话，`renderer_dependencies(root)` 会回退到 root 自己的
    `tools/material_gen/hyperframes/node_modules`，于是"检查仓库里装的这份"就变成了
    "检查底包里那份"——又是一次假绿。
    """
    return {"HYPERFRAMES_CLI": str(HF_DIR / "node_modules/hyperframes/dist/cli.js"),
            "HYPERFRAMES_GSAP": str(HF_DIR / "node_modules/gsap/dist/gsap.min.js")}


def resolve_components(root: Path | None = None) -> tuple[tuple | None, str, bool]:
    """跑运行时的探测。返回 (四件套, 失败说明, 是否只缺浏览器)。"""
    resolve = renderer_dependencies()
    root = root or runtime_root()
    try:
        return resolve(root), "", False
    except RuntimeError as error:
        first = str(error)
    # 把浏览器临时"补齐"成一个确定存在的文件再探一次：还过不了说明缺的不只是浏览器。
    previous = os.environ.get("HYPERFRAMES_BROWSER_PATH")
    os.environ["HYPERFRAMES_BROWSER_PATH"] = str(Path(__file__).resolve())
    try:
        resolve(root)
    except RuntimeError:
        return None, first, False
    finally:
        if previous is None:
            os.environ.pop("HYPERFRAMES_BROWSER_PATH", None)
        else:
            os.environ["HYPERFRAMES_BROWSER_PATH"] = previous
    return None, first, True


def installed_version(entry: Path) -> str | None:
    """从 dist/xxx 回推包的 package.json；覆盖键指到别处时可能读不到，返回 None。"""
    for parent in (entry.parent.parent, entry.parent):
        candidate = parent / "package.json"
        if candidate.is_file():
            try:
                return json.loads(candidate.read_text(encoding="utf-8")).get("version")
            except (OSError, ValueError):
                return None
    return None


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
    """十进制 MB，与 install_pi.py 同口径（字节总和）。"""
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1000 or unit == "GB":
            return f"{value:.1f} {unit}"
        value /= 1000
    return f"{value:.1f} GB"


def install() -> None:
    npm = npm_executable()
    lock = HF_DIR / "package-lock.json"
    subcommand = "ci" if lock.is_file() else "install"
    # 没有 --omit=optional：hyperframes 的原生依赖全是 optional 的平台包，见文件头。
    command = [npm, subcommand, "--prefix", str(HF_DIR), "--omit=dev"]
    print(f"[install_hyperframes] {' '.join(command)}")
    completed = subprocess.run(command, shell=False)
    if completed.returncode != 0:
        raise SystemExit(f"[install_hyperframes] npm {subcommand} 失败，退出码 {completed.returncode}")


MINIMAL_PAGED_COMPOSITION = """<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;width:640px;height:360px;background:transparent}
#main{position:relative;width:640px;height:360px}
.card{position:absolute;left:40px;top:40px;font:700 32px sans-serif;color:#fff;opacity:0}
</style><script src="gsap.min.js"></script></head><body>
<div id="main" data-composition-id="main" data-start="0" data-width="640" data-height="360" data-duration="2">
<div id="page-0" class="clip card" data-start="0.000000" data-duration="1.000000" data-track-index="1">A</div>
<div id="page-1" class="clip card" data-start="1.000000" data-duration="1.000000" data-track-index="2">B</div></div>
<script>const tl=gsap.timeline({paused:true});\
tl.fromTo("#page-0",{opacity:0,y:14},{opacity:1,y:0,duration:0.2,ease:"power2.out"},0);\
tl.to("#page-0",{opacity:0,duration:0.2},0.8);tl.set("#page-0",{opacity:0},1.0);\
tl.fromTo("#page-1",{opacity:0,y:14},{opacity:1,y:0,duration:0.2,ease:"power2.out"},1.0);\
tl.to("#page-1",{opacity:0,duration:0.2},1.8);tl.set("#page-1",{opacity:0},2.0);\
window.__timelines=window.__timelines||{};window.__timelines.main=tl;</script>
</body></html>"""

# 和 template_packaging.render_overlay 一致：不带这两个，hyperframes 会留下后台子进程
# 占着临时目录，Windows 上清理时报 WinError 32。
QUIET_ENV = {"HYPERFRAMES_NO_TELEMETRY": "1", "HYPERFRAMES_NO_UPDATE_CHECK": "1"}
# 单行，免得 Windows 上参数里出现换行（与 install_pi.py 同一个理由）。
SHARP_SCRIPT = ("const {createRequire} = require('module'); "
                "createRequire(process.argv[1])('sharp'); console.log('sharp ok')")


def run_sharp_probe(node: Path, cli: Path) -> str:
    """按 cli.js 的解析规则真 require 一次 sharp。返回空串表示通过。"""
    try:
        completed = subprocess.run([str(node), "-e", SHARP_SCRIPT, str(cli)],
                                   capture_output=True, text=True, encoding="utf-8",
                                   errors="replace", timeout=120)
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"跑不起来 {node}：{error}"
    if completed.returncode != 0:
        detail = [line.strip() for line in (completed.stderr or completed.stdout or "").splitlines() if line.strip()]
        # Windows 上第一条非空行是 node 打印的源码行 `throw new Error(help.join('\n'));`，
        # 光按「含 Error」挑会挑到它。先找真正的错误行（以 `Error:` 开头），再退回旧逻辑。
        head = next((line for line in detail if line.startswith("Error:")), None)
        if head is None:
            head = next((line for line in detail if "Error" in line), detail[0] if detail else "无输出")
        return (f"require('sharp') 失败：{head}"
                "——多半是装的时候 omit 了可选依赖，缺了 @img/sharp-* 平台包，"
                "删掉 node_modules 重新跑一次本脚本（不要加 --omit=optional）")
    return ""


def run_lint_probe(node: Path, cli: Path, gsap: Path) -> str:
    """对内置的最小分页 composition 真跑一次 lint。返回空串表示通过。"""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        work = Path(directory)
        (work / "index.html").write_text(MINIMAL_PAGED_COMPOSITION, encoding="utf-8")
        try:
            shutil.copy2(gsap, work / "gsap.min.js")
            completed = subprocess.run([str(node), str(cli), "lint", str(work)], cwd=work,
                                       env={**os.environ, **QUIET_ENV}, capture_output=True,
                                       text=True, encoding="utf-8", errors="replace", timeout=300)
        except (OSError, subprocess.TimeoutExpired) as error:
            return f"跑不起来 hyperframes lint：{error}"
    if completed.returncode != 0:
        output = (completed.stdout + completed.stderr).strip()
        return f"hyperframes lint 跑不通（退出码 {completed.returncode}）：\n{output[-800:]}"
    return ""


def check(*, require_browser: bool = False, runtime_root: Path | None = None) -> None:
    root = runtime_root
    wanted = required_versions()
    problems: list[str] = []
    warnings: list[str] = []
    lines: list[str] = []
    previous = {key: os.environ.get(key) for key in ("HYPERFRAMES_CLI", "HYPERFRAMES_GSAP")}
    if root is not None:
        os.environ.update(local_component_overrides())
    try:
        components, failure, browser_only = resolve_components(root)
        node = cli = gsap = None
        if components is None and not browser_only:
            problems.append(failure)
        else:
            if browser_only:
                message = (
                    "找不到 chrome-headless-shell（本目录 chrome-headless-shell/ 与 remotion 的 "
                    ".remotion/ 两处都没有）。它不由 npm install 装：装 remotion 依赖时会带下来，"
                    "或手动放进本目录的 chrome-headless-shell/。缺它模板包装会在合成阶段失败"
                )
                (problems if require_browser else warnings).append(message)
                browser_previous = os.environ.get("HYPERFRAMES_BROWSER_PATH")
                os.environ["HYPERFRAMES_BROWSER_PATH"] = str(Path(__file__).resolve())
                try:
                    node, cli, gsap, _browser = renderer_dependencies()(root or runtime_root())
                finally:
                    if browser_previous is None:
                        os.environ.pop("HYPERFRAMES_BROWSER_PATH", None)
                    else:
                        os.environ["HYPERFRAMES_BROWSER_PATH"] = browser_previous
            else:
                node, cli, gsap, browser = components
                lines.append(f"✓ chrome        {browser}")
            lines.insert(0, f"✓ node          {node}")
            if root is not None and HF_DIR not in cli.parents:
                problems.append(f"解析到的 cli.js 不在本目录下（{cli}）——本目录还没装上，"
                                "别拿底包那份冒充，先跑一次本脚本")
            for name, entry in (("hyperframes", cli), ("gsap", gsap)):
                version = installed_version(entry)
                if version is None:
                    warnings.append(f"读不到 {name} 的 package.json（{entry}），版本未校验")
                    lines.append(f"· {name:<13} {entry}")
                elif version != wanted.get(name):
                    problems.append(f"{name} 版本不对：装到的是 {version}，要求 {wanted.get(name)}")
                else:
                    lines.append(f"✓ {name:<13} {version}  {entry}")
        # 真跑：只查文件存在是假绿（2026-09-18 踩过），装完必须能 require sharp、能跑 lint。
        if not problems and node is not None:
            sharp_problem = run_sharp_probe(node, cli)
            problems.append(sharp_problem) if sharp_problem else lines.append("✓ require(sharp) 通过")
            if not sharp_problem:
                lint_problem = run_lint_probe(node, cli, gsap)
                problems.append(lint_problem) if lint_problem else lines.append("✓ 最小分页 composition lint 0 errors")
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    for line in lines:
        print(f"[install_hyperframes] {line}")
    for warning in warnings:
        print(f"[install_hyperframes] ! {warning}")
    if problems:
        for problem in problems:
            print(f"[install_hyperframes] ✗ {problem}", file=sys.stderr)
        print(
            "[install_hyperframes] 自检不通过。先跑 "
            "`python VideoAutoCut/tools/material_gen/hyperframes/install_hyperframes.py` 装一次；"
            "缺的若是「内置 Node」或 Chrome，说明这不是一个运行时目录——"
            "在仓库里自检要加 `--runtime-root <已安装的运行包目录>`（自检与运行时同一套解析规则，不看 PATH）。",
            file=sys.stderr,
        )
        raise SystemExit(1)

    files, total = measure(NODE_MODULES)
    print(f"[install_hyperframes] ✓ node_modules  {files} 个文件 / {total} 字节（{human(total)}）")
    print("[install_hyperframes] node_modules 不入库，随运行包分发：打包前依次跑 "
          "install_pi.py 与本脚本，各自 --check 通过再打包。")


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
        description=f"把 HyperFrames 渲染器按 package.json 钉死的版本装进 {HF_DIR}（供运行包自带）",
    )
    parser.add_argument("--check", action="store_true", help="只跑自检，不执行 npm install")
    parser.add_argument("--require-browser", action="store_true",
                        help="把缺 chrome-headless-shell 从告警升成失败")
    parser.add_argument("--runtime-root", type=Path, default=None,
                        help="自检时从这个运行时目录找 node 与 chrome（仓库里自检时指向已安装的底包）；"
                             "cli 与 gsap 仍只认本目录装的那份")
    args = parser.parse_args(argv)
    if not args.check:
        install()
    check(require_browser=args.require_browser, runtime_root=args.runtime_root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
