#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pure English-term and SSML rules used by the voice preparation pipeline."""
from __future__ import annotations

import html
import re
from typing import Any


ENGLISH_TERM_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])"
    r"(?:[A-Za-z]+[A-Za-z0-9]*(?:[._+-][A-Za-z0-9]+)*|[0-9]+[A-Za-z][A-Za-z0-9]*(?:[._+-][A-Za-z0-9]+)*)"
    r"(?![A-Za-z0-9])"
)
CMU_VOWELS = frozenset(
    {"AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"}
)
CMU_CONSONANTS = frozenset(
    {
        "B",
        "CH",
        "D",
        "DH",
        "F",
        "G",
        "HH",
        "JH",
        "K",
        "L",
        "M",
        "N",
        "NG",
        "P",
        "R",
        "S",
        "SH",
        "T",
        "TH",
        "V",
        "W",
        "Y",
        "Z",
        "ZH",
    }
)


class TtsTermError(ValueError):
    """A deterministic term-policy failure safe to present to CLI users."""


def is_english_narration(text: str) -> bool:
    """Use the voice's native English reading, retaining mixed Chinese rules."""
    return bool(re.search(r"[A-Za-z]", text or "")) and not any(
        is_cjk_char(character) for character in text
    )


def normalize_cmu_phonemes(value: str) -> tuple[str | None, str | None]:
    tokens = re.split(r"\s+", value.strip().upper())
    if not tokens or tokens == [""]:
        return None, "phoneme_cmu 为空"
    normalized: list[str] = []
    for token in tokens:
        match = re.fullmatch(r"([A-Z]+)([0-2]?)", token)
        if not match:
            return None, f"非法 CMU 音素: {token}"
        base, stress = match.groups()
        if base in CMU_VOWELS:
            if not stress:
                return None, f"CMU 元音必须带重音数字 0/1/2: {token}"
            normalized.append(f"{base}{stress}")
            continue
        if base in CMU_CONSONANTS:
            if stress:
                return None, f"CMU 辅音不能带重音数字: {token}"
            normalized.append(base)
            continue
        return None, f"未知 CMU 音素: {token}"
    return " ".join(normalized), None


def has_english_or_brand_token(text: str) -> bool:
    return bool(re.search(r"[A-Za-z]", text or ""))


def extract_english_terms(text: str) -> list[dict[str, str]]:
    terms: list[dict[str, str]] = []
    seen: set[str] = set()
    for match in ENGLISH_TERM_PATTERN.finditer(text or ""):
        token = match.group(0)
        key = token.lower()
        if key in seen:
            continue
        seen.add(key)
        letters = re.sub(r"[^A-Za-z]", "", token)
        kind = "acronym" if letters and letters.upper() == letters else "term"
        terms.append({"text": token, "kind": kind})
    return terms


def merge_english_terms(texts: list[str]) -> list[dict[str, str]]:
    terms: list[dict[str, str]] = []
    seen: set[str] = set()
    for text in texts:
        for item in extract_english_terms(text):
            key = item["text"].lower()
            if key not in seen:
                seen.add(key)
                terms.append(item)
    return terms


def spelled_non_acronym_terms(source_text: str, spoken_text: str) -> list[str]:
    """Find ordinary English words incorrectly expanded letter by letter."""
    bad_terms: list[str] = []
    spoken = spoken_text.lower()
    for item in extract_english_terms(source_text):
        if item["kind"] == "acronym":
            continue
        token = item["text"]
        letters = [re.escape(character.lower()) for character in token if character.isalpha()]
        if len(letters) <= 1:
            continue
        pattern = r"(?<![a-z])" + r"\s+".join(letters) + r"(?![a-z])"
        if re.search(pattern, spoken):
            bad_terms.append(token)
    return bad_terms


def find_spelled_non_acronym(source_text: str, spoken_text: str) -> str | None:
    bad_terms = spelled_non_acronym_terms(source_text, spoken_text)
    return bad_terms[0] if bad_terms else None


