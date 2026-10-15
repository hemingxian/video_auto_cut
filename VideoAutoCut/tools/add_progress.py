#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import ass_time, clean_label, env_float, escape_ass, load_dotenv
from output_format import canvas_size, layout_scale, scaled_pixels
from text_layout import fit_label, text_width, wrap_text_pixels


HIGHLIGHT = "&H44FFFFFF&"
DARK = "&H99303030&"
SEPARATOR = "&HCC111111&"
GRAY_TEXT = "&HD7DEE8&"
WHITE_TEXT = "&HFFFFFF&"

PROGRESS_TEMPLATE_FILE = Path(__file__).resolve().parents[1] / "config" / "progress-templates.json"
_PROGRESS_TEMPLATES_CACHE: dict[str, dict[str, str]] | None = None


@dataclass(frozen=True)
class AssColor:
    r"""ASS color split into BGR and alpha components.

    Style definitions accept ``&HAABBGGRR&``, while override tags require the
    color and alpha to be emitted separately (``\1c`` + ``\1a``).
    """

    bgr: str
    alpha: str = "00"

    @property
    def style_value(self) -> str:
        return f"&H{self.alpha}{self.bgr}&"

    def override_tags(self, channel: int = 1) -> str:
        return f"\\{channel}c&H{self.bgr}&\\{channel}a&H{self.alpha}&"


def load_progress_templates() -> dict[str, dict[str, str]]:
    with PROGRESS_TEMPLATE_FILE.open("r", encoding="utf-8-sig") as fp:
        data = json.load(fp)

    if not isinstance(data, list):
        raise ValueError(f"进度条模板文件格式错误: {PROGRESS_TEMPLATE_FILE}")

    templates: dict[str, dict[str, str]] = {}
    for item in data:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key", "")).strip().lower().replace("_", "-")
        settings = item.get("settings")
        if not key or not isinstance(settings, dict):
            continue
        templates[key] = {str(k): str(v) for k, v in settings.items()}

    if "classic" not in templates:
        raise ValueError(f"进度条模板文件缺少 classic 模板: {PROGRESS_TEMPLATE_FILE}")

    config_root = os.environ.get("VIDEOAUTO_CONFIG_ROOT", "").strip()
    user_file = Path(config_root).joinpath("progress-templates.user.json") if config_root else None
    if user_file and user_file.exists():
        try:
            with user_file.open("r", encoding="utf-8-sig") as fp:
                user_data = json.load(fp)
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            print(f"[警告] 读取用户进度条模板失败，使用默认模板: {exc}")
            user_data = []
        if isinstance(user_data, list):
            for item in user_data:
                if not isinstance(item, dict):
                    continue
                key = str(item.get("key", "")).strip().lower().replace("_", "-")
                settings = item.get("settings")
                if key.startswith("user-") and isinstance(settings, dict):
                    templates[key] = {str(k): str(v) for k, v in settings.items()}

    return templates


def progress_templates() -> dict[str, dict[str, str]]:
    global _PROGRESS_TEMPLATES_CACHE
    if _PROGRESS_TEMPLATES_CACHE is None:
        _PROGRESS_TEMPLATES_CACHE = load_progress_templates()
    return _PROGRESS_TEMPLATES_CACHE


