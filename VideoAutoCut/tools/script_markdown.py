#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path
from typing import Any, NamedTuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

from json_io import atomic_write_json
from progress_labels import ensure_progress_labels
from script_spec import (BODY_FIELD_NAMES, CONVERSION_KEYS, DICTIONARIES, FIELD_KEY_BY_NAME,
                         FIELD_NAMES, FORMAT, HEADERS, PRODUCTION_COLUMNS)
from script_template import (_duration, _issue, build_shot, say)
from shot_plan_schema import normalize_shot_plan


class MarkdownMatch(NamedTuple):
    version: str
    blocked: list[dict[str, Any]]


_FIELD_RE = re.compile(
    r"^-\s+(?:"
    r"\*\*(?P<bold_name>.+?)(?:\s*[：:]\s*\*\*|\*\*\s*[：:])\s*(?P<bold_value>.*)"
    r"|(?P<plain_name>.+?)\s*[：:]\s*(?P<plain_value>.*))$"
)
_SHOT_RE = re.compile(r"^##\s+分镜\s+(\d+)(?:\s*｜.*)?\s*$")
_INFO_RE = re.compile(r"^##\s+项目信息\s*$")
_ALIASES = {"时长（秒）": "时长(秒)"}


def _read(path: Path) -> str:
    data = path.read_bytes()
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            pass
    raise UnicodeDecodeError("utf-8", data, 0, len(data), "不是 UTF-8 或 GB18030 文本")


def _visible_lines(text: str) -> list[tuple[int, str]]:
    output: list[tuple[int, str]] = []
    fenced = False
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if not fenced:
            output.append((number, line))
    return output


def _field(line: str) -> tuple[str, str] | None:
    match = _FIELD_RE.match(line)
    if not match:
        return None
    raw_name = match.group("bold_name") or match.group("plain_name")
    value = match.group("bold_value") if match.group("bold_name") is not None else match.group("plain_value")
    name = _ALIASES.get(raw_name.strip(), raw_name.strip())
    return name, value


def _sections(text: str) -> tuple[dict[str, tuple[str, int]], list[dict[str, Any]], list[dict[str, Any]]]:
    lines = _visible_lines(text)
    info: dict[str, tuple[str, int]] = {}
    shots: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    in_info = False
    index = 0
    while index < len(lines):
        line_no, line = lines[index]
        if _INFO_RE.fullmatch(line):
            in_info, current = True, None
            index += 1
            continue
        shot_match = _SHOT_RE.fullmatch(line)
        if shot_match:
            in_info = False
            raw = shot_match.group(1)
            try:
                number = int(raw)
            except ValueError:
                number = -1
            current = {"number": number, "raw_number": raw, "line": line_no,
                       "fields": {}, "field_lines": {}, "field_value_lines": {}, "extras": {}}
            shots.append(current)
            index += 1
            continue
        if line.startswith("##") and re.match(r"^##\s*分镜", line):
            errors.append(_issue("shot_heading_invalid", "分镜标题应为「## 分镜 N」",
                                 cell=f"第 {line_no} 行", column="镜号"))
            in_info, current = False, None
            index += 1
            continue
        if line.startswith("## "):
            in_info, current = False, None
            index += 1
            continue
        parsed = _field(line)
        if parsed and (in_info or current is not None):
            name, value = parsed
            value_lines = [value] if value else []
            value_line_numbers = [line_no] if value else []
            next_index = index + 1
            if not value:
                while next_index < len(lines):
                    continuation_line, continuation = lines[next_index]
                    if not continuation.strip() or continuation.startswith("##") or continuation.startswith("- "):
                        break
                    if continuation.startswith("  "):
                        value_lines.append(continuation[2:])
                    elif continuation.startswith("\t"):
                        value_lines.append(continuation[1:])
                    else:
                        break
                    value_line_numbers.append(continuation_line)
                    next_index += 1
            joined = "\n".join(value_lines)
            if in_info:
                if name in info:
                    errors.append(_issue("duplicate_field", f"项目信息字段「{name}」重复",
                                         cell=f"第 {line_no} 行", column=name))
                else:
                    info[name] = (joined, line_no)
            else:
                target = current["fields"] if name in FIELD_NAMES[1:] else current["extras"]
                if name in current["fields"] or name in current["extras"]:
                    errors.append(_issue("duplicate_field", f"字段「{name}」重复", shot=current["number"],
                                         cell=f"第 {line_no} 行", column=name))
                else:
                    target[name] = joined
                    current["field_lines"][name] = line_no
                    current["field_value_lines"][name] = value_line_numbers
            index = next_index
            continue
        index += 1
    return info, shots, errors


