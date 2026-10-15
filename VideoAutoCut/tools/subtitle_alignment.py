#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pure subtitle segmentation, projection, and cue timeline algorithms."""
from __future__ import annotations

import math
import re


_PUNCTUATION = r"[、，,。！？!?；;：:.…\"'“”‘’（）()《》<>\[\]【】]"


def _finite_float(value: object, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return parsed if math.isfinite(parsed) else default


def normalize_content_for_compare(text: str) -> str:
    """Compare content while ignoring whitespace and display punctuation."""
    compact = re.sub(r"\s+", "", text or "")
    return re.sub(_PUNCTUATION + "+", "", compact)


def normalized_units_with_indices(text: str) -> list[tuple[str, int]]:
    units: list[tuple[str, int]] = []
    for index, character in enumerate(text or ""):
        if character.isspace() or re.match(_PUNCTUATION, character):
            continue
        units.append((character.lower(), index))
    return units


def boundary_after_normalized_units(
    raw: str,
    units: list[tuple[str, int]],
    count: int,
) -> int:
    if count <= 0:
        return 0
    if count >= len(units):
        return len(raw)
    index = units[count - 1][1] + 1
    while index < len(raw) and (
        raw[index].isspace() or re.match(_PUNCTUATION, raw[index])
    ):
        index += 1
    return index


def visible_len(text: str) -> int:
    return sum(1 for character in (text or "") if not character.isspace())


def cue_weight(text: str) -> float:
    weight = 0.0
    for character in text or "":
        if character.isspace():
            continue
        if character in "。！？!?；;":
            weight += 1.2
        elif character in "，,、：:":
            weight += 0.7
        elif character.isascii() and character.isalnum():
            weight += 0.55
        else:
            weight += 1.0
    return max(1.0, weight)


def pack_parts(parts: list[str], max_chars: int, min_chars: int) -> list[str]:
    output: list[str] = []
    current = ""
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if not current:
            current = part
            continue
        if visible_len(current + part) <= max_chars or visible_len(current) < min_chars:
            current += part
        else:
            output.append(current)
            current = part
    if current:
        output.append(current)
    return output


def hard_split_long_text(text: str, max_chars: int) -> list[str]:
    """Split long text while keeping ASCII/proper-noun tokens intact."""
    if max_chars <= 0:
        raise ValueError("max_chars must be positive")
    units = re.findall(r"[A-Za-z0-9][A-Za-z0-9._+-]*|\s+|.", text, flags=re.S)
    output: list[str] = []
    current = ""
    for unit in units:
        candidate = current + unit
        if visible_len(candidate) > max_chars and current and not re.fullmatch(r"\s+", unit):
            output.append(current)
            current = unit.lstrip()
        else:
            current = candidate
    if current:
        output.append(current)
    return output


def _strong_sentence_parts(text: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", (text or "").strip())
    if not normalized:
        return []
    return [
        part.strip()
        for part in re.findall(r"[^。！？!?；;]+[。！？!?；;]?", normalized)
        if part.strip()
    ]


def local_display_segments(
    text: str,
    *,
    max_chars: int = 18,
    min_chars: int = 7,
) -> list[str]:
    """Split original text into readable chunks without rewriting it."""
    if max_chars <= 0:
        raise ValueError("max_chars must be positive")
    min_chars = max(1, min_chars)
    strong_parts = _strong_sentence_parts(text) or [text]
    result: list[str] = []
    for sentence in strong_parts:
        sentence = sentence.strip()
        if not sentence:
            continue
        if visible_len(sentence) <= max_chars + 4:
            result.append(sentence)
            continue
        soft_parts = [
            part
            for part in re.findall(r"[^，,、：:]+[，,、：:]?", sentence)
            if part.strip()
        ]
        for chunk in pack_parts(soft_parts, max_chars=max_chars, min_chars=min_chars):
            if visible_len(chunk) <= max_chars + 4:
                result.append(chunk)
            else:
                result.extend(hard_split_long_text(chunk, max_chars=max_chars))
    return [item.strip() for item in result if item.strip()]


def segment_has_bad_boundary(segment: str) -> bool:
    normalized = (segment or "").strip()
    if not normalized:
        return True
    punctuation = "、，,。！？!?；;：:"
    return normalized[0] in punctuation or normalized[-1] in punctuation


def validate_standard_segments(segments: list[str], raw: str, max_chars: int) -> None:
    if not segments:
        raise ValueError("empty segments")
    if normalize_content_for_compare("".join(segments)) != normalize_content_for_compare(raw):
        raise ValueError("LLM segments changed original text")
    if len(segments) <= 1 and visible_len(raw) > max_chars + 4:
        raise ValueError("LLM did not split long subtitle")
    too_long = [segment for segment in segments if visible_len(segment) > max_chars + 4]
    if too_long:
        raise ValueError(f"segment too long: {too_long[0]}")
    bad = [segment for segment in segments if segment_has_bad_boundary(segment)]
    if bad:
        raise ValueError(f"bad subtitle boundary: {bad[0]}")


def subtitle_display_text(
    text: str,
    *,
    hide_punctuation: bool = False,
    strip_trailing_punctuation: bool = True,
) -> str:
    output = (text or "").strip()
    if hide_punctuation:
        output = re.sub(r"[、，,；;：:]+", " ", output)
        output = re.sub(r"[。！？!?.]+", "", output)
        return re.sub(r"\s+", " ", output).strip()
    if strip_trailing_punctuation:
        output = re.sub(r"[\s、，,。！？!?；;：:.…]+$", "", output).strip()
    return output


def project_segments_to_original(
    raw: str,
    segments: list[str],
    max_chars: int,
    *,
    hide_punctuation: bool = False,
    strip_trailing_punctuation: bool = True,
) -> list[str]:
    """Use chosen normalized boundaries while slicing text from the original."""
    raw_units = normalized_units_with_indices(raw)
    segment_lengths = [len(normalized_units_with_indices(segment)) for segment in segments]
    if not raw_units or sum(segment_lengths) != len(raw_units):
        raise ValueError("LLM segments cannot be projected to original text")

    projected: list[str] = []
    cursor = 0
    raw_start = 0
    for length in segment_lengths:
        cursor += length
        raw_end = boundary_after_normalized_units(raw, raw_units, cursor)
        item = raw[raw_start:raw_end].strip()
        if not item:
            raise ValueError("empty projected segment")
        display = subtitle_display_text(
            item,
            hide_punctuation=hide_punctuation,
            strip_trailing_punctuation=strip_trailing_punctuation,
        )
        if visible_len(display) > max_chars + 4:
            raise ValueError(f"projected segment too long: {display}")
        if display and display[0] in "、，,。！？!?；;：:":
            raise ValueError(f"bad projected boundary: {display}")
        projected.append(item)
        raw_start = raw_end

    if normalize_content_for_compare("".join(projected)) != normalize_content_for_compare(raw):
        raise ValueError("projected segments changed original text")
    return projected


def sentence_words(asr_sentence: dict) -> list[dict]:
    words = asr_sentence.get("words") or []
    clean: list[dict] = []
    for word in words:
        if not isinstance(word, dict):
            continue
        try:
            start = float(word.get("start", 0))
            end = float(word.get("end", 0))
        except (TypeError, ValueError, OverflowError):
            continue
        if math.isfinite(start) and math.isfinite(end) and end > start:
            clean.append({"start": start, "end": end})
    return clean


def split_text_by_weights(text: str, weights: list[float]) -> list[str]:
    normalized = (text or "").strip()
    if not normalized or not weights:
        return []
    units = normalized_units_with_indices(normalized)
    if not units:
        return [normalized] + [""] * (len(weights) - 1)

    total_weight = sum(weights) or 1.0
    parts: list[str] = []
    raw_start = 0
    consumed = 0.0
    for index, weight in enumerate(weights):
        if index == len(weights) - 1:
            raw_end = len(normalized)
        else:
            consumed += weight
            target = int(round(consumed / total_weight * len(units)))
            remaining = len(weights) - index - 1
            target = max(target, index + 1)
            target = min(target, len(units) - remaining)
            raw_end = boundary_after_normalized_units(normalized, units, target)
        parts.append(normalized[raw_start:raw_end].strip())
        raw_start = raw_end
    return parts


def validate_timing_segments(
    segments: list[str],
    spoken_text: str,
    expected_count: int,
) -> None:
    if len(segments) != expected_count:
        raise ValueError("timing segment count mismatch")
    if normalize_content_for_compare("".join(segments)) != normalize_content_for_compare(spoken_text):
        raise ValueError("timing segments changed spoken text")


def fix_cue_timing(
    cues: list[dict],
    start: float,
    end: float,
    *,
    min_duration: float = 0.45,
) -> list[dict]:
    if not cues:
        return []
    if not math.isfinite(start) or not math.isfinite(end) or end <= start:
        raise ValueError("cue timeline end must be greater than start")
    min_duration = max(0.0, float(min_duration))
    average_duration = (end - start) / max(1, len(cues))
    if average_duration < min_duration:
        # The configured floor cannot be honored when the whole audio span is
        # shorter than floor * cue_count. Scale it down instead of producing
        # negative or reversed cue ranges.
        min_duration = max(0.0, average_duration * 0.85)
    previous_end = start
    for index, cue in enumerate(cues):
        remaining = len(cues) - index - 1
        latest_end = end - remaining * min_duration
        latest_start = max(previous_end, latest_end - min_duration)
        preferred_start = _finite_float(cue.get("start"), previous_end)
        cue_start = min(max(previous_end, preferred_start), latest_start)
        if index == len(cues) - 1:
            cue_end = end
        else:
            preferred_end = _finite_float(cue.get("end"), cue_start + min_duration)
            cue_end = min(
                max(preferred_end, cue_start + min_duration),
                latest_end,
            )
        cue["start"] = cue_start
        cue["end"] = max(cue_start, cue_end)
        previous_end = cue["end"]

    # Preserve the historical millisecond precision while clamping again so
    # rounding can never move a cue outside a sub-millisecond input span.
    previous_end = start
    for cue in cues:
        cue_start = min(end, max(start, previous_end, round(float(cue["start"]), 3)))
        cue_end = min(end, max(cue_start, round(float(cue["end"]), 3)))
        cue["start"] = cue_start
        cue["end"] = cue_end
        previous_end = cue_end
    cues[-1]["end"] = end
    return cues


def distribute_segments(
    segments: list[str],
    start: float,
    end: float,
    words: list[dict] | None = None,
    timing_segments: list[str] | None = None,
    *,
    min_duration: float = 0.45,
) -> list[dict]:
    segments = [segment for segment in segments if segment.strip()]
    if not segments or end <= start:
        return []
    if len(segments) == 1:
        return [
            {
                "text": segments[0],
                "start": round(start, 3),
                "end": round(end, 3),
                "source": "original_asr",
            }
        ]

    timing = timing_segments if timing_segments and len(timing_segments) == len(segments) else segments
    weights = [cue_weight(segment) for segment in timing]
    total_weight = sum(weights) or 1.0
    cues: list[dict] = []

    if words and len(words) >= len(segments):
        word_count = len(words)
        cursor_index = 0
        cumulative = 0.0
        for index, (segment, weight) in enumerate(zip(segments, weights)):
            if index == len(segments) - 1:
                next_index = word_count
            else:
                cumulative += weight
                target = int(round(cumulative / total_weight * word_count))
                minimum_remaining = len(segments) - index - 1
                next_index = max(
                    cursor_index + 1,
                    min(word_count - minimum_remaining, target),
                )
            start_word = words[cursor_index] if cursor_index < word_count else {}
            end_word = words[next_index - 1] if next_index - 1 < word_count else {}
            start_value = start_word.get("start") if isinstance(start_word, dict) else None
            end_value = end_word.get("end") if isinstance(end_word, dict) else None
            word_start = _finite_float(start_value, start)
            word_end = _finite_float(end_value, end)
            cues.append(
                {
                    "text": segment,
                    "start": round(max(start, word_start), 3),
                    "end": round(min(end, word_end), 3),
                    "source": "original_asr_words",
                }
            )
            cursor_index = next_index
        return fix_cue_timing(
            cues,
            start,
            end,
            min_duration=min_duration,
        )

    cursor = start
    cumulative = 0.0
    for index, (segment, weight) in enumerate(zip(segments, weights)):
        cumulative += weight
        next_time = (
            end
            if index == len(segments) - 1
            else start + (end - start) * (cumulative / total_weight)
        )
        cues.append(
            {
                "text": segment,
                "start": round(cursor, 3),
                "end": round(next_time, 3),
                "source": "original_asr_weight",
            }
        )
        cursor = next_time
    return fix_cue_timing(
        cues,
        start,
        end,
        min_duration=min_duration,
    )


def apply_display_format(
    cues: list[dict],
    *,
    hide_punctuation: bool = False,
    strip_trailing_punctuation: bool = True,
) -> list[dict]:
    formatted: list[dict] = []
    for cue in cues:
        copied = dict(cue)
        original = str(copied.get("text") or "")
        display = subtitle_display_text(
            original,
            hide_punctuation=hide_punctuation,
            strip_trailing_punctuation=strip_trailing_punctuation,
        )
        if not display:
            continue
        copied["original_text"] = original
        copied["text"] = display
        formatted.append(copied)
    return formatted
