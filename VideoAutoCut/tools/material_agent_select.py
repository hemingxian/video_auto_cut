#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Agent-driven material selection inside a bound scope (trial, opt-in).

Enabled by MATERIAL_AGENT_SELECT=1 through material_selection_policy.py.
The engine contract is unchanged: request JSON in, report JSON out.

Rules (do not relax):
- Only paths under clip_root are ever returned; searches only inside bound_root.
- No random fallback. If nothing is acceptable the report says ok=false.
- Every decision (queries tried, candidates, frames, model verdict) is written
  to material-agent-log.json next to the report so it can be audited.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (
    env_bool,
    env_float,
    env_int,
    find_ffmpeg,
    load_dotenv,
    load_prompt_template,
    render_prompt_template,
)
from json_io import atomic_write_json

LOG_FILE_NAME = "material-agent-log.json"
FRAMES_DIR_NAME = "_agent_frames"
# Run-level orientation memory, shared by every shot: clips/_agent_cache/orientation.json
CACHE_DIR_NAME = "_agent_cache"
ORIENTATION_CACHE_FILE_NAME = "orientation.json"
ORIENTATION_CACHE_HISTORY = 20
QUERY_DIR_PREFIX = "_agent_q"
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi"}
SEARCH_LINE = re.compile(r"^\s*#(\d+)\s+\[([-0-9.eE]+)\]\s+(.+?)\s+@\s+(\S+)-(\S+)\s*$")
CLIPS_PREFIX = "VACUT_CLIPS:"
# sentrysearch names every exported clip "match_{source}_{MMmSSs}-{MMmSSs}.mp4"
# (sentrysearch/trimmer.py::_safe_filename). The engine and the agent write the
# same segment into different directories, so the span in the name is what tells
# two exports of one segment apart from two different segments.
CLIP_SPAN_NAME = re.compile(r"^(?:match_)?(?P<base>.+?)_(?P<start>\d+m\d+s)-(?P<end>\d+m\d+s)$", re.IGNORECASE)
SPAN_TEXT = re.compile(r"^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$")
ORIENTATIONS = ("upright", "rotated", "unsure")
# The prompt asks for reason ≤40 chars and list items ≤12; 28 of 48 reasons still
# ran over on 2026-09-17 (longest 72). Anything past these limits is cut after
# parsing, so one wordy reply cannot keep growing the audit log.
JUDGE_REASON_LIMIT = 60
JUDGE_LIST_LIMIT = 4
JUDGE_LIST_ITEM_LIMIT = 20
# 评审漏评（ranking 少了候选）时补一句要求再问一次，措辞集中在这里，和顶层数组重试同构。
JUDGE_COVERAGE_NUDGE = ("\n\n注意：ranking 必须包含全部 {total} 个候选，每个候选一项，不要省略；"
                        "先把 {total} 个候选逐个评审写进 ranking，再在 pick 里挑。")
JUDGE_COVERAGE_RETRY_LOG = "[agent] 评审漏评候选 {missing}（{reviewed}/{total}），补充要求逐个评审后重试一次"
OBSTRUCTIONS = ("none", "partial", "heavy")
CAMERA_ANGLES = ("overhead", "high", "eye_level", "low", "unsure")
# Deterministic backstop for the judge: a sideways frame is never usable, and an
# orientation the model will not commit to loses priority instead of being trusted.
UNSURE_ORIENTATION_PENALTY = 30.0
# 2026-09-17: the judge called a shot whose subject sits behind a safety mesh
# "无遮挡" and gave it 95. Obstruction now caps the score whatever the model says.
OBSTRUCTION_SCORE_CAP = {"heavy": 50.0, "partial": 75.0}
# 2026-09-17: a candidate with "没有袋料/没有箱体/未展示不同工件对比" in ``missing``
# still scored 85 and was used. What the model leaves out of the frame decides the
# band, deterministically: one gap keeps it out of the 90s, three gaps refuse it
# (55 < the default minimum of 60).
MISSING_SCORE_CAP = {1: 89.0, 2: 75.0}
MISSING_SCORE_CAP_MANY = 55.0
# Tie-break for the fallback suggestion a human reads after a full refusal.
OBSTRUCTION_PREFERENCE = {"none": 0, "partial": 1, "heavy": 2}
ORIENTATION_PREFERENCE = {"upright": 0, "unsure": 1, "rotated": 2}
# Re-search words that describe a concept or an edit instead of a frame. The
# vector index only holds workshop footage, so these can only return noise.
QUERY_BLOCKLIST = (
    "simulation", "test", "verification", "validation", "failure", "scenario",
    "concept", "generic", "solution",
    # editing narration; the Chinese half is named in the prompt, these are its
    # English equivalents ("aerial shot ..." was searched for real on 2026-09-17)
    "footage", "close-up", "closeup", "cut to", "b-roll",
    "仿真", "测试", "验证", "通用", "场景", "概念", "方案", "切至", "镜头", "特写", "画面",
)
# 2026-09-17: the blocklist only held "aerial/wide/close/medium/establishing shot",
# so "top-down shot showing pickup station ..." went through. "shot" is an editing
# word wherever it appears - except in the industrial process, which is why the
# lookahead keeps shot blasting / shot peening searchable.
QUERY_SHOT_WORD = re.compile(r"\bshot\b(?![\s-]+(?:blast|peen))")
QUERY_VERBS = (
    "pick", "place", "lift", "grip", "grab", "hold", "move", "rotate", "turn", "stack",
    "convey", "carry", "load", "unload", "feed", "transfer", "align", "insert", "push",
    "pull", "press", "clamp", "weld", "grind", "polish", "spray", "wrap", "seal", "scan",
    "inspect", "extend", "retract", "drop", "slide", "raise", "lower", "contact", "adjust",
    # 2026-09-17: "conveyor belt connects pickup station to palletizer ..." was
    # refused for having "no action word". These are the plain verbs a frame
    # description actually uses.
    "connect", "link", "join", "run", "pass", "flow", "travel", "enter", "leave",
    "arrive", "approach", "tilt", "tip", "spill", "fall", "stop", "start", "rest",
    "sit", "stand", "hang", "swing", "sway", "shake", "vibrate", "open", "close",
    "release", "return", "follow", "guide", "reach", "touch", "descend", "ascend",
    "rise", "sink", "land", "settle", "hover", "wait", "queue", "show",
)
QUERY_VERB_PHRASES = re.compile(r"\bline[sd]?\s+up\b|\blining\s+up\b")
QUERY_VERB_HANZI = "抓放抬转移夹吸码送举落推拉装卸搬走看检连接经过进出到停起降开合松靠贴升摆晃倒滑翻"
# Fabricated sizes: the rewrite invented "吸盘已离开箱面5厘米" for a shot whose
# script never names a distance. A number the script does not carry cannot help
# the vector search and can only describe footage nobody asked for.
QUERY_MEASUREMENT_CN = re.compile(r"(\d+(?:\.\d+)?)\s*(厘米|毫米|公分|米|度)")
QUERY_MEASUREMENT_EN = re.compile(r"(\d+(?:\.\d+)?)\s*(cm|mm|degrees?|m)\b", re.IGNORECASE)


# ----------------------------------------------------------------------------
# settings
# ----------------------------------------------------------------------------

def agent_enabled() -> bool:
    return env_bool("MATERIAL_AGENT_SELECT", False)


def setting_int(name: str, default: int, low: int, high: int) -> int:
    return max(low, min(high, env_int(name, default)))


def setting_ratio(name: str, default: float, low: float, high: float) -> float:
    value = env_float(name, default)
    if not math.isfinite(value):
        return default
    return max(low, min(high, value))


def backend_name() -> str:
    """后端只由 MATERIAL_AGENT_BACKEND 决定，没显式配一律 dashscope。

    行为变更（2026-09-17，pi 打进运行包那一轮）：旧版是「没配 BACKEND 但机器上
    找得到 pi 就默认走 pi」。运行包开始自带 pi 之后，那条默认会让**所有**安装
    静默切到 pi 通路（模型、耗时、口径全变），所以收紧成显式选择：只有
    MATERIAL_AGENT_BACKEND=pi 才走 pi，其余（含留空、含机器上装了 pi）都是
    dashscope。
    """
    configured = os.environ.get("MATERIAL_AGENT_BACKEND", "").strip().lower()
    if configured in {"pi", "dashscope"}:
        return configured
    return "dashscope"


def runtime_root() -> Path:
    """运行包根目录（`tools/` 的上级），与 template_packaging.render_overlay 同一算法。

    仓库里是 `VideoAutoCut/`，运行包里是解压出来的那个根目录——两处都满足
    「`tools/` 的上级」，所以包内 pi 与包内 node-runtime 用同一个基点。
    """
    return Path(__file__).resolve().parents[1]


# 运行包自带的 pi：`tools/` 整棵被打包脚本拷进运行包，所以放这里就自动进包。
BUNDLED_PI_DIR_PARTS = ("tools", "material_gen", "pi")
BUNDLED_PI_CLI_PARTS = (
    *BUNDLED_PI_DIR_PARTS,
    "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js",
)


def bundled_pi_dir() -> Path:
    return runtime_root().joinpath(*BUNDLED_PI_DIR_PARTS)


def bundled_pi_cli() -> Path:
    return runtime_root().joinpath(*BUNDLED_PI_CLI_PARTS)


def pi_executable() -> str | None:
    """Whatever `pi` resolves to. May be a .cmd shim; use pi_command() to launch.

    顺序：MATERIAL_AGENT_PI_EXE → 运行包内的 cli.js → PATH 上的 pi。包内那份是
    自包含 bundle，直接交给 node 跑，不经 npm 的 .cmd shim（shim 会截断多行参数，
    见 pi_command 的说明）。
    """
    configured = os.environ.get("MATERIAL_AGENT_PI_EXE", "").strip()
    if configured and Path(configured).is_file():
        return configured
    bundled = bundled_pi_cli()
    if bundled.is_file():
        return str(bundled)
    return shutil.which("pi")


def node_executable(near: Path | None = None) -> str:
    """node used to run pi's cli.js directly. `near` is the npm dir holding node.exe.

    顺序：MATERIAL_AGENT_NODE_EXE → VIDEOAUTO_NODE_EXE（运行包既有变量，模板包装
    也用它）→ 运行包内 `node-runtime/node.exe` → `node/node.exe` → pi 同目录的
    node → PATH。中间三档与 template_packaging.renderer_dependencies 一致，所以
    包内 pi 不需要用户再配任何路径。
    """
    for name in ("MATERIAL_AGENT_NODE_EXE", "VIDEOAUTO_NODE_EXE"):
        configured = os.environ.get(name, "").strip()
        if configured and Path(configured).is_file():
            return configured
    root = runtime_root()
    for parts in (("node-runtime", "node.exe"), ("node-runtime", "node"), ("node", "node.exe"), ("node", "node")):
        candidate = root.joinpath(*parts)
        if candidate.is_file():
            return str(candidate)
    if near is not None:
        for name in ("node.exe", "node"):
            candidate = near / name
            if candidate.is_file():
                return str(candidate)
    found = shutil.which("node")
    if found:
        return found
    raise RuntimeError(
        "找不到 node，无法直接运行 pi 的 cli.js（Windows 上不能走 pi.cmd，见 MATERIAL_AGENT_PI_EXE 说明）。"
        "请把 node 加进 PATH，或用 MATERIAL_AGENT_NODE_EXE 指向 node 可执行文件。"
    )


