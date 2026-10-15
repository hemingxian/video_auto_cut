#!/usr/bin/env python3
"""Deterministic post-processing for AI-organized, non-standard scripts."""
from __future__ import annotations

import hashlib
import re
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import script_tabular
from script_card_fields import (FIELD_BY_KEY, FIELD_LINE, collect_blocks, normalize_key,
                                read_script_text, same_text)
from script_spec import DICTIONARIES, FORMAT

AI_SUGGESTED = [
    "title", "voice_text", "subtitle", "card_content", "card_hint", "module_label",
    "duration", "visual_description", "shot_size", "camera_move", "camera_angle",
    "transition", "search_keywords", "material_requirements", "material_source", "notes",
]
CAMERA_FIELDS = ("shot_size", "camera_move", "camera_angle", "transition")
SINGLE_CAMERA_MOVES = frozenset("推拉跟升降甩")
WORD_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _compact(value: object) -> str:
    return re.sub(r"\s+", "", str(value or ""))


def _source_text(path: Path) -> tuple[str | None, bool]:
    suffix = path.suffix.lower()
    if suffix in {".md", ".txt", ".csv", ".json", ".srt"}:
        text = read_script_text(path)
        return text, text is not None
    if suffix in script_tabular.XLSX_SUFFIXES:
        details = script_tabular.read_workbook_detail(path)
        if details is None:
            return None, False
        return "\n".join(str(cell) for sheet in details for row in sheet.grid for cell in row), True
    if suffix in script_tabular.DOCX_SUFFIXES:
        text = _read_docx_text(path)
        return text, text is not None
    return None, False


def _read_docx_text(path: Path) -> str | None:
    """Read Word paragraphs, including paragraphs nested in table cells."""
    try:
        with zipfile.ZipFile(path) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > script_tabular.MAX_ENTRY_BYTES:
                return None
            payload = archive.read(info)
        if b"<!DOCTYPE" in payload or b"<!ENTITY" in payload:
            return None
        root = ElementTree.fromstring(payload)
    except (OSError, KeyError, RuntimeError, ValueError, zipfile.BadZipFile, ElementTree.ParseError):
        return None
    paragraphs = []
    for paragraph in root.iter(f"{WORD_NS}p"):
        paragraphs.append("".join(node.text or "" for node in paragraph.iter(f"{WORD_NS}t")))
    return "\n".join(paragraphs)


def _is_excerpt(value: object, source: str | None) -> bool:
    needle, haystack = _compact(value), _compact(source)
    return bool(needle and haystack and needle in haystack)


def _labeled_card_values(source: str | None) -> dict[str, set[str]]:
    """Return exact values from explicit card field lines in confirmed voice text."""
    values = {"card_content": set(), "card_hint": set()}
    for line in (source or "").splitlines():
        match = FIELD_LINE.fullmatch(line)
        if not match:
            continue
        key = normalize_key(match.group(1))
        # 51505407 explicitly treats the short voice-script label `上屏：` as authored.
        # Keep the alias local to organized voice verification; the shared card parser is unchanged.
        field = "card_content" if key == "上屏" else FIELD_BY_KEY.get(key)
        value = match.group(2).strip()
        if field in values and value:
            values[field].add(value)
    return values


def _camera_value(field: str, value: str, evidence: str, source: str | None) -> tuple[str, str, str | None]:
    default = "" if field == "transition" else "不限"
    if not value:
        return default, "default", None
    valid = value in DICTIONARIES[field]
    alias_collision = any(other != value and ((value in other and other in evidence)
                                               or other + value in evidence or value + other in evidence)
                          for other in DICTIONARIES[field])
    evidence_ok = _is_excerpt(evidence, source) and value in evidence
    context_ok = not (field == "camera_move" and value in SINGLE_CAMERA_MOVES) or (
        "镜头" in evidence or "机位" in evidence)
    if valid and evidence_ok and context_ok and not alias_collision:
        return value, "script", None
    return default, "default", f"camera_inferred_dropped: {field}={value}"


def _warning(code: str, message: str, field: str) -> dict[str, str]:
    return {"code": code, "message": message, "field": field, "level": "warn"}


