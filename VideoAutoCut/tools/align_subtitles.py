#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import subtitle_alignment as _alignment
from common import dashscope_url, env_bool, load_dotenv, load_prompt_template, read_http_response_text, split_subtitle_sentences, urlopen_with_retry
from json_io import atomic_write_json
from register_voice_template import upload_file_to_dashscope_temp
from subtitle_alignment import (
    cue_weight,
    normalize_content_for_compare,
    sentence_words,
    split_text_by_weights,
    validate_standard_segments,
    validate_timing_segments,
)

boundary_after_normalized_units = _alignment.boundary_after_normalized_units
hard_split_long_text = _alignment.hard_split_long_text
normalized_units_with_indices = _alignment.normalized_units_with_indices
pack_parts = _alignment.pack_parts
segment_has_bad_boundary = _alignment.segment_has_bad_boundary
visible_len = _alignment.visible_len

try:
    from optimize_queries import call_qwen
except Exception:
    call_qwen = None


def dashscope_api_key() -> str:
    api_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("DASHSCOPE_API_KEY is missing in .env")
    return api_key


def http_json(req: urllib.request.Request, timeout: int = 120) -> dict:
    try:
        with urlopen_with_retry(req, timeout=timeout, label="DashScope ASR") as resp:
            payload = read_http_response_text(resp)
    except urllib.error.HTTPError as e:
        detail = read_http_response_text(e)
        raise SystemExit(f"DashScope ASR HTTP {e.code}: {detail}")
    return json.loads(payload)


def post_json(url: str, body: dict, headers: dict[str, str], timeout: int = 120) -> dict:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    return http_json(req, timeout=timeout)


def get_json(url: str, headers: dict[str, str], timeout: int = 120) -> dict:
    req = urllib.request.Request(url, headers=headers, method="GET")
    return http_json(req, timeout=timeout)


def download_json(url: str, timeout: int = 180) -> dict:
    try:
        with urlopen_with_retry(url, timeout=timeout, label="下载 ASR 结果") as resp:
            payload = read_http_response_text(resp)
    except urllib.error.HTTPError as e:
        detail = read_http_response_text(e)
        raise SystemExit(f"下载 ASR 结果失败 HTTP {e.code}: {detail}")
    return json.loads(payload)


def upload_audio(audio_path: Path) -> str:
    api_key = dashscope_api_key()
    upload_models = []
    for m in [
        os.environ.get("DASHSCOPE_ASR_UPLOAD_MODEL", "").strip(),
        os.environ.get("DASHSCOPE_ASR_MODEL", "").strip(),
        "qwen3-asr-flash-filetrans",
        "qwen3-asr-flash",
    ]:
        if m and m not in upload_models:
            upload_models.append(m)

    last_error = None
    for model in upload_models:
        try:
            print(f"上传口播音频到百炼临时存储: {audio_path}")
            print(f"上传绑定模型: {model}")
            url = upload_file_to_dashscope_temp(api_key, audio_path, model)
            print(f"ASR 临时 URL: {url}")
            return url
        except SystemExit as exc:
            last_error = exc
            print(f"[警告] 使用模型 {model} 获取上传凭证/上传失败，尝试下一个: {exc}")
    raise SystemExit(f"上传口播音频失败: {last_error}")


def submit_asr_task(file_url: str, *, corpus_text: str = "") -> str:
    api_key = dashscope_api_key()
    endpoint = dashscope_url(
        "api/v1/services/audio/asr/transcription",
        override_env="DASHSCOPE_ASR_TRANSCRIPTION_URL",
        default="https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
    )
    model = os.environ.get("DASHSCOPE_ASR_MODEL", "qwen3-asr-flash-filetrans").strip()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
        "X-DashScope-OssResourceResolve": "enable",
    }
    params: dict = {
        "channel_id": [0],
        "enable_itn": env_bool("DASHSCOPE_ASR_ENABLE_ITN", False),
    }
    if env_bool("DASHSCOPE_ASR_ENABLE_WORDS", True):
        params["enable_words"] = True
    language = os.environ.get("DASHSCOPE_ASR_LANGUAGE", "").strip()
    # 如果有明显中英混合，不建议固定 language；留空让模型自动判断。
    if language:
        params["language"] = language
    if env_bool("DASHSCOPE_ASR_USE_CORPUS", True) and corpus_text.strip():
        # Qwen-ASR async uses parameters.text for context biasing.
        params["text"] = corpus_text.strip()[:6000]

    body = {
        "model": model,
        "input": {"file_url": file_url},
        "parameters": params,
    }
    print(f"提交阿里 ASR 打轴任务: {model}")
    result = post_json(endpoint, body, headers, timeout=120)
    task_id = (((result or {}).get("output") or {}).get("task_id") or "").strip()
    if not task_id:
        raise SystemExit(f"ASR 提交成功但没有 task_id: {json.dumps(result, ensure_ascii=False)[:1000]}")
    print(f"ASR task_id: {task_id}")
    return task_id


