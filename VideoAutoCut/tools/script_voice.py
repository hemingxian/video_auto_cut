#!/usr/bin/env python3
"""Verbatim voice-script slicing and validation."""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any


class VoiceScriptError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def read_body(path: Path) -> str:
    try:
        raw = Path(path).read_bytes()
    except OSError as exc:
        raise VoiceScriptError("voice_script_missing", "口播正文文件已不存在，请重新选择脚本") from exc
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise VoiceScriptError("voice_script_unreadable", "口播正文文件无法读取，请重新选择脚本")
    if not re.sub(r"\s+", "", text):
        raise VoiceScriptError("voice_script_empty", "口播正文为空，请重新确认正文")
    return text


def body_sha256(path: Path) -> str:
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError as exc:
        raise VoiceScriptError("voice_script_missing", "口播正文文件已不存在，请重新选择脚本") from exc


def _compact_with_offsets(text: str) -> tuple[str, list[int]]:
    compact, offsets = [], []
    for index, char in enumerate(text):
        if not char.isspace():
            compact.append(char)
            offsets.append(index)
    return "".join(compact), offsets


def locate_starts(body: str, raw_shots: list[dict[str, Any]]) -> list[int]:
    compact, _ = _compact_with_offsets(body)
    starts: list[int] = []
    cursor = 0
    for index, shot in enumerate(raw_shots, 1):
        marker = re.sub(r"\s+", "", str(shot.get("voice_start") or ""))
        if not marker:
            raise VoiceScriptError("voice_start_not_found", f"第 {index} 镜没有可定位的 voice_start")
        position = compact.find(marker, cursor)
        if position < 0:
            if starts and 0 <= compact.find(marker, starts[-1]) < cursor:
                raise VoiceScriptError(
                    "voice_start_out_of_order",
                    f"第 {index} 镜起始摘录与上一镜重叠，可能上一镜摘录过长",
                )
            if compact.find(marker) >= 0:
                raise VoiceScriptError("voice_start_out_of_order", f"第 {index} 镜 voice_start 顺序倒置")
            raise VoiceScriptError("voice_start_not_found", f"第 {index} 镜 voice_start 在正文中找不到")
        if index == 1 and position != 0:
            raise VoiceScriptError("voice_start_out_of_order", "第 1 镜 voice_start 必须从正文开头开始")
        starts.append(position)
        cursor = position + len(marker)
    return starts


def slice_voices(body: str, starts: list[int]) -> tuple[list[str], list[list[int]]]:
    compact, offsets = _compact_with_offsets(body)
    ends = starts[1:] + [len(compact)]
    voices, spans = [], []
    for start, end in zip(starts, ends):
        raw_start = offsets[start]
        raw_end = offsets[end] if end < len(offsets) else len(body)
        voice = re.sub(r"\s+", " ", body[raw_start:raw_end].strip())
        voices.append(voice)
        spans.append([start, end])
    return voices, spans


def validate_concat(body: str, voices: list[str]) -> None:
    expected = re.sub(r"\s+", "", body)
    actual = re.sub(r"\s+", "", "".join(voices))
    if actual == expected:
        return
    point = next((i for i, pair in enumerate(zip(expected, actual)) if pair[0] != pair[1]),
                 min(len(expected), len(actual)))
    shot = 1
    consumed = 0
    for index, voice in enumerate(voices, 1):
        consumed += len(re.sub(r"\s+", "", voice))
        if point < consumed:
            shot = index
            break
    lo, hi = max(0, point - 20), point + 21
    raise VoiceScriptError("voice_script_mismatch",
                           f"第 {shot} 镜口播与确认正文不一致；期望：{expected[lo:hi]}；实际：{actual[lo:hi]}")


def apply(plan: dict[str, Any], raw_plan: dict[str, Any], body: str,
          slicer=None, *, raw_body_sha256: str | None = None) -> dict[str, Any]:
    raw_shots = [item for item in raw_plan.get("shots", []) if isinstance(item, dict)]
    shots = plan.get("shots") if isinstance(plan.get("shots"), list) else []
    if not raw_shots or len(raw_shots) != len(shots):
        raise VoiceScriptError("voice_start_not_found", "模型分镜与规范化分镜数量不一致")
    starts = locate_starts(body, raw_shots)
    voices, spans = (slicer or slice_voices)(body, starts)
    if len(voices) != len(shots) or len(spans) != len(shots):
        raise VoiceScriptError("voice_script_mismatch", "口播切片数量与分镜数量不一致")
    for shot, voice in zip(shots, voices):
        shot["voice_text"] = voice
        shot["voiceover"] = True
        shot.pop("subtitle", None)
    validate_concat(body, voices)
    for shot, span in zip(shots, spans):
        meta = shot["script_meta"]
        meta["source"]["voice_span"] = span
        meta["field_origin"]["voice_text"] = "script"
        meta["script_values"]["voice_text"] = shot["voice_text"]
        meta["script_values"]["subtitle"] = ""
        meta["review"]["ai_suggested"] = [field for field in meta["review"]["ai_suggested"]
                                                   if field != "voice_text"]
        status = meta["review"].setdefault("status_lines", [])
        status.append("口播按原文逐字切分，分段位置由 AI 决定，请检查每镜起止")
    plan["script_source"]["voice_mode"] = "verbatim"
    plan["script_source"]["voice_body_sha256"] = raw_body_sha256 or hashlib.sha256(body.encode("utf-8")).hexdigest()
    return plan