def _explicit_project_info(raw: object, source: str | None) -> dict[str, Any]:
    if not isinstance(raw, dict) or not source:
        return {}
    result = {}
    for key, value in raw.items():
        key_text, value_text = str(key).strip(), str(value).strip()
        if key_text and value_text and re.search(
                rf"(?m)^[^\S\r\n]*(?:[-*+]\s*)?(?:\*\*)?{re.escape(key_text)}(?:\*\*)?\s*[:：]\s*"
                rf"(?:\*\*)?{re.escape(value_text)}(?:\*\*)?\s*$", source):
            result[key_text] = value
    return result


def organize(plan: dict[str, Any], source_path: Path, raw_plan: dict[str, Any] | None = None,
             *, evidence_path: Path | None = None, force_shot_mismatch: bool = False,
             voice_mode: bool = False) -> dict[str, Any]:
    """Decorate an existing normalized plan without changing its legacy field contract."""
    source_path = Path(source_path)
    evidence_path = Path(evidence_path) if evidence_path is not None else source_path
    source_text, verifiable = _source_text(evidence_path)
    raw_plan = raw_plan if isinstance(raw_plan, dict) else {}
    project_info = _explicit_project_info(raw_plan.get("project_info"), source_text)
    raw_shots = ([item for item in raw_plan.get("shots", []) if isinstance(item, dict)]
                 if isinstance(raw_plan.get("shots"), list) else [])
    shots = plan.get("shots") if isinstance(plan.get("shots"), list) else []
    raw_aligned = len(raw_shots) == len(shots)
    camera_material_aligned = raw_aligned and not force_shot_mismatch
    blocks, block_status, _ = collect_blocks(evidence_path)
    labeled_card_values = _labeled_card_values(source_text) if voice_mode else {}
    for index, shot in enumerate(shots):
        raw = raw_shots[index] if raw_aligned else {}
        evidence_map = raw.get("evidence") if isinstance(raw.get("evidence"), dict) else {}
        warnings: list[dict[str, str]] = []
        origins: dict[str, str] = {}
        card_origins: dict[str, str] = {}

        for field in ("card_content", "card_hint"):
            value = str(shot.get(field) or "")
            if not value:
                card_origins[field] = "default"
                continue
            if not verifiable:
                card_origins[field] = "ai"
                continue
            valid = value in labeled_card_values.get(field, set()) if voice_mode else _is_excerpt(value, source_text)
            if valid:
                card_origins[field] = "script"
            else:
                shot.pop(field, None)
                card_origins[field] = "default"
                warnings.append(_warning(
                    "card_not_in_script", "上屏文字/卡片提示不是脚本明写内容，已清空", field))

        subtitle = str(shot.get("subtitle") or "")
        card_matches = {
            str(shot.get("card_content") or ""),
            str(shot.get("card_hint") or ""),
        }
        if subtitle and subtitle in card_matches:
            shot.pop("subtitle", None)
            warnings.append(_warning("subtitle_is_card", "字幕与上屏文字相同，已按上屏处理并清空字幕", "subtitle"))
            subtitle = ""
        elif subtitle and not _is_excerpt(subtitle, source_text):
            shot.pop("subtitle", None)
            warnings.append(_warning("subtitle_not_in_script", "AI 字幕不在脚本原文中，已清空", "subtitle"))
            subtitle = ""
        origins["subtitle"] = "script" if subtitle else "default"

        material_source = str(raw.get("material_source") or "").strip() if camera_material_aligned else ""
        if material_source and not _is_excerpt(material_source, source_text):
            warnings.append(_warning("material_source_not_in_script", "推荐素材来源不在脚本原文中，已清空", "material_source"))
            material_source = ""
        origins["material_source"] = "script" if material_source else "default"

        voice = str(shot.get("voice_text") or "")
        voice_source = raw.get("voice_source") if isinstance(raw.get("voice_source"), dict) else {}
        voice_in_source = _is_excerpt(voice, source_text)
        origins["voice_text"] = "script" if voice and voice_in_source else ("ai" if voice else "default")
        if voice and voice_source.get("source") == "document_quote" and not voice_in_source:
            warnings.append(_warning("voice_quote_unverified", "模型标为原文口播，但本地未找到连续原文，按 AI 整理标记", "voice_text"))

        camera: dict[str, str] = {}
        for field in CAMERA_FIELDS:
            if not verifiable or not camera_material_aligned:
                camera[field] = "" if field == "transition" else "不限"
                origins[field] = "default"
                continue
            camera[field], origins[field], warning = _camera_value(
                field, str(raw.get(field) or "").strip(), str(evidence_map.get(field) or ""), source_text)
            if warning:
                warnings.append(_warning("camera_inferred_dropped", warning.split(": ", 1)[-1], field))
        if not verifiable:
            warnings.append(_warning("camera_unverifiable", "此文件格式无法在本地核对景别、运镜、拍摄角度和转场", "camera"))
        if not camera_material_aligned:
            warnings.append(_warning("organize_shot_mismatch", "模型原始分镜数与规范化分镜数不一致，镜头字段和素材来源已按无法核对处理", "shot"))

        visual = str(shot.get("visual_query") or "")
        material_requirements = str(shot.get("clip_requirements") or "")
        search = str(shot.get("download_query") or "")
        notes_value = shot.get("extra_requirements") or []
        notes = "\n".join(str(item) for item in notes_value)
        for field in ("title", "module_label", "duration", "visual_description", "search_keywords",
                      "material_requirements", "notes"):
            origins[field] = "ai"
        if _is_excerpt(shot.get("title"), source_text):
            origins["title"] = "script"
        origins.update(card_origins)
        script_values = {
            "title": shot.get("title", ""), "voice_text": voice, "subtitle": subtitle,
            "card_content": shot.get("card_content", ""), "card_layout": shot.get("card_layout", ""),
            "card_hint": shot.get("card_hint", ""), "visual_description": visual,
            **camera,
        }
        meta: dict[str, Any] = {
            "v": 1,
            "source": {"route": "organized", "file": source_path.name},
            "segment": shot.get("module_label") or "",
            "visual_description": visual,
            **camera,
            "material_source": material_source,
            "material_requirements": material_requirements,
            "search_keywords": search,
            "notes": notes,
            "script_values": script_values,
            "field_origin": origins,
            "review": {"status": "待确认", "status_lines": ["待确认", f"AI 整理自：{source_path.name}"],
                       "ai_suggested": list(AI_SUGGESTED), "confirmed": [],
                       "warnings": warnings, "acknowledged": []},
        }
        source_evidence = str(raw.get("source") or "").strip()
        if source_evidence:
            meta["source"]["evidence"] = source_evidence
        if (shot.get("card_content") and block_status == "ok" and blocks
                and len(blocks) == len(plan.get("shots") or []) and index < len(blocks)):
            entry = blocks[index].get("card_content", {})
            if (entry.get("reliable") and entry.get("present")
                    and same_text(str(shot["card_content"]), str(entry.get("value") or ""))):
                meta["authored"] = {"card_content": entry.get("raw", entry.get("value", shot["card_content"]))}
        shot["script_meta"] = meta
        if subtitle and subtitle != voice:
            hints = shot.get("render_hints") if isinstance(shot.get("render_hints"), dict) else {}
            shot["render_hints"] = {**hints, "caption_source": "subtitle"}
        elif isinstance(shot.get("render_hints"), dict):
            shot["render_hints"].pop("caption_source", None)
            if not shot["render_hints"]:
                shot.pop("render_hints")

    all_warnings = [warning for shot in plan.get("shots") or []
                    for warning in shot.get("script_meta", {}).get("review", {}).get("warnings", [])]
    plan["script_source"] = {
        "v": 1, "route": "organized", "format": FORMAT, "file_name": source_path.name,
        "file_sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
        "project_info": project_info if isinstance(project_info, dict) else {},
        "dictionaries": DICTIONARIES,
        "import_summary": {"shots": len(plan.get("shots") or []), "warnings": len(all_warnings),
                           "shots_with_ai_suggested": len(plan.get("shots") or [])},
    }
    return plan


def sync_progress_labels(plan: dict[str, Any], original_labels: list[object]) -> dict[str, Any]:
    """Keep organized metadata aligned after deterministic progress-label processing."""
    added = 0
    for shot, original in zip(plan.get("shots") or [], original_labels):
        meta = shot.get("script_meta") if isinstance(shot, dict) else None
        if not isinstance(meta, dict):
            continue
        current = shot.get("module_label") or ""
        meta["segment"] = current
        if original and current != original:
            review = meta.get("review") if isinstance(meta.get("review"), dict) else {}
            warnings = review.get("warnings") if isinstance(review.get("warnings"), list) else []
            warnings.append(_warning("module_label_replaced", "段落不适合作为进度标签，已确定性替换", "module_label"))
            review["warnings"] = warnings
            meta["review"] = review
            added += 1
    summary = plan.get("script_source", {}).get("import_summary")
    if isinstance(summary, dict):
        summary["warnings"] = int(summary.get("warnings") or 0) + added
    return plan
