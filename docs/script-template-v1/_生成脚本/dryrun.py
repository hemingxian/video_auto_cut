# -*- coding: utf-8 -*-
"""用仓库 origin/feature/material-agent-select 的 script_card_fields 做确定性干跑（不调模型/API）。"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import os
# 指向仓库 VideoAutoCut/tools（origin/feature/material-agent-select 的 worktree）
WT = Path(os.environ.get("VAC_TOOLS", Path(__file__).resolve().parent.parent / "wt" / "VideoAutoCut" / "tools"))
sys.path.insert(0, str(WT))
import script_card_fields as scf  # noqa: E402
import script_tabular  # noqa: E402

PLACE = scf.is_placeholder


def expected_card(raw):
    return scf.script_value(raw or "", "card_content", preserve_layout=True)


def plan_from_shots(shots, mode="ideal"):
    """模拟解析器产出的 plan。ideal=完全照原文且剥好标签；buggy=常见错误。"""
    out = []
    for i, s in enumerate(shots, 1):
        voice = s.get("口播") or ""
        sub = s.get("字幕") or voice
        card_raw = s.get("上屏文字") or ""
        hint_raw = s.get("卡片提示") or ""
        shot = {"shot": i, "title": s.get("分镜标题") or f"分镜{i}", "voice_text": voice,
                "subtitle": sub,
                "card_content": expected_card(card_raw),
                "card_hint": "" if PLACE(hint_raw) else hint_raw}
        if mode == "buggy":
            if i == 1:
                shot["card_content"] = card_raw          # 没剥标签
            if i == 2:
                shot["card_content"] = ""                # 丢失
            if i == 3:
                shot["card_content"] = "人工预放一整盘"    # 占位镜臆造
            if i == 4:
                shot["card_hint"] = "flow bar"           # 翻译
        out.append(shot)
    return {"shots": out}


def other_header_rows(path):
    hits = []
    for d in script_tabular.read_workbook_detail(Path(path)) or []:
        for ri, row in enumerate(d.grid):
            if scf.is_field_header_row(row):
                hits.append(f"{d.name}!{ri + 1}")
    return hits


def run(path, shots=None, label=""):
    path = Path(path)
    blocks, status, info = scf.collect_blocks(path)
    res = {"file": path.name, "label": label, "status": status, "tier": scf.tier_of(status),
           "route": info.get("route"), "header_row": info.get("header_row"),
           "roles": info.get("roles"), "uncertain": info.get("uncertain"),
           "sheets": info.get("sheets"), "field_header_rows": other_header_rows(path)}
    if blocks is not None:
        res["blocks"] = [{
            "shot": i,
            "card_content": b["card_content"]["value"],
            "card_layout": b["card_content"].get("layout"),
            "card_reliable": b["card_content"]["reliable"],
            "card_notice": b["card_content"].get("notice"),
            "card_hint": b["card_hint"]["value"],
            "title": b["title"]["value"],
            "anchors": sorted((b.get("anchors") or {}).keys()),
        } for i, b in enumerate(blocks, 1)]
    if shots is not None and blocks is not None:
        for mode in ("ideal", "buggy"):
            plan = plan_from_shots(shots, mode)
            rep = scf.reconcile(plan, path, autofix=True)
            res[f"reconcile_{mode}"] = {
                "status": rep["status"], "tier": rep["tier"], "checked": rep["checked"],
                "corrections": [{k: c[k] for k in ("shot", "field", "kind", "applied")}
                                for c in rep["corrections"]],
                "layouts": rep.get("layouts"),
                "warnings": rep["warnings"],
                "final": [{"shot": s["shot"], "card_content": s.get("card_content", ""),
                           "card_layout": s.get("card_layout"), "card_hint": s.get("card_hint", "")}
                          for s in plan["shots"]],
            }
    return res


if __name__ == "__main__":
    print(json.dumps(run(sys.argv[1]), ensure_ascii=False, indent=1))