def pi_command() -> list[str] | None:
    """Command prefix that launches pi.

    Windows: `shutil.which("pi")` finds npm's `pi.CMD`, which forwards arguments
    through cmd.exe as `"%_prog%" cli.js %*`. cmd truncates the argument list at
    the first newline, so the multi-line system prompt and everything after it —
    including `--`, the `@image` arguments and the user text — never reach pi:
    it emits one session event, exits 0 with empty stderr, and the caller sees an
    empty assistant message. Quoting cannot fix this reliably (`"`, `%`, `^`, `&`,
    `|`, `<`, `>` are all hazards), so resolve the bundled cli.js and run it with
    node instead.
    """
    executable = pi_executable()
    if not executable:
        return None
    path = Path(executable)
    suffix = path.suffix.lower()
    if suffix in {".js", ".mjs", ".cjs"}:
        return [node_executable(path.parent), executable]
    if suffix in {".cmd", ".bat"}:
        cli = path.parent.joinpath(
            "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"
        )
        if cli.is_file():
            return [node_executable(path.parent), str(cli)]
        raise RuntimeError(
            f"pi 解析到 {executable}：经 cmd 转发的参数会在第一个换行处被截断，"
            f"多行 system prompt 与其后的图片、用户文本全部丢失，pi 会静默返回空结果。"
            f"同目录下也没找到 {cli}。"
            "请把 MATERIAL_AGENT_PI_EXE 指向 pi 的 cli.js（脚本会自动加 node），不要指向 .cmd/.bat。"
        )
    return [executable]


def pi_provider() -> str:
    return os.environ.get("MATERIAL_AGENT_PI_PROVIDER", "").strip() or "dashscope"


def pi_model() -> str:
    """Vision-capable model used to judge frames."""
    return os.environ.get("MATERIAL_AGENT_PI_MODEL", "").strip() or "qwen3-vl-plus"


def pi_text_model() -> str:
    """Model for text-only steps (query rewriting); defaults to the vision model."""
    return os.environ.get("MATERIAL_AGENT_PI_TEXT_MODEL", "").strip() or pi_model()


def pi_thinking() -> str:
    """Thinking level passed to pi (off by default: judging frames does not need long reasoning)."""
    value = os.environ.get("MATERIAL_AGENT_PI_THINKING", "").strip().lower()
    return value if value in {"off", "minimal", "low", "medium", "high", "xhigh", "max"} else "off"


def dashscope_thinking() -> bool | None:
    """Leave provider defaults intact unless this agent-only option is set."""
    value = os.environ.get("MATERIAL_AGENT_DASHSCOPE_THINKING", "").strip().lower()
    if not value:
        return None
    if value in {"off", "false", "0"}:
        return False
    if value in {"on", "true", "1"}:
        return True
    raise ValueError("MATERIAL_AGENT_DASHSCOPE_THINKING must be on or off")


# Providers that are the company DashScope gateway under another name reuse the
# account-issued DASHSCOPE_API_KEY, so nothing has to be written into app.env.
DASHSCOPE_KEY_PROVIDERS = ("dashscope", "evst-gateway")


def pi_api_key() -> str:
    explicit = os.environ.get("MATERIAL_AGENT_PI_API_KEY", "").strip()
    if explicit:
        return explicit
    source = os.environ.get("MATERIAL_AGENT_PI_API_KEY_FROM", "").strip().lower()
    if source == "dashscope" or (not source and pi_provider() in DASHSCOPE_KEY_PROVIDERS):
        return os.environ.get("DASHSCOPE_API_KEY", "").strip()
    return ""


PI_PROVIDER_CONFIG_LOG = "[agent] pi provider 配置 "


def pi_agent_dir() -> Path:
    """pi 的用户配置目录（默认 `~/.pi/agent`，Windows 即 `%USERPROFILE%\\.pi\\agent`）。

    pi 0.85.1 查证（`src/config.ts`）：`getAgentDir()`（528-534 行）先读环境变量
    `PI_CODING_AGENT_DIR`（507 行 `ENV_AGENT_DIR`，由 APP_NAME 拼出来），没有才用
    `homedir()/CONFIG_DIR_NAME/agent`；`CONFIG_DIR_NAME` 取自 package.json 的
    `piConfig.configDir`（504 行，值就是 `.pi`）。models.json 固定是
    `getAgentDir()/models.json`（`getModelsPath()`，541-543 行），**没有**命令行参数
    能单独换这一个文件的路径（`--models` 是 Ctrl+P 的模型轮换列表，不是路径），
    所以只能合并进用户目录，并顺带尊重 `PI_CODING_AGENT_DIR`。
    """
    configured = os.environ.get("PI_CODING_AGENT_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".pi" / "agent"


def bundled_pi_provider_config(provider: str) -> Path:
    """运行包里随 `tools/` 一起发出去的 provider 配置正本，文件名约定 models.{provider}.json。"""
    return bundled_pi_dir() / f"models.{provider}.json"


def ensure_pi_provider_config(provider: str | None = None) -> None:
    """把运行包自带的 provider 配置合并进 pi 的 models.json（首启一次，之后幂等）。

    models.json 的 schema 只有一个顶层键：`{"providers": {"<名字>": {...}}}`
    （pi 0.85.1 `src/core/model-config.ts` 212-215 行 `ModelsConfigSchema`）。所以
    这里**只**增/覆盖 `providers[provider]` 这一个键，用户自己的其他 provider 和
    顶层其他键原样保留；内容已经一致就不写。写入走临时文件 + `os.replace`。

    任何失败都不中断任务，只打一行警告——真配错了 pi 调用本身会报错，那时用户
    看得见，比在这里把整条流水线拦下来划算。`MATERIAL_AGENT_PI_SKIP_PROVIDER_MERGE=1`
    可整体关掉（自己维护 models.json 的机器用）。
    """
    if env_bool("MATERIAL_AGENT_PI_SKIP_PROVIDER_MERGE", False):
        return
    name = (provider if provider is not None else pi_provider()).strip()
    if not name:
        return
    source = bundled_pi_provider_config(name)
    if not source.is_file():
        # 包里没带这个 provider 的配置（例如 provider=dashscope 用的是用户自己那份），
        # 不是错误，也不打日志。
        return
    target = pi_agent_dir() / "models.json"
    temporary: Path | None = None
    try:
        wanted = json.loads(source.read_text(encoding="utf-8-sig"))["providers"][name]
        document: dict[str, Any] = {}
        if target.is_file():
            loaded = json.loads(target.read_text(encoding="utf-8-sig"))
            if not isinstance(loaded, dict):
                raise ValueError("models.json 顶层不是对象")
            document = loaded
        providers = document.get("providers")
        if not isinstance(providers, dict):
            providers = {}
        if providers.get(name) == wanted:
            print(f"{PI_PROVIDER_CONFIG_LOG}{name} 与 {target} 已一致，跳过", flush=True)
            return
        providers[name] = wanted
        document["providers"] = providers
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f"{target.name}.tmp-{os.getpid()}")
        temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, target)
        temporary = None
        print(f"{PI_PROVIDER_CONFIG_LOG}{name} 已合并进 {target}（其余 provider 与顶层其他键原样保留）", flush=True)
    except Exception as error:  # noqa: BLE001 - 合并失败不该拦住整条任务
        print(f"{PI_PROVIDER_CONFIG_LOG}{name} 合并失败，已跳过（pi 若报 provider 未配置，"
              f"请手工把 {source} 并进 {target}）：{error}", flush=True)
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass


# 本进程已经为哪些 provider 打过「没配」的告警（同一进程里只打一次；引擎是每镜起一个
# Python 子进程，所以整跑时每镜会有一行——那是进程边界，不是 bug）。
_PI_PROVIDER_WARNED: set[str] = set()
# 日志里不用 U+26A0 之类的符号：中文 Windows 把 stdout 重定向到文件时按 gbk 编码，
# 编不出来会抛 UnicodeEncodeError——一个「让静默降级可见」的功能反倒把调用方打断，
# 在包装线还会被 packaging_agent 的 except 吞成一条假错因。
PI_PROVIDER_MISSING_LOG = "[agent] [!] pi provider "
# pi 用户目录里可能出现的 provider 线索文件。布局随 pi 版本变（0.85 实测是
# `models-store.json` + `settings.json`，不一定有 `models.json`），所以逐个扫，
# 命中任意一个就算配了：**宁可少打一条提醒，也不要打假告警**。
PI_PROVIDER_HINT_FILES = ("models.json", "models-store.json", "auth.json", "settings.json")


def json_names_in(path: Path) -> tuple[set[str], bool]:
    """收集一个 JSON 文件里顶层 / 次层的键名与字符串值，外加「这文件读出来了吗」。

    只想知道「这个 provider 名出现过没有」，所以扫得宽：键名（`providers` 下一层）
    和值（`settings.json` 的 `defaultProvider` 是字符串值）都算。
    读不出来（文件损坏 / 没权限）与「确实没有」要分开——前者不该拿来判定没配。
    """
    names: set[str] = set()
    try:
        document = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return names, True          # 文件不存在 = 确实没有，算读到了
    except (OSError, ValueError):
        return names, False         # 损坏 / 读不了：不能据此断言没配
    def collect(value: object, depth: int) -> None:
        if isinstance(value, dict):
            names.update(str(key) for key in value)
            if depth:
                for item in value.values():
                    collect(item, depth - 1)
        elif isinstance(value, str):
            names.add(value)
    collect(document, 2)
    return names, True


def pi_provider_is_configured(provider: str) -> bool:
    """这个 provider 有没有线索说明它是配好的。任一命中即算配了：

    1. 显式给了 key（`MATERIAL_AGENT_PI_API_KEY`）——那是 docs 里推荐的另一条配法；
    2. 运行包自带 `tools/material_gen/pi/models.{provider}.json` **且首启合并没被关掉**；
    3. pi 用户目录（`~/.pi/agent`，尊重 `PI_CODING_AGENT_DIR`）的任一配置文件里出现过这个名字；
    4. 上述文件有读不出来的（损坏 / 没权限）——那就**不下结论**，按配了处理。
    """
    if not provider:
        return False
    if os.environ.get("MATERIAL_AGENT_PI_API_KEY", "").strip():
        return True
    if bundled_pi_provider_config(provider).is_file():
        # 关掉首启合并时，包里那份不会进用户目录，所以不能拿它当「配好了」的证据。
        if not env_bool("MATERIAL_AGENT_PI_SKIP_PROVIDER_MERGE", False):
            return True
    agent_dir = pi_agent_dir()
    for name in PI_PROVIDER_HINT_FILES:
        names, readable = json_names_in(agent_dir / name)
        if not readable or provider in names:
            return True
    return False


