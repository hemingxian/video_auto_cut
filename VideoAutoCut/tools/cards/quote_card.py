#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ass_header, default_times, read_plan, rect, split_lines, text, write_ass


def render(plan: dict) -> str:
    start, end = default_times(plan)
    quote = str(plan.get("quote") or plan.get("text") or plan.get("content") or "").strip()
    author = str(plan.get("author") or plan.get("subtitle") or "").strip()
    body = ass_header()
    body += rect(8, start, end, 0, 0, 1920, 1080, "&HCC000000")
    body += text(20, start, end, 380, 350, "“", "CardTitle", size=110, color="&H003A7BFF")
    lines = split_lines(quote, max_chars=18, max_lines=3)
    base_y = 390 - (len(lines)-1)*42
    for i, line in enumerate(lines):
        body += text(21, start, end, 480, base_y + i*82, line, "CardTitle", size=62)
    if author:
        body += text(21, start + 0.1, end, 500, base_y + len(lines)*82 + 30, f"— {author}", "CardSmall", size=34)
    return body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    write_ass(args.output, render(read_plan(args.input)))

if __name__ == "__main__":
    main()