def wait_asr_task(task_id: str) -> dict:
    api_key = dashscope_api_key()
    base = dashscope_url(
        "api/v1/tasks",
        override_env="DASHSCOPE_ASR_TASK_BASE_URL",
        default="https://dashscope.aliyuncs.com/api/v1/tasks",
    ).rstrip("/")
    url = f"{base}/{task_id}"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "X-DashScope-Async": "enable",
        "Content-Type": "application/json",
    }
    timeout_s = int(os.environ.get("DASHSCOPE_ASR_TIMEOUT_SECONDS", "600"))
    interval_s = float(os.environ.get("DASHSCOPE_ASR_POLL_INTERVAL", "2"))
    deadline = time.time() + timeout_s
    while True:
        result = get_json(url, headers, timeout=120)
        output = (result or {}).get("output") or {}
        status = str(output.get("task_status") or "").upper()
        print(f"ASR 状态: {status}")
        if status == "SUCCEEDED":
            transcription_url = (((output.get("result") or {}).get("transcription_url")) or "").strip()
            if not transcription_url:
                raise SystemExit(f"ASR 成功但没有 transcription_url: {json.dumps(result, ensure_ascii=False)[:1000]}")
            data = download_json(transcription_url)
            return {"task": result, "transcription": data}
        if status in {"FAILED", "UNKNOWN"}:
            raise SystemExit(f"ASR 任务失败: {json.dumps(result, ensure_ascii=False)[:1000]}")
        if time.time() > deadline:
            raise SystemExit(f"ASR 等待超时: {task_id}")
        time.sleep(interval_s)


def extract_asr_sentences(transcription: dict) -> list[dict]:
    out: list[dict] = []
    transcripts = transcription.get("transcripts") or []
    for transcript in transcripts:
        sentences = transcript.get("sentences") or []
        for item in sentences:
            try:
                start = float(item.get("begin_time", 0)) / 1000.0
                end = float(item.get("end_time", 0)) / 1000.0
                text = str(item.get("text") or "").strip()
            except Exception:
                continue
            if not end > start:
                continue
            words: list[dict] = []
            for w in item.get("words") or []:
                try:
                    ws = float(w.get("begin_time", 0)) / 1000.0
                    we = float(w.get("end_time", 0)) / 1000.0
                    wt = str(w.get("text") or "")
                    punct = str(w.get("punctuation") or "")
                except Exception:
                    continue
                if we > ws:
                    words.append({"text": wt, "punctuation": punct, "start": round(ws, 3), "end": round(we, 3)})
            out.append({"text": text, "start": round(start, 3), "end": round(end, 3), "words": words})
    out.sort(key=lambda x: (x["start"], x["end"]))
    return out


def local_display_segments(text: str, max_chars: int | None = None) -> list[str]:
    max_chars = max_chars or int(os.environ.get("SUBTITLE_DISPLAY_MAX_CHARS", "18"))
    min_chars = int(os.environ.get("SUBTITLE_DISPLAY_MIN_CHARS", "7"))
    return _alignment.local_display_segments(
        text,
        max_chars=max_chars,
        min_chars=min_chars,
    )


def project_segments_to_original(raw: str, segments: list[str], max_chars: int) -> list[str]:
    return _alignment.project_segments_to_original(
        raw,
        segments,
        max_chars,
        hide_punctuation=env_bool("SUBTITLE_HIDE_PUNCTUATION", False),
        strip_trailing_punctuation=env_bool("SUBTITLE_STRIP_TRAILING_PUNCTUATION", True),
    )


def llm_display_segments(text: str, max_chars: int | None = None) -> list[str]:
    """Use LLM to split original voiceover into standard subtitle chunks."""
    raw = (text or "").strip()
    if not raw:
        return []
    max_chars = max_chars or int(os.environ.get("SUBTITLE_DISPLAY_MAX_CHARS", "18"))
    if call_qwen is None:
        return local_display_segments(raw, max_chars=max_chars)

    system = load_prompt_template("subtitle_split.md").strip()
    try:
        obj = call_qwen(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps({"subtitle": raw}, ensure_ascii=False)},
            ],
            temperature=0.0,
        )
        segments = obj.get("segments") or []
        if not isinstance(segments, list):
            raise ValueError("segments is not list")
        segments = [str(x).strip() for x in segments if str(x).strip()]
        validate_standard_segments(segments, raw, max_chars)
        return project_segments_to_original(raw, segments, max_chars)
    except (Exception, SystemExit) as exc:
        print(f"[警告] 大模型字幕拆分失败，使用规则拆分: {exc}")
        return local_display_segments(raw, max_chars=max_chars)


