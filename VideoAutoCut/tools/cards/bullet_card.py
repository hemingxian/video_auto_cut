#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ass_header, default_times, read_plan, rect, split_items, text, write_ass


def render(plan: dict) -> str:
    start, end = default_times(plan)
    title = str(plan.get("title") or "核心要点").strip()
    items = split_items(plan.get("items") or plan.get("text") or plan.get("content"))[:5]
    x, y = 1180, 190
    body = ass_header()
    h = 135 + max(1, len(items)) * 62
    body += rect(10, start, end, 1120, 150, 1820, 150 + h, "&HAA111111")
    body += rect(11, start, end, 1120, 150, 1820, 205, "&H003A7BFF")
    body += text(20, start, end, x, y - 26, title, "CardTitle", size=44)
    for i, item in enumerate(items):
        t0 = start + 0.18 + i * 0.18
        yy = y + 55 + i * 62
        body += rect(12, t0, end, x, yy + 8, x + 14, yy + 22, "&H000078FF", fade=(180, 250))
        body += text(21, t0, end, x + 32, yy, item, "CardText", size=38, fade=(180, 250))
    return body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    write_ass(args.output, render(read_plan(args.input)))

if __name__ == "__main__":
    main()
