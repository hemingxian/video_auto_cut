#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import load_dotenv, load_prompt_template
from json_io import atomic_write_json
from optimize_queries import call_qwen

VALID_TYPES = {"title_card", "bullet_card", "logo_watermark", "lower_third", "quote_card"}


def choose_with_ai(shot: dict) -> dict:
    content = str(shot.get("card_content") or "").strip()
    hint = str(shot.get("card_hint") or "").strip()
    if not content and not hint:
        return {}

    system = load_prompt_template("card_choose.md").strip()
    obj = call_qwen([
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps({
            "shot_title": shot.get("title", ""),
            "duration": shot.get("duration", 4),
            "voice_text": shot.get("voice_text", ""),
            "subtitle": shot.get("subtitle", ""),
            "card_content": content,
            "card_hint": hint,
        }, ensure_ascii=False)},
    ], temperature=0.0)

    card_type = str(obj.get("type") or "")
    if card_type not in VALID_TYPES:
        raise ValueError(f"invalid card type: {card_type}")
    return obj


def main() -> None:
    load_dotenv()
    ap = argparse.ArgumentParser(description="Choose card template with AI")
    ap.add_argument("--shot-json", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    shot = json.loads(Path(args.shot_json).read_text(encoding="utf-8"))
    plan = choose_with_ai(shot)

    out = Path(args.output)
    atomic_write_json(out, plan)
    print(f"card plan: {out}")


if __name__ == "__main__":
    main()
