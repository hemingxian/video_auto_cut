#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, NamedTuple

# The embedded Python in the runtime package does not add the script directory to
# sys.path (python311._pth); every other tool here does this before importing.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from json_io import atomic_write_json
from progress_labels import ensure_progress_labels
from script_card_fields import (authored_field_value, field_doubt,
                                layout_from_labels, say, script_value,
                                split_layout_label)
from script_spec import (CONVERSION_KEYS, CRITICAL_FILL_COLUMNS, DICTIONARIES, FIELD_KEYS,
                         FORMAT, HEADERS, ISSUE_ACTIONS, NORMAL_FILLS, PRODUCTION_COLUMNS,
                         RED, SHEET_INFO, SHEET_SHOTS, TEXT_COLUMNS, YELLOW, is_placeholder)
from script_tabular import (CellText, SheetDetail, cell_kind, read_selected_sheet_details,
                            read_sheet_fills)
from shot_plan_schema import normalize_shot_plan

class TemplateMatch(NamedTuple):
    version: str
    blocked: list[dict[str, Any]]

def _issue(code: str, message: str, *, shot: int | None = None, cell: str = "",
           column: str = "") -> dict[str, Any]:
    return {"shot": shot, "cell": cell, "column": column, "code": code, "message": message,
            "action": ISSUE_ACTIONS.get(code, "请按提示检查 Excel 原文")}

def _column_name(index: int) -> str:
    out = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        out = chr(65 + rem) + out
    return out

def _cell(row: int, column: int) -> str:
    return f"{_column_name(column)}{row + 1}"

def _sheets(path: Path) -> dict[str, SheetDetail] | None:
    details = read_selected_sheet_details(path, {SHEET_INFO, SHEET_SHOTS})
    return {sheet.name: sheet for sheet in details} if details else None

def _info(sheet: SheetDetail) -> dict[str, str]:
    output = {}
    for row in sheet.grid:
        key = str(row[0]).strip() if row else ""
        value = authored_field_value(row[1]) if len(row) > 1 else ""
        if key and value:
            output[key] = value
    return output

def _detect_impl(path: Path) -> TemplateMatch | None:
    if path.suffix.lower() not in {".xlsx", ".xlsm"}:
        return None
    sheets = _sheets(path)
    if not sheets or SHEET_INFO not in sheets:
        return None
    info = _info(sheets[SHEET_INFO])
    if "模板版本" not in info:
        return None
    version = info["模板版本"]
    if re.fullmatch(r"VAC-SB-\d+", version.strip()) is None:
        return None
    version = version.strip()
    blocked = []
    if version != FORMAT:
        blocked.append(_issue("unsupported_version", f"不支持的模板版本 {version}"))
    shot_sheet = sheets.get(SHEET_SHOTS)
    if shot_sheet is None:
        blocked.append(_issue("missing_sheet", "缺少分镜脚本 sheet"))
    else:
        actual = [str(x).strip() for x in (shot_sheet.grid[0] if shot_sheet.grid else [])]
        for index, expected in enumerate(HEADERS):
            got = actual[index] if index < len(actual) else ""
            if got != expected:
                blocked.append(_issue("header_mismatch", f"第 {index + 1} 列应为「{expected}」，实际「{got}」",
                                      cell=_cell(0, index), column=expected))
    return TemplateMatch(version, blocked)


def detect(path: Path) -> TemplateMatch | None:
    """Recognize a template silently; malformed or unreadable files are non-templates."""
    try:
        return _detect_impl(path)
    except Exception:
        return None

def _dictionary(sheet: SheetDetail | None) -> dict[str, list[str]]:
    if sheet is None or not sheet.grid:
        return {}
    headers = [str(x).strip() for x in sheet.grid[0]]
    result = {header: [] for header in headers if header}
    for row in sheet.grid[1:]:
        for index, header in enumerate(headers):
            value = authored_field_value(row[index]) if index < len(row) else ""
            if header and value:
                result[header].append(value)
    return result

def _duration(raw: object) -> tuple[int | None, str]:
    text = str(raw or "").strip()
    try:
        value = float(text)
    except ValueError:
        return None, text
    if not math.isfinite(value) or value <= 0:
        return None, text
    return int(math.ceil(value)), text

