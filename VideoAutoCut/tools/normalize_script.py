#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import copy
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import dashscope_base_url, env_bool, env_int, load_dotenv, load_prompt_template, read_http_response_text, strict_bool, urlopen_with_retry
from json_io import atomic_write_json
from optimize_queries import call_qwen
from progress_labels import ensure_progress_labels
from script_card_fields import is_table_script, verify_and_fix as verify_card_fields
import script_template
import script_markdown
import script_organize
import script_voice
from shot_plan_schema import (
    compact_json_value as _compact_json_value,
    normalize_duration as _normalize_duration,
    normalize_shot_plan,
    optional_json_list as _optional_json_list,
)


SUPPORTED_FILE_EXTENSIONS = {
    ".xlsx",
    ".xlsm",
    ".xls",
    ".docx",
    ".doc",
    ".pdf",
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".srt",
}


def _write_unexpected_template_error(error: Exception) -> None:
    """Write one encoding-safe diagnostic line without exposing it in events/reports."""
    try:
        message = str(error).replace("\r", "\\r").replace("\n", "\\n")
        line = f"[script] 标准模板导入 unexpected_error: {type(error).__name__}: {message}"
        encoding = getattr(sys.stderr, "encoding", None) or "utf-8"
        safe_line = line.encode(encoding, errors="backslashreplace").decode(encoding)
        print(safe_line, file=sys.stderr, flush=True)
    except Exception:
        # Diagnostics must never replace the stable report/event/exit behavior.
        pass

VISUAL_MODES = {"stock_video", "local_material"}


def ensure_supported_script_file(path: Path) -> None:
    if not path.exists():
        raise SystemExit(f"脚本文件不存在: {path}")
    if not path.is_file():
        raise SystemExit(f"脚本路径不是文件: {path}")
    if path.suffix.lower() not in SUPPORTED_FILE_EXTENSIONS:
        supported = ", ".join(sorted(SUPPORTED_FILE_EXTENSIONS))
        raise SystemExit(f"不支持的脚本文件类型: {path.suffix or '(无扩展名)'}，支持: {supported}")


def dashscope_openai_base_url() -> str:
    relay_root = dashscope_base_url()
    if relay_root:
        return f"{relay_root}/v1"
    configured = os.environ.get("DASHSCOPE_OPENAI_BASE_URL", "").strip()
    if configured:
        return re.sub(r"/chat/completions/?$", "", configured.rstrip("/"))
    return "https://dashscope.aliyuncs.com/compatible-mode/v1"


def dashscope_files_url() -> str:
    relay_root = dashscope_base_url()
    if relay_root:
        return f"{relay_root}/v1/files"
    configured = (
        os.environ.get("DASHSCOPE_OPENAI_FILES_URL", "").strip()
        or os.environ.get("DASHSCOPE_FILE_UPLOAD_URL", "").strip()
    )
    if configured:
        return configured
    return f"{dashscope_openai_base_url()}/files"


def safe_upload_filename(path: Path) -> str:
    suffix = path.suffix or ".dat"
    stem = re.sub(r"[^0-9A-Za-z._-]+", "_", path.stem).strip("._") or "script"
    max_stem_len = max(1, 120 - len(suffix))
    return f"{stem[:max_stem_len]}{suffix}"


def multipart_body_for_file(path: Path) -> tuple[bytes, str]:
    boundary = f"----VideoAutoCut{uuid.uuid4().hex}"
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    filename = safe_upload_filename(path)
    file_bytes = path.read_bytes()

    chunks = [
        f"--{boundary}\r\n".encode("utf-8"),
        b'Content-Disposition: form-data; name="purpose"\r\n\r\n',
        b"file-extract\r\n",
        f"--{boundary}\r\n".encode("utf-8"),
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode("utf-8"),
        f"Content-Type: {mime_type}\r\n\r\n".encode("utf-8"),
        file_bytes,
        b"\r\n",
        f"--{boundary}--\r\n".encode("utf-8"),
    ]
    return b"".join(chunks), boundary