def normalize_term_spec(
    term: dict[str, str],
    item: dict[str, Any],
    *,
    allow_text_substitution: bool = False,
) -> tuple[dict[str, str] | None, str | None]:
    text = str(term.get("text") or "").strip()
    mode = str(item.get("mode") or "").strip().lower().replace("-", "_")
    value = str(item.get("value") or item.get("ph") or item.get("spoken") or "").strip()

    if not mode and term.get("kind") == "acronym":
        mode = "characters"
    if mode in {"character", "chars", "spell", "spelling", "say_as_characters"}:
        mode = "characters"
    if mode in {"alias", "replace", "sub_alias"}:
        mode = "sub"
    if mode in {"cmu", "phoneme", "phoneme_en"}:
        mode = "phoneme_cmu"

    if mode == "characters":
        if not has_english_or_brand_token(text):
            return None, "characters 模式只能用于含英文的术语"
        return {"text": text, "mode": mode, "value": ""}, None
    if mode == "phoneme_cmu":
        if not value:
            return None, "phoneme_cmu 缺少 ph/value"
        normalized_value, reason = normalize_cmu_phonemes(value)
        if reason or not normalized_value:
            return None, reason
        return {"text": text, "mode": mode, "value": normalized_value}, None
    if mode == "sub":
        if not allow_text_substitution:
            return None, "sub 是文本替换，不是音标；英文术语默认只能使用 characters 或 phoneme_cmu"
        if not value:
            return None, "sub 缺少 alias/value"
        if value.lower() == text.lower():
            return None, "sub alias 等于原词，无法控制发音"
        if has_english_or_brand_token(value):
            return None, "sub alias 仍包含英文字母，应改用 characters 或 phoneme_cmu"
        if term.get("kind") != "acronym" and spelled_non_acronym_terms(text, value):
            return None, "普通英文词被拆成字母读法"
        if len(value) > max(36, len(text) * 6):
            return None, "sub alias 过长"
        return {"text": text, "mode": mode, "value": value}, None
    return None, f"不支持的 SSML 发音模式: {mode or '空'}"


def term_spec_error(
    term: dict[str, str],
    spec: dict[str, str] | None,
    *,
    allow_text_substitution: bool = False,
) -> str | None:
    if not spec:
        return "缺少 SSML 发音策略"
    _, reason = normalize_term_spec(
        term,
        spec,
        allow_text_substitution=allow_text_substitution,
    )
    return reason


def term_plain_reading(term: dict[str, str], spec: dict[str, str]) -> str:
    if spec.get("mode") == "sub" and spec.get("value"):
        return spec["value"]
    return str(term.get("text") or spec.get("text") or "")


def term_ssml(token: str, spec: dict[str, str]) -> str:
    escaped = html.escape(token)
    mode = spec.get("mode")
    value = spec.get("value", "")
    if mode == "characters":
        return f'<say-as interpret-as="characters">{escaped}</say-as>'
    if mode == "phoneme_cmu":
        return f'<phoneme alphabet="cmu" ph="{html.escape(value, quote=True)}">{escaped}</phoneme>'
    if mode == "sub":
        return f'<sub alias="{html.escape(value, quote=True)}">{escaped}</sub>'
    raise TtsTermError(f"不支持的 SSML 发音模式: {mode}")


def term_spec_summary(spec: dict[str, str]) -> str:
    mode = spec.get("mode", "")
    value = spec.get("value", "")
    return f"{mode}:{value}" if value else mode


def invalid_term_reading_reason(term: dict[str, str], spoken: str) -> str | None:
    text = str(term.get("text") or "").strip()
    if not spoken:
        return "读法为空"
    if term.get("kind") != "acronym" and spelled_non_acronym_terms(text, spoken):
        return "普通英文词被拆成字母读法"
    return None


def unresolved_term_details(terms: list[dict[str, str]], limit: int = 12) -> str:
    names = [str(item.get("text") or "").strip() for item in terms if str(item.get("text") or "").strip()]
    shown = names[:limit]
    suffix = f" 等 {len(names)} 个" if len(names) > limit else ""
    return "、".join(shown) + suffix


def ensure_text_resolved(text: str, label: str) -> None:
    leftovers = extract_english_terms(text)
    if leftovers:
        raise TtsTermError(f"{label}仍包含未确认读法的英文术语: {unresolved_term_details(leftovers)}")


