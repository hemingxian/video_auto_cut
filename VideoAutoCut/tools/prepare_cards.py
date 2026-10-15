#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import load_dotenv
from json_io import atomic_write_json
from shot_plan_schema import normalize_shot_plan

CARD_SCRIPTS = {
    "title_card": "title_card.py",
    "bullet_card": "bullet_card.py",
    "logo_watermark": "logo_watermark.py",
    "lower_third": "lower_third.py",
    "quote_card": "quote_card.py",
}


def run(cmd: list[str]) -> None:
    print(">>>", " ".join(f'"{c}"' if " " in c else c for c in cmd))
    subprocess.run(cmd, check=True)


def has_card_content(shot: dict) -> bool:
    return bool(str(shot.get("card_content") or shot.get("card_hint") or "").strip())


def main() -> None:
    load_dotenv()
    ap = argparse.ArgumentParser(description="Prepare card plans and ASS files for each shot")
    ap.add_argument("--shots-json", required=True)
    ap.add_argument("--cards-dir", required=True)
    args = ap.parse_args()

    root = Path(__file__).resolve().parent
    cards_root = root / "cards"
    choose_script = cards_root / "choose_card.py"
    cards_dir = Path(args.cards_dir)
    cards_dir.mkdir(parents=True, exist_ok=True)
    plan_path = Path(args.shots_json)
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    shots = plan.get("shots") or []

    for idx, shot in enumerate(shots, 1):
        if not isinstance(shot, dict):
            continue
        if not has_card_content(shot):
            shot.pop("card_plan", None)
            shot.pop("card_ass", None)
            continue

        shot_json = cards_dir / f"{idx:04d}_shot.json"
        card_plan = cards_dir / f"{idx:04d}_card_plan.json"
        card_ass = cards_dir / f"{idx:04d}_card.ass"
        atomic_write_json(shot_json, shot)
        run([sys.executable, str(choose_script), "--shot-json", str(shot_json), "--output", str(card_plan)])
        card = json.loads(card_plan.read_text(encoding="utf-8")) if card_plan.exists() else {}
        card_type = str(card.get("type") or "").strip()
        script_name = CARD_SCRIPTS.get(card_type)
        if not script_name:
            raise SystemExit(f"分镜 #{idx:02d} 未生成有效卡片类型")
        run([sys.executable, str(cards_root / script_name), "--input", str(card_plan), "--output", str(card_ass)])
        shot["card_plan"] = str(card_plan)
        shot["card_ass"] = str(card_ass)
        print(f"分镜 #{idx:02d} 卡片: {card_type} -> {card_ass}")

    plan = normalize_shot_plan(plan)
    atomic_write_json(plan_path, plan)
    print(f"已回写卡片计划: {plan_path}")


if __name__ == "__main__":
    main()