def upload_script_file(path: Path) -> str:
    api_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("DASHSCOPE_API_KEY is missing in .env")

    body, boundary = multipart_body_for_file(path)
    req = urllib.request.Request(
        dashscope_files_url(),
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )

    try:
        with urlopen_with_retry(req, timeout=300, label="Qwen 文件上传") as resp:
            payload = read_http_response_text(resp)
    except urllib.error.HTTPError as exc:
        detail = read_http_response_text(exc)
        raise SystemExit(f"Qwen 文件上传 HTTP {exc.code}: {detail}") from exc

    try:
        result = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Qwen 文件上传返回的 JSON 无效: {payload}") from exc

    file_id = str(result.get("id") or result.get("file_id") or "").strip()
    if not file_id:
        raise SystemExit(f"Qwen 文件上传没有返回 file_id: {payload}")
    return file_id


def normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip())


def normalize_evidence_text(value: str) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().lower())


def normalized_choice(value: object, allowed: set[str], default: str) -> str:
    text = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    return text if text in allowed else default


def compact_json_value(value: object, max_text: int = 2000, depth: int = 0) -> object:
    """Compatibility facade for script-specific whitespace compaction."""
    return _compact_json_value(
        value,
        max_text=max_text,
        depth=depth,
        collapse_whitespace=True,
    )


def optional_json_list(value: object) -> list[object]:
    return _optional_json_list(value, collapse_whitespace=True)


def normalize_duration(value: object) -> int | None:
    return _normalize_duration(value, rounding="nearest")


def voice_source_value(item: dict) -> str:
    source = item.get("voice_source") or {}
    if isinstance(source, dict):
        value = source.get("value")
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def voice_source_kind(item: dict) -> str:
    source = item.get("voice_source") or {}
    if isinstance(source, dict):
        return str(source.get("source") or "").strip().lower().replace("-", "_")
    return ""


def voice_text_matches_declared_source(voice_text: str, source_value: str) -> bool:
    voice = normalize_evidence_text(voice_text)
    source = normalize_evidence_text(source_value)
    if len(voice) < 6 or len(source) < 6:
        return False
    return voice in source or source in voice


def voice_text_allowed(item: dict, voice_text: str) -> bool:
    if not voice_text.strip():
        return False

    source_kind = voice_source_kind(item)
    source_value = voice_source_value(item)
    # A source kind without a value is not a usable declaration. Treat it the
    # same as an omitted source and let the organizer verify the quote against
    # the document text.
    if not source_value:
        return True
    if voice_text_matches_declared_source(voice_text, source_value):
        return True

    if source_kind in {"generated_from_document", "document_generated", "semantic_from_document"}:
        return True

    return False


def has_any_text(plan: dict, field: str) -> bool:
    shots = plan.get("shots") if isinstance(plan, dict) else []
    return any(str(item.get(field) or "").strip() for item in shots if isinstance(item, dict))


def script_review_enabled() -> bool:
    return env_bool("VIDEOAUTO_SCRIPT_REVIEW", True)


def should_review_voice_and_subtitles(plan: dict) -> bool:
    shots = plan.get("shots") if isinstance(plan, dict) else []
    if not shots or not script_review_enabled():
        return False
    return not has_any_text(plan, "voice_text")


REVIEWED_VOICE_FIELDS = ("voice_text", "voiceover", "voice_source", "voice_requirements")


def review_shots_align(initial_raw: dict, reviewed_raw: dict) -> bool:
    initial_shots = initial_raw.get("shots") if isinstance(initial_raw, dict) else None
    reviewed_shots = reviewed_raw.get("shots") if isinstance(reviewed_raw, dict) else None
    return (isinstance(initial_shots, list) and isinstance(reviewed_shots, list)
            and len(initial_shots) == len(reviewed_shots)
            and all(isinstance(item, dict) for item in initial_shots)
            and all(isinstance(item, dict) for item in reviewed_shots))