def display_segments_from_original(original_text: str) -> list[str]:
    """Split original subtitle text into display segments without ASR assumptions."""
    original_sentences = split_subtitle_sentences(original_text, max_chars=9999)
    if not original_sentences:
        original_sentences = [original_text]
    all_segments: list[str] = []
    for sentence in original_sentences:
        segs = llm_display_segments(sentence)
        all_segments.extend(segs)
    return all_segments


def llm_spoken_segments_for_timing(display_segments: list[str], spoken_text: str) -> list[str]:
    if call_qwen is None:
        raise ValueError("call_qwen unavailable")
    system = load_prompt_template("subtitle_timing_map.md").strip()
    obj = call_qwen(
        [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": json.dumps(
                    {"display_segments": display_segments, "spoken_text": spoken_text},
                    ensure_ascii=False,
                ),
            },
        ],
        temperature=0.0,
    )
    segments = obj.get("segments") or []
    if not isinstance(segments, list):
        raise ValueError("timing segments is not list")
    segments = [str(item).strip() for item in segments]
    validate_timing_segments(segments, spoken_text, len(display_segments))
    return segments


def timing_segments_for_display(display_segments: list[str], original_text: str, spoken_text: str) -> list[str]:
    spoken_text = (spoken_text or "").strip()
    if not spoken_text:
        return display_segments
    if normalize_content_for_compare(spoken_text) == normalize_content_for_compare(original_text):
        return display_segments

    try:
        return llm_spoken_segments_for_timing(display_segments, spoken_text)
    except (Exception, SystemExit) as exc:
        print(f"[警告] 大模型口播时间片段映射失败，使用比例映射: {exc}")

    weights = [cue_weight(segment) for segment in display_segments]
    parts = split_text_by_weights(spoken_text, weights)
    try:
        validate_timing_segments(parts, spoken_text, len(display_segments))
        return parts
    except Exception:
        return display_segments


def distribute_segments(
    segments: list[str],
    start: float,
    end: float,
    words: list[dict] | None = None,
    timing_segments: list[str] | None = None,
) -> list[dict]:
    return _alignment.distribute_segments(
        segments,
        start,
        end,
        words,
        timing_segments,
        min_duration=float(os.environ.get("SUBTITLE_MIN_DURATION", "0.45")),
    )


def fix_cue_timing(cues: list[dict], start: float, end: float) -> list[dict]:
    return _alignment.fix_cue_timing(
        cues,
        start,
        end,
        min_duration=float(os.environ.get("SUBTITLE_MIN_DURATION", "0.45")),
    )


def subtitle_display_text(text: str) -> str:
    return _alignment.subtitle_display_text(
        text,
        hide_punctuation=env_bool("SUBTITLE_HIDE_PUNCTUATION", False),
        strip_trailing_punctuation=env_bool("SUBTITLE_STRIP_TRAILING_PUNCTUATION", True),
    )


def apply_display_format(cues: list[dict]) -> list[dict]:
    return _alignment.apply_display_format(
        cues,
        hide_punctuation=env_bool("SUBTITLE_HIDE_PUNCTUATION", False),
        strip_trailing_punctuation=env_bool("SUBTITLE_STRIP_TRAILING_PUNCTUATION", True),
    )


def standard_cues_for_span(
    original_text: str,
    start: float,
    end: float,
    *,
    spoken_text: str = "",
    words: list[dict] | None = None,
) -> list[dict]:
    """Create standard display subtitle cues for a known audio span."""
    original_text = (original_text or "").strip()
    if not original_text or end <= start:
        return []
    display_segments = display_segments_from_original(original_text)
    if not display_segments:
        return []
    timing_segments = timing_segments_for_display(display_segments, original_text, spoken_text)
    cues = distribute_segments(display_segments, start, end, words, timing_segments=timing_segments)
    return apply_display_format([c for c in cues if str(c.get("text") or "").strip()])


