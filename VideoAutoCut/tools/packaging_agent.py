#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模板包装的第一步 agent：从固定模板库里选版式（试验，默认关闭）。

由 PACKAGING_AGENT_SELECT=1 打开，`render_segment.py` 在调 `render_overlay` 之前
调 `plan_for_shot()`。关掉时 `render_segment.py` 连本模块都不 import，代码路径与
接入之前完全一致。

铁律（不要放松）：
- **模型不产出任何上屏文字。** 返回 schema 里根本没有文字字段；上屏文字永远是
  `template_packaging.packaging_content()` 从 `card_content` / `title` 原样取的那份。
- **作者写了 `card_content` 的分镜不许关包装**：模型填 show=false 会被强制改回 true，
  并在日志里记 `overridden="author_card_content"`。
- **脚本版式标签定了版式的分镜（`card_layout`）不问模型**：直接用脚本的版式，
  日志记 `overridden="script_layout"`（2026-09-23 用户拍板：agent 不得覆盖）。
  `template_packaging.packaging_content` 里有同一条判断兜底。
- **任何异常都返回 None**，调用方拿 None 就走确定性正则选择，成片不会少。
- 传输层复用选材 agent 那一套（`material_agent_select`），本模块只 import 不改它：
  pi 的 `.cmd` 参数截断修法、provider 首启合并、顶层数组重试全部自动继承。
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import env_bool, env_int, load_prompt_template
from json_io import atomic_write_json
from template_packaging import (
    TEMPLATE_VERSION, has_script_card_content, packaging_content, script_layout, shot_count,
)

PROMPT_NAME = "agent_packaging_plan.md"
LOG_FILE_NAME = "packaging-agent-log.json"
CACHE_DIR_NAME = "_agent_cache"
CACHE_FILE_NAME = "packaging.json"
# run 级缓存的条数上限，对齐选材的 ORIENTATION_CACHE_HISTORY 做法（超了丢最旧的）。
CACHE_HISTORY = 200
# 与 template_packaging.build_composition 的色板 dict 键一致，少一个就 KeyError。
TEMPLATES = ("title", "parameters", "cta")
REASON_LIMIT = 60
# 喂给模型的分镜字段。只读文案，不读素材路径、不读画面。
CONTEXT_FIELDS = ("title", "card_content", "card_hint", "voice_text", "subtitle", "clip_requirements")
# 两个后端在一次 ask 里各自最多重试几回（都在 material_agent_select 里，本模块不改它）：
# ask_pi 正常一次 + 顶层数组补一次；ask_dashscope 的 `for attempt in range(3)`。只作记录，
# **不再用来摊超时**——见 per_call_timeout 的说明。
BACKEND_INTERNAL_ATTEMPTS = {"pi": 2, "dashscope": 3}
# 预算再紧也别把单次调用压到没法完成；小于这个数就直接判预算用尽、走确定性版式。
MIN_CALL_TIMEOUT = 10


# ----------------------------------------------------------------------------
# settings
# ----------------------------------------------------------------------------

def enabled() -> bool:
    return env_bool("PACKAGING_AGENT_SELECT", False)


def backend_name() -> str:
    """与选材同款收紧逻辑：没显式配 pi 一律 dashscope，不因为机器上有 pi 就切过去。"""
    configured = os.environ.get("PACKAGING_AGENT_BACKEND", "").strip().lower()
    if configured in {"pi", "dashscope"}:
        return configured
    return "dashscope"


def timeout_seconds() -> int:
    """本镜 agent 决策的**整体预算**（秒），不是单次调用超时。"""
    return max(30, min(600, env_int("PACKAGING_AGENT_TIMEOUT", 90)))


def per_call_timeout(remaining: float) -> int:
    """这次调用能用多久：**deadline 还剩多少就给多少**，下限 MIN_CALL_TIMEOUT。

    早先是按后端内部重试次数摊（90s → 单次 45s），2026-09-18 Windows #4b 实测证明那是错的：
    超时这条路径根本不会重试（`ask_pi` 的第二次尝试只在返回顶层数组时才触发），30s 的预算
    实际只用掉 14s；反过来，正常但慢的调用（比如 thinking 打开）会在预算没用完时被提前杀。

    内部那次重试只可能发生在第一次**成功且快速**返回之后（顶层数组 / HTTP 400 的 JSON 异常，
    都意味着服务端已经回过话了），所以把整份剩余预算交给这一次调用，实际总耗时仍贴着预算。
    要给内部重试单独算一份更小的超时，得改 `material_agent_select.ask_pi` 的签名——那是禁区，
    所以这里只记录：真出现「慢响应 + 顶层数组重试」时，最坏会到预算的两倍，日志的
    `budget.overran` 会标出来。
    """
    return max(MIN_CALL_TIMEOUT, int(remaining))