def warn_if_pi_provider_missing() -> None:
    """backend=pi 但 provider 查无线索时，在**第一次调用之前**打一行醒目告警。

    2026-09-21 Windows 回帖 51296044 第五节的真实踩坑：app.env 只写了
    `PACKAGING_AGENT_BACKEND=pi`，没写 `MATERIAL_AGENT_PI_PROVIDER`，于是取默认值
    `dashscope`；而运行包里只带 `models.evst-gateway.json` → pi 报 Unknown provider →
    每镜 0.2s 静默降级，整跑 5 条脚本的 agent 全程没参与，成片照出，没人看得出来。

    **不阻断、不改降级行为**，只让这件事在日志里有一行。选材与包装两条线都经过
    `make_ask()`，所以挂在那里；每个 provider 每进程只打一次。
    """
    provider = pi_provider()
    if provider in _PI_PROVIDER_WARNED:
        return
    try:
        if pi_provider_is_configured(provider):
            return
        message = (
            f"{PI_PROVIDER_MISSING_LOG}{provider!r} 未配置或不存在："
            f"运行包里没有 {bundled_pi_provider_config(provider).name}，"
            f"{pi_agent_dir()} 下的 pi 配置里也查不到它。"
            f"pi 多半会报 Unknown provider，那样本次所有 agent 调用都会静默降级为确定性结果"
            f"（成片照出，但模型没参与）。"
            f"请在 app.env 里就地设 MATERIAL_AGENT_PI_PROVIDER（本机网关填 evst-gateway），"
            f"连同 MATERIAL_AGENT_PI_MODEL / _TEXT_MODEL / _THINKING 四个键一起，详见 .env.example。"
        )
    except Exception:  # noqa: BLE001 —— 一条提醒不值得把整条流水线带倒
        return
    _PI_PROVIDER_WARNED.add(provider)
    try:
        print(message, flush=True)
    except Exception:  # noqa: BLE001 —— 连日志都打不出来时保持沉默
        pass


def dashscope_model() -> str:
    return os.environ.get("DASHSCOPE_VISUAL_REVIEW_MODEL", "").strip() or "qwen3-vl-plus"


def orientation_model() -> str:
    """Model for the standalone orientation pass; empty means "same vision model"."""
    return os.environ.get("MATERIAL_AGENT_ORIENTATION_MODEL", "").strip()


@contextmanager
def orientation_model_selected() -> Iterator[None]:
    """Point both backends at MATERIAL_AGENT_ORIENTATION_MODEL for one call.

    ``ask`` keeps one signature everywhere (the tests fake it), so the model is
    swapped through the environment the backends already read.
    """
    model = orientation_model()
    if not model:
        yield
        return
    names = ("DASHSCOPE_VISUAL_REVIEW_MODEL", "MATERIAL_AGENT_PI_MODEL")
    previous = {name: os.environ.get(name) for name in names}
    try:
        for name in names:
            os.environ[name] = model
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def ffmpeg_path() -> str:
    found = find_ffmpeg()
    if found != "ffmpeg" or shutil.which("ffmpeg"):
        return found
    raise RuntimeError("找不到 ffmpeg")


def ffprobe_path() -> str:
    ffmpeg = Path(ffmpeg_path())
    probe = ffmpeg.with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
    if probe.is_file():
        return str(probe)
    found = shutil.which("ffprobe")
    if found:
        return found
    raise RuntimeError("找不到 ffprobe")


# ----------------------------------------------------------------------------
# request / shot context
# ----------------------------------------------------------------------------

def within(path: Path, root: Path) -> Path:
    resolved = path.resolve(strict=True)
    if not resolved.is_file() or not resolved.is_relative_to(root.resolve(strict=True)):
        raise ValueError(f"候选路径不在本分镜的素材范围内: {path}")
    return resolved


def find_shots_json(start: Path) -> Path | None:
    configured = os.environ.get("MATERIAL_AGENT_SHOTS_JSON", "").strip()
    if configured and Path(configured).is_file():
        return Path(configured)
    current = start.resolve()
    for candidate in [current, *current.parents][:10]:
        target = candidate / "shots.json"
        if target.is_file():
            return target
    return None


SHOT_TEXT_FIELDS = (
    "title",
    "module_label",
    "visual_query",
    "raw_visual_query",
    "download_query",
    "raw_download_query",
    "voice_text",
    "subtitle",
    "clip_requirements",
    "production_notes",
    "extra_requirements",
)


def load_shot_context(shots_json: Path | None, shot_id: str) -> dict[str, Any]:
    context: dict[str, Any] = {"shot_id": shot_id, "shots_json": str(shots_json) if shots_json else None}
    if shots_json is None:
        context["note"] = "shots.json not found; only engine candidates are judged"
        return context
    plan = json.loads(shots_json.read_text(encoding="utf-8-sig"))
    context["topic"] = plan.get("topic")
    shots = plan.get("shots") if isinstance(plan, dict) else []
    match = None
    for item in shots or []:
        if isinstance(item, dict) and str(item.get("shot_id") or "").strip() == str(shot_id).strip():
            match = item
            break
    if match is None:
        context["note"] = f"shot_id {shot_id} not found in shots.json"
        return context
    context["shot"] = match.get("shot")
    for field in SHOT_TEXT_FIELDS:
        value = match.get(field)
        if value not in (None, "", [], {}):
            context[field] = value
    context["duration"] = match.get("duration")
    return context


# ----------------------------------------------------------------------------
# sentrysearch (vector recall inside bound_root)
# ----------------------------------------------------------------------------

def sentrysearch_entry() -> Path | None:
    configured = os.environ.get("MATERIAL_AGENT_SENTRY_ENTRY", "").strip()
    if configured and Path(configured).is_file():
        return Path(configured)
    roots: list[Path] = []
    for name in ("VIDEOAUTO_ROOT", "VIDEOAUTO_RUNTIME_ROOT"):
        value = os.environ.get(name, "").strip()
        if value:
            roots.append(Path(value))
    roots.append(Path(__file__).resolve().parent.parent)
    for root in roots:
        for folder in ("sentrysearch", "sentrysearch_py", "sentrysearch_src", "sentrysearch_python"):
            candidate = root / folder / "sentrysearch_entry.py"
            if candidate.is_file():
                return candidate
    return None


def parse_search_output(output: str) -> tuple[list[dict[str, Any]], list[str]]:
    hits: list[dict[str, Any]] = []
    clips: list[str] = []
    for line in output.splitlines():
        if line.startswith(CLIPS_PREFIX):
            try:
                payload = json.loads(line[len(CLIPS_PREFIX):])
                clips = [str(item) for item in payload.get("paths", [])]
            except ValueError:
                pass
            continue
        match = SEARCH_LINE.match(line)
        if match:
            try:
                score = float(match.group(2))
            except ValueError:
                continue
            hits.append({
                "rank": int(match.group(1)),
                "score": score if math.isfinite(score) else None,
                "source_name": match.group(3).strip(),
                "start": match.group(4),
                "end": match.group(5),
            })
    hits.sort(key=lambda item: item["rank"])
    return hits, clips


def run_vector_search(
    query: str,
    source_root: Path,
    output_dir: Path,
    *,
    save_top: int,
    results: int,
    timeout: int,
) -> list[dict[str, Any]]:
    entry = sentrysearch_entry()
    if entry is None:
        raise RuntimeError("找不到 sentrysearch_entry.py，无法重新检索")
    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable, str(entry), "search", query,
        "--backend", "qwen-cloud",
        "--results", str(max(results, save_top)),
        "--save-top", str(save_top),
        "--source-root", str(source_root),
        "--threshold", "0.0",
        "--verbose",
        "--output-dir", str(output_dir),
    ]
    env = dict(os.environ)
    env.pop("VIDEOAUTO_MIN_MATCH_SCORE", None)  # the agent sees every score itself
    completed = subprocess.run(
        command, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout, env=env, stdin=subprocess.DEVNULL,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"sentrysearch 退出码 {completed.returncode}: {completed.stderr.strip()[-800:]}")
    hits, clips = parse_search_output(completed.stdout)
    candidates: list[dict[str, Any]] = []
    for index, clip in enumerate(clips):
        hit = hits[index] if index < len(hits) else {}
        candidates.append({
            "path": clip,
            "score": hit.get("score"),
            "source_name": hit.get("source_name"),
            "start": hit.get("start"),
            "end": hit.get("end"),
        })
    return candidates


# ----------------------------------------------------------------------------
# frames
# ----------------------------------------------------------------------------

