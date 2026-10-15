#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import dashscope_url, env_int, load_dotenv, load_prompt_template, read_http_response_text, urlopen_with_retry
from json_io import atomic_write_json, decode_json_object
from shot_plan_schema import normalize_shot_plan

SUPPORTED_SOURCES = {"pexels", "pixabay", "wikimedia-commons"}
DEFAULT_SOURCE = "pexels"
MAX_OPTIMIZATION_ATTEMPTS = 3


def strip_code_fence(text: str) -> str:
    text = (text or "").strip()
    match = re.match(r"(?s)^```(?:json)?\s*(.*?)\s*```$", text)
    return match.group(1).strip() if match else text


def call_qwen(
    messages: list[dict],
    temperature: float = 0.2,
    label: str = "Qwen 请求",
    model: str | None = None,
    timeout: int | None = None,
    enable_thinking: bool | None = None,
    http_attempts: int | None = None,
) -> dict:
    load_dotenv()
    api_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("DASHSCOPE_API_KEY is missing in .env")

    model = model or os.environ.get("DASHSCOPE_TEXT_MODEL", "qwen-plus")
    url = dashscope_url(
        "v1/chat/completions",
        override_env="DASHSCOPE_OPENAI_BASE_URL",
        default="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    )
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "response_format": {"type": "json_object"},
    }
    if enable_thinking is not None:
        body["enable_thinking"] = enable_thinking
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    timeout = timeout if timeout is not None else env_int("DASHSCOPE_HTTP_TIMEOUT", env_int("QWEN_HTTP_TIMEOUT", 240))
    try:
        retry_kwargs = {"attempts": http_attempts} if http_attempts is not None else {}
        with urlopen_with_retry(req, timeout=timeout, label=label, **retry_kwargs) as resp:
            payload = read_http_response_text(resp)
    except urllib.error.HTTPError as exc:
        detail = read_http_response_text(exc)
        raise SystemExit(f"Qwen query optimize HTTP {exc.code}: {detail}") from exc

    result = decode_json_object(payload, label="Qwen API 响应")
    choices = result.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise ValueError("Qwen API 响应缺少 choices[0]")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise ValueError("Qwen API 响应缺少 choices[0].message")
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("Qwen API 响应缺少非空 message.content")
    return decode_json_object(strip_code_fence(content), label="Qwen 模型输出")


def compact(text: str) -> str:
    text = re.sub(r"\s+", " ", (text or "").strip())
    return text


def quality_issues(value: object) -> list[str]:
    if isinstance(value, dict):
        raw = value.get("issues") or []
    else:
        raw = []
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    if isinstance(raw, str) and raw.strip():
        return [raw.strip()]
    return []


def quality_ok(value: object) -> bool:
    if not isinstance(value, dict):
        return True
    ok = value.get("ok")
    if isinstance(ok, bool):
        return ok
    return not quality_issues(value)


def require_text_field(obj: dict, field: str) -> str:
    raw = obj.get(field)
    if not isinstance(raw, str):
        raise ValueError(f"{field} 必须是字符串")
    value = compact(raw)
    if not value:
        raise ValueError(f"{field} 为空")
    if re.search(r"[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]", value):
        raise ValueError(f"{field} 必须使用英文描述，不能混入中文或其他东亚文字：{value}")
    if not re.search(r"[A-Za-z]", value):
        raise ValueError(f"{field} 缺少英文检索内容")
    return value


def normalize_source(value: str | None) -> str:
    source = compact(str(value or "")).lower().replace("_", "-")
    if source == "wikimedia":
        source = "wikimedia-commons"
    if not source:
        source = DEFAULT_SOURCE
    if source not in SUPPORTED_SOURCES:
        raise SystemExit(
            f"不支持的素材来源: {source}。当前只支持: {', '.join(sorted(SUPPORTED_SOURCES))}"
        )
    return source


