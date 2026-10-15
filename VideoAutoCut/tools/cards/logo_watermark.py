#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ass_header, default_times, read_plan, rect, text, write_ass


def render(plan: dict) -> str:
    start, end = default_times(plan)
    logo_text = str(plan.get("logo_text") or plan.get("title") or plan.get("text") or "VideoAuto").strip()
    body = ass_header()
    body += rect(30, start, end, 1510, 56, 1840, 118, "&HBB111111", fade=(300,300))
    body += text(31, start, end, 1535, 72, logo_text, "CardSmall", size=32, color="&H00FFFFFF", fade=(300,300))
    return body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    write_ass(args.output, render(read_plan(args.input)))

if __name__ == "__main__":
    main()