def _warning(review: dict[str, Any], warnings: list[dict[str, Any]], code: str, message: str,
             shot: int, row: int, column: int) -> None:
    item = _issue(code, message, shot=shot, cell=_cell(row, column), column=HEADERS[column])
    item.update(field=FIELD_KEYS.get(column, {2: "title", 8: "voice_text", 9: "subtitle",
                                              10: "card_content", 17: "review"}.get(column, "")),
                level="warn")
    warnings.append(item)
    review.setdefault("warnings", []).append(item)


def build_shot(values: list[object], headers: list[str], number: int, row_index: int,
               duration: int | None, duration_raw: str, review: dict[str, Any],
               warnings: list[dict[str, Any]], warn=_warning) -> dict[str, Any]:
    """Build one standard shot from carrier values without carrier-specific parsing."""
    authored_title = script_value(authored_field_value(values[2]), "title")
    title = authored_title or f"分镜{number}"
    voice = "" if is_placeholder(str(values[8]), "voice_text") else " ".join(str(values[8]).split())
    subtitle_raw = authored_field_value(values[9])
    subtitle = "" if is_placeholder(subtitle_raw, "subtitle") else subtitle_raw
    if subtitle_raw and not subtitle:
        warn(review, warnings, "subtitle_placeholder", "字幕占位按同口播处理", number, row_index, 9)
    raw_card = authored_field_value(values[10])
    retained_card_lines = []
    for line in raw_card.splitlines():
        label, content = split_layout_label(line)
        if is_placeholder(content.strip(), "card_content"):
            continue
        retained_card_lines.append(f"{label}：{content}" if label else content)
    filtered_card = "\n".join(retained_card_lines).strip()
    doubt = field_doubt(filtered_card, "card_content", preserve_layout=True) if filtered_card else None
    card = script_value(filtered_card, "card_content", preserve_layout=True) if filtered_card else ""
    if doubt:
        card = "\n".join(split_layout_label(line)[1] for line in filtered_card.splitlines()).strip()
        warn(review, warnings, "doubtful_value", doubt, number, row_index, 10)
    visual_authored = authored_field_value(values[7])
    visual = visual_authored
    search = authored_field_value(values[14])
    if not visual:
        visual = search or title
        warn(review, warnings, "visual_missing", "画面内容为空，已使用搜索关键词或标题", number, row_index, 7)
    meta: dict[str, Any] = {"v": 1,
                            "source": {"format": FORMAT, "sheet": SHEET_SHOTS, "row": row_index + 1},
                            "script_values": {}}
    mappings = {"segment": 1, "shot_size": 4, "camera_move": 5, "camera_angle": 6,
                "visual_description": 7, "material_source": 12, "material_requirements": 13,
                "search_keywords": 14, "transition": 15, "notes": 16}
    for key, col in mappings.items():
        value = authored_field_value(values[col])
        if value:
            meta[key] = value
    for key, col in (("shot_size", 4), ("camera_move", 5),
                     ("camera_angle", 6), ("transition", 15)):
        value = meta.get(key)
        if value and value not in DICTIONARIES[key]:
            warn(review, warnings, "not_in_dictionary", "值不在模板字典中",
                     number, row_index, col)
    layout = None if doubt or not card else layout_from_labels(filtered_card)
    meta["script_values"] = {
        "title": authored_title or None, "voice_text": voice or None, "subtitle": subtitle or None,
        "card_content": card or None, "card_layout": layout,
        "card_hint": script_value(str(values[11]), "card_hint") or None,
        "visual_description": meta.get("visual_description"), "shot_size": meta.get("shot_size"),
        "camera_move": meta.get("camera_move"), "camera_angle": meta.get("camera_angle"),
        "transition": meta.get("transition"),
    }
    if duration_raw and duration is not None and not float(duration_raw).is_integer():
        meta["duration_raw"] = duration_raw
    if raw_card:
        meta["authored"] = {"card_content": raw_card}
    if review:
        meta["review"] = review
    extras = {headers[i]: authored_field_value(values[i]) for i in range(len(HEADERS), len(headers))
              if headers[i] and i < len(values) and authored_field_value(values[i])}
    if extras:
        meta["extra_columns"] = extras
    shot: dict[str, Any] = {"shot_id": f"template-{number:04d}", "shot": number, "title": title,
                            "duration": duration, "visual_query": visual,
                            "download_query": search or visual_authored,
                            "voice_text": voice or None, "voiceover": bool(voice), "script_meta": meta}
    optional = {"module_label": authored_field_value(values[1]), "subtitle": subtitle,
                "card_content": card, "card_hint": script_value(str(values[11]), "card_hint"),
                "clip_requirements": authored_field_value(values[13])}
    shot.update({k: v for k, v in optional.items() if v})
    if subtitle and " ".join(subtitle.split()) != " ".join(voice.split()):
        shot["render_hints"] = {"caption_source": "subtitle"}
    if layout:
        shot["card_layout"] = layout
    material_source = authored_field_value(values[12])
    if material_source:
        shot["production_notes"] = [f"推荐素材来源：{material_source}"]
    note = authored_field_value(values[16])
    if note:
        shot["extra_requirements"] = [note]
    return shot


