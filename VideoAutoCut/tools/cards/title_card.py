#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ass_header, default_times, read_plan, rect, text, write_ass


def render(plan: dict) -> str:
    start, end = default_times(plan)
    title = str(plan.get("title") or plan.get("text") or "").strip()
    subtitle = str(plan.get("subtitle") or "").strip()
    x, y = 150, 210
    body = ass_header()
    body += rect(10, start, end, 110, 170, 1040, 360, "&HAA111111")
    body += rect(11, start, end, 110, 170, 128, 360, "&H000078FF")
    body += text(20, start, end, x, y, title, "CardTitle", size=70, extra="\\move(120,210,150,210,0,320)")
    if subtitle:
        body += text(20, start + 0.12, end, x, y + 88, subtitle, "CardText", size=40)
    return body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    write_ass(args.output, render(read_plan(args.input)))

if __name__ == "__main__":
    main()