def merge_reviewed_voice_fields(initial_raw: dict, reviewed_raw: dict) -> dict:
    """Use a same-length review only to fill voice fields.

    All other fields remain anchored to the first parse. A shot-count mismatch
    deliberately preserves the legacy whole-review fallback so the organizer
    can fail closed with ``organize_shot_mismatch``.
    """
    initial_shots = initial_raw.get("shots") if isinstance(initial_raw, dict) else None
    reviewed_shots = reviewed_raw.get("shots") if isinstance(reviewed_raw, dict) else None
    if not review_shots_align(initial_raw, reviewed_raw):
        return reviewed_raw

    merged = copy.deepcopy(initial_raw)
    merged_shots = merged.get("shots")
    if not isinstance(merged_shots, list):
        return reviewed_raw
    for initial_shot, reviewed_shot in zip(merged_shots, reviewed_shots):
        for field in REVIEWED_VOICE_FIELDS:
            initial_shot.pop(field, None)
            if field in reviewed_shot:
                initial_shot[field] = copy.deepcopy(reviewed_shot[field])
    return merged


def review_shot_counts_match(initial_raw: dict, reviewed_raw: dict) -> bool:
    return review_shots_align(initial_raw, reviewed_raw)


# 表格脚本的 `card_content` 保留单元格内的人工换行 / 空白（`script_card_fields` 表格路按原文逐字比对）。
# 哪些算表格脚本见 `script_card_fields.is_table_script`（xlsx / xlsm，以及表头认得出来的 csv）。


def authored_layout_text(value: object) -> str:
    """只去首尾空白、CRLF/CR 统一成 LF；内部换行和空白原样保留。"""
    return re.sub(r"\r\n?", "\n", str(value or "")).strip()


def compact_plan(plan: dict, topic: str, *, preserve_card_layout: bool = False) -> dict:
    """模型输出 -> 规范 plan。

    `preserve_card_layout=True`（表格脚本）时 `card_content` **不折叠内部空白**：
    作者在单元格里敲的换行是上屏排版的一部分，校验层也按保留换行的原文逐字比对。
    原来一律折叠，真实 v2A 每次导入都会先被折成一行、再被校验层按原文「改写」回来
    （6 条纠正），日志里永远有噪音（2026-09-23 复盘建议）。文本脚本（md/txt 等）的
    作者值本来就是单行，保持原折叠口径，避免模型自己加的换行把卡片版式改掉。
    """
    raw_shots = plan.get("shots") if isinstance(plan, dict) else []
    shots = raw_shots if isinstance(raw_shots, list) else []
    output = {"topic": str(plan.get("topic") or topic or "脚本文档"), "shots": []}
    background_music = compact_json_value(plan.get("background_music"))
    if background_music not in (None, "", [], {}):
        output["background_music"] = background_music
    for field in ("content_blocks", "extra_requirements"):
        values = optional_json_list(plan.get(field))
        if values:
            output[field] = values

    for index, item in enumerate(shots, 1):
        if not isinstance(item, dict):
            continue

        def text_field(name: str) -> str:
            return normalize_whitespace(item.get(name) or "")

        voice = text_field("voice_text")
        if voice and not voice_text_allowed(item, voice):
            voice = ""
        voiceover = bool(strict_bool(item.get("voiceover"), f"shots[{index}].voiceover", bool(voice))) and bool(voice)

        title = text_field("title") or f"分镜{index}"
        visual_mode = normalized_choice(item.get("visual_mode"), VISUAL_MODES, "stock_video")
        visual = text_field("visual_query")
        download = text_field("download_query")

        if not visual:
            visual = download
        if visual_mode != "local_material" and not download:
            download = visual

        shot = {
            "shot": index,
            "title": title,
            "module_label": text_field("module_label") or None,
            "download_query": download,
            "visual_query": visual or download or title,
            "visual_mode": visual_mode,
            "query_optimized": False,
            "duration": normalize_duration(item.get("duration")),
            "voice_text": voice or None,
            "voiceover": voiceover,
            "subtitle": text_field("subtitle") or None,
            "clip_requirements": text_field("clip_requirements") or None,
            "progress_text": text_field("progress_text") or None,
            "highlight_rule": text_field("highlight_rule") or None,
            "subtitle_effect": text_field("subtitle_effect") or None,
            "voice_requirements": text_field("voice_requirements") or None,
            "time_range": text_field("time_range") or None,
            "card_content": (authored_layout_text(item.get("card_content")) if preserve_card_layout
                             else text_field("card_content")) or None,
            "card_hint": text_field("card_hint") or None,
        }
        for field in ("extra_requirements", "production_notes", "content_blocks"):
            values = optional_json_list(item.get(field))
            if values:
                shot[field] = values
        required_fields = {"shot", "title", "download_query", "visual_query"}
        output["shots"].append(
            {k: v for k, v in shot.items() if k in required_fields or v not in (None, "")}
        )

    return normalize_shot_plan(output, topic=topic)