def import_template(path: Path, topic: str, match: TemplateMatch | None = None) -> tuple[dict, dict]:
    match = match or detect(path)
    if match is None:
        raise ValueError("不是 VAC-SB 模板")
    sheets = _sheets(path) or {}
    blocked = list(match.blocked)
    warnings: list[dict[str, Any]] = []
    shot_sheet = sheets.get(SHEET_SHOTS)
    info = _info(sheets[SHEET_INFO]) if SHEET_INFO in sheets else {}
    dictionaries = DICTIONARIES
    fills_result = read_sheet_fills(path, SHEET_SHOTS)
    fills = fills_result or {}
    if shot_sheet is not None and fills_result is None:
        blocked.append(_issue("fill_read_error", "无法读取分镜脚本单元格底色"))
    shots = []
    if shot_sheet is not None and not match.blocked:
        headers = [str(x).strip() for x in shot_sheet.grid[0]]
        extra_headers = headers[len(HEADERS):]
        if any(extra_headers):
            warnings.append(_issue("extra_columns", "模板包含作者自加列"))
        expected_number = 1
        for row_index, row in enumerate(shot_sheet.grid[1:], 1):
            values = [row[i] if i < len(row) else "" for i in range(max(len(headers), len(HEADERS)))]
            has_content = any(str(x).strip() or cell_kind(x) in {"formula", "error"}
                              for x in values[:len(HEADERS)])
            if not has_content:
                continue
            raw_number = str(values[0]).strip()
            try:
                number = int(float(raw_number)) if float(raw_number).is_integer() else -1
            except (ValueError, OverflowError):
                number = -1
            if not raw_number:
                blocked.append(_issue("row_without_shot_no", "有内容但镜号为空", cell=_cell(row_index, 0), column=HEADERS[0]))
                number = expected_number
            elif number != expected_number:
                blocked.append(_issue("shot_no_invalid", f"镜号应为 {expected_number}，实际 {raw_number}", shot=number,
                                      cell=_cell(row_index, 0), column=HEADERS[0]))
            expected_number += 1
            duration, duration_raw = _duration(values[3])
            if duration is None:
                blocked.append(_issue("duration_invalid", "时长必须是大于 0 的数字", shot=number,
                                      cell=_cell(row_index, 3), column=HEADERS[3]))
            review: dict[str, Any] = {"status": "", "status_lines": [], "ai_suggested": [],
                                      "confirmed": [], "warnings": [], "acknowledged": []}
            for col in range(len(headers)):
                fill = fills.get((row_index, col), "")
                kind = cell_kind(values[col]) if col < len(values) else ""
                column_label = headers[col] if col < len(headers) and headers[col] else _column_name(col)
                if fill == RED:
                    blocked.append(_issue("red_cell", "红格禁止导入", shot=number,
                                          cell=_cell(row_index, col), column=column_label))
                elif fill == YELLOW:
                    if col in CRITICAL_FILL_COLUMNS:
                        blocked.append(_issue("text_cell_pending", "正文或时长黄格须先在 Excel 核对", shot=number,
                                              cell=_cell(row_index, col), column=HEADERS[col]))
                    elif col in PRODUCTION_COLUMNS:
                        review["ai_suggested"].append(FIELD_KEYS[col])
                        _warning(review, warnings, "ai_suggested", "制作字段为 AI 建议", number, row_index, col)
                elif fill not in NORMAL_FILLS and col in CRITICAL_FILL_COLUMNS:
                    blocked.append(_issue("unexpected_fill", "请清除底色后再导入", shot=number,
                                          cell=_cell(row_index, col), column=column_label))
                elif fill not in NORMAL_FILLS and col in (PRODUCTION_COLUMNS | {17}):
                    _warning(review, warnings, "unknown_fill", f"不认识的底色 {fill}", number, row_index, col)
                if kind and col in TEXT_COLUMNS and (str(values[col]).strip() or kind in {"formula", "error"}):
                    blocked.append(_issue("text_cell_kind", f"正文格类型为 {kind}", shot=number,
                                          cell=_cell(row_index, col), column=HEADERS[col]))
            status_lines = authored_field_value(values[17]).splitlines()
            status = status_lines[0].strip() if status_lines else ""
            review["status"] = status if status in {"已确认", "待确认", "校验失败"} else (
                "作者手写" if not status else "待确认")
            review["status_lines"] = status_lines
            if status == "校验失败":
                blocked.append(_issue("status_failed", "来源/核对状态为校验失败", shot=number,
                                      cell=_cell(row_index, 17), column=HEADERS[17]))
            elif status == "待确认":
                _warning(review, warnings, "status_pending", "来源/核对状态待确认", number, row_index, 17)
            elif status not in {"", "已确认"}:
                _warning(review, warnings, "unknown_status", f"未知状态 {status}", number, row_index, 17)
            notes = [line.strip() for line in status_lines[1:] if line.strip() and
                     not line.strip().startswith(("原文：", "AI建议：", "原文:", "AI建议:"))]
            for note in notes:
                _warning(review, warnings, "status_note", note, number, row_index, 17)
            shots.append(build_shot(values, headers, number, row_index, duration, duration_raw,
                                    review, warnings))
        if shot_sheet.merges:
            for top, left, bottom, right in shot_sheet.merges:
                if bottom >= 1:
                    blocked.append(_issue("merged_cells", "分镜数据区禁止合并单元格", cell=f"{_cell(top,left)}:{_cell(bottom,right)}"))
        for description in shot_sheet.hidden:
            hidden_has_content = False
            hidden_cell = ""
            hidden_column = ""
            hidden_shot: int | None = None
            row_match = re.fullmatch(r"第 (\d+) 行", description)
            col_match = re.fullmatch(r"第 ([A-Z]+) 列", description)
            range_match = re.fullmatch(r"第 (\d+)–(\d+) 列", description)
            if row_match:
                index = int(row_match.group(1)) - 1
                if 1 <= index < len(shot_sheet.grid):
                    for col, value in enumerate(shot_sheet.grid[index]):
                        if str(value).strip() or cell_kind(value) in {"formula", "error"}:
                            hidden_has_content = True
                            hidden_cell = _cell(index, col)
                            hidden_column = headers[col] if col < len(headers) else _column_name(col)
                            try:
                                hidden_shot = int(float(str(shot_sheet.grid[index][0])))
                            except (ValueError, OverflowError, IndexError):
                                pass
                            break
            elif col_match:
                index = 0
                for char in col_match.group(1):
                    index = index * 26 + ord(char) - 64
                index -= 1
                for row_index, row in enumerate(shot_sheet.grid[1:], 1):
                    if index < len(row) and (str(row[index]).strip() or
                                             cell_kind(row[index]) in {"formula", "error"}):
                        hidden_has_content = True
                        hidden_cell = _cell(row_index, index)
                        hidden_column = headers[index] if index < len(headers) else _column_name(index)
                        try:
                            hidden_shot = int(float(str(row[0])))
                        except (ValueError, OverflowError, IndexError):
                            pass
                        break
            elif range_match:
                first, last = int(range_match.group(1)) - 1, int(range_match.group(2)) - 1
                grid_width = max((len(row) for row in shot_sheet.grid), default=0)
                first = max(0, first)
                last = min(last, grid_width - 1)
                for row_index, row in enumerate(shot_sheet.grid[1:], 1):
                    for col in range(first, last + 1):
                        if col < len(row) and (str(row[col]).strip() or
                                               cell_kind(row[col]) in {"formula", "error"}):
                            hidden_has_content = True
                            hidden_cell = _cell(row_index, col)
                            hidden_column = headers[col] if col < len(headers) else _column_name(col)
                            try:
                                hidden_shot = int(float(str(row[0])))
                            except (ValueError, OverflowError, IndexError):
                                pass
                            break
                    if hidden_has_content:
                        break
            else:
                hidden_has_content = True
            if hidden_has_content:
                blocked.append(_issue("hidden_content", f"分镜表含隐藏内容：{description}",
                                      shot=hidden_shot, cell=hidden_cell, column=hidden_column))
    if not shots and not match.blocked:
        blocked.append(_issue("no_shots", "分镜脚本没有可导入的分镜"))
    if "语言" in info and "双语" in info["语言"]:
        warnings.append(_issue("language_multi", "模板要求一个文件只放一种语言"))
    report = {"route": "template", "format": match.version, "file": path.name, "shots": len(shots),
              "blocked": blocked, "warnings": warnings}
    plan = {"schema_version": 2, "task_revision": 0, "topic": topic, "shots": shots,
            "script_source": {"v": 1, "route": "template", "format": match.version,
                              "file_name": path.name,
                              "file_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                              "project_info": dict(info),
                              "conversion": {k: v for k, v in info.items() if k in CONVERSION_KEYS},
                              "dictionaries": DICTIONARIES,
                              "import_summary": {}}}
    original_labels = [shot.get("module_label") for shot in shots]
    ensure_progress_labels(plan, reviewer=None)
    for shot, original in zip(shots, original_labels):
        if original and shot.get("module_label") != original:
            row_index = int(shot["script_meta"]["source"]["row"]) - 1
            _warning(shot["script_meta"]["review"], warnings, "module_label_replaced",
                     "段落不适合作为进度标签，已确定性替换", shot["shot"], row_index, 1)
    plan["script_source"]["import_summary"] = {
        "shots": len(shots), "warnings": len(warnings),
        "shots_with_ai_suggested": sum(
            bool(shot.get("script_meta", {}).get("review", {}).get("ai_suggested")) for shot in shots),
    }
    report["warnings"] = warnings
    return normalize_shot_plan(plan, topic=topic), report

