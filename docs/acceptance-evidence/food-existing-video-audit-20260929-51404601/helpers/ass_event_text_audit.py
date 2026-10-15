#!/usr/bin/env python3
"""Read-only ASS text audit for Mac instruction 51404601.

No text normalization is performed.  Events sharing the same interval/layer are
physical lines; they are ordered by ASS \\pos y and then source line.  Unequal
overlaps and ambiguous alignments never pass.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

TRAILING_PUNCT = frozenset("、，,。！？!?；;：:.…")
POS_RE = re.compile(r"\\pos\(\s*[-+]?\d+(?:\.\d+)?\s*,\s*([-+]?\d+(?:\.\d+)?)\s*\)", re.I)


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ass_time(value: str) -> float:
    match = re.fullmatch(r"(\d+):(\d+):(\d+(?:\.\d+)?)", value.strip())
    if not match:
        raise ValueError(f"invalid ASS time {value!r}")
    return int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])


def visible(raw: str) -> str:
    return re.sub(r"\{[^}]*\}", "", raw).replace(r"\N", "\n").replace(r"\n", "\n").replace(r"\h", " ")


def pos_y(raw: str):
    match = POS_RE.search(raw)
    return float(match[1]) if match else None


def parse_ass(path: Path, style: str):
    events, errors = [], []
    for line_no, line in enumerate(path.read_text(encoding="utf-8-sig", errors="strict").splitlines(), 1):
        if not line.startswith("Dialogue:"):
            continue
        fields = line[len("Dialogue:"):].lstrip().split(",", 9)
        if len(fields) != 10:
            errors.append({"line": line_no, "error": f"malformed Dialogue field count: {len(fields)}"})
            continue
        if fields[3].strip() != style:
            continue
        try:
            start, end = ass_time(fields[1]), ass_time(fields[2])
        except ValueError as exc:
            errors.append({"line": line_no, "error": str(exc)})
            continue
        events.append({
            "line": line_no, "layer": fields[0].strip(), "start": start, "end": end,
            "raw": fields[9], "visible": visible(fields[9]), "pos_y": pos_y(fields[9]),
        })
    return events, errors


def order_and_group(events):
    groups = {}
    for event in events:
        groups.setdefault((event["start"], event["end"], event["layer"]), []).append(event)
    ordered, group_rows = [], []
    for key in sorted(groups, key=lambda item: (item[0], item[1], item[2])):
        members = groups[key]
        if len(members) > 1 and any(item["pos_y"] is None for item in members):
            return [], [], [f"same-time group {key} lacks pos y for deterministic physical-line order"]
        ys = [item["pos_y"] for item in members]
        if len(members) > 1 and len(set(ys)) != len(ys):
            return [], [], [f"same-time group {key} has duplicate pos y values"]
        members.sort(key=lambda item: ((item["pos_y"] if item["pos_y"] is not None else 0.0), item["line"]))
        for physical_line_index, item in enumerate(members):
            item["group_key"] = [key[0], key[1], key[2]]
            item["physical_line_index"] = physical_line_index
            item["physical_line_count"] = len(members)
        group_rows.append({"start": key[0], "end": key[1], "layer": key[2], "physical_lines": [item["line"] for item in members], "pos_y": [item["pos_y"] for item in members]})
        ordered.extend(members)
    overlap_errors = []
    sorted_groups = sorted(group_rows, key=lambda item: (item["start"], item["end"], item["layer"]))
    for previous, current in zip(sorted_groups, sorted_groups[1:]):
        if current["start"] < previous["end"] and (current["start"], current["end"]) != (previous["start"], previous["end"]):
            overlap_errors.append(f"unequal event groups overlap: {previous['start']}-{previous['end']} vs {current['start']}-{current['end']}")
    return ordered, group_rows, overlap_errors


def trailing_skippable(char: str, physical_line_boundary: bool) -> bool:
    # At a physical auto-wrap seam, whitespace is governed exclusively by the
    # explicit zero-or-one U+0020/hard-LF rule.  At a temporal event tail, the
    # instruction's \s allowance applies exactly as authored.
    return char in TRAILING_PUNCT or (char.isspace() and not physical_line_boundary)


def match_expected(expected: str, events):
    """Exact matcher with only the two allowances in instruction 51404601."""
    states = {(0, tuple())}
    for event_index, event in enumerate(events):
        for char in event["visible"]:
            next_states = set()
            for pos, trace in states:
                if pos < len(expected) and expected[pos] == char:
                    next_states.add((pos + 1, trace))
            states = next_states
        next_states = set()
        has_next = event_index + 1 < len(events)
        physical_next = has_next and event["group_key"] == events[event_index + 1]["group_key"]
        for pos, trace in states:
            cursor = pos
            next_states.add((cursor, trace + ((event_index, "tail_zero", pos, cursor),)))
            while cursor < len(expected) and trailing_skippable(expected[cursor], physical_next):
                cursor += 1
                next_states.add((cursor, trace + ((event_index, "tail_allowed", pos, cursor),)))
        states = next_states
        if has_next and physical_next:
            seam_states = set()
            for pos, trace in states:
                # Authored hard LF is consumed only as an actual event seam.
                if pos < len(expected) and expected[pos] == "\n":
                    seam_states.add((pos + 1, trace + ((event_index, "hard_lf", pos, pos + 1),)))
                else:
                    seam_states.add((pos, trace + ((event_index, "soft_zero", pos, pos),)))
                    if pos < len(expected) and expected[pos] == " ":
                        seam_states.add((pos + 1, trace + ((event_index, "soft_u0020", pos, pos + 1),)))
            states = seam_states
    solutions = []
    for pos, trace in states:
        if pos == len(expected) and trace not in solutions:
            solutions.append(trace)
    return {
        "match": len(solutions) == 1,
        "ambiguous": len(solutions) > 1,
        "solution_count": len(solutions),
        "trace": [{"event_index": x[0], "kind": x[1], "expected_start": x[2], "expected_end": x[3], "expected_text": expected[x[2]:x[3]]} for x in solutions[0]] if len(solutions) == 1 else [],
    }


def expected_subtitles(oracle):
    result = {}
    for row in oracle["rows"]:
        checks = {item["field"]: item["expected"] for item in row["checks"]}
        result[int(row["shot"])] = checks["subtitle"]
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ass-dir", type=Path, required=True)
    parser.add_argument("--run-shots", type=Path, required=True)
    parser.add_argument("--oracle", type=Path, required=True)
    parser.add_argument("--oracle-sha256", required=True)
    parser.add_argument("--xlsx", type=Path, required=True)
    parser.add_argument("--xlsx-sha256", required=True)
    parser.add_argument("--duration-receipt", type=Path, required=True)
    parser.add_argument("--time-tolerance", type=float, default=0.06)
    parser.add_argument("--style", default="Subtitle")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    oracle, run_shots = load(args.oracle), load(args.run_shots)
    duration_receipt = load(args.duration_receipt)
    source_errors = []
    if sha256(args.xlsx) != args.xlsx_sha256:
        source_errors.append("xlsx hash differs from frozen source")
    if oracle.get("xlsx_sha256") != args.xlsx_sha256:
        source_errors.append("oracle xlsx hash differs from frozen source")
    if sha256(args.oracle) != args.oracle_sha256:
        source_errors.append("oracle byte hash differs from locked source")
    if duration_receipt.get("schema") != "food-media-51404601/v1":
        source_errors.append("unexpected duration receipt schema")
    duration_rows = duration_receipt.get("clips", [])
    durations = {int(item["shot"]): float(item["duration"]) for item in duration_rows if "shot" in item and "duration" in item}
    if sorted(durations) != list(range(1, 10)):
        source_errors.append("duration receipt must map shots 1..9 exactly once")
    expected = expected_subtitles(oracle)
    oracle_ids = {int(row["shot"]): row["shot_id"] for row in oracle.get("rows", [])}
    run_ids = {index: shot.get("shot_id") for index, shot in enumerate(run_shots.get("shots", []), 1)}
    if run_ids != oracle_ids:
        source_errors.append("run shots order/shot_id differs from locked oracle")
    ass_by_shot = {}
    for path in args.ass_dir.glob("*.ass"):
        match = re.match(r"^(\d{4})_final_.*\.ass$", path.name)
        if not match:
            source_errors.append(f"unexpected ASS filename: {path.name}")
            continue
        shot_no = int(match[1])
        if shot_no in ass_by_shot:
            source_errors.append(f"duplicate ASS prefix for shot {shot_no}")
        ass_by_shot[shot_no] = path
    if sorted(ass_by_shot) != list(range(1, 10)):
        source_errors.append(f"ASS prefixes must map exactly to 0001..0009; found {sorted(ass_by_shot)}")
    audits = []
    halted = bool(source_errors)
    for shot_no in range(1, 10):
        if halted:
            audits.append({"shot": shot_no, "status": "not_run", "pass": False, "reason": "earlier source or shot audit failure"})
            continue
        ass_path = ass_by_shot.get(shot_no)
        if ass_path is None:
            continue
        events, parse_errors = parse_ass(ass_path, args.style)
        ordered, groups, ordering_errors = order_and_group(events)
        duration = durations.get(shot_no)
        time_errors = []
        if duration is None:
            time_errors.append("missing actual clip duration")
        else:
            for event in events:
                if event["start"] < -args.time_tolerance:
                    time_errors.append(f"line {event['line']} starts before local zero")
                if event["end"] <= event["start"]:
                    time_errors.append(f"line {event['line']} has non-positive duration")
                if event["end"] > duration + args.time_tolerance:
                    time_errors.append(f"line {event['line']} ends beyond actual clip duration {duration}")
        result = match_expected(str(expected.get(shot_no, "")), ordered) if ordered else {"match": False, "ambiguous": False, "solution_count": 0, "trace": []}
        reasons = list(ordering_errors) + time_errors
        if parse_errors: reasons.append("ASS parse error")
        if not ordered: reasons.append("no deterministically ordered Subtitle events")
        if result["ambiguous"]: reasons.append("multiple valid exact alignments")
        if not result["match"] and not result["ambiguous"]: reasons.append("text mismatch under 51404601 rules")
        audit_row = {
            "shot": shot_no, "shot_id": run_shots["shots"][shot_no - 1].get("shot_id"),
            "ass": str(ass_path.resolve()), "ass_sha256": sha256(ass_path),
            "expected": expected.get(shot_no), "events": ordered, "same_time_groups": groups,
            "actual_clip_duration": duration, "time_tolerance": args.time_tolerance,
            "match": result, "parse_errors": parse_errors, "time_errors": time_errors, "manual_review_reasons": reasons,
            "pass": result["match"] and not reasons,
        }
        audits.append(audit_row)
        if not audit_row["pass"]:
            halted = True
    receipt = {
        "schema": "food-ass-51404601/v1", "instruction": 51404601,
        "rules": [
            "no normalization of internal text, punctuation, case, or spaces",
            "each temporal ASS event tail may omit only characters in \\s、，,。！？!?；;：:.…",
            "a same-time physical-line seam may consume zero or one U+0020; authored LF must align to that seam",
            "same-time/same-layer events are physical lines ordered by pos y then ASS source line",
            "unequal overlaps or multiple text alignments require manual review and never pass",
        ],
        "xlsx": str(args.xlsx.resolve()), "xlsx_sha256": sha256(args.xlsx),
        "oracle": str(args.oracle.resolve()), "oracle_sha256": sha256(args.oracle),
        "run_shots": str(args.run_shots.resolve()), "run_shots_sha256": sha256(args.run_shots),
        "duration_receipt": str(args.duration_receipt.resolve()), "duration_receipt_sha256": sha256(args.duration_receipt),
        "source_errors": source_errors, "shot_audits": audits,
        "ok": not source_errors and len(audits) == 9 and all(item.get("pass") for item in audits),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(args.out)
    return 0 if receipt["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
