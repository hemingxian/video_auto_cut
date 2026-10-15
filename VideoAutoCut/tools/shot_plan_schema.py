#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import copy
import math
import uuid
from typing import Any, Literal

from common import strict_bool

# 上屏卡片版式（2026-09-23）：只由 `script_card_fields` 按脚本原文的版式标签确定性写入，
# 模型不产出（`normalize_script.compact_plan` 不收这个键）。认不出的值一律丢掉，
# 渲染层回到默认规则。与 `script_card_fields.CARD_LAYOUTS` 保持一致（有测试核对）。
CARD_LAYOUTS = ("headline_sub", "equal_lines")

KNOWN_PLAN_KEYS = frozenset({
    "schema_version", "task_revision", "topic", "shots", "background_music",
    "content_blocks", "extra_requirements",
})
KNOWN_SHOT_KEYS = frozenset({
    "shot_id", "shot", "title", "download_query", "visual_query", "download_material",
    "material_bindings", "module_label", "visual_mode", "voice_text", "subtitle",
    "clip_requirements", "progress_text", "highlight_rule", "subtitle_effect",
    "voice_requirements", "time_range", "card_content", "card_hint", "raw_download_query",
    "raw_visual_query", "voice_audio", "subtitle_cues_file", "card_plan", "card_ass",
    "card_layout", "duration", "voiceover", "query_optimized", "subtitle_cues",
    "extra_requirements", "production_notes", "content_blocks",
})


def text_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def optional_text(value: Any) -> str | None:
    text = text_value(value).strip()
    return text or None


def _normalized_string(value: object, *, collapse_whitespace: bool) -> str:
    text = str(value).strip()
    return " ".join(text.split()) if collapse_whitespace else text


def compact_json_value(
    value: Any,
    max_text: int = 2000,
    depth: int = 0,
    *,
    collapse_whitespace: bool = False,
) -> Any:
    if depth > 5:
        return None
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        text = _normalized_string(value, collapse_whitespace=collapse_whitespace)
        return text[:max_text] if text else None
    if isinstance(value, list):
        items = [
            compact_json_value(
                item,
                max_text=max_text,
                depth=depth + 1,
                collapse_whitespace=collapse_whitespace,
            )
            for item in value[:120]
        ]
        return [item for item in items if item not in (None, "", [], {})]
    if isinstance(value, dict):
        output: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str) or not key.strip():
                continue
            compacted = compact_json_value(
                item,
                max_text=max_text,
                depth=depth + 1,
                collapse_whitespace=collapse_whitespace,
            )
            if compacted not in (None, "", [], {}):
                output[key.strip()] = compacted
        return output or None
    text = _normalized_string(value, collapse_whitespace=collapse_whitespace)
    return text[:max_text] if text else None


def optional_json_list(value: Any, *, collapse_whitespace: bool = False) -> list[Any]:
    compacted = compact_json_value(value, collapse_whitespace=collapse_whitespace)
    if isinstance(compacted, list):
        return compacted
    if compacted in (None, "", {}, []):
        return []
    return [compacted]


def normalize_duration(
    value: Any,
    *,
    rounding: Literal["ceil", "nearest"] = "ceil",
) -> int | None:
    if value in (None, ""):
        return None
    try:
        duration = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(duration) or duration <= 0:
        return None
    if rounding == "ceil":
        normalized = math.ceil(duration)
    elif rounding == "nearest":
        normalized = round(duration)
    else:
        raise ValueError(f"Unsupported duration rounding mode: {rounding}")
    return max(1, normalized)