def optimize_one(shot: dict, source: str) -> dict:
    system = load_prompt_template("query_optimize.md").strip()
    user = {
        "source": source,
        "title": shot.get("title", ""),
        "current_download_query": shot.get("download_query", ""),
        "current_visual_query": shot.get("visual_query", ""),
        "clip_requirements": shot.get("clip_requirements", ""),
        "subtitle_effect": shot.get("subtitle_effect", ""),
        "voice_text": shot.get("voice_text", ""),
        "subtitle": shot.get("subtitle", ""),
    }

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
    ]
    for attempt in range(1, MAX_OPTIMIZATION_ATTEMPTS + 1):
        obj = None
        try:
            obj = call_qwen(
                messages,
                temperature=0.1,
                label=f"Qwen 搜索词优化 ({attempt}/{MAX_OPTIMIZATION_ATTEMPTS})",
            )
            if not isinstance(obj, dict):
                raise ValueError("模型输出必须是 JSON 对象")
            download_query = require_text_field(obj, "download_query")
            visual_query = require_text_field(obj, "visual_query")
            quality = obj.get("quality") or {}
            if not quality_ok(quality):
                issues = "；".join(quality_issues(quality)) or "模型自检未通过"
                raise ValueError(f"模型自检未通过：{issues}")
            return {"download_query": download_query, "visual_query": visual_query}
        except ValueError as exc:
            if attempt == MAX_OPTIMIZATION_ATTEMPTS:
                raise SystemExit(
                    f"分镜 #{shot.get('shot')} 搜索词优化失败（已尝试 {attempt} 次，前面完成的分镜已保存）: {exc}"
                ) from exc
            if obj is not None:
                messages.append({"role": "assistant", "content": json.dumps(obj, ensure_ascii=False)})
            messages.append({"role": "user", "content": (
                f"上次结果未通过校验：{exc}。请根据原始分镜修正两个检索字段并重新自检。"
                "两个字段都使用英文，翻译中文概念而不是删除它们；保持原始主体和画面含义，"
                "去掉字幕、剪辑指令、时码和无关符号。只返回修正后的完整 JSON。"
            )})
            print(f"分镜 #{shot.get('shot')} 搜索词自检未通过，正在自动修正 ({attempt + 1}/{MAX_OPTIMIZATION_ATTEMPTS})")
        except Exception as exc:
            raise SystemExit(f"分镜 #{shot.get('shot')} 搜索词优化失败: {exc}") from exc
    raise AssertionError("unreachable")


def visual_mode(shot: dict) -> str:
    return str(shot.get("visual_mode") or "stock_video").strip().lower().replace("-", "_")


def main() -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Optimize download/search queries from shots.json")
    parser.add_argument("--shots-json", required=True)
    parser.add_argument("--source", default=os.environ.get("SOURCE", DEFAULT_SOURCE))
    parser.add_argument("--force", action="store_true", help="re-optimize even if query_optimized exists")
    args = parser.parse_args()
    source = normalize_source(args.source)

    path = Path(args.shots_json)
    plan = json.loads(path.read_text(encoding="utf-8"))
    shots = plan.get("shots") or []

    for shot in shots:
        if not isinstance(shot, dict):
            continue
        if shot.get("query_optimized") and not args.force:
            continue

        original = {
            "download_query": shot.get("download_query", ""),
            "visual_query": shot.get("visual_query", ""),
        }
        print(f"优化搜索词 #{shot.get('shot')}: {shot.get('title')}")
        opt = optimize_one(shot, source)
        shot["raw_download_query"] = original["download_query"]
        shot["raw_visual_query"] = original["visual_query"]
        shot["download_query"] = opt["download_query"]
        shot["visual_query"] = opt["visual_query"]
        shot["query_optimized"] = True
        # Keep completed shots when the process is paused during a later request.
        atomic_write_json(path, normalize_shot_plan(plan))
        print(f"  download_query: {shot['download_query']}")
        print(f"  visual_query: {shot['visual_query']}")

    plan = normalize_shot_plan(plan)
    atomic_write_json(path, plan)
    print(f"已回写优化后的搜索词: {path}")


if __name__ == "__main__":
    main()
