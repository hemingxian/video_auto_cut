#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ass_header, default_times, read_plan, rect, text, write_ass


def render(plan: dict) -> str:
    start, end = default_times(plan)
    name = str(plan.get("name") or plan.get("title") or plan.get("text") or "").strip()
    role = str(plan.get("role") or plan.get("subtitle") or "").strip()
    body = ass_header()
    body += rect(10, start, end, 115, 725, 920, 875, "&HAA111111")
    body += rect(11, start, end, 115, 725, 920, 738, "&H000078FF")
    body += text(20, start, end, 155, 755, name, "CardTitle", size=54, extra="\\move(120,755,155,755,0,280)")
    if role:
        body += text(20, start + 0.08, end, 155, 820, role, "CardSmall", size=34)
    return body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    write_ass(args.output, render(read_plan(args.input)))

if __name__ == "__main__":
    main()