def clip_duration(path: Path) -> float:
    result = subprocess.run(
        [ffprobe_path(), "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True, check=True, timeout=30,
    )
    seconds = float(json.loads(result.stdout)["format"]["duration"])
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("视频时长无效")
    return seconds


def probe_rotation(path: Path) -> int | None:
    """Rotation metadata on the video stream, or None when there is none.

    Recorded for the audit only. ffmpeg auto-applies the display matrix when it
    extracts frames, so a clip whose pixels are sideways after normalisation has
    no metadata left to read - that case is what the model's orientation field is
    for. A value here still explains cases where metadata and pixels disagree.
    """
    try:
        result = subprocess.run(
            [ffprobe_path(), "-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json", str(path)],
            capture_output=True, check=True, timeout=30,
        )
        streams = json.loads(result.stdout or "{}").get("streams") or []
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        return None
    if not streams:
        return None
    stream = streams[0]
    values: list[Any] = [stream.get("rotation"), (stream.get("tags") or {}).get("rotate")]
    for side_data in stream.get("side_data_list") or []:
        if isinstance(side_data, dict):
            values.append(side_data.get("rotation"))
    for value in values:
        if value in (None, ""):
            continue
        try:
            degrees = int(round(float(value))) % 360
        except (TypeError, ValueError):
            continue
        if degrees:
            return degrees
    return None


def frame_times(seconds: float, count: int) -> list[float]:
    count = max(1, count)
    if count == 1:
        return [seconds / 2]
    margin = min(0.2, seconds / 10)
    span = max(0.0, seconds - 2 * margin)
    return [margin + span * index / (count - 1) for index in range(count)]


def extract_frames(clip: Path, out_dir: Path, *, count: int, max_width: int = 640) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    frames: list[Path] = []
    seconds = clip_duration(clip)
    for index, at in enumerate(frame_times(seconds, count), 1):
        target = out_dir / f"f{index:02d}_{at:06.2f}s.jpg"
        subprocess.run(
            [
                ffmpeg_path(), "-v", "error", "-y", "-ss", f"{at:.3f}", "-i", str(clip),
                "-frames:v", "1", "-vf", f"scale='min({max_width},iw)':-2", "-q:v", "3", str(target),
            ],
            capture_output=True, check=True, timeout=45,
        )
        if target.is_file() and target.stat().st_size > 32:
            frames.append(target)
    if not frames:
        raise ValueError(f"无法从候选抽帧: {clip}")
    return frames


def contact_sheet(frames: list[Path], target: Path) -> Path:
    """Stack a candidate's frames side by side so one image == one candidate."""
    if len(frames) == 1:
        shutil.copyfile(frames[0], target)
        return target
    command = [ffmpeg_path(), "-v", "error", "-y"]
    for frame in frames:
        command += ["-i", str(frame)]
    inputs = "".join(f"[{index}:v]scale=-2:360[s{index}];" for index in range(len(frames)))
    stacked = "".join(f"[s{index}]" for index in range(len(frames)))
    command += ["-filter_complex", f"{inputs}{stacked}hstack=inputs={len(frames)}", "-q:v", "3", str(target)]
    subprocess.run(command, capture_output=True, check=True, timeout=45)
    if not target.is_file() or target.stat().st_size < 32:
        raise ValueError("拼图失败")
    return target


# ----------------------------------------------------------------------------
# model backends: ask(system, user_text, images) -> dict
# ----------------------------------------------------------------------------

# 顶层数组重试用的三段共享文案：dashscope 与 pi 两条后端都引用这里，避免两份漂移。
# 措辞与 tools/json_io.py 的报错保持一致，好让两边用同一个子串识别这种失败。
TOP_LEVEL_LIST_MARKER = "顶层必须是 JSON 对象"
TOP_LEVEL_LIST_NUDGE = "\n\n注意：顶层必须是一个 JSON 对象（用 {} 包住），不要直接返回数组；数组要放在对象的字段里。"
TOP_LEVEL_LIST_RETRY_LOG = "[agent] 模型返回了顶层数组，补充对象格式要求后重试一次"


def extract_json_object(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    fenced = re.match(r"(?s)^```(?:json)?\s*(.*?)\s*```$", text)
    if fenced:
        text = fenced.group(1).strip()
    try:
        parsed: Any = json.loads(text)
    except ValueError:
        parsed = None
    if isinstance(parsed, dict):
        return parsed
    if isinstance(parsed, list):
        # 顶层数组要能被上层认出来才好重试。旧写法认不出：单元素数组会被下面的
        # 花括号扫描把里面的对象抠出来当答案（把模型的格式错误吞掉），多元素数组
        # 则报 json 的 "Extra data"。统一抛成 json_io 的措辞。
        raise ValueError(f"模型输出 {TOP_LEVEL_LIST_MARKER}，实际为 {type(parsed).__name__}: {text[:300]}")
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        value = json.loads(text[start:end + 1])
        if isinstance(value, dict):
            return value
    raise ValueError(f"模型没有返回 JSON 对象: {text[:300]}")


def assistant_text_from_pi_events(stdout: str) -> str:
    texts: list[str] = []
    saw_json = False
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        saw_json = True
        if event.get("type") != "message_end":
            continue
        message = event.get("message") or {}
        if message.get("role") != "assistant":
            continue
        if message.get("stopReason") == "error":
            # pi exits 0 on provider errors; surface the reason instead of an empty answer.
            raise RuntimeError(f"pi 模型调用失败: {message.get('errorMessage') or 'unknown error'}")
        content = message.get("content")
        if isinstance(content, str):
            texts.append(content)
        elif isinstance(content, list):
            texts.append("".join(
                str(part.get("text", "")) for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            ))
    if texts:
        return texts[-1]
    return "" if saw_json else stdout


PI_DEBUG_CLIP = 60


def pi_debug_command_enabled() -> bool:
    return os.environ.get("MATERIAL_AGENT_PI_DEBUG_COMMAND", "").strip().lower() in {"1", "true", "yes", "on"}


def clip_for_debug(text: str) -> str:
    """调试打印用：只留前 PI_DEBUG_CLIP 字 + 总长，换行转义成一行。"""
    head = text[:PI_DEBUG_CLIP].replace("\n", "\\n")
    ellipsis = "…" if len(text) > PI_DEBUG_CLIP else ""
    return f"<{head}{ellipsis}|len={len(text)}>"


def ask_pi(system: str, user_text: str, images: list[Path], *, timeout: int) -> dict[str, Any]:
    """Ask pi in print mode. Returns the parsed JSON object from the assistant message.

    图文顺序（2026-09-17 在 Mac 上用假 baseUrl 抓请求体实证，pi 0.85.1）：
    命令行里 `@图片` 和用户文本谁先谁后**不影响**发给模型的顺序。pi 的 parseArgs
    （src/cli/args.ts）把 `--` 之后的位置参数按 `@` 前缀拆成两个数组 fileArgs 和
    messages，命令行上的交错顺序当场就丢了；随后 buildInitialMessage
    （src/cli/initial-message.ts）固定拼成 `<file name="…"></file>` 若干行 + messages[0]
    当作一段文本，AgentSession.prompt（src/core/agent-session.ts）再固定地把
    content 组成 [{"type":"text",…}, 图片, 图片…]。也就是说 pi 本来就是
    **文本在前、图片在后**，与 ask_dashscope 一致；两边唯一的结构差别是 pi 会在
    user_text 前面多加几行 `<file name="绝对路径"></file>` 占位、并给 system 末尾
    追加一行 `Current working directory: …`，这两处用 @file 传图时无法去掉。
    因此这里保持命令行原样（图片在前），只把事实记在这里。

    两条命令行约束（同样来自 parseArgs）：
    - `--` 之后 pi 仍按 `@` 前缀识别文件，所以 user_text 不能以 `@` 开头（会被当路径）；
      以 `-` 开头则安全（`--` 之后不再解析选项）。当前 prompt 都以中文/字母开头。
    - 多个非 `@` 位置参数不会被空格拼成一段，而是被当成多轮对话逐条发送
      （print-mode.ts 对 messages[1:] 逐条再 prompt 一次），所以 user_text
      必须是**单个**参数。

    print 模式对 `~/.pi`（或 `PI_CODING_AGENT_DIR`）的写盘（pi 0.85.1 查证，仅记录不处理）：
    会话文件已被 `--no-session` 关掉；`src/main.ts:649` 的 `runMigrations` 只在检测到
    旧版布局时才改写 `settings.json` / `auth.json` / `keybindings.json`（`src/migrations.ts`），
    正常机器上不动；`models-store.json`（`src/core/models-store.ts:52`）只在动态刷新
    provider 目录时写，走 `--provider/--model` 固定模型的本线路不会触发；debug 日志
    （`src/config.ts:578`）要显式开关。也就是说本线路除了这里主动合并的 models.json
    之外，不往用户目录写东西——真有残留也不影响选材，不做清理。
    """
    launcher = pi_command()
    if not launcher:
        raise RuntimeError("找不到 pi 可执行文件（npm i -g @earendil-works/pi-coding-agent）")

    def run(text: str) -> str:
        command = [
            *launcher, "-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
            "--no-prompt-templates", "--no-context-files", "--no-themes", "--mode", "json",
            "--provider", pi_provider(), "--model", pi_model() if images else pi_text_model(),
            "--thinking", pi_thinking(), "--system-prompt", system,
        ]
        # 调试打印时要脱敏/截断的位置，按下标记住，别再去猜哪个参数是什么。
        masked: dict[int, str] = {len(command) - 1: clip_for_debug(system)}
        key = pi_api_key()
        if key:
            command += ["--api-key", key]
            masked[len(command) - 1] = "***"
        command.append("--")
        command += [f"@{image}" for image in images]
        command.append(text)
        masked[len(command) - 1] = clip_for_debug(text)
        if pi_debug_command_enabled():
            shown = " ".join(masked.get(index, item) for index, item in enumerate(command))
            print(f"[agent] pi command: {shown}", flush=True)
        # stdin must be closed: pi in print mode waits for piped stdin to end otherwise.
        completed = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
            stdin=subprocess.DEVNULL,
        )
        if completed.returncode != 0:
            raise RuntimeError(f"pi 退出码 {completed.returncode}: {completed.stderr.strip()[-800:]}")
        return assistant_text_from_pi_events(completed.stdout)

    try:
        return extract_json_object(run(user_text))
    except ValueError as error:
        # 与 ask_dashscope 同一处理：方向判断那一步的模型偶尔直接回顶层数组，
        # 补一句对象格式要求重试一次，比丢掉整条独立判断划算。其余错误照旧抛出。
        if TOP_LEVEL_LIST_MARKER not in str(error):
            raise
    print(TOP_LEVEL_LIST_RETRY_LOG, flush=True)
    return extract_json_object(run(user_text + TOP_LEVEL_LIST_NUDGE))


def ask_dashscope(system: str, user_text: str, images: list[Path], *, timeout: int) -> dict[str, Any]:
    from optimize_queries import call_qwen  # imported lazily so tests can run without it

    content: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
    for image in images:
        data = base64.b64encode(image.read_bytes()).decode()
        content.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + data}})
    messages = [{"role": "system", "content": system}, {"role": "user", "content": content}]
    model = dashscope_model() if images else os.environ.get("DASHSCOPE_TEXT_MODEL", "").strip() or dashscope_model()
    options = {}
    thinking = dashscope_thinking()
    if thinking is not None:
        options["enable_thinking"] = thinking
    nudged = False
    for attempt in range(3):
        try:
            return call_qwen(messages, temperature=0, model=model, label="素材选取 agent", timeout=timeout, **options)
        except ValueError as error:
            # 2026-09-17 batch4: the orientation call answered with a bare JSON
            # array 3 times out of 7. Ask once more with the object shape spelled
            # out instead of dropping the whole independent verdict.
            if not nudged and TOP_LEVEL_LIST_MARKER in str(error):
                nudged = True
                content[0] = {"type": "text", "text": user_text + TOP_LEVEL_LIST_NUDGE}
                print(TOP_LEVEL_LIST_RETRY_LOG, flush=True)
                continue
            raise RuntimeError(str(error)) from error
        except SystemExit as error:
            # Some vision models report a transient JSON decoding failure as
            # HTTP 400. Retry the exact request once; never relax JSON parsing
            # or repeat authentication, unavailable-model or other bad requests.
            cause = error.__cause__
            if (attempt == 0 and isinstance(cause, urllib.error.HTTPError) and cause.code == 400
                    and "Model output became abnormal while generating a JSON response for response_format" in str(error)):
                print("[agent] 视觉模型 JSON 生成中断，原样重试一次", flush=True)
                continue
            # The shared CLI helper exits on missing credentials and HTTP errors.
            # Convert those failures here so the failure report is still saved.
            raise RuntimeError(str(error)) from error
    raise AssertionError("unreachable")


def make_ask(backend: str) -> Callable[..., dict[str, Any]]:
    """选材与包装两条线共用的后端入口，所以 provider 的可见性检查挂在这里。"""
    if backend == "pi":
        warn_if_pi_provider_missing()
        return ask_pi
    return ask_dashscope


# ----------------------------------------------------------------------------
# agent steps
# ----------------------------------------------------------------------------

def context_text(context: dict[str, Any]) -> str:
    keep = {key: value for key, value in context.items() if key not in {"shots_json", "note"} and value not in (None, "", [], {})}
    return json.dumps(keep, ensure_ascii=False, indent=1)


def blocked_query_term(lowered: str) -> str | None:
    """First blocklisted term in a query, or None. ASCII terms match whole words."""
    if QUERY_SHOT_WORD.search(lowered):
        return "shot"
    for term in QUERY_BLOCKLIST:
        if term.isascii():
            if re.search(rf"(?<![a-z]){re.escape(term)}(?:s|es|ed|ing)?(?![a-z])", lowered):
                return term
        elif term in lowered:
            return term
    return None


def query_has_verb(text: str, lowered: str) -> bool:
    """A concrete query says who does what: it needs an action word, not only nouns."""
    if any(character in QUERY_VERB_HANZI for character in text):
        return True
    if QUERY_VERB_PHRASES.search(lowered):
        return True
    for word in re.findall(r"[a-z]+", lowered):
        if len(word) > 4 and word.endswith("ing"):
            return True
        for verb in QUERY_VERBS:
            if word == verb or word in {verb + "s", verb + "es", verb + "ed", verb + "ing"}:
                return True
    return False


def shot_numbers(context: dict[str, Any]) -> set[str]:
    """Numbers written in this shot's own text.

    Only the script fields count: ``duration``/``shot`` are engine metadata, so
    letting them whitelist a number would quietly allow "5厘米" on any 5-second shot.
    """
    parts = [str(context.get("topic") or "")]
    for field in SHOT_TEXT_FIELDS:
        value = context.get(field)
        if value in (None, "", [], {}):
            continue
        parts.append(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))
    return set(re.findall(r"\d+(?:\.\d+)?", " ".join(parts)))


def fabricated_measurement(text: str, numbers: set[str]) -> str | None:
    """A size or angle in the query that the shot's own text never mentions."""
    for pattern in (QUERY_MEASUREMENT_CN, QUERY_MEASUREMENT_EN):
        for match in pattern.finditer(text):
            if match.group(1) not in numbers:
                return match.group(0).strip()
    return None