def script_parser_system_prompt() -> str:
    return load_prompt_template("script_parse.md").strip()


def normalize_with_ai(payload: dict) -> dict:
    model = os.environ.get("DASHSCOPE_SCRIPT_MODEL", "qwen-long").strip() or "qwen-long"
    timeout = env_int("DASHSCOPE_SCRIPT_TIMEOUT", 600)
    file_id = str(payload["file_id"])

    messages = [
        {"role": "system", "content": script_parser_system_prompt()},
        {"role": "system", "content": f"fileid://{file_id}"},
        {
            "role": "user",
            "content": (
                "请读取上传的原文件，完成语义理解和分镜结构化。"
                "不要要求我提供表头或关键词，不要使用固定格式假设。"
                f"\n文件信息：{json.dumps(payload, ensure_ascii=False)}"
            ),
        },
    ]
    return call_qwen(messages, temperature=0.0, label="Qwen 脚本文件解析", model=model, timeout=timeout)


def review_voice_and_subtitles_with_ai(payload: dict, plan: dict) -> dict:
    model = os.environ.get("DASHSCOPE_SCRIPT_REVIEW_MODEL", "").strip()
    if not model:
        model = os.environ.get("DASHSCOPE_SCRIPT_MODEL", "qwen-long").strip() or "qwen-long"
    timeout = env_int("DASHSCOPE_SCRIPT_REVIEW_TIMEOUT", env_int("DASHSCOPE_SCRIPT_TIMEOUT", 600))
    file_id = str(payload["file_id"])

    messages = [
        {"role": "system", "content": load_prompt_template("script_parse_review.md").strip()},
        {"role": "system", "content": f"fileid://{file_id}"},
        {
            "role": "user",
            "content": (
                "请复核下面第一次解析结果，重点修正遗漏的口播正文和字幕。"
                "如果原文件语义不需要口播或字幕，请保持为空。"
                f"\n文件信息：{json.dumps(payload, ensure_ascii=False)}"
                f"\n第一次解析结果：{json.dumps(plan, ensure_ascii=False)}"
            ),
        },
    ]
    return call_qwen(messages, temperature=0.0, label="Qwen 口播字幕复核", model=model, timeout=timeout)


def review_progress_labels_with_ai(choices: list[dict]) -> dict:
    messages = [
        {"role": "system", "content": (
            '仅根据每个分镜的 context 原文生成语义准确、简洁的章节标签。language=zh 必须用中文，'
            'language=en 必须用英文；保留必要品牌/产品术语，不删除或拆开单词。'
            '不得修改其他脚本内容。只返回 JSON：{"labels":[{"shot":1,"module_label":"章节标签"}]}。'
        )},
        {"role": "user", "content": json.dumps(choices, ensure_ascii=False)},
    ]
    return call_qwen(messages, temperature=0.0, label="Qwen 章节标签语言复核")


def normalize_voice_script_with_ai(body: str, payload: dict) -> dict:
    model = os.environ.get("DASHSCOPE_SCRIPT_MODEL", "qwen-long").strip() or "qwen-long"
    timeout = env_int("DASHSCOPE_SCRIPT_TIMEOUT", 600)
    messages = [
        {"role": "system", "content": load_prompt_template("script_parse_voice_script.md").strip()},
        {"role": "user", "content": (f"文件信息：{json.dumps(payload, ensure_ascii=False)}"
                                      f"\n确认口播正文：\n{body}")},
    ]
    return call_qwen(messages, temperature=0.0, label="Qwen 口播稿分镜", model=model,
                     timeout=timeout, http_attempts=1)


