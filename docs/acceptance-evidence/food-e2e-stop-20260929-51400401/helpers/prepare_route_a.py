#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

FOLDER_ID = "fld_8cedce6439804fc4b4e86332ea9e6e9d"
U3_SUBTITLE = "U3字幕验收：整箱来料排队。"
SHOT8_SUBTITLE = "先备好四样：箱体尺寸和重量、每小时箱数、托盘规格、目标垛型。"
ORACLE_SHA256 = "c2d18ec367ec69017b71cf2f1f3a2f41e8dc9240b509cf37b6f0197f3b6f0948"

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", type=Path, required=True)
    ap.add_argument("--oracle-manifest", type=Path, required=True)
    ap.add_argument("--out-plan", type=Path, required=True)
    ap.add_argument("--out-manifest", type=Path, required=True)
    ap.add_argument("--receipt", type=Path, required=True)
    args = ap.parse_args()

    source = json.loads(args.plan.read_text(encoding="utf-8-sig"))
    oracle = json.loads(args.oracle_manifest.read_text(encoding="utf-8-sig"))
    shots = source.get("shots")
    if not isinstance(shots, list) or len(shots) != 9:
        raise SystemExit("fresh template plan must contain exactly nine shots")
    if source.get("task_revision") != 0:
        raise SystemExit("fresh plan task_revision must be exactly 0")
    if sha256(args.oracle_manifest) != ORACLE_SHA256:
        raise SystemExit("frozen oracle manifest SHA differs")
    if not source.get("script_source") or any(not s.get("script_meta") for s in shots):
        raise SystemExit("template script_source/script_meta missing")
    forbidden = ("voice_audio", "subtitle_cues", "subtitle_cues_file")
    if any(any(k in s for k in forbidden) for s in shots):
        raise SystemExit("fresh plan already contains voice/cue artifacts")
    if shots[7].get("subtitle") != SHOT8_SUBTITLE:
        raise SystemExit("fixture-authored shot-8 subtitle differs")
    if shots[7].get("render_hints", {}).get("caption_source") != "subtitle":
        raise SystemExit("fixture-authored shot-8 caption hint missing")

    edited = copy.deepcopy(source)
    for shot in edited["shots"]:
        shot["download_material"] = False
        shot["material_bindings"] = [{
            "binding_type": "folder", "folder_id": FOLDER_ID,
            "include_subfolders": True,
        }]
    edited["shots"][1]["subtitle"] = U3_SUBTITLE
    edited["shots"][1].setdefault("render_hints", {})["caption_source"] = "subtitle"
    expected = copy.deepcopy(source)
    for shot in expected["shots"]:
        shot["download_material"] = False
        shot["material_bindings"] = [{"binding_type": "folder", "folder_id": FOLDER_ID, "include_subfolders": True}]
    expected["shots"][1]["subtitle"] = U3_SUBTITLE
    expected["shots"][1].setdefault("render_hints", {})["caption_source"] = "subtitle"
    if edited != expected:
        raise SystemExit("edited plan contains a change outside the exact allowlist")

    if edited.get("script_source") != source.get("script_source"):
        raise SystemExit("script_source changed")
    if [s.get("script_meta") for s in edited["shots"]] != [s.get("script_meta") for s in shots]:
        raise SystemExit("script_meta changed")
    if edited["shots"][7].get("subtitle") != shots[7].get("subtitle") or edited["shots"][7].get("render_hints") != shots[7].get("render_hints"):
        raise SystemExit("shot-8 authored fields changed")

    materials = oracle.get("shots", [{}])[0].get("materials")
    if not isinstance(materials, list) or len(materials) != 6:
        raise SystemExit("oracle must expose exactly six material identities")
    if len({m.get("material_id") for m in materials}) != 6 or len({m.get("source_sha256") for m in materials}) != 6:
        raise SystemExit("oracle material identities are not unique")
    material_checks = []
    for material in materials:
        path = Path(material["local_path"])
        actual = sha256(path) if path.is_file() else None
        expected = material.get("source_sha256")
        if actual != expected:
            raise SystemExit(f"material identity mismatch: {material.get('material_id')}")
        material_checks.append({"material_id": material["material_id"], "source_sha256": expected, "same": True})

    shot_ids = [s.get("shot_id") for s in edited["shots"]]
    if any(not isinstance(v, str) or not v for v in shot_ids) or len(set(shot_ids)) != 9:
        raise SystemExit("fresh plan shot_id set invalid")
    run_id = "run_" + uuid.uuid4().hex
    manifest = {
        "schema_version": oracle.get("schema_version", 1),
        "run_id": run_id,
        "task_id": "food_route_a_" + uuid.uuid4().hex,
        "task_revision": 0,
        "resolved_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "shots": [{"shot_id": shot_id, "materials": copy.deepcopy(materials)} for shot_id in shot_ids],
    }
    args.out_plan.parent.mkdir(parents=True, exist_ok=False)
    args.out_plan.write_text(json.dumps(edited, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.out_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    receipt = {
        "ok": True,
        "source_plan": str(args.plan.resolve()),
        "source_plan_sha256": sha256(args.plan),
        "edited_plan_sha256": sha256(args.out_plan),
        "manifest_sha256": sha256(args.out_manifest),
        "run_id": run_id,
        "shots": 9,
        "folder_id": FOLDER_ID,
        "only_authorized_plan_edits": True,
        "shot2_u3_subtitle": U3_SUBTITLE,
        "shot8_preserved": True,
        "script_source_equal": True,
        "script_meta_equal_count": 9,
        "material_checks": material_checks,
    }
    args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