def normalize_model_readings(
    terms: list[dict[str, str]],
    raw_readings: Any,
    *,
    allow_text_substitution: bool = False,
) -> dict[str, dict[str, str]]:
    if isinstance(raw_readings, dict):
        raw_readings = [
            {"text": key, **value} if isinstance(value, dict) else {"text": key, "spoken": value}
            for key, value in raw_readings.items()
        ]
    if not isinstance(raw_readings, list):
        return {}

    allowed = {item["text"].lower(): item for item in terms}
    readings: dict[str, dict[str, str]] = {}
    for item in raw_readings:
        if not isinstance(item, dict):
            continue
        key = str(item.get("text") or "").strip().lower()
        if key not in allowed:
            continue
        spec, reason = normalize_term_spec(
            allowed[key],
            item,
            allow_text_substitution=allow_text_substitution,
        )
        if not reason and spec:
            readings[key] = spec
    return readings


def apply_term_readings(
    text: str,
    specs: dict[str, dict[str, str]],
    *,
    allow_text_substitution: bool = False,
) -> str:
    if not specs:
        return text
    missing: list[dict[str, str]] = []

    def replace(match: re.Match[str]) -> str:
        token = match.group(0)
        term = extract_english_terms(token)[0]
        spec = specs.get(token.lower())
        if term_spec_error(
            term,
            spec,
            allow_text_substitution=allow_text_substitution,
        ):
            missing.append(term)
            return token
        return term_plain_reading(term, spec)

    normalized = ENGLISH_TERM_PATTERN.sub(replace, text or "")
    if missing:
        raise TtsTermError(f"TTS 术语读法未确认: {unresolved_term_details(missing)}")
    return normalized


def has_unresolved_terms(
    text: str,
    specs: dict[str, dict[str, str]],
    *,
    allow_text_substitution: bool = False,
) -> bool:
    return any(
        item["text"].lower() not in specs
        or term_spec_error(
            item,
            specs[item["text"].lower()],
            allow_text_substitution=allow_text_substitution,
        )
        for item in extract_english_terms(text)
    )


def is_cjk_char(character: str) -> bool:
    return (
        "\u3400" <= character <= "\u4dbf"
        or "\u4e00" <= character <= "\u9fff"
        or "\uf900" <= character <= "\ufaff"
    )


def should_inline_character_term(
    text: str,
    match: re.Match[str],
    spec: dict[str, str] | None,
) -> bool:
    if not spec or spec.get("mode") != "characters":
        return False
    previous_index = match.start() - 1
    next_index = match.end()
    return (
        (previous_index >= 0 and is_cjk_char(text[previous_index]))
        or (next_index < len(text) and is_cjk_char(text[next_index]))
    )


def build_ssml(
    text: str,
    specs: dict[str, dict[str, str]],
    *,
    enable_ssml: bool = True,
    allow_text_substitution: bool = False,
) -> str | None:
    terms = extract_english_terms(text)
    if terms and not enable_ssml:
        raise TtsTermError("TTS_ENABLE_SSML=false，但口播中存在需要 SSML 控制读音的英文术语")
    if not terms:
        return None

    parts: list[str] = []
    last = 0
    has_tag = False
    missing: list[dict[str, str]] = []
    for match in ENGLISH_TERM_PATTERN.finditer(text or ""):
        token = match.group(0)
        term = extract_english_terms(token)[0]
        spec = specs.get(token.lower())
        parts.append(html.escape(text[last:match.start()]))
        reason = term_spec_error(
            term,
            spec,
            allow_text_substitution=allow_text_substitution,
        )
        if reason:
            missing.append(term)
            parts.append(html.escape(token))
        elif should_inline_character_term(text, match, spec):
            parts.append(html.escape(token))
        else:
            parts.append(term_ssml(token, spec))
            has_tag = True
        last = match.end()

    parts.append(html.escape((text or "")[last:]))
    if missing:
        raise TtsTermError(f"SSML 术语读法未确认: {unresolved_term_details(missing)}")
    return f"<speak>{''.join(parts)}</speak>" if has_tag else None