def _detect_impl(path: Path) -> MarkdownMatch | None:
    if path.suffix.lower() not in {".md", ".txt"}:
        return None
    info, shots, errors = _sections(_read(path))
    version_entry = info.get("模板版本")
    if version_entry is None:
        return None
    version = version_entry[0].strip()
    blocked = list(errors)
    if version != FORMAT:
        blocked.append(_issue("unsupported_version", f"不支持的模板版本 {version}",
                              cell=f"第 {version_entry[1]} 行", column="模板版本"))
    expected = 1
    for shot in shots:
        if shot["number"] != expected:
            blocked.append(_issue("shot_no_invalid", f"镜号应为 {expected}，实际 {shot['raw_number']}",
                                  shot=shot["number"], cell=f"第 {shot['line']} 行", column="镜号"))
        expected += 1
    return MarkdownMatch(version, blocked)


def detect(path: Path) -> MarkdownMatch | None:
    """Recognize a standard Markdown carrier without printing."""
    if path.suffix.lower() not in {".md", ".txt"}:
        return None
    try:
        return _detect_impl(path)
    except Exception:
        # Once a template-version key is visible, fail closed instead of falling through to AI.
        try:
            in_info = False
            for line_no, line in _visible_lines(_read(path)):
                if _INFO_RE.fullmatch(line):
                    in_info = True
                    continue
                if line.startswith("## "):
                    in_info = False
                parsed = _field(line) if in_info else None
                if parsed and parsed[0] == "模板版本":
                    return MarkdownMatch(parsed[1].strip(), [
                        _issue("unexpected_error", "Markdown 读取发生意外错误，请检查文件后重试",
                               cell=f"第 {line_no} 行", column="模板版本")])
        except Exception:
            pass
        return None


