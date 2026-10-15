#!/usr/bin/env python3
"""验收辅助（只读）：真实 v2A xlsx 原始单元格 vs 导入得到的 shots.json，逐镜逐字核对。

用法：python docs\\acceptance-tools\\check_v2a_shots.py <v2A.xlsx> <shots.json 或 normalized_script_shots.json>

expected 一侧**独立实现**，不调用 `script_card_fields`：只用读取层 `script_tabular.read_workbook` 取
「分镜脚本」sheet 第 1 行表头下的原始 `屏字/大字` / `原创图层` 单元格，CRLF/CR 统一成 LF、去首尾空白，
每行行首的白名单版式标签（大字/副行/小字/参数卡/决策树，可连写、可包 markdown 粗体）剥掉；
不折叠空白、不经 collect_blocks。期望版式按用户 2026-09-23 口径独立推出。
退出码：任何一镜不一致为 1。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "VideoAutoCut" / "tools"))
import script_tabular  # noqa: E402

LABELS = ("大字", "副行", "小字", "参数卡", "决策树")
HEAD = re.compile(r"^[ \t　]*(?:(?:\*\*|__)[ \t　]*)?(" + "|".join(LABELS)
                  + r")[ \t　]*(?:(?:\*\*|__)[ \t　]*)?[:：][ \t　]*")


def split(line: str):
    first, rest = None, line
    while (m := HEAD.match(rest)):
        first = first or m.group(1)
        rest = rest[m.end():]
    if first is None:
        return None, line
    rest = rest.strip()
    for mark in ("**", "__"):
        while rest.startswith(mark):
            rest = rest[2:].lstrip()
        while rest.endswith(mark):
            rest = rest[:-2].rstrip()
    return first, rest


def main() -> int:
    xlsx, shots_path = Path(sys.argv[1]), Path(sys.argv[2])
    grid = dict(script_tabular.read_workbook(xlsx))["分镜脚本"]
    header = [c.strip() for c in grid[0]]
    ci, hi = header.index("屏字/大字"), header.index("原创图层")
    rows = [r for r in grid[1:] if r and r[0].strip()]
    shots = json.loads(shots_path.read_text(encoding="utf-8-sig"))["shots"]
    bad = 0
    print(f"shots={len(shots)} rows={len(rows)}")
    if len(shots) != len(rows):
        print("镜数不一致")
        return 1
    for index, (row, shot) in enumerate(zip(rows, shots), 1):
        raw = re.sub(r"\r\n?", "\n", row[ci]).strip()
        pairs = [split(line) for line in raw.split("\n")]
        card = "\n".join(text for _label, text in pairs).strip()
        labels = [label for label, text in pairs if text.strip()]
        layout = None
        if len(labels) >= 2 and any(labels):
            if labels[0] in ("大字", None) and all(l in ("副行", "小字") for l in labels[1:]):
                layout = "headline_sub"
            elif all(l == "大字" for l in labels) or labels[0] in ("参数卡", "决策树"):
                layout = "equal_lines"
        hint = re.sub(r"\r\n?", "\n", row[hi]).strip()
        got_card, got_hint = shot.get("card_content"), shot.get("card_hint")
        got_layout = shot.get("card_layout")
        ok = (got_card == (card or None) and got_hint == (hint or None) and got_layout == layout)
        bad += not ok
        print(f"分镜 {index}: card {'OK' if got_card == (card or None) else 'DIFF'} | "
              f"hint {'OK' if got_hint == (hint or None) else 'DIFF'} | "
              f"card_layout 期望={layout} 实际={got_layout} {'OK' if got_layout == layout else 'DIFF'}")
        if not ok:
            print("   expected card:", json.dumps(card, ensure_ascii=False))
            print("   actual   card:", json.dumps(got_card, ensure_ascii=False))
    print(f"RESULT mismatches={bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