def unexpected_error_report(path: Path, match: TemplateMatch, error: Exception) -> dict[str, Any]:
    """Build a stable blocked report for an unexpected recognized-template failure."""
    return {
        "route": "template",
        "format": match.version,
        "file": path.name,
        "shots": 0,
        "blocked": [_issue("unexpected_error", "模板读取发生意外错误，请检查文件后重试")],
        "warnings": [],
    }

def _event(report: dict, failed: bool) -> None:
    markdown = report.get("carrier") == "markdown"
    label = ((f"标准 Markdown 导入被拦下：{len(report['blocked'])} 处需在文件里处理" if markdown else
              f"标准模板导入被拦下：{len(report['blocked'])} 处需在 Excel 里处理") if failed else
             (f"标准 Markdown 导入：{report['shots']} 镜，{len(report['warnings'])} 条提醒" if markdown else
              f"标准模板导入：{report['shots']} 镜，{len(report['warnings'])} 条提醒"))
    payload = {"kind": "workflow", "workflowStage": "script", "workflowStatus": "failed" if failed else "running",
               "workflowProgress": {"stage": "script", "status": "failed" if failed else "running",
                                    "phase": "template_import", "label": label}, "scriptImport": report}
    print("VACUT_EVENT:" + json.dumps(payload, ensure_ascii=True, separators=(",", ":")))

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", required=True)
    parser.add_argument("--json")
    parser.add_argument("--plan")
    args = parser.parse_args()
    path = Path(args.check)
    match = detect(path)
    if match is None:
        print("not_template")
        return
    plan, report = import_template(path, path.stem, match)
    for item in report["blocked"] + report["warnings"]:
        say(f"[script] 标准模板导入 {item['code']}: {item['cell']} {item['message']}")
    _event(report, bool(report["blocked"]))
    if args.json:
        atomic_write_json(Path(args.json), report)
    if report["blocked"]:
        raise SystemExit(2)
    if args.plan:
        atomic_write_json(Path(args.plan), plan)

if __name__ == "__main__":
    main()