@contextmanager
def bounded_http_retries() -> Iterator[None]:
    """dashscope 链路专用：把 `common.urlopen_with_retry` 的默认 5 次重试压到 1 次。

    那 5 次带指数退避（最长 30s 一次），一次网络抖动就能把本镜拖过预算。用环境变量
    临时压制，既不用改 `call_qwen` 的签名，也不用动 `common.py`。
    """
    previous = os.environ.get("VIDEOAUTO_HTTP_RETRIES")
    os.environ["VIDEOAUTO_HTTP_RETRIES"] = "1"
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("VIDEOAUTO_HTTP_RETRIES", None)
        else:
            os.environ["VIDEOAUTO_HTTP_RETRIES"] = previous


def model_override() -> str:
    return os.environ.get("PACKAGING_AGENT_MODEL", "").strip()


def cache_enabled() -> bool:
    return env_bool("PACKAGING_AGENT_CACHE", True)


@contextmanager
def selected_model() -> Iterator[None]:
    """本步骤临时覆盖模型（两个后端各自读的键都盖上），用完还原。

    对齐 `material_agent_select.orientation_model_selected()` 的写法：`ask` 在各处
    保持同一个签名（测试要能替换掉），所以模型只能从环境里换。本步骤不传图片，
    走的是两个后端的「纯文本模型」分支，所以 text 键也要盖。
    """
    model = model_override()
    if not model:
        yield
        return
    names = ("DASHSCOPE_VISUAL_REVIEW_MODEL", "DASHSCOPE_TEXT_MODEL",
             "MATERIAL_AGENT_PI_MODEL", "MATERIAL_AGENT_PI_TEXT_MODEL")
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


def shot_total(shots_json: str) -> int:
    """进度事件用的分镜总数；读不到就返回 0（调用方按未知处理）。

    实现在 `template_packaging.shot_count`——「按脚本跳过」的分镜要在不 import 本模块的前提下
    也能发进度事件，所以那边才是正本，这里只保留旧名字。
    """
    return shot_count(shots_json)


# ----------------------------------------------------------------------------
# 日志（对齐 material-agent-log.json 的形状）
# ----------------------------------------------------------------------------

_STATE: dict[str, Any] = {}


def _flush() -> None:
    path = _STATE.get("path")
    log = _STATE.get("log")
    if not path or not isinstance(log, dict):
        return
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(Path(path), log)
    except OSError as error:
        print(f"[packaging] 写不了决策日志 {path}: {error}", flush=True)


def record(section: str, data: Any) -> None:
    """把包装之后才知道的事实（overlay 降级、成片自校验）补进同一份日志。"""
    log = _STATE.get("log")
    if isinstance(log, dict):
        log[section] = data
        _flush()


def note(message: str) -> None:
    log = _STATE.get("log")
    if isinstance(log, dict):
        log.setdefault("errors", []).append(message)
        _flush()


# ----------------------------------------------------------------------------
# prompt / 校验
# ----------------------------------------------------------------------------

def context_text(shot: dict[str, Any]) -> str:
    keep: dict[str, str] = {}
    for field in CONTEXT_FIELDS:
        value = str(shot.get(field) or "").strip()
        if value:
            keep[field] = value
    return json.dumps(keep, ensure_ascii=False, indent=1)


def user_text_for(shot: dict[str, Any], *, duration: float, width: int, height: int,
                  picture_bounds: Any = None) -> str:
    bounds = picture_bounds or (0, 0, width, height)
    return "\n".join([
        f"分镜信息：\n{context_text(shot)}",
        "",
        f"分镜时长 {duration:.0f} 秒，画布 {width}x{height}，"
        f"画面可用区域 宽 {int(bounds[2])} 高 {int(bounds[3])}。",
        "",
        "只返回 JSON。",
    ])