def query_is_concrete(text: str, numbers: set[str] | None = None) -> tuple[bool, str | None]:
    """Refuse abstract keyword strings before they cost a re-search.

    2026-09-17: "box spillage slip simulation pallet stability test real world
    failure" and "aerial shot ... metal parts ..." were both searched for real.
    Neither names a subject doing something, and the vector index only holds
    workshop footage, so both can only return noise.

    ``numbers`` are the numbers the shot's own script carries. Passed in, a size
    or angle the script never states is refused as an invented detail. Camera
    words (overhead view / top-down / from above) are deliberately allowed: when
    the script asks for an angle they are real search signal; only editing words
    such as "shot" are refused.
    """
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    lowered = value.lower()
    if not value:
        return False, "检索词为空"
    term = blocked_query_term(lowered)
    if term:
        return False, f"含抽象概念或剪辑叙述词「{term}」，向量库里没有对应画面"
    if not query_has_verb(value, lowered):
        return False, "没有任何动作词，是名词堆叠而不是「主体+动作+对象」的画面"
    if numbers is not None:
        invented = fabricated_measurement(value, numbers)
        if invented:
            return False, f"分镜信息里没有「{invented}」这个尺寸/角度，不许自己设定数值"
    return True, None


def propose_queries(
    context: dict[str, Any], ask: Callable[..., dict[str, Any]], *, limit: int, timeout: int,
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """Return (queries to search, queries refused by query_is_concrete)."""
    system = load_prompt_template("agent_query_rewrite.md").strip()
    user = render_prompt_template(
        "分镜信息：\n{{context}}\n\n最多给出 {{limit}} 条检索词。只返回 JSON。",
        {"context": context_text(context), "limit": limit},
    )
    response = ask(system, user, [], timeout=timeout)
    raw = response.get("queries") if isinstance(response, dict) else None
    queries: list[dict[str, str]] = []
    rejected: list[dict[str, str]] = []
    numbers = shot_numbers(context)
    seen = {str(context.get("visual_query") or "").strip().lower()}
    for item in raw or []:
        if isinstance(item, str):
            item = {"text": item, "strategy": ""}
        if not isinstance(item, dict):
            continue
        text = re.sub(r"\s+", " ", str(item.get("text") or "")).strip()
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        strategy = str(item.get("strategy") or "").strip()
        concrete, reason = query_is_concrete(text, numbers)
        if not concrete:
            rejected.append({"text": text, "strategy": strategy, "reason": reason or ""})
            continue
        queries.append({"text": text, "strategy": strategy})
        if len(queries) >= limit:
            break
    return queries, rejected


def clamp_verdict(item: dict[str, Any]) -> dict[str, Any]:
    """Cut an over-long verdict down to the size the prompt asks for.

    The model keeps writing past the limits, and the whole reply is one JSON
    object, so nothing can be capped on the wire; it is capped here instead and
    the entry is marked ``truncated`` so the audit shows the reply was wordy.
    """
    truncated = False
    reason = item.get("reason")
    if isinstance(reason, str) and len(reason) > JUDGE_REASON_LIMIT:
        item["reason"] = reason[:JUDGE_REASON_LIMIT]
        truncated = True
    for field in ("visible", "missing"):
        values = item.get(field)
        if not isinstance(values, list):
            continue
        if len(values) > JUDGE_LIST_LIMIT:
            truncated = True
        kept: list[str] = []
        for value in values[:JUDGE_LIST_LIMIT]:
            text = str(value)
            if len(text) > JUDGE_LIST_ITEM_LIMIT:
                text = text[:JUDGE_LIST_ITEM_LIMIT]
                truncated = True
            kept.append(text)
        item[field] = kept
    if truncated:
        item["truncated"] = True
    return item


def index_text(indexes: list[int]) -> str:
    return "、".join(str(index) for index in indexes) or "无"


def ranking_coverage(
    ranking: list[Any], expected: list[int],
) -> tuple[list[Any], list[int], list[int]]:
    """Split a ranking into (kept entries, duplicated indexes, unreviewed indexes).

    2026-09-17 Windows flash run: two shots came back with 4 of the 8 candidates
    in ``ranking`` and nothing noticed, so the missing ones read as "rejected by
    the judge" and one of them was a known sideways clip. Coverage is compared
    here against the candidates that were actually sent.

    A repeated ``candidate`` keeps its first entry (the caller used to keep the
    last one silently). Entries whose index is unreadable or outside the candidate
    range are passed through untouched; the caller drops them as it always did.
    """
    seen: set[int] = set()
    duplicates: list[int] = []
    kept: list[Any] = []
    for item in ranking:
        index: int | None = None
        if isinstance(item, dict):
            try:
                index = int(item.get("candidate"))
            except (TypeError, ValueError):
                index = None
        if index is None:
            kept.append(item)
            continue
        if index in seen:
            if index not in duplicates:
                duplicates.append(index)
            continue
        seen.add(index)
        kept.append(item)
    missing = [index for index in expected if index not in seen]
    return kept, duplicates, missing


def judge_candidates(
    context: dict[str, Any],
    candidates: list[dict[str, Any]],
    ask: Callable[..., dict[str, Any]],
    *,
    exclude_overlays: bool,
    want: int,
    timeout: int,
) -> dict[str, Any]:
    system = load_prompt_template("agent_candidate_judge.md").strip()
    lines = [f"分镜信息：\n{context_text(context)}", "", f"需要选出 {want} 段。", ""]
    if exclude_overlays:
        lines.append("额外要求：画面里出现烧录字幕、logo、台标、水印的候选一律 acceptable=false。")
        lines.append("")
    lines.append("候选列表。附图与候选一一对应：第 1 张图 = 候选 1，第 2 张图 = 候选 2，以此类推；每张图是该候选从头到尾抽的几帧横向拼在一起。")
    images: list[Path] = []
    for candidate in candidates:
        frames = candidate.get("frames") or []
        score = candidate.get("score")
        score_text = f"{score:.3f}" if isinstance(score, (int, float)) else "n/a"
        lines.append(
            f"- 候选 {candidate['index']}: 来源 {candidate.get('source_name') or Path(candidate['path']).name}"
            f"，向量分 {score_text}，检索词「{candidate.get('query') or ''}」，拼图含 {len(frames)} 帧"
        )
        images.append(Path(candidate["sheet"]))
    lines.append("")
    lines.append("只返回 JSON。")
    user_text = "\n".join(lines)

    def once(text: str) -> dict[str, Any]:
        response = ask(system, text, images, timeout=timeout)
        if not isinstance(response, dict) or not isinstance(response.get("ranking"), list):
            raise ValueError(f"判断结果缺少 ranking: {json.dumps(response, ensure_ascii=False)[:300]}")
        response["ranking"] = [clamp_verdict(item) if isinstance(item, dict) else item
                               for item in response["ranking"]]
        return response

    expected = [candidate["index"] for candidate in candidates]
    response = once(user_text)
    ranking, duplicates, missing = ranking_coverage(response["ranking"], expected)
    if missing:
        print(JUDGE_COVERAGE_RETRY_LOG.format(
            missing=index_text(missing), reviewed=len(expected) - len(missing), total=len(expected)), flush=True)
        response = once(user_text + JUDGE_COVERAGE_NUDGE.format(total=len(expected)))
        ranking, duplicates, missing = ranking_coverage(response["ranking"], expected)
    response["ranking"] = ranking
    if duplicates:
        print(f"[agent] 评审给候选 {index_text(duplicates)} 各写了多条结论，只保留第一条", flush=True)
        response["duplicate_candidates"] = duplicates
    if missing:
        # 不补分、不进 ranking：未评审就是未评审，让上层按"没有结论"记录。
        print(f"[agent] 评审仍漏评候选 {index_text(missing)}，按未评审记录，不参与 pick", flush=True)
        response["unreviewed"] = missing
    return response


def check_orientation(
    candidates: list[dict[str, Any]], ask: Callable[..., dict[str, Any]], *, timeout: int,
) -> dict[int, dict[str, Any]]:
    """Ask only "is this picture rotated", with no shot text in the prompt.

    2026-09-17 acceptance: one sheet (identical SHA256) was called "rotated" in
    four shots and "upright / overhead" in the fifth, whose script asked for an
    overhead view. Orientation is a property of the pixels, so it is judged in
    its own call that never sees what the shot wants.
    """
    system = load_prompt_template("agent_orientation_check.md").strip()
    lines = [
        "图片与编号一一对应：第 1 张图 = 图 1，第 2 张图 = 图 2，以此类推；"
        "每张图是一段素材从头到尾抽的几帧横向拼在一起。",
        "",
    ]
    images: list[Path] = []
    for position, candidate in enumerate(candidates, 1):
        lines.append(f"- 图 {position}：{len(candidate.get('frames') or [])} 帧")
        images.append(Path(candidate["sheet"]))
    lines += ["", "只返回 JSON。"]
    with orientation_model_selected():
        response = ask(system, "\n".join(lines), images, timeout=timeout)
    rows = response.get("images") if isinstance(response, dict) else None
    if not isinstance(rows, list):
        raise ValueError(f"方向判断结果缺少 images: {json.dumps(response, ensure_ascii=False)[:300]}")
    results: dict[int, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            position = int(row.get("index"))
        except (TypeError, ValueError):
            continue
        if not 1 <= position <= len(candidates):
            continue
        value = str(row.get("orientation") or "").strip().lower()
        results[candidates[position - 1]["index"]] = {
            "orientation": value if value in ORIENTATIONS else "unsure",
            "evidence": str(row.get("evidence") or "").strip()[:60],
        }
    return results


def combine_orientation(independent: str, judged: str, *, cached: list[str]) -> str:
    """Merge the two verdicts (and the run cache). Any "rotated" wins.

    Refusing a usable clip costs one re-search; shipping a sideways clip costs a
    re-render, so disagreement always resolves to ``rotated``.
    """
    if "rotated" in (independent, judged) or "rotated" in cached:
        return "rotated"
    if "upright" in (independent, judged):
        return "upright"
    return "unsure"


def clip_sha256(path: Path) -> str | None:
    """Content id of a candidate clip; None when it cannot be read."""
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
    except OSError:
        return None
    return digest.hexdigest()


def orientation_cache_path(clip_root: Path) -> Path:
    """``clips/_agent_cache/orientation.json``, shared by every shot of one run.

    The live layout is ``clips/<hash>/<hash>/<shot>``; the nearest ancestor named
    ``clips`` is used so a shallower layout still ends up with one cache per run.
    """
    for parent in clip_root.parents:
        if parent.name == "clips":
            return parent / CACHE_DIR_NAME / ORIENTATION_CACHE_FILE_NAME
    parents = list(clip_root.parents)
    base = parents[2] if len(parents) > 2 else (parents[-1] if parents else clip_root)
    return base / CACHE_DIR_NAME / ORIENTATION_CACHE_FILE_NAME


def load_orientation_cache(path: Path) -> dict[str, Any]:
    """A missing or damaged cache is empty, never an error: it only ever adds refusals."""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    entries = value.get("entries") if isinstance(value, dict) else None
    return entries if isinstance(entries, dict) else {}


def cached_orientations(entries: dict[str, Any], digest: str | None) -> list[str]:
    if not digest:
        return []
    entry = entries.get(digest)
    values = entry.get("verdicts") if isinstance(entry, dict) else entry
    if not isinstance(values, list):
        return []
    return [value for value in values if isinstance(value, str) and value in ORIENTATIONS]


def save_orientation_cache(
    path: Path, entries: dict[str, Any], updates: list[tuple[str, str, str]],
) -> None:
    """Append this shot's final verdicts. Shots run one after another, so the
    atomic write is all the concurrency safety this needs."""
    if not updates:
        return
    for digest, verdict, name in updates:
        entry = entries.get(digest)
        if not isinstance(entry, dict):
            entry = {"verdicts": cached_orientations(entries, digest)}
        verdicts = [value for value in entry.get("verdicts", []) if value in ORIENTATIONS]
        verdicts.append(verdict)
        entry["verdicts"] = verdicts[-ORIENTATION_CACHE_HISTORY:]
        entry["name"] = name
        entry["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        entries[digest] = entry
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(path, {"schema_version": 1, "entries": entries})
    except OSError as error:  # noqa: BLE001 - the cache is an optimisation
        print(f"[agent] 方向缓存写入失败（忽略）: {error}", flush=True)


def verdict_orientation(item: dict[str, Any]) -> str:
    """Model-reported orientation, defaulting to "unsure" when missing or unknown."""
    value = str((item or {}).get("orientation") or "").strip().lower()
    return value if value in ORIENTATIONS else "unsure"


def verdict_obstruction(item: dict[str, Any]) -> str:
    """Model-reported obstruction; a missing or unknown value counts as "partial"."""
    value = str((item or {}).get("obstruction") or "").strip().lower()
    return value if value in OBSTRUCTIONS else "partial"


def verdict_camera_angle(item: dict[str, Any]) -> str:
    """Model-reported camera angle; a missing or unknown value counts as "unsure"."""
    value = str((item or {}).get("camera_angle") or "").strip().lower()
    return value if value in CAMERA_ANGLES else "unsure"


def verdict_missing(item: dict[str, Any]) -> list[str]:
    """The model's own list of what the script asks for and the frames do not show."""
    values = (item or {}).get("missing")
    if not isinstance(values, list):
        return []
    return [str(value).strip() for value in values if str(value).strip()]


def missing_score_cap(count: int) -> float | None:
    """Score ceiling for a candidate the model says is missing ``count`` things."""
    if count <= 0:
        return None
    return MISSING_SCORE_CAP.get(count, MISSING_SCORE_CAP_MANY)


def verdict_score(item: dict[str, Any]) -> float:
    try:
        return float((item or {}).get("score") or 0)
    except (TypeError, ValueError):
        return 0.0


def fallback_mode() -> str:
    """What to do when every candidate of a shot is refused.

    ``fill`` (default): use the best refused candidate as a visible placeholder so
    the run finishes, and mark it 【占位】 everywhere a human will look.
    ``stop``: the shot fails (ok=false) and only a suggestion is written.
    """
    value = os.environ.get("MATERIAL_AGENT_FALLBACK", "").strip().lower()
    return value if value in {"fill", "stop"} else "fill"


def stop_suggestion_rank(entry: dict[str, Any]) -> tuple[Any, ...]:
    """Order of the suggestion a human reads after a shot stops: score first.

    On a tie prefer the clip a human can actually look at - unobstructed subject
    before a mesh, upright before a sideways or unclear frame (2026-09-17
    suggested a heavy-obstruction clip over two clean ones that scored the same 25).
    """
    return (
        -float(entry["adjusted_score"]),
        OBSTRUCTION_PREFERENCE.get(entry["obstruction"], 3),
        ORIENTATION_PREFERENCE.get(entry["orientation"], 3),
        entry["candidate"],
    )


def fill_placeholder_rank(entry: dict[str, Any]) -> tuple[Any, ...]:
    """Order of the clip that is actually cut in as a placeholder.

    Here viewability outranks the model's score: a sideways or mesh-covered frame
    on screen is worse than a lower-scoring clean one, and a segment the agent's
    own re-searches kept finding is the better guess among equals.
    """
    return (
        ORIENTATION_PREFERENCE.get(entry["orientation"], 3),
        OBSTRUCTION_PREFERENCE.get(entry["obstruction"], 3),
        -float(entry["adjusted_score"]),
        -int(entry.get("agent_hits") or 0),
        entry["candidate"],
    )


def min_accept_score() -> float:
    """Lowest adjusted score that may still be used for a shot."""
    return float(setting_int("MATERIAL_AGENT_MIN_ACCEPT_SCORE", 60, 0, 100))


def deterministic_review(
    item: dict[str, Any], *, min_score: float | None = None, orientation: str | None = None,
) -> dict[str, Any]:
    """Turn the model's own fields into a deterministic usable/score decision.

    The model keeps overstating what a frame shows, so three of its answers are
    re-read here instead of being trusted (2026-09-17 acceptance):
    rotated     -> unusable whatever the score is (a sideways clip got 95 and
                   was called an overhead view, and it shipped).
    unsure      -> keep it, but behind every upright candidate and minus the penalty.
    obstruction -> heavy (mesh/fence over the subject) caps the score at 50 and is
                   unusable; partial caps it at 75 so it can never reach the 90 band.
    min score   -> anything below MATERIAL_AGENT_MIN_ACCEPT_SCORE is refused even
                   when the model wrote acceptable=true ("内容不对，勉强可用" at 45).
    camera_angle is recorded only: which angle a shot needs is in the script, so the
    prompt makes the model put a mismatch into ``missing`` instead.

    ``orientation`` overrides what this judge call said: it carries the merged
    verdict of the standalone orientation call, this judge call and the run cache
    (see combine_orientation). Left out, only the judge's own answer is used.
    """
    judged_orientation = verdict_orientation(item)
    orientation = orientation if orientation in ORIENTATIONS else judged_orientation
    obstruction = verdict_obstruction(item)
    score = verdict_score(item)
    missing = verdict_missing(item)
    threshold = min_accept_score() if min_score is None else float(min_score)
    review: dict[str, Any] = {
        "orientation": orientation,
        "orientation_judge": judged_orientation,
        "orientation_final": orientation,
        "reported": (item or {}).get("orientation"),
        "obstruction": obstruction,
        "reported_obstruction": (item or {}).get("obstruction"),
        "camera_angle": verdict_camera_angle(item),
        "reported_camera_angle": (item or {}).get("camera_angle"),
        "missing_count": len(missing),
        "missing_cap": missing_score_cap(len(missing)),
        "model_score": score,
        "adjusted_score": score,
        "min_accept_score": threshold,
        "blocked": False,
        "block_kind": None,
        "reason": None,
    }
    reasons: list[str] = []
    adjusted = score
    if orientation == "rotated":
        review["blocked"] = True
        review["block_kind"] = "orientation"
        adjusted = 0.0
        disagreement = "" if judged_orientation == "rotated" else f"（独立方向判断/缓存判 rotated，本次评审写 {judged_orientation}）"
        reasons.append(
            f"画面整体旋转（orientation=rotated）{disagreement}，确定性兜底判为不可用；模型分 {score:g} 不采信"
        )
    else:
        if orientation == "unsure":
            adjusted = max(0.0, adjusted - UNSURE_ORIENTATION_PENALTY)
            reasons.append(
                f"画面方向存疑（orientation={review['reported'] or '缺失'}），"
                f"扣 {UNSURE_ORIENTATION_PENALTY:g} 分并排在方向确定的候选之后"
            )
        cap = OBSTRUCTION_SCORE_CAP.get(obstruction)
        if cap is not None:
            capped = min(adjusted, cap)
            if obstruction == "heavy":
                review["blocked"] = True
                review["block_kind"] = "obstruction"
                reasons.append(
                    f"主体被大面积遮挡（obstruction=heavy），分数上限 {cap:g}（{adjusted:g}→{capped:g}）且判为不可用"
                )
            elif capped < adjusted:
                reasons.append(
                    f"主体有部分遮挡（obstruction={review['reported_obstruction'] or '缺失，按 partial 处理'}），"
                    f"分数上限 {cap:g}（{adjusted:g}→{capped:g}），不进 90 分档"
                )
            adjusted = capped
        missing_cap = missing_score_cap(len(missing))
        if missing_cap is not None:
            capped = min(adjusted, missing_cap)
            if capped < adjusted:
                reasons.append(
                    f"模型自己列了 {len(missing)} 条 missing（{'、'.join(missing[:4])}），"
                    f"分数上限 {missing_cap:g}（{adjusted:g}→{capped:g}）"
                )
            adjusted = capped
        if not review["blocked"] and adjusted < threshold:
            review["blocked"] = True
            review["block_kind"] = "min_score"
            reasons.append(
                f"调整后 {adjusted:g} 分低于最低接受分 {threshold:g}"
                f"（MATERIAL_AGENT_MIN_ACCEPT_SCORE），不予采用"
            )
    review["adjusted_score"] = adjusted
    review["reasons"] = reasons
    review["reason"] = "；".join(reasons) or None
    return review


def normalise_source(name: str) -> str:
    """Compare a source file the way the clip exporter sanitises it into a name."""
    stem = Path(str(name or "").strip()).stem
    return re.sub(r"[^\w\-]", "_", stem).strip("_").lower()


def span_seconds(text: object) -> int | None:
    """Accept both clip-name spans (``02m15s``) and search spans (``02:15``)."""
    value = str(text or "").strip().lower()
    if not value:
        return None
    if ":" in value:
        total = 0.0
        for part in value.split(":"):
            try:
                total = total * 60 + float(part)
            except ValueError:
                return None
        return int(total)
    match = SPAN_TEXT.match(value)
    if not match or not any(match.groups()):
        return None
    hours, minutes, seconds = match.groups()
    return int(float(hours or 0) * 3600 + float(minutes or 0) * 60 + float(seconds or 0))


def dedupe_key(candidate: dict[str, Any]) -> str:
    """Identify a candidate by source file + time span, not by where it was written.

    The engine exports into the shot clip directory and the agent exports into
    ``_agent_qNN`` sub-directories, so comparing full paths (or even directory
    plus name) would let the same segment enter the pool twice.
    """
    name_match = CLIP_SPAN_NAME.match(Path(str(candidate["path"])).stem)
    if name_match:
        start = span_seconds(name_match.group("start"))
        end = span_seconds(name_match.group("end"))
        if start is not None and end is not None:
            return f"{normalise_source(name_match.group('base'))}|{start}|{end}"
    source = normalise_source(candidate.get("source_name") or "")
    start = span_seconds(candidate.get("start"))
    end = span_seconds(candidate.get("end"))
    if source and start is not None and end is not None:
        return f"{source}|{start}|{end}"
    return Path(str(candidate["path"])).name.lower()


def merge_agent_hit(existing: dict[str, Any], query: str, rank: int | None, score: object) -> dict[str, Any]:
    """Fold a re-search hit into the candidate that already holds that segment.

    Dropping the hit (what this used to do) threw away the only evidence the
    agent produces about an engine candidate: that its own queries found the
    same segment, and how highly. An engine candidate hit by re-search becomes
    ``origin="both"`` and competes for the agent quota instead of being buried
    at rank 9 or 10 of the engine list.
    """
    if existing.get("origin") == "engine":
        existing["origin"] = "both"
    existing["agent_hits"] = int(existing.get("agent_hits") or 0) + 1
    queries = existing.setdefault("agent_queries", [])
    if query and query not in queries:
        queries.append(query)
    if isinstance(rank, int):
        current = existing.get("agent_rank")
        existing["agent_rank"] = rank if not isinstance(current, int) else min(current, rank)
    if existing.get("score") is None and isinstance(score, (int, float)):
        # engine candidates arrive without a vector score; the re-search has one.
        existing["score"] = score
    return existing


def agent_priority(candidate: dict[str, Any]) -> tuple[int, int, float, int]:
    """Order the agent side of the pool: most re-search hits first, then best rank."""
    rank = candidate.get("agent_rank")
    score = candidate.get("score")
    return (
        -int(candidate.get("agent_hits") or 0),
        rank if isinstance(rank, int) else 10 ** 6,
        -(score if isinstance(score, (int, float)) else -1.0),
        int(candidate.get("index") or 0),
    )


def merge_candidates(
    engine: list[dict[str, Any]],
    agent: list[dict[str, Any]],
    *,
    limit: int,
    reserve_ratio: float,
) -> list[dict[str, Any]]:
    """Fill the judging pool by quota so re-search results are never starved.

    The engine hands over more candidates than the pool holds, so concatenating
    engine and agent candidates used to truncate every re-search result away.
    The agent side (``agent`` and ``both`` candidates) keeps at least
    ``ceil(limit * reserve_ratio)`` slots and the engine fills the rest with the
    engine-only candidates it has not placed yet, in the vector order it handed
    them over; whichever side has fewer candidates than its quota hands the
    unused slots to the other side.
    """
    limit = max(0, limit)
    agent_quota = min(len(agent), math.ceil(limit * reserve_ratio))
    engine_quota = min(len(engine), limit - agent_quota)
    agent_quota = min(len(agent), limit - engine_quota)
    return engine[:engine_quota] + agent[:agent_quota]


def run_agent_selection(
    request: dict[str, Any],
    *,
    search: Callable[..., list[dict[str, Any]]] = run_vector_search,
    ask: Callable[..., dict[str, Any]] | None = None,
    frames: Callable[..., list[Path]] = extract_frames,
) -> dict[str, Any]:
    started = time.time()
    clip_root = Path(request["clip_root"]).resolve(strict=True)
    bound_root = Path(request["bound_root"]).resolve(strict=True) if request.get("bound_root") else None
    count = max(1, min(20, int(request.get("count", 1))))
    shot_id = str(request.get("shot_id") or "")
    exclude_overlays = request.get("exclude_overlays") is True
    backend = backend_name()
    if backend == "pi":
        # 运行包自带 pi 时用户目录里多半还没有 provider 配置，首启在这里补一次。
        ensure_pi_provider_config()
    ask = ask or make_ask(backend)

    max_queries = setting_int("MATERIAL_AGENT_MAX_QUERIES", 3, 0, 8)
    per_query = setting_int("MATERIAL_AGENT_SAVE_PER_QUERY", 3, 1, 10)
    max_candidates = setting_int("MATERIAL_AGENT_MAX_CANDIDATES", 8, 1, 20)
    reserve_ratio = setting_ratio("MATERIAL_AGENT_RESERVE_RATIO", 0.4, 0.0, 1.0)
    frames_per_candidate = setting_int("MATERIAL_AGENT_FRAMES", 3, 1, 6)
    min_score = min_accept_score()
    model_timeout = setting_int("MATERIAL_AGENT_TIMEOUT", 240, 30, 1800)
    search_timeout = setting_int("SENTRY_SEARCH_TIMEOUT_SECONDS", 120, 10, 1800)

    log: dict[str, Any] = {
        "schema_version": 1,
        "policy": "agent-select-trial",
        "backend": backend,
        "model": {"vision": pi_model(), "text": pi_text_model()} if backend == "pi" else dashscope_model(),
        "shot_id": shot_id,
        "clip_root": str(clip_root),
        "bound_root": str(bound_root) if bound_root else None,
        "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "queries": [],
        "rejected_queries": [],
        "candidates": [],
        "candidate_pool": None,
        "merged": [],
        "min_accept_score": min_score,
        "judge": None,
        "review": [],
        # 评审 ranking 漏掉、重试一次后仍没有结论的候选序号（既不是"被拒"也不是"被选"）
        "unreviewed": [],
        "picked": [],
        "errors": [],
        "fallback_suggestion": None,
        "fallback_used": None,
        # per-stage timings: elapsed_seconds alone could not say where the
        # 2026-09-17 slow-down (40-48s/shot vs 27-39s) actually went.
        "orientation": None,
        "timings": {name: 0.0 for name in
                    ("rewrite_seconds", "search_seconds", "frames_seconds", "probe_seconds",
                     "orientation_seconds", "judge_seconds")},
    }
    log_path = clip_root / LOG_FILE_NAME

    def spend(name: str, since: float) -> None:
        log["timings"][name] = round(log["timings"][name] + (time.time() - since), 3)

    def finish(report: dict[str, Any]) -> dict[str, Any]:
        log["elapsed_seconds"] = round(time.time() - started, 2)
        log["ok"] = report["ok"]
        atomic_write_json(log_path, log)
        report["agent"] = {
            "backend": backend,
            "log": str(log_path),
            "fallback_mode": fallback_mode(),
            "fallback_used": log["fallback_used"],
            "queries": [item["text"] for item in log["queries"]],
            "rejected_queries": log["rejected_queries"],
            "picked": log["picked"],
            "timings": log["timings"],
            "errors": log["errors"],
        }
        return report

    def empty_report(reason: str) -> dict[str, Any]:
        log["errors"].append(reason)
        return finish({
            "schema_version": 1, "paths": [], "rejected": [], "fallback": None,
            "sampled_only": True, "ok": False, "fallback_used": False, "fallback_reason": None,
        })

    context = load_shot_context(find_shots_json(clip_root), shot_id)
    log["shot_context"] = context

    candidates: list[dict[str, Any]] = []
    by_key: dict[str, dict[str, Any]] = {}

    def add_candidate(path: str, origin: str, query: str, extra: dict[str, Any], *, rank: int | None = None) -> None:
        try:
            resolved = within(Path(path), clip_root)
        except (OSError, ValueError) as error:
            log["errors"].append(f"忽略候选 {path}: {error}")
            return
        candidate = {"index": len(candidates) + 1, "path": str(resolved), "origin": origin, "query": query, **extra}
        key = dedupe_key(candidate)
        existing = by_key.get(key)
        if existing is not None:
            entry = {"path": str(resolved), "origin": origin, "key": key, "query": query, "agent_rank": rank,
                     "merged_into": {"path": existing["path"], "candidate": None, "origin": None}}
            if origin != "engine":
                merge_agent_hit(existing, query, rank, candidate.get("score"))
            else:
                entry["note"] = "引擎候选重复，保留先到的一条"
            log["merged"].append(entry)
            return
        if origin != "engine":
            candidate["agent_hits"] = 1
            candidate["agent_queries"] = [query] if query else []
            candidate["agent_rank"] = rank
        by_key[key] = candidate
        candidates.append(candidate)

    original_query = str(context.get("visual_query") or "")
    for path in request.get("paths", []):
        add_candidate(str(path), "engine", original_query, {"score": None})
    log["queries"].append({"text": original_query, "strategy": "engine", "hits": len(candidates)})

    if bound_root is not None and max_queries > 0 and context.get("shot") is not None:
        rewrite_started = time.time()
        try:
            proposals, refused_queries = propose_queries(context, ask, limit=max_queries, timeout=model_timeout)
        except Exception as error:  # noqa: BLE001 - logged, selection continues with engine candidates
            proposals, refused_queries = [], []
            log["errors"].append(f"检索词改写失败: {error}")
        spend("rewrite_seconds", rewrite_started)
        for refused in refused_queries:
            log["rejected_queries"].append(refused)
            print(f"[agent] 检索词不具象，不重搜：「{refused['text']}」（{refused['reason']}）", flush=True)
        for number, proposal in enumerate(proposals, 1):
            entry = {"text": proposal["text"], "strategy": proposal["strategy"], "hits": 0}
            log["queries"].append(entry)
            search_started = time.time()
            try:
                found = search(
                    proposal["text"], bound_root, clip_root / f"{QUERY_DIR_PREFIX}{number:02d}",
                    save_top=per_query, results=max(per_query, 10), timeout=search_timeout,
                )
            except Exception as error:  # noqa: BLE001
                entry["error"] = str(error)
                log["errors"].append(f"检索「{proposal['text']}」失败: {error}")
                continue
            finally:
                spend("search_seconds", search_started)
            entry["hits"] = len(found)
            entry["scores"] = [item.get("score") for item in found]
            for position, item in enumerate(found, 1):
                add_candidate(str(item["path"]), "agent", proposal["text"], {
                    "score": item.get("score"), "source_name": item.get("source_name"),
                    "start": item.get("start"), "end": item.get("end"),
                }, rank=position)
    elif bound_root is None:
        log["errors"].append("请求没有 bound_root（指定范围随机兜底开关未开或分镜为下载模式），跳过重新检索")

    if not candidates:
        return empty_report("没有任何可判断的候选")

    def count_origins(items: list[dict[str, Any]]) -> dict[str, int]:
        return {name: sum(1 for item in items if item["origin"] == name) for name in ("engine", "agent", "both")}

    engine_only = [item for item in candidates if item["origin"] == "engine"]
    agent_side = sorted((item for item in candidates if item["origin"] in ("agent", "both")), key=agent_priority)
    found_origins = count_origins(candidates)
    candidates = merge_candidates(
        engine_only, agent_side, limit=max_candidates, reserve_ratio=reserve_ratio,
    )
    for number, candidate in enumerate(candidates, 1):
        candidate["index"] = number
    pool_index = {dedupe_key(item): item["index"] for item in candidates}
    for entry in log["merged"]:
        target = by_key.get(entry["key"])
        entry["merged_into"]["origin"] = target["origin"] if target else None
        entry["merged_into"]["candidate"] = pool_index.get(entry["key"])
    log["candidate_pool"] = {
        "max_candidates": max_candidates,
        "reserve_ratio": reserve_ratio,
        "found": found_origins,
        "origins": count_origins(candidates),
        "merged": len(log["merged"]),
    }
    print(
        "[agent] 评审池 {total}/{limit}：engine {engine} + agent {agent} + both {both}"
        "（重搜命中已并入 {merged} 条，agent 名额比例 {ratio}）".format(
            total=len(candidates), limit=max_candidates,
            engine=log["candidate_pool"]["origins"]["engine"],
            agent=log["candidate_pool"]["origins"]["agent"],
            both=log["candidate_pool"]["origins"]["both"],
            merged=len(log["merged"]), ratio=reserve_ratio,
        ),
        flush=True,
    )

    frames_root = clip_root / FRAMES_DIR_NAME
    judged: list[dict[str, Any]] = []
    for candidate in candidates:
        probe_started = time.time()
        candidate["metadata_rotation"] = probe_rotation(Path(candidate["path"]))
        spend("probe_seconds", probe_started)
        frames_started = time.time()
        try:
            frame_dir = frames_root / f"c{candidate['index']:02d}"
            extracted = frames(Path(candidate["path"]), frame_dir, count=frames_per_candidate)
            candidate["frames"] = [str(path) for path in extracted]
            candidate["sheet"] = str(contact_sheet(extracted, frame_dir / "sheet.jpg"))
            judged.append(candidate)
        except Exception as error:  # noqa: BLE001
            candidate["frames"] = []
            candidate["error"] = f"抽帧失败: {error}"
            log["errors"].append(f"候选 {candidate['index']} 抽帧失败: {error}")
        finally:
            spend("frames_seconds", frames_started)

    cache_path = orientation_cache_path(clip_root)
    cache_entries = load_orientation_cache(cache_path)
    digests: dict[int, str | None] = {}
    cached_map: dict[int, list[str]] = {}
    for candidate in judged:
        digest = clip_sha256(Path(candidate["path"]))
        history = cached_orientations(cache_entries, digest)
        digests[candidate["index"]] = digest
        cached_map[candidate["index"]] = history
        candidate["clip_sha256"] = digest
        if "rotated" in history:
            log["errors"].append(
                f"候选 {candidate['index']} 命中方向缓存：这段素材在本次任务里此前已被判 rotated"
            )
    log["candidates"] = [{key: value for key, value in item.items()} for item in candidates]
    if not judged:
        return empty_report("所有候选都无法抽帧")

    # Orientation first and on its own: the judge call below sees the script and
    # keeps explaining a sideways frame as the overhead view the script asked for.
    orientation_started = time.time()
    independent: dict[int, dict[str, Any]] = {}
    try:
        independent = check_orientation(judged, ask, timeout=model_timeout)
    except Exception as error:  # noqa: BLE001 - logged; the judge still runs
        log["errors"].append(f"独立方向判断失败，本镜只用评审与缓存的方向结论: {error}")
    spend("orientation_seconds", orientation_started)
    log["orientation"] = {
        "model": orientation_model() or None,
        "cache": str(cache_path),
        "results": [
            {
                "candidate": candidate["index"],
                "clip_sha256": digests.get(candidate["index"]),
                "independent": (independent.get(candidate["index"]) or {}).get("orientation", "unsure"),
                "evidence": (independent.get(candidate["index"]) or {}).get("evidence", ""),
                "cached": cached_map.get(candidate["index"]) or [],
            }
            for candidate in judged
        ],
    }

    judge_started = time.time()
    try:
        verdict = judge_candidates(context, judged, ask, exclude_overlays=exclude_overlays, want=count, timeout=model_timeout)
    except Exception as error:  # noqa: BLE001
        # timed before empty_report(), which writes the log file straight away
        spend("judge_seconds", judge_started)
        return empty_report(f"模型判断失败: {error}")
    spend("judge_seconds", judge_started)
    log["judge"] = verdict

    by_index = {item["index"]: item for item in judged}
    # judge_candidates 已经补要求重试过一次；到这里还缺的候选就是没人评过，
    # 既不按拒绝算也不给分，只记下来让 report 与 inspect 能和"被评审拦下"区分开。
    unreviewed = [int(index) for index in (verdict.get("unreviewed") or []) if int(index) in by_index]
    log["unreviewed"] = unreviewed
    if unreviewed:
        log["errors"].append(
            f"评审漏评候选 {index_text(unreviewed)}（重试一次后仍缺，{len(judged) - len(unreviewed)}/{len(judged)} 有结论）："
            "按未评审记录，不计分也不参与 pick"
        )
    if verdict.get("duplicate_candidates"):
        log["errors"].append(
            f"评审给候选 {index_text(verdict['duplicate_candidates'])} 各写了多条结论，只用第一条"
        )
    rotated_metadata = [item["index"] for item in judged if item.get("metadata_rotation")]
    if rotated_metadata:
        log["errors"].append(
            "候选带旋转元数据（仅记录，抽帧已自动转正）: "
            + ", ".join(f"#{index}={by_index[index]['metadata_rotation']}°" for index in rotated_metadata)
        )
    verdicts: dict[int, dict[str, Any]] = {}
    for item in verdict.get("ranking", []):
        if not isinstance(item, dict):
            continue
        try:
            index = int(item.get("candidate"))
        except (TypeError, ValueError):
            continue
        if index in by_index:
            verdicts[index] = item

    reviews = {
        index: deterministic_review(
            item, min_score=min_score,
            orientation=combine_orientation(
                (independent.get(index) or {}).get("orientation", "unsure"),
                verdict_orientation(item),
                cached=cached_map.get(index) or [],
            ),
        )
        for index, item in verdicts.items()
    }
    log["review"] = sorted(
        [
            {"candidate": index, "path": by_index[index]["path"],
             "metadata_rotation": by_index[index].get("metadata_rotation"),
             "clip_sha256": digests.get(index),
             "orientation_independent": (independent.get(index) or {}).get("orientation", "unsure"),
             "orientation_cache_hit": "rotated" in (cached_map.get(index) or []),
             "truncated": verdicts[index].get("truncated") is True,
             "reviewed": True,
             **review}
            for index, review in reviews.items()
        ] + [
            # 没有分数、没有 blocked：这一行就是"模型没评过"，读日志的人不会把它
            # 错当成被方向/遮挡兜底拦下的候选。
            {"candidate": index, "path": by_index[index]["path"],
             "metadata_rotation": by_index[index].get("metadata_rotation"),
             "clip_sha256": digests.get(index),
             "orientation_independent": (independent.get(index) or {}).get("orientation", "unsure"),
             "orientation_cache_hit": "rotated" in (cached_map.get(index) or []),
             "reviewed": False,
             "note": "评审 ranking 里没有这一条（补要求重试一次后仍缺），未评审：无分数、不参与 pick"}
            for index in unreviewed
        ],
        key=lambda row: row["candidate"],
    )
    save_orientation_cache(cache_path, cache_entries, [
        (digests[index], review["orientation"], Path(by_index[index]["path"]).name)
        for index, review in sorted(reviews.items()) if digests.get(index)
    ])

    # Only what the model put in ``pick`` may be used. An empty pick is the model
    # saying it recommends nothing; 2026-09-17 shot 2 had pick=[] and the old code
    # filled the gap from the ranking by score, selecting a candidate whose own
    # missing list said the shot's subject was not in the frame.
    picked_order: list[int] = []
    for value in verdict.get("pick") or []:
        try:
            index = int(value)
        except (TypeError, ValueError):
            continue
        if index in unreviewed:
            # 选了一条自己没评过的候选：没有结论就没有依据，按未评审放掉。
            log["errors"].append(f"模型把未评审的候选 {index} 写进了 pick，已忽略")
            continue
        if index in by_index and index not in picked_order:
            picked_order.append(index)
    # Stable, so the model's own priority order survives inside each group: the
    # orientation backstop only demotes, it never re-ranks upright candidates.
    picked_order.sort(key=lambda index: ORIENTATIONS.index(reviews.get(index, {}).get("orientation", "unsure")))
    if not picked_order:
        log["errors"].append("模型 pick 为空（没有推荐任何候选），本镜按全拒处理，不再从 ranking 按分数补选")
    pick_set = set(picked_order)
    ordered = picked_order + [
        index for index, _ in sorted(reviews.items(), key=lambda pair: -pair[1]["adjusted_score"])
        if index not in pick_set
    ]

    accepted: list[str] = []
    rejected: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    fallback_reason: str | None = None
    for index in ordered:
        item = verdicts.get(index, {})
        candidate = by_index[index]
        review = reviews.get(index) or deterministic_review(
            item, min_score=min_score,
            orientation=combine_orientation(
                (independent.get(index) or {}).get("orientation", "unsure"),
                verdict_orientation(item),
                cached=cached_map.get(index) or [],
            ),
        )
        acceptable = index in pick_set and item.get("acceptable") is True and not review["blocked"]
        if acceptable and len(accepted) < count:
            accepted.append(candidate["path"])
            log["picked"].append({
                "candidate": index, "path": candidate["path"], "origin": candidate["origin"],
                "query": candidate.get("query"), "vector_score": candidate.get("score"),
                "model_score": item.get("score"), "adjusted_score": review["adjusted_score"],
                "orientation": review["orientation"], "obstruction": review["obstruction"],
                "camera_angle": review["camera_angle"],
                "metadata_rotation": candidate.get("metadata_rotation"),
                "reason": item.get("reason"),
            })
        else:
            if review["blocked"]:
                reason = review["reason"]
            elif index not in pick_set:
                reason = "模型没有把它写进 pick（没有推荐），不按分数补选"
            elif acceptable:
                reason = "未被选中"
            else:
                reason = str(item.get("reason") or "模型判定不符合")
            rejected.append({"path": candidate["path"], "reason": str(reason)})
            missing = [str(value) for value in (item.get("missing") or []) if str(value).strip()]
            refused.append({
                "candidate": index, "path": candidate["path"], "origin": candidate["origin"],
                "model_score": review["model_score"], "adjusted_score": review["adjusted_score"],
                "orientation": review["orientation"], "obstruction": review["obstruction"],
                "camera_angle": review["camera_angle"], "missing": missing,
                "agent_hits": int(candidate.get("agent_hits") or 0),
                "block_kind": review["block_kind"], "reason": str(reason),
            })
            if review["blocked"]:
                label = {"orientation": "方向", "obstruction": "遮挡", "min_score": "最低接受分"}.get(
                    review["block_kind"] or "", "确定性")
                log["errors"].append(f"候选 {index} 被{label}兜底否决: {review['reason']}")
    for candidate in judged:
        if candidate["index"] not in ordered:
            rejected.append({"path": candidate["path"], "reason": "模型未评价该候选"})

    if not accepted and refused:
        for entry in refused:
            log["errors"].append(
                "候选 {candidate} 未采用（模型分 {model:g} → 调整后 {adjusted:g}）：{reason}；缺少：{missing}".format(
                    candidate=entry["candidate"], model=entry["model_score"], adjusted=entry["adjusted_score"],
                    reason=entry["reason"], missing="、".join(entry["missing"]) or "模型未列出",
                )
            )
        mode = fallback_mode()
        if mode == "stop":
            best = min(refused, key=stop_suggestion_rank)
            log["fallback_suggestion"] = {
                **best, "mode": "stop",
                "note": "全部候选被否决，任务在这一镜停下；这是被拒候选里调整后分数最高的一条，供人工决定是否放行或换素材",
            }
        else:
            best = min(refused, key=fill_placeholder_rank)
            missing_text = "、".join(best["missing"]) or "模型未列出"
            fallback_reason = (
                f"全部 {len(refused)} 个候选被拒，用候选 {best['candidate']} 占位"
                f"（调整后 {best['adjusted_score']:g} 分、方向 {best['orientation']}、遮挡 {best['obstruction']}），"
                f"缺：{missing_text}"
            )
            log["fallback_used"] = {
                **best, "mode": "fill",
                "note": "全部候选被否决，按 MATERIAL_AGENT_FALLBACK=fill 用这一条占位出片；"
                        "log 的 errors 里留着每个候选的 missing，成片必须人工复核",
            }
            log["errors"].append(f"【占位】{fallback_reason}")
            accepted.append(best["path"])
            rejected = [entry for entry in rejected if entry["path"] != best["path"]]
            placeholder = by_index[best["candidate"]]
            log["picked"].append({
                "candidate": best["candidate"], "path": best["path"], "origin": best["origin"],
                "query": placeholder.get("query"), "vector_score": placeholder.get("score"),
                "model_score": best["model_score"], "adjusted_score": best["adjusted_score"],
                "orientation": best["orientation"], "obstruction": best["obstruction"],
                "camera_angle": best["camera_angle"],
                "metadata_rotation": placeholder.get("metadata_rotation"),
                # the policy script prints this reason, so the engine log has to
                # show at a glance that this shot is a placeholder, not a match
                "reason": f"【占位】{fallback_reason}",
                "fallback": True,
            })

    return finish({
        "schema_version": 1, "paths": accepted, "rejected": rejected, "fallback": None,
        "sampled_only": True, "ok": bool(accepted),
        "fallback_used": fallback_reason is not None,
        "fallback_reason": fallback_reason,
    })


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Agent-driven candidate selection (trial)")
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    load_dotenv()
    result = run_agent_selection(json.loads(args.request.read_text(encoding="utf-8")))
    atomic_write_json(args.output, result)
    print(json.dumps(result.get("agent"), ensure_ascii=False, indent=1))
    if not result["ok"]:
        raise SystemExit("agent 未选到可用片段，详情见 material-agent-log.json")


if __name__ == "__main__":
    main()
