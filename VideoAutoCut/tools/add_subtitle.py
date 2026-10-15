#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import subtitle_events_by_sentence


def write_subtitle_ass(text: str, duration: float, output: Path) -> None:
    ass = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Subtitle,Microsoft YaHei,58,&H00FFFFFF,&H00FFFFFF,&H00121212,&H96000000,1,0,0,0,100,100,0,0,1,3,1,2,140,140,115,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ass += subtitle_events_by_sentence(text, duration, style="Subtitle", layer=2, y=870)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(ass, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description="Generate ASS subtitle file")
    ap.add_argument("--text", default="")
    ap.add_argument("--duration", type=float, default=10)
    ap.add_argument("--output", "-o", default="subtitle.ass")
    args = ap.parse_args()
    write_subtitle_ass(args.text, args.duration, Path(args.output))
    print(f"subtitle ass saved: {args.output}")


if __name__ == "__main__":
    main()