def validate_response(response: Any, *, author_card_content: bool) -> tuple[dict[str, Any] | None, str]:
    """把模型返回收成 plan，或说明哪里不合法。不合法一律降级，不猜、不修补。"""
    if not isinstance(response, dict):
        return None, f"返回不是 JSON 对象：{type(response).__name__}"
    template = response.get("template")
    if template not in TEMPLATES:
        return None, f"template 不在 {list(TEMPLATES)}：{template!r}"
    show = response.get("show")
    if not isinstance(show, bool):
        return None, f"show 不是布尔值：{show!r}"
    overridden = None
    if author_card_content and not show:
        # 作者写了 card_content 就是已经决定要上屏，agent 无权撤销。
        show = True
        overridden = "author_card_content"
    reason = str(response.get("reason") or "").strip()[:REASON_LIMIT]
    return {"template": template, "show": show, "reason": reason, "overridden": overridden}, ""


# ----------------------------------------------------------------------------
# 缓存
# ----------------------------------------------------------------------------

def cache_key(shot: dict[str, Any]) -> str:
    payload = json.dumps(
        {field: str(shot.get(field) or "") for field in CONTEXT_FIELDS}
        | {"template_version": TEMPLATE_VERSION},
        ensure_ascii=False, sort_keys=True,
    )
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def cache_path(directory: Path) -> Path:
    # directory 是本分镜的包装目录，它的上级是 run 级的 packaging/，缓存跨分镜共享。
    return directory.parent / CACHE_DIR_NAME / CACHE_FILE_NAME


