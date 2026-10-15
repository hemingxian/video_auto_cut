#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
import re
import importlib.util
from pathlib import Path

TOOLS_COMMON_PATH = Path(__file__).resolve().parents[1] / "common.py"
TOOLS_COMMON_SPEC = importlib.util.spec_from_file_location("_video_auto_cut_tools_common", TOOLS_COMMON_PATH)
if TOOLS_COMMON_SPEC is None or TOOLS_COMMON_SPEC.loader is None:
    raise ImportError(f"Cannot load shared common helpers: {TOOLS_COMMON_PATH}")
TOOLS_COMMON = importlib.util.module_from_spec(TOOLS_COMMON_SPEC)
TOOLS_COMMON_SPEC.loader.exec_module(TOOLS_COMMON)

ass_time = TOOLS_COMMON.ass_time
escape_ass = TOOLS_COMMON.escape_ass
split_lines = TOOLS_COMMON.split_lines

PLAY_W = 1920
PLAY_H = 1080


def read_plan(path: str | Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_ass(path: str | Path, body: str) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(body, encoding="utf-8")


def ass_header() -> str:
    return """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CardTitle,Microsoft YaHei,68,&H00FFFFFF,&H00FFFFFF,&H00111111,&HAA000000,1,0,0,0,100,100,0,0,1,2,1,7,0,0,0,1
Style: CardText,Microsoft YaHei,42,&H00FFFFFF,&H00FFFFFF,&H00222222,&HAA000000,0,0,0,0,100,100,0,0,1,2,1,7,0,0,0,1
Style: CardSmall,Microsoft YaHei,34,&H00EDEDED,&H00EDEDED,&H00222222,&HAA000000,0,0,0,0,100,100,0,0,1,1,1,7,0,0,0,1
Style: CardAccent,Microsoft YaHei,46,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def rect(layer: int, start: float, end: float, x1: int, y1: int, x2: int, y2: int, color: str = "&HAA000000", fade: tuple[int, int] = (250, 250)) -> str:
    # ASS vector rectangle. Colour is in \c, transparency in alpha part of &HAABBGGRR.
    st, et = ass_time(start), ass_time(end)
    fad = f"\\fad({fade[0]},{fade[1]})" if fade else ""
    drawing = f"m {x1} {y1} l {x2} {y1} l {x2} {y2} l {x1} {y2}"
    return f"Dialogue: {layer},{st},{et},CardAccent,,0,0,0,,{{{fad}\\pos(0,0)\\c{color}\\p1}}{drawing}{{\\p0}}\n"


def text(layer: int, start: float, end: float, x: int, y: int, content: str, style: str = "CardText", align: int = 7, size: int | None = None, color: str | None = None, fade: tuple[int, int] = (250, 250), extra: str = "") -> str:
    st, et = ass_time(start), ass_time(end)
    tags = f"\\an{align}\\pos({x},{y})"
    if fade:
        tags += f"\\fad({fade[0]},{fade[1]})"
    if size:
        tags += f"\\fs{size}"
    if color:
        tags += f"\\c{color}"
    tags += extra
    return f"Dialogue: {layer},{st},{et},{style},,0,0,0,,{{{tags}}}{escape_ass(content)}\n"


def default_times(plan: dict) -> tuple[float, float]:
    start = float(plan.get("start", os.environ.get("CARD_DEFAULT_START", "0.35")) or 0.35)
    end = float(plan.get("end", os.environ.get("CARD_DEFAULT_END", "3.8")) or 3.8)
    return max(0, start), max(start + 0.2, end)


def normalized_type(plan: dict) -> str:
    return str(plan.get("type") or plan.get("card_type") or "title_card").strip().lower()


def split_items(value) -> list[str]:
    if isinstance(value, list):
        return [str(x).strip() for x in value if str(x).strip()]
    s = str(value or "").strip()
    if not s:
        return []
    parts = re.split(r"[\n；;]+", s)
    if len(parts) <= 1:
        parts = re.split(r"(?<=[。！？!?])", s)
    return [p.strip(" -•·\t") for p in parts if p.strip(" -•·\t")]
