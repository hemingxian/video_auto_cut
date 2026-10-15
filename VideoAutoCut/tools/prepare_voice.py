#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent))

import tts_term_rules as _term_rules
from common import find_ffmpeg, load_dotenv, load_prompt_template, split_subtitle_sentences, strict_bool, temp_path
from json_io import atomic_write_json
from tts_dashscope import synthesize

try:
    from optimize_queries import call_qwen
except Exception:
    call_qwen = None

try:
    from align_subtitles import align_voice_to_subtitle, standard_cues_for_span
except Exception:
    align_voice_to_subtitle = None
    standard_cues_for_span = None

from shot_plan_schema import normalize_shot_plan



def emit_workflow_progress(current: int, total: int, label: str) -> None:
    print(
        "VACUT_EVENT:"
        + json.dumps(
            {
                "kind": "workflow",
                "workflowStage": "voice",
                "workflowProgress": {
                    "stage": "voice",
                    "current": current,
                    "total": total,
                    "label": label,
                },
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def find_ffprobe() -> str:
    ffmpeg = Path(find_ffmpeg())
    if ffmpeg.name.lower() == "ffmpeg.exe":
        ffprobe = ffmpeg.with_name("ffprobe.exe")
        if ffprobe.exists():
            return str(ffprobe)
    root = Path(__file__).resolve().parents[1]
    candidates = [
        root / "ffmpeg" / "bin" / "ffprobe.exe",
        root / "ffprobe.exe",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return "ffprobe"


def audio_duration_seconds(path: Path) -> float:
    cmd = [
        find_ffprobe(),
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    out = subprocess.check_output(cmd, text=True, encoding="utf-8", errors="replace").strip()
    return max(0.1, float(out))




_TTS_TEXT_CACHE_VERSION = 9
_TTS_TEXT_CACHE: dict[str, str] = {}
_TTS_TERM_SPECS: dict[str, dict[str, str]] = {}
_TTS_TEXT_CACHE_PATH: Path | None = None
_ENGLISH_TERM_PATTERN = _term_rules.ENGLISH_TERM_PATTERN
_CMU_VOWELS = _term_rules.CMU_VOWELS
_CMU_CONSONANTS = _term_rules.CMU_CONSONANTS
normalize_cmu_phonemes = _term_rules.normalize_cmu_phonemes


def load_tts_text_cache(voice_dir: Path) -> None:
    """Cache LLM-normalized spoken text so reruns do not repeatedly call Qwen."""
    global _TTS_TEXT_CACHE, _TTS_TERM_SPECS, _TTS_TEXT_CACHE_PATH
    _TTS_TEXT_CACHE_PATH = voice_dir / "tts_text_cache.json"
    if _TTS_TEXT_CACHE_PATH.exists():
        try:
            data = json.loads(_TTS_TEXT_CACHE_PATH.read_text(encoding="utf-8"))
            if (
                isinstance(data, dict)
                and data.get("version") == _TTS_TEXT_CACHE_VERSION
                and isinstance(data.get("items"), dict)
            ):
                _TTS_TEXT_CACHE = {str(k): str(v) for k, v in data["items"].items()}
                if isinstance(data.get("term_specs"), dict):
                    _TTS_TERM_SPECS = {
                        str(k).lower(): {
                            "text": str(v.get("text") or k),
                            "mode": str(v.get("mode") or ""),
                            "value": str(v.get("value") or ""),
                        }
                        for k, v in data["term_specs"].items()
                        if isinstance(v, dict) and str(k).strip()
                    }
        except Exception:
            _TTS_TEXT_CACHE = {}
            _TTS_TERM_SPECS = {}


def save_tts_text_cache() -> None:
    if _TTS_TEXT_CACHE_PATH is None:
        return
    try:
        atomic_write_json(
            _TTS_TEXT_CACHE_PATH,
            {
                "version": _TTS_TEXT_CACHE_VERSION,
                "items": _TTS_TEXT_CACHE,
                "term_specs": _TTS_TERM_SPECS,
            },
        )
    except Exception as exc:
        print(f"[警告] 保存口播文本解析缓存失败: {exc}")


def plain_tts_read_text(text: str) -> str:
    """Return source text unchanged when LLM pronunciation normalization is unavailable."""
    return text


def tts_env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name, "").strip().lower()
    if not value:
        return default
    if value in {"1", "true", "yes", "y", "on"}:
        return True
    if value in {"0", "false", "no", "n", "off"}:
        return False
    return default


has_english_or_brand_token = _term_rules.has_english_or_brand_token
extract_english_terms = _term_rules.extract_english_terms
merge_english_terms = _term_rules.merge_english_terms
spelled_non_acronym_terms = _term_rules.spelled_non_acronym_terms
find_spelled_non_acronym = _term_rules.find_spelled_non_acronym
term_plain_reading = _term_rules.term_plain_reading
term_spec_summary = _term_rules.term_spec_summary
invalid_term_reading_reason = _term_rules.invalid_term_reading_reason
unresolved_term_details = _term_rules.unresolved_term_details
is_cjk_char = _term_rules.is_cjk_char
should_inline_character_term = _term_rules.should_inline_character_term


def needs_tts_term_readings(text: str) -> bool:
    """Only Chinese narration needs explicit readings for embedded English terms."""
    return any(is_cjk_char(char) for char in text) and has_english_or_brand_token(text)


def _allow_text_substitution() -> bool:
    return tts_env_bool("TTS_ALLOW_TEXT_SUBSTITUTION", False)


def normalize_term_spec(term: dict[str, str], item: dict) -> tuple[dict[str, str] | None, str | None]:
    return _term_rules.normalize_term_spec(
        term,
        item,
        allow_text_substitution=_allow_text_substitution(),
    )


def term_spec_error(term: dict[str, str], spec: dict[str, str] | None) -> str | None:
    return _term_rules.term_spec_error(
        term,
        spec,
        allow_text_substitution=_allow_text_substitution(),
    )


def term_ssml(token: str, spec: dict[str, str]) -> str:
    try:
        return _term_rules.term_ssml(token, spec)
    except _term_rules.TtsTermError as exc:
        raise SystemExit(str(exc)) from exc


def ensure_tts_text_resolved(text: str, label: str) -> None:
    try:
        _term_rules.ensure_text_resolved(text, label)
    except _term_rules.TtsTermError as exc:
        raise SystemExit(str(exc)) from exc


def call_tts_term_model(
    terms: list[dict[str, str]],
    context_texts: list[str],
    previous_errors: list[dict[str, str]] | None = None,
) -> dict[str, dict[str, str]]:
    if call_qwen is None or not terms:
        return {}
    system = load_prompt_template("tts_term_readings.md").strip()
    payload = {
        "english_terms": terms,
        "context_samples": context_texts[:12],
    }
    if previous_errors:
        payload["previous_errors"] = previous_errors
    obj = call_qwen(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        temperature=0.0,
    )
    raw_readings = obj.get("readings") or []
    return _term_rules.normalize_model_readings(
        terms,
        raw_readings,
        allow_text_substitution=_allow_text_substitution(),
    )


def prepare_tts_term_readings(texts: list[str]) -> None:
    term_texts = [text for text in texts if needs_tts_term_readings(text)]
    all_terms = merge_english_terms(term_texts)
    if not all_terms:
        return

    if not tts_env_bool("TTS_LLM_PRONUNCIATION", True):
        raise SystemExit(
            f"TTS_LLM_PRONUNCIATION=false，但口播中存在需要确认读法的英文术语: {unresolved_term_details(all_terms)}"
        )
    if call_qwen is None:
        raise SystemExit("大模型口播术语读法不可用，无法确认英文术语读法")

    missing_terms: list[dict[str, str]] = []
    for item in all_terms:
        key = item["text"].lower()
        if key in _TTS_TERM_SPECS and not term_spec_error(item, _TTS_TERM_SPECS[key]):
            continue
        missing_terms.append(item)

    unresolved = missing_terms
    previous_errors: list[dict[str, str]] = []
    last_error: BaseException | None = None
    for attempt in range(1, 4):
        if not unresolved:
            break
        try:
            specs = call_tts_term_model(unresolved, term_texts, previous_errors)
            previous_errors = []
            for item in unresolved:
                key = item["text"].lower()
                spec = specs.get(key)
                reason = term_spec_error(item, spec)
                if reason:
                    previous_errors.append(
                        {
                            "text": item["text"],
                            "kind": item["kind"],
                            "returned": term_spec_summary(spec) if spec else "",
                            "reason": reason,
                        }
                    )
                    continue
                _TTS_TERM_SPECS[key] = spec
            unresolved = [
                item
                for item in unresolved
                if item["text"].lower() not in _TTS_TERM_SPECS
                or term_spec_error(item, _TTS_TERM_SPECS[item["text"].lower()])
            ]
            if unresolved:
                action = "将重试" if attempt < 3 else "已达到重试上限"
                print(f"[警告] TTS 术语读法第 {attempt}/3 次结果不完整，{action}: {unresolved_term_details(unresolved)}")
        except SystemExit as exc:
            last_error = exc
            action = "将重试" if attempt < 3 else "已达到重试上限"
            print(f"[警告] TTS 术语读法第 {attempt}/3 次失败，{action}: {exc}")
        except Exception as exc:
            last_error = exc
            action = "将重试" if attempt < 3 else "已达到重试上限"
            print(f"[警告] TTS 术语读法第 {attempt}/3 次失败，{action}: {exc}")

    if unresolved:
        suffix = f"；最后错误: {last_error}" if last_error else ""
        raise SystemExit(f"TTS 术语读法未确认: {unresolved_term_details(unresolved)}{suffix}")

    save_tts_text_cache()
    if _TTS_TERM_SPECS:
        print(f"TTS term SSML specs: {len(_TTS_TERM_SPECS)}")


def apply_tts_term_readings(text: str) -> str:
    if _term_rules.is_english_narration(text):
        return text
    try:
        return _term_rules.apply_term_readings(
            text,
            _TTS_TERM_SPECS,
            allow_text_substitution=_allow_text_substitution(),
        )
    except _term_rules.TtsTermError as exc:
        raise SystemExit(str(exc)) from exc


def has_unresolved_english_terms(text: str) -> bool:
    if _term_rules.is_english_narration(text):
        return False
    return _term_rules.has_unresolved_terms(
        text,
        _TTS_TERM_SPECS,
        allow_text_substitution=_allow_text_substitution(),
    )


def build_tts_ssml(text: str) -> str | None:
    if not needs_tts_term_readings(text):
        return None
    try:
        return _term_rules.build_ssml(
            text,
            _TTS_TERM_SPECS,
            enable_ssml=tts_env_bool("TTS_ENABLE_SSML", True),
            allow_text_substitution=_allow_text_substitution(),
        )
    except _term_rules.TtsTermError as exc:
        raise SystemExit(str(exc)) from exc


def tts_request_text(text: str) -> tuple[str, str, bool]:
    spoken_text = tts_read_text(text)
    ssml_text = build_tts_ssml(text)
    if ssml_text:
        return spoken_text, ssml_text, True
    return spoken_text, spoken_text, False


def call_tts_text_model(raw: str, extra_instruction: str = "", invalid_terms: list[str] | None = None) -> str:
    system = load_prompt_template("tts_read_text.md").strip()
    if extra_instruction:
        system = f"{system}\n\n{extra_instruction.strip()}"
    payload = {
        "subtitle_text": raw,
        "english_terms": extract_english_terms(raw),
        "term_specs": _TTS_TERM_SPECS,
    }
    if invalid_terms:
        payload["invalid_terms"] = invalid_terms
    obj = call_qwen(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        temperature=0.0,
    )
    return str(obj.get("spoken_text") or "").strip()


def llm_tts_read_text(text: str) -> str:
    """Use Qwen to convert subtitle text into text that TTS can pronounce naturally.

    Subtitle text remains original. Only this returned text is sent to TTS.
    """
    raw = (text or "").strip()
    if not raw or not needs_tts_term_readings(raw):
        return raw
    normalized = apply_tts_term_readings(raw)
    if raw in _TTS_TEXT_CACHE:
        cached = _TTS_TEXT_CACHE[raw]
        if not has_unresolved_english_terms(raw):
            return cached
        del _TTS_TEXT_CACHE[raw]
    if not has_unresolved_english_terms(raw):
        _TTS_TEXT_CACHE[raw] = normalized
        save_tts_text_cache()
        print(f"口播文本解析: {raw} -> {normalized}")
        return normalized
    if not has_english_or_brand_token(normalized):
        return raw
    if call_qwen is None:
        return plain_tts_read_text(normalized)

    try:
        spoken = call_tts_text_model(normalized)
        bad_terms = spelled_non_acronym_terms(normalized, spoken)
        if bad_terms:
            spoken = call_tts_text_model(
                normalized,
                (
                    "上一次结果里有普通英文词、技术名词或产品名被拆成了逐字母读法。"
                    "这类词不允许字母朗读；只有 english_terms 中 kind=acronym 的项目才允许字母朗读。"
                    "请保留 invalid_terms 里的英文原词，具体发音由 term_specs 的 SSML 控制。"
                ),
                invalid_terms=bad_terms,
            )
            bad_terms = spelled_non_acronym_terms(normalized, spoken)
            if bad_terms:
                raise SystemExit(f"大模型仍把普通英文词拆成字母读法: {', '.join(bad_terms[:5])}")
        if not spoken:
            raise SystemExit("大模型口播解析结果为空")
        elif len(spoken) > max(80, len(raw) * 3):
            raise SystemExit(f"大模型口播解析结果过长: {spoken[:80]}...")
        ensure_tts_text_resolved(spoken, "大模型口播解析结果")
        _TTS_TEXT_CACHE[raw] = spoken
        save_tts_text_cache()
        if spoken != raw:
            print(f"口播文本解析: {raw} -> {spoken}")
        return spoken
    except SystemExit as exc:
        raise SystemExit(f"大模型口播解析失败: {exc}") from exc
    except Exception as exc:
        raise SystemExit(f"大模型口播解析失败: {exc}") from exc


def tts_read_text(text: str) -> str:
    """Return the text actually sent to TTS.

    Default: use Qwen for English terms embedded in Chinese narration.
    English narration is sent directly to TTS without pronunciation rewriting.
    Set TTS_LLM_PRONUNCIATION=false in .env to disable it.
    """
    if _term_rules.is_english_narration(text):
        return (text or "").strip()
    if tts_env_bool("TTS_LLM_PRONUNCIATION", True):
        return llm_tts_read_text(text)
    return plain_tts_read_text(text)

def shot_voice_text(shot: dict) -> str:
    if not strict_bool(shot.get("voiceover"), "shot.voiceover", True):
        return ""
    return str(shot.get("voice_text") or "").strip()


def ffmpeg_concat_mp3(parts: list[Path], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    list_path = temp_path(output.stem, ".concat.txt", subdir="concat")
    lines = []
    for part in parts:
        path = str(part.resolve()).replace("\\", "/").replace("'", "'\\''")
        lines.append(f"file '{path}'")
    list_path.write_text("\n".join(lines), encoding="utf-8")
    cmd = [
        find_ffmpeg(),
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_path),
        "-c",
        "copy",
        str(output),
    ]
    subprocess.run(cmd, check=True)


def synthesize_sentence_mode(text: str, out: Path, sent_dir: Path, shot_idx: int) -> tuple[float, list[dict]]:
    sentences = split_subtitle_sentences(text, max_chars=int(os.environ.get("SUBTITLE_MAX_CHARS", "18")))
    if not sentences:
        sentences = [text]
    sent_dir.mkdir(parents=True, exist_ok=True)

    parts: list[Path] = []
    cues: list[dict] = []
    cursor = 0.0
    gap = float(os.environ.get("TTS_SENTENCE_GAP", "0"))

    for sent_idx, sentence in enumerate(sentences, 1):
        part = sent_dir / f"{shot_idx:04d}_{sent_idx:02d}.mp3"
        text_meta = part.with_suffix(".txt")
        ssml_meta = part.with_suffix(".tts.txt")
        spoken_text, tts_text, enable_ssml = tts_request_text(sentence)
        old_text = text_meta.read_text(encoding="utf-8", errors="ignore") if text_meta.exists() else ""
        old_tts_text = ssml_meta.read_text(encoding="utf-8", errors="ignore") if ssml_meta.exists() else ""
        need_regen = (
            not part.exists()
            or part.stat().st_size <= 1024
            or old_text != spoken_text
            or old_tts_text != tts_text
        )
        if need_regen:
            print(f"生成口播分句 #{shot_idx:02d}.{sent_idx:02d}: {sentence}")
            synthesize(tts_text, part, enable_ssml=enable_ssml)
            text_meta.write_text(spoken_text, encoding="utf-8")
            ssml_meta.write_text(tts_text, encoding="utf-8")
        else:
            print(f"口播分句已存在 #{shot_idx:02d}.{sent_idx:02d}: {part}")
        dur = audio_duration_seconds(part)
        start = cursor
        end = cursor + dur
        sentence_cues: list[dict] = []
        if standard_cues_for_span is not None:
            try:
                sentence_cues = standard_cues_for_span(sentence, start, end, spoken_text=spoken_text)
            except Exception as exc:
                print(f"[警告] 标准字幕拆分失败，保留整句字幕 #{shot_idx:02d}.{sent_idx:02d}: {exc}")
        if sentence_cues:
            for cue in sentence_cues:
                cue["audio"] = str(part)
            cues.extend(sentence_cues)
        else:
            cues.append({"text": sentence, "start": round(start, 3), "end": round(end, 3), "audio": str(part)})
        cursor = end + gap
        parts.append(part)

    ffmpeg_concat_mp3(parts, out)
    total = audio_duration_seconds(out) if out.exists() else cursor
    return total, cues


def main() -> None:
    load_dotenv()
    ap = argparse.ArgumentParser(description="Generate voiceover first, then update shots.json durations")
    ap.add_argument("--shots-json", required=True)
    ap.add_argument("--voice-dir", required=True)
    ap.add_argument("--no-voiceover", action="store_true")
    ap.add_argument("--min-duration", type=float, default=1.0)
    args = ap.parse_args()

    shots_path = Path(args.shots_json)
    voice_dir = Path(args.voice_dir)
    voice_dir.mkdir(parents=True, exist_ok=True)
    load_tts_text_cache(voice_dir)
    sentence_mode = tts_env_bool("TTS_SENTENCE_MODE", True)
    sent_root = voice_dir / "sentences"

    plan = json.loads(shots_path.read_text(encoding="utf-8-sig"))
    shots = plan.get("shots") or []
    if not isinstance(shots, list):
        raise SystemExit("shots.json 格式错误：shots 不是数组")

    total = len(shots)
    emit_workflow_progress(0, total, f"准备口播 0/{total}")
    print(f"口播准备: 共 {total} 个分镜", flush=True)
    voice_texts = [
        shot_voice_text(shot)
        for shot in shots
        if isinstance(shot, dict) and shot_voice_text(shot)
    ]
    if voice_texts and not args.no_voiceover:
        prepare_tts_term_readings(voice_texts)

    for idx, shot in enumerate(shots, 1):
        if not isinstance(shot, dict):
            continue
        text = shot_voice_text(shot)
        out = voice_dir / f"{idx:04d}_voice.mp3"
        emit_workflow_progress(idx - 1, total, f"正在处理 {idx}/{total}")
        print(f"口播准备 #{idx:02d}/{total:02d}: {'需要生成' if text and not args.no_voiceover else '跳过'}", flush=True)
        if args.no_voiceover or not text:
            old = float(shot.get("duration") or 4)
            shot["duration"] = int(max(args.min_duration, math.ceil(old)))
            shot.pop("voice_audio", None)
            shot.pop("subtitle_cues", None)
            shot.pop("subtitle_cues_file", None)
            emit_workflow_progress(idx, total, f"已完成 {idx}/{total}")
            continue

        if sentence_mode:
            dur, cues = synthesize_sentence_mode(text, out, sent_root / f"{idx:04d}", idx)
            shot["subtitle_cues"] = cues
            cues_path = voice_dir / f"{idx:04d}_cues.json"
            atomic_write_json(cues_path, cues)
            shot["subtitle_cues_file"] = str(cues_path)
        else:
            spoken_text, tts_text, enable_ssml = tts_request_text(text)
            text_meta = out.with_suffix(".txt")
            ssml_meta = out.with_suffix(".tts.txt")
            old_text = text_meta.read_text(encoding="utf-8", errors="ignore") if text_meta.exists() else ""
            old_tts_text = ssml_meta.read_text(encoding="utf-8", errors="ignore") if ssml_meta.exists() else ""
            need_regen = (
                not out.exists()
                or out.stat().st_size <= 1024
                or old_text != spoken_text
                or old_tts_text != tts_text
            )
            if need_regen:
                print(f"生成整段口播 #{idx:02d}: {out}")
                synthesize(tts_text, out, enable_ssml=enable_ssml)
                text_meta.write_text(spoken_text, encoding="utf-8")
                ssml_meta.write_text(tts_text, encoding="utf-8")
            else:
                print(f"整段口播已存在 #{idx:02d}: {out}")
            dur = audio_duration_seconds(out)

            if align_voice_to_subtitle is None:
                raise SystemExit("align_subtitles.py 不可用，无法调用阿里 ASR 打轴")

            try:
                cues, _raw = align_voice_to_subtitle(
                    out,
                    text,
                    spoken_text=spoken_text,
                    cache_path=voice_dir / f"{idx:04d}_asr_result.json",
                )
                if cues:
                    shot["subtitle_cues"] = cues
                    cues_path = voice_dir / f"{idx:04d}_cues.json"
                    atomic_write_json(cues_path, cues)
                    shot["subtitle_cues_file"] = str(cues_path)
                    print(f"分镜 #{idx:02d} 已生成 ASR 字幕时间轴: {cues_path}")
                else:
                    raise RuntimeError("ASR 没有返回可用句子")
            except Exception as exc:
                raise SystemExit(f"分镜 #{idx:02d} ASR 打轴失败: {exc}") from exc

        # 稍微多留一点尾音余量，避免最后一个字被截断。
        shot["duration"] = int(max(args.min_duration, math.ceil(dur + 0.25)))
        shot["voice_audio"] = str(out)
        print(f"分镜 #{idx:02d} 音频时长: {dur:.2f}s，视频时长设置为: {shot['duration']}s")
        emit_workflow_progress(idx, total, f"已完成 {idx}/{total}")

    plan = normalize_shot_plan(plan)
    atomic_write_json(shots_path, plan)
    emit_workflow_progress(total, total, "口播完成")
    print(f"已回写分镜时长: {shots_path}")


if __name__ == "__main__":
    main()