def import_markdown(path: Path, topic: str, match: MarkdownMatch | None = None) -> tuple[dict, dict]:
    match = match or detect(path)
    if match is None:
        raise ValueError("不是 VAC-SB Markdown")
    info_entries, rows, parse_errors = _sections(_read(path))
    info = {key: value for key, (value, _) in info_entries.items()}
    blocked = list(match.blocked)
    for item in parse_errors:
        if item not in blocked:
            blocked.append(item)
    warnings: list[dict[str, Any]] = []
    shots: list[dict[str, Any]] = []
    for row in rows:
        if not any(value.strip() for value in (*row["fields"].values(), *row["extras"].values())):
            continue
        number = row["number"]
        values: list[object] = [number] + [row["fields"].get(name, "") for name in FIELD_NAMES[1:]]
        extra_names = list(row["extras"])
        headers = HEADERS + extra_names
        values.extend(row["extras"][name] for name in extra_names)
        duration, duration_raw = _duration(values[3])
        if duration is None:
            blocked.append(_issue("duration_invalid", "时长必须是大于 0 的数字", shot=number,
                                  cell=f"第 {row['field_lines'].get('时长(秒)', row['line'])} 行",
                                  column="时长(秒)"))
        review: dict[str, Any] = {"status": "", "status_lines": [], "ai_suggested": [],
                                  "confirmed": [], "warnings": [], "acknowledged": []}

        def warn(review_obj, all_warnings, code, message, shot, _row_index, column):
            name = headers[column]
            item = _issue(code, message, shot=shot,
                          cell=f"第 {row['field_lines'].get(name, row['line'])} 行", column=name)
            item.update(field=FIELD_KEY_BY_NAME.get(name, ""), level="warn")
            all_warnings.append(item)
            review_obj.setdefault("warnings", []).append(item)

        status_lines = str(values[17]).splitlines()
        first_line = status_lines[0].strip() if status_lines else ""
        status = "" if re.fullmatch(r"AI建议[：:].*", first_line) else first_line
        review["status"] = status if status in {"已确认", "待确认", "校验失败"} else (
            "作者手写" if not status else "待确认")
        review["status_lines"] = status_lines
        status_line = row["field_lines"].get("来源/核对", row["line"])
        if status == "校验失败":
            blocked.append(_issue("status_failed", "来源/核对状态为校验失败", shot=number,
                                  cell=f"第 {status_line} 行", column="来源/核对"))
        elif status == "待确认":
            warn(review, warnings, "status_pending", "来源/核对状态待确认", number, 0, 17)
        elif status not in {"", "已确认"}:
            warn(review, warnings, "unknown_status", f"未知状态 {status}", number, 0, 17)
        status_value_lines = row["field_value_lines"].get("来源/核对", [status_line])
        for note_index, raw in enumerate(status_lines):
            note = raw.strip()
            actual_line = (status_value_lines[note_index] if note_index < len(status_value_lines)
                           else status_line)
            ai = re.fullmatch(r"AI建议[：:]\s*(.*)", note)
            if ai:
                for field_name in (part.strip() for part in re.split(r"[、,，]", ai.group(1))):
                    field_name = _ALIASES.get(field_name, field_name)
                    if field_name not in FIELD_KEY_BY_NAME:
                        warn(review, warnings, "unknown_ai_field", f"AI建议字段「{field_name}」不认识",
                             number, 0, 17)
                        continue
                    if field_name in BODY_FIELD_NAMES or field_name == "时长(秒)":
                        blocked.append(_issue("text_cell_pending", "正文或时长须先核对", shot=number,
                                              cell=f"第 {actual_line} 行", column=field_name))
                    elif FIELD_NAMES.index(field_name) in PRODUCTION_COLUMNS:
                        key = FIELD_KEY_BY_NAME[field_name]
                        if key not in review["ai_suggested"]:
                            review["ai_suggested"].append(key)
                            warn(review, warnings, "ai_suggested", "制作字段为 AI 建议",
                                 number, 0, FIELD_NAMES.index(field_name))
                continue
            if note_index == 0 and status:
                continue
            if note and not note.startswith(("原文：", "原文:")):
                item = _issue("status_note", note, shot=number, cell=f"第 {actual_line} 行",
                              column="来源/核对")
                item.update(field="review", level="warn")
                warnings.append(item)
                review["warnings"].append(item)
        if extra_names:
            warnings.append(_issue("extra_columns", "模板包含作者自加列", shot=number,
                                   cell=f"第 {row['field_lines'][extra_names[0]]} 行",
                                   column=extra_names[0]))
        shot = build_shot(values, headers, number, row["line"] - 1, duration, duration_raw,
                          review, warnings, warn)
        shot["shot_id"] = f"template-{number:04d}"
        shot["script_meta"]["source"] = {"format": FORMAT, "carrier": "markdown", "line": row["line"]}
        shots.append(shot)
    if not shots and not match.blocked:
        blocked.append(_issue("no_shots", "分镜脚本没有可导入的分镜"))
    if "语言" in info and "双语" in info["语言"]:
        warnings.append(_issue("language_multi", "模板要求一个文件只放一种语言"))
    report = {"route": "template", "format": match.version, "carrier": "markdown",
              "file": path.name, "shots": len(shots), "blocked": blocked, "warnings": warnings}
    plan = {"schema_version": 2, "task_revision": 0, "topic": topic, "shots": shots,
            "script_source": {"v": 1, "route": "template", "format": match.version,
                              "carrier": "markdown", "file_name": path.name,
                              "file_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                              "project_info": info,
                              "conversion": {k: v for k, v in info.items() if k in CONVERSION_KEYS},
                              "dictionaries": DICTIONARIES,
                              "import_summary": {}}}
    original_labels = [shot.get("module_label") for shot in shots]
    ensure_progress_labels(plan, reviewer=None)
    for shot, original in zip(shots, original_labels):
        if original and shot.get("module_label") != original:
            row = next(item for item in rows if item["number"] == shot["shot"])
            source_line = row["field_lines"].get("段落", row["line"])
            item = _issue("module_label_replaced", "段落不适合作为进度标签，已确定性替换",
                          shot=shot["shot"], cell=f"第 {source_line} 行", column="段落")
            item.update(field="module_label", level="warn")
            warnings.append(item)
            shot["script_meta"]["review"]["warnings"].append(item)
    plan["script_source"]["import_summary"] = {
        "shots": len(shots), "warnings": len(warnings),
        "shots_with_ai_suggested": sum(
            bool(shot.get("script_meta", {}).get("review", {}).get("ai_suggested")) for shot in shots),
    }
    report["warnings"] = warnings
    return normalize_shot_plan(plan, topic=topic), report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", required=True)
    parser.add_argument("--json")
    parser.add_argument("--plan")
    args = parser.parse_args()
    path = Path(args.check)
    match = detect(path)
    if match is None:
        return
    plan, report = import_markdown(path, path.stem, match)
    for item in report["blocked"] + report["warnings"]:
        say(f"[script] 标准 Markdown 导入 {item['code']}: {item['cell']} {item['message']}")
    from script_template import _event
    _event(report, bool(report["blocked"]))
    if args.json:
        atomic_write_json(Path(args.json), report)
    if report["blocked"]:
        raise SystemExit(2)
    if args.plan:
        atomic_write_json(Path(args.plan), plan)


if __name__ == "__main__":
    main()