def _voice_script_ignored(report: dict) -> None:
    report["warnings"].append(script_template._issue(
        "voice_script_ignored", "标准脚本已有口播列，已忽略口播稿选项"))


def _voice_script_failed(script_file: Path, error: script_voice.VoiceScriptError) -> None:
    report = {"route": "organized", "format": "VAC-SB-1", "file": script_file.name,
              "shots": 0, "blocked": [script_template._issue(error.code, str(error))], "warnings": []}
    script_template.say(f"[script] 口播稿导入 {error.code}: {error}")
    script_template._event(report, True)


def main() -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Normalize script files into VideoAuto shots.json using Qwen file understanding")
    parser.add_argument("--input", default="", help="script file: xlsx/xlsm/xls/docx/doc/pdf/txt/md/csv/json/srt")
    parser.add_argument("--output", required=True)
    parser.add_argument("--topic", default="")
    parser.add_argument("--voice-script-body", default="")
    args = parser.parse_args()

    if not args.input:
        raise SystemExit("缺少脚本文档，请使用 --input 指定")

    script_file = Path(args.input)
    ensure_supported_script_file(script_file)

    topic = args.topic or script_file.stem
    template_match = script_template.detect(script_file)
    if template_match is not None:
        try:
            plan, report = script_template.import_template(script_file, topic, template_match)
            if args.voice_script_body:
                _voice_script_ignored(report)
            for item in report["blocked"] + report["warnings"]:
                script_template.say(
                    f"[script] 标准模板导入 {item['code']}: {item['cell']} {item['message']}"
                )
            if report["blocked"]:
                script_template._event(report, True)
                raise SystemExit(2)
            plan = ensure_progress_labels(plan, reviewer=None)
            atomic_write_json(Path(args.output), plan)
        except Exception as exc:
            report = script_template.unexpected_error_report(script_file, template_match, exc)
            _write_unexpected_template_error(exc)
            script_template.say("[script] 标准模板导入 unexpected_error: 模板读取失败")
            script_template._event(report, True)
            raise SystemExit(2) from None
        script_template._event(report, False)
        print(f"[script] 标准模板导入完成: {len(plan['shots'])} 镜，{len(report['warnings'])} 条提醒")
        return
    markdown_match = script_markdown.detect(script_file)
    if markdown_match is not None:
        try:
            plan, report = script_markdown.import_markdown(script_file, topic, markdown_match)
            if args.voice_script_body:
                _voice_script_ignored(report)
            for item in report["blocked"] + report["warnings"]:
                script_template.say(
                    f"[script] 标准 Markdown 导入 {item['code']}: {item['cell']} {item['message']}"
                )
            if report["blocked"]:
                script_template._event(report, True)
                raise SystemExit(2)
            atomic_write_json(Path(args.output), plan)
        except Exception as exc:
            report = {"route": "template", "format": markdown_match.version,
                      "carrier": "markdown", "file": script_file.name, "shots": 0,
                      "blocked": [script_template._issue(
                          "unexpected_error", "Markdown 读取发生意外错误，请检查文件后重试")],
                      "warnings": []}
            _write_unexpected_template_error(exc)
            script_template.say("[script] 标准 Markdown 导入 unexpected_error: 文件读取失败")
            script_template._event(report, True)
            raise SystemExit(2) from None
        script_template._event(report, False)
        print(f"[script] 标准 Markdown 导入完成: {len(plan['shots'])} 镜，{len(report['warnings'])} 条提醒")
        return
    voice_body = ""
    voice_body_sha = ""
    voice_mode = bool(args.voice_script_body)
    payload = {"file_name": script_file.name, "file_type": script_file.suffix.lower().lstrip("."),
               "topic": topic}
    if voice_mode:
        try:
            voice_body = script_voice.read_body(Path(args.voice_script_body))
            voice_body_sha = script_voice.body_sha256(Path(args.voice_script_body))
        except script_voice.VoiceScriptError as exc:
            _voice_script_failed(script_file, exc)
            raise SystemExit(2) from None
        print(f"AI 解析已确认口播正文: {script_file}")
        raw_plan = normalize_voice_script_with_ai(voice_body, payload)
    else:
        print(f"AI 上传脚本文件: {script_file}")
        file_id = upload_script_file(script_file)
        print(f"AI 脚本文件上传完成: {file_id}")
        payload["file_id"] = file_id
        print(f"AI 解析脚本文件: {script_file}")
        raw_plan = normalize_with_ai(payload)
    organized_raw = raw_plan
    review_shot_mismatch = False
    # csv 表头认不出来时校验层退回文本路（值按单行比对），这里跟着按文本脚本折叠，
    # 两边换行口径一致（第二次对抗复审建议）。xlsx / xlsm 一律按表格。
    preserve_card_layout = is_table_script(script_file)
    plan = compact_plan(raw_plan, topic, preserve_card_layout=preserve_card_layout)
    if not voice_mode and should_review_voice_and_subtitles(plan):
        print("AI 复核口播字幕: 检查是否遗漏 voice_text/subtitle")
        reviewed_raw = review_voice_and_subtitles_with_ai(payload, plan)
        merged_raw = merge_reviewed_voice_fields(raw_plan, reviewed_raw)
        reviewed_plan = compact_plan(merged_raw, topic, preserve_card_layout=preserve_card_layout)
        if reviewed_plan.get("shots"):
            plan = reviewed_plan
            organized_raw = merged_raw
            review_shot_mismatch = not review_shot_counts_match(raw_plan, reviewed_raw)
        voice_count = sum(1 for item in plan["shots"] if str(item.get("voice_text") or "").strip())
        subtitle_count = sum(1 for item in plan["shots"] if str(item.get("subtitle") or "").strip())
        print(f"AI 口播字幕复核完成: 口播 {voice_count}/{len(plan['shots'])}，字幕 {subtitle_count}/{len(plan['shots'])}")
    if not plan["shots"]:
        raise SystemExit("AI 没有从脚本文件解析出任何分镜")

    # 上屏字段（card_content / card_hint）和分镜标题（title）拿脚本原文再对一遍：
    # AI 解析会丢字、会把中文 hint 翻成英文、会在作者写「（不填）」的地方凭空造 hint、
    # 会改写标题（2026-09-21 实测 14 处）。「只按脚本上屏」口径下上屏字段直接决定
    # 上不上卡片，所以以原文为准纠正回来。
    #
    # **必须跑在 `ensure_progress_labels` 之前**：`progress_labels` 在 AI 没给
    # module_label 时会拿 `title` 当章节名（`progress_labels.py:45`），跑在后面的话
    # 进度条拿到的是**未纠正**的标题，等于这一层白纠（2026-09-21 对抗复审应修 2）。
    verification_file = Path(args.voice_script_body) if voice_mode else script_file
    verify_card_fields(plan, verification_file)

    plan = script_organize.organize(
        plan, script_file, organized_raw,
        evidence_path=verification_file if voice_mode else None,
        force_shot_mismatch=review_shot_mismatch, voice_mode=voice_mode)
    if voice_mode:
        try:
            plan = script_voice.apply(plan, organized_raw, voice_body, raw_body_sha256=voice_body_sha)
        except script_voice.VoiceScriptError as exc:
            _voice_script_failed(script_file, exc)
            raise SystemExit(2) from None

    original_labels = [shot.get("module_label") for shot in plan["shots"]]
    plan = ensure_progress_labels(plan, reviewer=None if voice_mode else review_progress_labels_with_ai)
    script_organize.sync_progress_labels(plan, original_labels)

    out = Path(args.output)
    atomic_write_json(out, plan)
    print(f"AI 脚本规范化完成: {out}")
    print(f"分镜数: {len(plan['shots'])}")


if __name__ == "__main__":
    main()