def normalize_material_bindings(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        binding_type = optional_text(item.get("binding_type"))
        if binding_type == "material":
            material_id = optional_text(item.get("material_id"))
            key = f"material:{material_id}"
            if material_id and key not in seen:
                output.append({
                    "binding_type": "material",
                    "material_id": material_id,
                })
                seen.add(key)
        elif binding_type == "folder":
            folder_id = optional_text(item.get("folder_id"))
            key = f"folder:{folder_id}"
            if folder_id and key not in seen:
                output.append({
                    "binding_type": "folder",
                    "folder_id": folder_id,
                    "include_subfolders": item.get("include_subfolders") is True,
                })
                seen.add(key)
    return output


def normalize_shot_plan(plan: Any, topic: str = "") -> dict[str, Any]:
    source = plan if isinstance(plan, dict) else {}
    shots = source.get("shots") if isinstance(source.get("shots"), list) else []
    source_revision = source.get("task_revision")
    task_revision = (
        source_revision
        if isinstance(source_revision, int)
        and not isinstance(source_revision, bool)
        and source_revision >= 0
        else 0
    )
    normalized: dict[str, Any] = {
        "schema_version": 2,
        "task_revision": task_revision,
        "topic": optional_text(source.get("topic")) or topic or "脚本文档",
        "shots": [],
    }
    background_music = compact_json_value(source.get("background_music"))
    if background_music not in (None, "", [], {}):
        normalized["background_music"] = background_music
    for field in ("content_blocks", "extra_requirements"):
        values = optional_json_list(source.get(field))
        if values:
            normalized[field] = values

    for index, raw in enumerate(shots, 1):
        if not isinstance(raw, dict):
            continue

        bindings = normalize_material_bindings(raw.get("material_bindings"))
        download_material_value = strict_bool(
            raw.get("download_material"),
            f"shots[{index}].download_material",
            None,
        )
        if download_material_value is None:
            download_material_value = not bindings
        if download_material_value and bindings:
            shot_label = optional_text(raw.get("shot_id")) or str(index)
            raise ValueError(
                f"shot {shot_label} cannot keep material_bindings "
                "when download_material is true"
            )

        shot: dict[str, Any] = {
            "shot_id": optional_text(raw.get("shot_id"))
            or f"shot_{uuid.uuid4().hex}",
            "shot": index,
            "title": optional_text(raw.get("title")) or f"分镜{index}",
            "download_query": text_value(raw.get("download_query")).strip(),
            "visual_query": text_value(raw.get("visual_query") or raw.get("download_query")).strip(),
            "download_material": download_material_value,
            "material_bindings": bindings,
        }
        if not shot["visual_query"]:
            shot["visual_query"] = shot["title"]

        optional_fields = [
            "module_label",
            "visual_mode",
            "voice_text",
            "subtitle",
            "clip_requirements",
            "progress_text",
            "highlight_rule",
            "subtitle_effect",
            "voice_requirements",
            "time_range",
            "card_content",
            "card_hint",
            "raw_download_query",
            "raw_visual_query",
            "voice_audio",
            "subtitle_cues_file",
            "card_plan",
            "card_ass",
        ]
        for field in optional_fields:
            value = optional_text(raw.get(field))
            if value:
                shot[field] = value

        layout = optional_text(raw.get("card_layout"))
        if layout in CARD_LAYOUTS and shot.get("card_content"):
            shot["card_layout"] = layout

        duration = normalize_duration(raw.get("duration"))
        if duration is not None:
            shot["duration"] = duration

        for field in ("voiceover", "query_optimized"):
            value = strict_bool(raw.get(field), f"shots[{index}].{field}", None)
            if value is not None:
                shot[field] = value

        if isinstance(raw.get("subtitle_cues"), list):
            shot["subtitle_cues"] = raw["subtitle_cues"]

        for field in ("extra_requirements", "production_notes", "content_blocks"):
            values = optional_json_list(raw.get(field))
            if values:
                shot[field] = values

        for field, value in raw.items():
            if field not in KNOWN_SHOT_KEYS:
                shot[field] = copy.deepcopy(value)

        normalized["shots"].append(shot)

    for field, value in source.items():
        if field not in KNOWN_PLAN_KEYS:
            normalized[field] = copy.deepcopy(value)

    return normalized
