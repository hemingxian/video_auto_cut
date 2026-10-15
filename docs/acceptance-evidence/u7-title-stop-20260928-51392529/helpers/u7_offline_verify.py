#!/usr/bin/env python3
"""Offline U7 receipt verifier. Reads artifacts only; never imports product code."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


XLSX_SHA = "32928ce140c3d8b25ad0b5ac482896b3698417f7de8401920c9129c3b030697e"
ORACLE_SHA = "e8d132ead6801bf7b6ecda1ec1bd5169695a9969c281ea4b810353cc03d72cf0"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def text_sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def lines(path: Path) -> list[str]:
    return path.read_bytes().decode("utf-8", errors="strict").splitlines()


def positions(rows: list[str], pattern: str) -> list[int]:
    regex = re.compile(pattern)
    return [index for index, row in enumerate(rows, 1) if regex.search(row)]


def text_language(text: str) -> str:
    han = len(re.findall(r"[\u3400-\u9fff]", text or ""))
    words = len(re.findall(r"[A-Za-z]+(?:['’-][A-Za-z]+)*", text or ""))
    if han and han >= words:
        return "zh"
    if words:
        return "en"
    return ""


def label_matches(label: str, language: str, context: str) -> bool:
    if not label.strip():
        return False
    if not language:
        return True
    if language == "zh":
        if re.search(r"[\u3400-\u9fff]", label):
            return True
        return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/+\-]*", label)
                    and label in context and (label.isupper() or any(c.isdigit() for c in label)))
    return bool(re.search(r"[A-Za-z]", label) and not re.search(r"[\u3400-\u9fff]", label))


def clean_label(text: str, index: int) -> str:
    """Frozen equivalent of common.clean_label; avoids importing product code."""
    value = (text or "").strip()
    if not value:
        return f"模块{index}"
    for sep in ("：", ":"):
        if sep in value:
            prefix, rest = value.split(sep, 1)
            if len(prefix) <= 12:
                value = rest.strip()
            break
    for sep in ("，", ",", "；", ";", "。"):
        if sep in value:
            value = value.split(sep, 1)[0].strip()
            break
    return value or f"模块{index}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", required=True, type=Path)
    parser.add_argument("--shots", required=True, type=Path)
    parser.add_argument("--stdout", required=True, type=Path)
    parser.add_argument("--stderr", required=True, type=Path)
    parser.add_argument("--metadata", required=True, type=Path, action="append")
    parser.add_argument("--oracle", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    errors: list[str] = []
    gaps: list[str] = []
    if sha256(args.xlsx) != XLSX_SHA:
        errors.append("frozen XLSX SHA differs")
    if sha256(args.oracle) != ORACLE_SHA:
        errors.append("frozen authored-field oracle SHA differs")

    root = json.loads(args.shots.read_text(encoding="utf-8"))
    shots = root if isinstance(root, list) else root.get("shots", [])
    oracle = json.loads(args.oracle.read_text(encoding="utf-8"))
    if len(shots) != 7:
        errors.append(f"final shot count is {len(shots)}, expected 7")

    expected_rows = oracle.get("rows", [])
    oracle_order = [row.get("shot") for row in expected_rows if isinstance(row, dict)]
    if len(expected_rows) != 7 or oracle_order != list(range(1, 8)):
        errors.append(f"oracle rows/order invalid: {oracle_order}")
        expected_rows = []

    field_checks = []
    for expected_row, actual in zip(expected_rows, shots):
        shot_no = expected_row["shot"]
        item = {"shot": shot_no, "fields": {}, "explicit_show": {}}
        for field, expected in expected_row["fields"].items():
            value = actual.get(field)
            present = value not in (None, "")
            actual_text = "" if value is None else str(value)
            exact = present == expected["present"] and (
                not expected["present"] or text_sha(actual_text) == expected["expected_sha256"]
            )
            item["fields"][field] = {
                "expected_authored": expected["authored"],
                "expected_present": expected["present"],
                "actual_present": present,
                "actual_len": len(actual_text),
                "actual_sha256": text_sha(actual_text) if present else None,
                "exact": exact,
            }
            if not exact:
                errors.append(f"shot {shot_no} {field} differs from frozen authored oracle")
        for key in ("show", "show_card", "card_show"):
            if key in actual:
                item["explicit_show"][key] = actual[key]
        if not item["explicit_show"]:
            item["show_inference"] = {
                "source": "card_content_presence_only",
                "expected": expected_row["fields"]["card_content"]["present"],
                "direct_show_field_observed": False,
            }
        field_checks.append(item)

    contexts = [str(shot.get("subtitle") or shot.get("voice_text") or "").strip() for shot in shots]
    overall = text_language(" ".join(contexts))
    label_choices = []
    label_zero_proven = True
    for index, (shot, context) in enumerate(zip(shots, contexts), 1):
        language = text_language(context) or overall
        title = str(shot.get("title") or "").strip()
        cleaned_title = clean_label(title, index)
        title_sufficient = label_matches(cleaned_title, language, context)
        excluded_without_candidate = not context or not language
        pending_excluded = title_sufficient or excluded_without_candidate
        if not pending_excluded:
            label_zero_proven = False
        label_choices.append({
            "shot": index, "context_source": "subtitle" if shot.get("subtitle") else "voice_text",
            "language": language, "context_present": bool(context),
            "title_sha256": text_sha(title) if title else None,
            "cleaned_title_sha256": text_sha(cleaned_title),
            "title_sufficient_for_language": title_sufficient,
            "excluded_because_context_or_language_empty": excluded_without_candidate,
            "pending_excluded_without_using_final_module_label": pending_excluded,
        })
    predicate_status = "proven_zero" if label_zero_proven else "unknown"
    if not label_zero_proven:
        gaps.append("final module_label cannot reconstruct pre-review state; frozen title/context do not prove label pending=0")

    stdout_rows = lines(args.stdout)
    stderr_rows = lines(args.stderr)
    marker_patterns = {
        "upload_start": r"AI 上传脚本文件:",
        "upload_complete": r"AI 脚本文件上传完成:",
        "main_parse_start": r"AI 解析脚本文件:",
        "voice_review_start": r"AI 复核口播字幕:",
        "voice_review_complete": r"AI 口播字幕复核完成:",
        "normalize_complete": r"AI 脚本规范化完成:",
        "retry": r"\[警告\].*重试\s+\d+/\d+",
        "label_review_warning": r"章节标签复核失败|部分章节标签未通过语言复核",
    }
    markers = {name: positions(stdout_rows, pattern) for name, pattern in marker_patterns.items()}
    stderr_retry_positions = positions(stderr_rows, marker_patterns["retry"])
    if len(markers["upload_start"]) != 1 or len(markers["main_parse_start"]) != 1:
        errors.append("raw stdout does not prove exactly one upload/main parse workflow")
    if not markers["normalize_complete"]:
        errors.append("raw stdout lacks normalization completion")
    voice_start_count = len(markers["voice_review_start"])
    voice_complete_count = len(markers["voice_review_complete"])
    if voice_start_count == 1 and voice_complete_count == 1:
        voice_logical_calls = 1
        voice_evidence = "paired-workflow-markers"
    elif voice_start_count == 0 and voice_complete_count == 0 and markers["normalize_complete"]:
        voice_logical_calls = 0
        voice_evidence = "source-control-flow-derived: review call is always preceded by start marker"
    else:
        voice_logical_calls = None
        voice_evidence = "unknown"
        gaps.append(f"voice/subtitle review marker mismatch start={voice_start_count} complete={voice_complete_count}")
    if voice_start_count > 1 or voice_complete_count > 1:
        errors.append("voice/subtitle review workflow markers occur more than once")

    # Raw stdout does not emit a universal successful request-start line from
    # common.call_qwen. Counts below distinguish workflow evidence from HTTP attempts.
    purpose_counts = {
        "main_parse": {"logical_calls": 1 if len(markers["main_parse_start"]) == 1 else None,
                       "evidence": "workflow-marker-observed"},
        "voice_subtitle_review": {"logical_calls": voice_logical_calls,
                                  "start_marker_count": voice_start_count,
                                  "completion_marker_count": voice_complete_count,
                                  "evidence": voice_evidence},
        "progress_label_review": {"logical_calls": 0 if label_zero_proven else None,
                                  "evidence": "frozen-cleaned-title-and-actual-context-source-derived" if label_zero_proven else "unknown"},
        "automatic_retry_warnings": {
            "count": len(markers["retry"]) + len(stderr_retry_positions),
            "stdout_line_positions": markers["retry"],
            "stderr_line_positions": stderr_retry_positions,
        },
    }
    if markers["retry"] or stderr_retry_positions:
        gaps.append("retry warnings require local raw-line context attribution by purpose; helper does not guess")

    metadata = [{"path": str(path), "sha256": sha256(path), "bytes": path.stat().st_size}
                for path in args.metadata]
    receipt = {
        "ok": not errors,
        "kind": "u7-offline-actual-verification",
        "inputs": {
            "xlsx_sha256": sha256(args.xlsx), "shots_sha256": sha256(args.shots),
            "stdout_sha256": sha256(args.stdout), "stderr_sha256": sha256(args.stderr),
            "stdout_bytes": args.stdout.stat().st_size, "stderr_bytes": args.stderr.stat().st_size,
            "metadata": metadata,
        },
        "stream_line_counts": {"stdout": len(stdout_rows), "stderr": len(stderr_rows)},
        "marker_line_positions": markers,
        "stderr_retry_line_positions": stderr_retry_positions,
        "purpose_counts": purpose_counts,
        "field_checks": field_checks,
        "progress_label_source_predicate": {"status": predicate_status, "proven_pending_count": 0 if label_zero_proven else None, "choices": label_choices},
        "evidence_gaps": gaps,
        "errors": errors,
        "notes": [
            "Missing log markers are not converted to zero calls.",
            "No model is called and no product module is imported by this verifier.",
            "Legacy drawer visual comparison remains native-UI evidence outside this receipt.",
        ],
    }
    args.out.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if not errors else 2


if __name__ == "__main__":
    raise SystemExit(main())