def load_cache(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    entries = data.get("entries") if isinstance(data, dict) else None
    return entries if isinstance(entries, dict) else {}


def save_cache(path: Path, entries: dict[str, Any]) -> None:
    if len(entries) > CACHE_HISTORY:
        # dict 保持插入顺序，丢最早写进去的。
        for key in list(entries)[:len(entries) - CACHE_HISTORY]:
            entries.pop(key, None)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(path, {"schema_version": 1, "entries": entries})
    except OSError as error:
        print(f"[packaging] 写不了决策缓存 {path}: {error}", flush=True)


# ----------------------------------------------------------------------------
# 入口
# ----------------------------------------------------------------------------

def plan_for_shot(
    shot: dict[str, Any],
    *,
    directory: Path,
    shot_index: int = 0,
    duration: float = 0.0,
    width: int = 0,
    height: int = 0,
    picture_bounds: Any = None,
    ask: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """返回 {"template","show","source","reason","cache_key"}，或 None（走确定性路径）。"""
    started = time.time()
    deadline = started + timeout_seconds()
    backend = backend_name()
    deterministic_kind, _content = packaging_content(shot)
    author_card_content = has_script_card_content(shot)
    key = cache_key(shot)
    log: dict[str, Any] = {
        "schema_version": 1,
        "policy": "packaging-agent-step1",
        "backend": backend,
        "shot_id": str(shot.get("shot_id") or ""),
        "shot_index": shot_index,
        "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "template_version": TEMPLATE_VERSION,
        "input": {field: str(shot.get(field) or "") for field in CONTEXT_FIELDS if shot.get(field)}
        | {"duration": duration, "width": width, "height": height},
        "deterministic": {"template": deterministic_kind, "show": True},
        "response_raw": None,
        "decision": None,
        "agreed_with_deterministic": None,      # 只比版式
        "show_agreed_with_deterministic": None,  # 只比"上不上包装"
        "decision_changed": None,                # 版式或 show 任一不同
        "cache": {"hit": False, "path": str(cache_path(directory))},
        # PACKAGING_AGENT_TIMEOUT 是本镜整体预算；call_timeout_seconds 是这次调用拿到的剩余量
        # （= 调用时刻的 deadline 余额）；overran 记录后端内部重试是否把总耗时带过了预算。
        "budget": {"seconds": timeout_seconds(), "call_timeout_seconds": None, "overran": False,
                   "internal_attempts": BACKEND_INTERNAL_ATTEMPTS.get(backend, 1)},
        "timings": {"model_seconds": 0.0},
        "errors": [],
        "fallback_used": False,
        "ok": False,
    }
    _STATE.clear()
    _STATE["log"] = log
    _STATE["path"] = str(Path(directory) / LOG_FILE_NAME)

    def finish(plan: dict[str, Any] | None, *, reason: str = "") -> dict[str, Any] | None:
        if plan is None:
            log["fallback_used"] = True
            if reason:
                log["errors"].append(reason)
                print(f"[packaging] 分镜 {shot_index} 决策降级（{reason}），用确定性模板", flush=True)
        else:
            log["decision"] = plan
            # 三个对照口径分开记：只比版式的、只比 show 的、以及"agent 到底改没改这一镜"。
            # 确定性路径永远上包装（content = card_content or title，title 由 schema 保证非空），
            # 所以确定性的 show 恒为 True。
            log["agreed_with_deterministic"] = plan["template"] == deterministic_kind
            log["show_agreed_with_deterministic"] = plan["show"] is True
            log["decision_changed"] = not (log["agreed_with_deterministic"]
                                           and log["show_agreed_with_deterministic"])
            log["ok"] = True
            source = {"cache": "缓存", "script_label": "脚本版式标签"}.get(plan["source"], "agent")
            # show=false 这一镜根本不会有 overlay，打「版式 title」会让人以为上了包装。
            what = f"版式 {plan['template']}" if plan["show"] else "不上包装"
            print(f"[packaging] 分镜 {shot_index} {what}"
                  f"（{source}，{plan.get('reason') or '无说明'}）"
                  f"，耗时 {log['timings']['model_seconds']:.1f}s", flush=True)
        # 每条出口都要记：超时和异常那两条路径尤其要，它们才是真会超预算的。
        log["elapsed_seconds"] = round(time.time() - started, 2)
        log["budget"]["overran"] = time.time() > deadline
        _flush()
        return plan

    layout = script_layout(shot)
    if layout is not None:
        # 脚本写了版式标签：版式由脚本定，模型无权改，连问都不问（省一次调用，也不写缓存）。
        log["script_layout"] = layout
        return finish({"template": deterministic_kind, "show": True, "source": "script_label",
                       "reason": f"脚本版式标签 {layout}", "overridden": "script_layout",
                       "cache_key": key})

    try:
        entries = load_cache(cache_path(directory)) if cache_enabled() else {}
        cached = entries.get(key)
        if isinstance(cached, dict) and cached.get("template") in TEMPLATES and isinstance(cached.get("show"), bool):
            log["cache"]["hit"] = True
            return finish({"template": cached["template"], "show": cached["show"],
                           "source": "cache", "reason": str(cached.get("reason") or ""),
                           "cache_key": key})

        from material_agent_select import ensure_pi_provider_config, make_ask  # 只 import，不改

        if ask is None:
            if backend == "pi":
                # 运行包自带 pi 时用户目录里多半还没 provider 配置，首启补一次。
                ensure_pi_provider_config()
            ask = make_ask(backend)

        system = load_prompt_template(PROMPT_NAME).strip()
        user_text = user_text_for(shot, duration=duration, width=width, height=height,
                                  picture_bounds=picture_bounds)
        remaining = deadline - time.time()
        if remaining < MIN_CALL_TIMEOUT:
            return finish(None, reason=f"本镜决策预算已用尽（剩 {remaining:.1f}s）")
        call_timeout = per_call_timeout(remaining)
        log["budget"]["call_timeout_seconds"] = call_timeout
        model_started = time.time()
        with selected_model(), bounded_http_retries():
            response = ask(system, user_text, [], timeout=call_timeout)
        log["timings"]["model_seconds"] = round(time.time() - model_started, 3)
        log["response_raw"] = response if isinstance(response, dict) else str(response)[:300]

        plan, problem = validate_response(response, author_card_content=author_card_content)
        if plan is None:
            return finish(None, reason=problem)
        plan = {**plan, "source": "agent", "cache_key": key}
        if cache_enabled():
            entries[key] = {"template": plan["template"], "show": plan["show"],
                            "reason": plan["reason"], "overridden": plan["overridden"],
                            "saved_at": time.strftime("%Y-%m-%d %H:%M:%S")}
            save_cache(cache_path(directory), entries)
        return finish(plan)
    except Exception as error:  # noqa: BLE001 —— 决策失败绝不能带倒整条渲染
        log["timings"]["model_seconds"] = round(time.time() - started, 3)
        return finish(None, reason=f"{type(error).__name__}: {error}")