def env_str(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def selected_template() -> dict[str, str]:
    name = env_str("PROGRESS_TEMPLATE", "classic").lower().replace("_", "-")
    templates = progress_templates()
    return templates.get(name) or templates["classic"]


def template_default(name: str, default: str) -> str:
    return selected_template().get(name, default)


def progress_setting(name: str, default: str) -> str:
    return template_default(name, default).strip() or default


def progress_int(name: str, default: int) -> int:
    try:
        return int(progress_setting(name, str(default)))
    except Exception:
        return default


def progress_float(name: str, default: float) -> float:
    try:
        return float(progress_setting(name, str(default)))
    except Exception:
        return default


def parse_ass_color(value: str, default: str) -> AssColor:
    """Read a color from env.

    Supported:
    - ASS format: &H00D7FF& / &HAA000000
    - Web hex: #RRGGBB or RRGGBB, converted to ASS BGR: &HBBGGRR&
    """
    normalized = (value or "").strip()
    if re.fullmatch(r"#?[0-9a-fA-F]{6}", normalized):
        hex_value = normalized.lstrip("#")
        rr, gg, bb = hex_value[0:2], hex_value[2:4], hex_value[4:6]
        return AssColor(bgr=f"{bb}{gg}{rr}".upper())

    match = re.fullmatch(r"&H([0-9a-fA-F]{6}|[0-9a-fA-F]{8})&?", normalized)
    if match:
        digits = match.group(1).upper()
        if len(digits) == 8:
            return AssColor(bgr=digits[2:], alpha=digits[:2])
        return AssColor(bgr=digits)

    if normalized != default:
        return parse_ass_color(default, "&H00FFFFFF&")
    return AssColor(bgr="FFFFFF")


def ass_color(name: str, default: str) -> AssColor:
    return parse_ass_color(progress_setting(name, default), default)


def rect_dialogue(
    layer: int,
    start: str,
    end: str,
    color: AssColor,
    x: float,
    y: float,
    x2: float,
    y2: float,
    extra_tags: str = "",
) -> str:
    return (
        f"Dialogue: {layer},{start},{end},ProgressBox,,0,0,0,,"
        f"{{\\an7\\p1\\bord0\\shad0{color.override_tags()}{extra_tags}\\pos(0,0)}}"
        f"m {x:.0f} {y:.0f} l {x2:.0f} {y:.0f} l {x2:.0f} {y2:.0f} l {x:.0f} {y2:.0f}{{\\p0}}\n"
    )


def write_progress_ass(modules: list[str], current: int, duration: float, output: Path, picture_bounds=None) -> None:
    width, height = canvas_size()
    scale = layout_scale()
    total = max(1, len(modules))
    idx = max(0, min(current - 1, total - 1))
    start = "0:00:00.00"
    end = ass_time(duration)

    # Bottom full-width segmented progress bar.
    # .env can override color/height/font/position. Color supports #RRGGBB or ASS &HBBGGRR&.
    highlight = ass_color("PROGRESS_HIGHLIGHT_COLOR", HIGHLIGHT)
    dark = ass_color("PROGRESS_DARK_COLOR", DARK)
    separator = ass_color("PROGRESS_SEPARATOR_COLOR", SEPARATOR)
    gray_text = ass_color("PROGRESS_TEXT_COLOR", GRAY_TEXT)
    white_text = ass_color("PROGRESS_ACTIVE_TEXT_COLOR", WHITE_TEXT)
    font = env_str("PROGRESS_FONT", "Microsoft YaHei")
    font_size = max(1, scaled_pixels(progress_int("PROGRESS_FONT_SIZE", 30)))
    outline_color = ass_color("PROGRESS_TEXT_OUTLINE_COLOR", "&H111111&")

    visible_bottom = env_float("PROGRESS_VIDEO_HEIGHT", 1080.0) * scale if width * 9 == height * 16 else float(height)
    bar_x = env_float("PROGRESS_BAR_X", 0.0) * scale
    bar_w = env_float("PROGRESS_BAR_WIDTH", 1920.0) * scale if width * 9 == height * 16 else float(width)
    bar_h = progress_float("PROGRESS_BAR_HEIGHT", 76) * scale
    bottom_margin = progress_float("PROGRESS_BOTTOM_MARGIN", 0) * scale
    if picture_bounds is not None:
        picture_x, picture_y, picture_w, picture_h = picture_bounds
        bar_x, bar_w = picture_x, picture_w
        visible_bottom = picture_y + picture_h
        bottom_margin = 0
        bar_h = min(bar_h, picture_h)
    bar_y = visible_bottom - bottom_margin - bar_h
    gap = env_float("PROGRESS_SEGMENT_GAP", 0.0) * scale
    seg_w = (bar_w - gap * (total - 1)) / total
    label_y = bar_y + (visible_bottom - bottom_margin - bar_y) / 2 + env_float("PROGRESS_TEXT_Y_OFFSET", 2.0) * scale
    ms = max(1, int(duration * 1000))
    labels = [clean_label(modules[i] if i < len(modules) else "", i + 1) for i in range(total)]
    # Fit the actual font in each segment. All text survives layout; when the
    # overview would require unreadably small type, show the current chapter
    # over the full bar and keep the segmented timeline underneath it.
    label_width = max(1.0, (seg_w - 16 * scale) * 0.94)
    layouts = [fit_label(label, label_width, max(1, bar_h - 4 * scale), font, font_size, max(scaled_pixels(12), round(font_size * 0.72)))
               for label in labels]
    current_only = any(layout is None for layout in layouts)
    segment_y = bar_y + max(0, bar_h - 6 * scale) if current_only else bar_y

    ass = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ProgressBox,Microsoft YaHei,1,&H00FFFFFF,&H00FFFFFF,&H00111111,&HAA000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: ProgressText,{font},{font_size},{gray_text.style_value},&H00FFFFFF,{outline_color.style_value},&HAA000000,1,0,0,0,100,100,0,0,1,{scaled_pixels(2)},0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    if current_only:
        ass += rect_dialogue(0, start, end, dark, bar_x, bar_y, bar_x + bar_w, bar_y + bar_h)

    for i in range(total):
        x = bar_x + i * (seg_w + gap)
        x2 = x + seg_w
        y2 = bar_y + bar_h
        layout = layouts[i]
        label = "\n".join(layout[0]) if layout is not None else labels[i]
        size_tag = f"\\fs{layout[1]}" if layout is not None else ""
        cx = x + seg_w / 2

        # Base dark segment.
        ass += rect_dialogue(0, start, end, dark, x, segment_y, x2, y2)

        # Separator.
        if i > 0:
            ass += rect_dialogue(3, start, end, separator, x - scale, segment_y, x + scale, y2)

        # Played segments are fully highlighted; current segment is animated.
        if i < idx:
            ass += rect_dialogue(1, start, end, highlight, x, segment_y, x2, y2)
        elif i == idx:
            extra = f"\\clip({x:.0f},{bar_y:.0f},{x:.0f},{y2:.0f})\\t(0,{ms},\\clip({x:.0f},{bar_y:.0f},{x2:.0f},{y2:.0f}))"
            ass += rect_dialogue(1, start, end, highlight, x, segment_y, x2, y2, extra_tags=extra)

        if current_only:
            continue

        # Text: played = active text color; current/future = normal text color by default.
        if i < idx:
            base_color, base_bold = white_text, "1"
        else:
            base_color, base_bold = gray_text, "1"
        ass += (
            f"Dialogue: 4,{start},{end},ProgressText,,0,0,0,,"
            f"{{\\an5{size_tag}\\pos({cx:.0f},{label_y:.0f}){base_color.override_tags()}\\b{base_bold}\\bord{scaled_pixels(2)}}}"
            f"{escape_ass(label)}\n"
        )

        # Current text active-color overlay, clipped by current progress.
        if i == idx:
            ass += (
                f"Dialogue: 5,{start},{end},ProgressText,,0,0,0,,"
                f"{{\\an5{size_tag}\\pos({cx:.0f},{label_y:.0f}){white_text.override_tags()}\\b1\\bord{scaled_pixels(1)}{outline_color.override_tags(3)}"
                f"\\clip({x:.0f},{bar_y:.0f},{x:.0f},{y2:.0f})"
                f"\\t(0,{ms},\\clip({x:.0f},{bar_y:.0f},{x2:.0f},{y2:.0f}))}}"
                f"{escape_ass(label)}\n"
            )

    if current_only:
        available_height = max(1, segment_y - bar_y - 2 * scale)
        size = max(1, min(font_size, int(available_height / 1.35)))
        available_width = max(1, (bar_w - 24 * scale) * 0.94)
        full_label = f"{idx + 1} / {total} · {labels[idx]}"
        lines = wrap_text_pixels(full_label, available_width, font, size)
        max_lines = max(1, int(available_height / (size * 1.35)))
        pages = [lines[i:i + max_lines] for i in range(0, len(lines), max_lines)]
        for page_index, page in enumerate(pages):
            fitted_size = size
            while fitted_size > 1 and any(text_width(line, font, fitted_size) > available_width for line in page):
                fitted_size -= 1
            page_start = ass_time(duration * page_index / len(pages))
            page_end = ass_time(duration * (page_index + 1) / len(pages))
            ass += (
                f"Dialogue: 4,{page_start},{page_end},ProgressText,,0,0,0,,"
                f"{{\\an5\\fs{fitted_size}\\pos({bar_x + bar_w / 2:.0f},{bar_y + available_height / 2:.0f})"
                f"{white_text.override_tags()}\\b1\\bord{scaled_pixels(1)}}}{escape_ass(chr(10).join(page))}\n"
            )

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(ass, encoding="utf-8")


def main():
    load_dotenv()
    ap = argparse.ArgumentParser(description="Generate ASS segmented module progress bar")
    ap.add_argument("--modules", required=True, help="module labels separated by |")
    ap.add_argument("--current", type=int, default=1, help="1-based current module")
    ap.add_argument("--duration", type=float, default=10)
    ap.add_argument("--output", "-o", default="progress.ass")
    args = ap.parse_args()
    modules = [m.strip() for m in args.modules.split("|") if m.strip()]
    write_progress_ass(modules, args.current, args.duration, Path(args.output))
    print(f"progress ass saved: {args.output}")


if __name__ == "__main__":
    main()