def cues_from_asr(asr_sentences: list[dict], original_text: str, spoken_text: str = "") -> list[dict]:
    """Use original subtitle text and align it against the full ASR timeline.

    ASR sentence boundaries are model output, not a stable contract. The
    original text is the source of truth for display; ASR only provides timing.
    """
    original_text = (original_text or "").strip()
    if not asr_sentences or not original_text:
        return []

    all_segments = display_segments_from_original(original_text)
    if not all_segments:
        return []

    start = float(asr_sentences[0]["start"])
    end = float(asr_sentences[-1]["end"])
    words: list[dict] = []
    for asr in asr_sentences:
        words.extend(sentence_words(asr))

    return standard_cues_for_span(original_text, start, end, spoken_text=spoken_text, words=words)

def align_voice_to_subtitle(audio_path: Path, original_text: str, *, spoken_text: str = "", cache_path: Path | None = None) -> tuple[list[dict], dict]:
    load_dotenv()
    audio_path = Path(audio_path)
    if not audio_path.exists():
        raise SystemExit(f"音频不存在，无法 ASR 打轴: {audio_path}")
    cache_path = cache_path or audio_path.with_suffix(".asr.json")
    meta = {
        "align_version": 10,
        "subtitle_hide_punctuation": env_bool("SUBTITLE_HIDE_PUNCTUATION", False),
        "subtitle_strip_trailing_punctuation": env_bool("SUBTITLE_STRIP_TRAILING_PUNCTUATION", True),
        "subtitle_display_max_chars": os.environ.get("SUBTITLE_DISPLAY_MAX_CHARS", "18"),
        "subtitle_display_min_chars": os.environ.get("SUBTITLE_DISPLAY_MIN_CHARS", "7"),
        "audio": str(audio_path),
        "audio_mtime": audio_path.stat().st_mtime,
        "audio_size": audio_path.stat().st_size,
        "original_text": original_text,
        "spoken_text": spoken_text,
    }
    if cache_path.exists() and not env_bool("DASHSCOPE_ASR_FORCE", False):
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            cached_meta = cached.get("meta") or {}
            if cached_meta == meta:
                print(f"使用已有 ASR 打轴缓存: {cache_path}")
                cues = cached.get("cues") or []
                return cues if isinstance(cues, list) else [], cached

            same_audio_text = all(
                cached_meta.get(k) == meta.get(k)
                for k in ("audio", "audio_mtime", "audio_size", "original_text", "spoken_text")
            )
            if same_audio_text:
                raw_transcription = ((cached.get("raw") or {}).get("transcription") or {})
                asr_sentences = extract_asr_sentences(raw_transcription) if raw_transcription else (cached.get("asr_sentences") or [])
                if asr_sentences:
                    print(f"使用 ASR 原始结果缓存，重新生成字幕时间轴: {cache_path}")
                    cues = cues_from_asr(asr_sentences, original_text, spoken_text=spoken_text)
                    payload = dict(cached)
                    payload["meta"] = meta
                    payload["asr_sentences"] = asr_sentences
                    payload["cues"] = cues
                    atomic_write_json(cache_path, payload)
                    return cues, payload
        except Exception as exc:
            print(f"[警告] 读取 ASR 缓存失败，将重新打轴: {exc}")

    file_url = upload_audio(audio_path)
    task_id = submit_asr_task(file_url, corpus_text=spoken_text or original_text)
    raw = wait_asr_task(task_id)
    asr_sentences = extract_asr_sentences(raw.get("transcription") or {})
    cues = cues_from_asr(asr_sentences, original_text, spoken_text=spoken_text)
    payload = {"meta": meta, "file_url": file_url, "task_id": task_id, "asr_sentences": asr_sentences, "cues": cues, "raw": raw}
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(cache_path, payload)
    print(f"ASR 打轴结果已缓存: {cache_path}")
    return cues, payload


def main() -> None:
    load_dotenv()
    ap = argparse.ArgumentParser(description="Align subtitle cues by Alibaba DashScope ASR timestamps")
    ap.add_argument("--audio", required=True)
    ap.add_argument("--subtitle", required=True, help="original subtitle text")
    ap.add_argument("--spoken-text", default="", help="text actually sent to TTS")
    ap.add_argument("--output-cues", default="")
    ap.add_argument("--cache", default="")
    args = ap.parse_args()

    cues, _ = align_voice_to_subtitle(
        Path(args.audio),
        args.subtitle,
        spoken_text=args.spoken_text,
        cache_path=Path(args.cache) if args.cache else None,
    )
    if args.output_cues:
        out = Path(args.output_cues)
        atomic_write_json(out, cues)
        print(f"字幕时间轴已写入: {out}")
    else:
        print(json.dumps(cues, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
