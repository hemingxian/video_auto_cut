#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pure normalization rules shared by third-party material providers.

Provider HTTP clients should only handle authentication and transport.  This
module owns the defensive conversion of untrusted API values into stable
numbers, media selections, tags, attribution metadata, and license policy.
"""
from __future__ import annotations

import html
import math
import re
from dataclasses import dataclass
from typing import Any


AUDIO_ALLOWED_LICENSES = frozenset({"cc0", "pdm", "by"})
_TRUE_VALUES = {"1", "true", "yes", "y", "on"}
_FALSE_VALUES = {"0", "false", "no", "n", "off"}


@dataclass(frozen=True, slots=True)
class AudioLicense:
    key: str
    label: str
    attribution_required: bool
    commercial_use: bool = True


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def strip_html(value: Any) -> str:
    text = clean_text(value)
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def clean_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def clean_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if math.isfinite(parsed) else None


def clean_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    text = clean_text(value).lower()
    if text in _TRUE_VALUES:
        return True
    if text in _FALSE_VALUES:
        return False
    return default


def clamped_limit(limit: Any, *, default: int, minimum: int, maximum: int) -> int:
    if minimum > maximum:
        raise ValueError("minimum cannot be greater than maximum")
    value = clean_int(limit, default)
    return max(minimum, min(value, maximum))


def duration_allowed(
    duration: float | None,
    *,
    min_duration: int | None,
    max_duration: int | None,
) -> bool:
    if duration is None:
        return True
    if not math.isfinite(duration) or duration < 0:
        return False
    if min_duration is not None and duration < min_duration:
        return False
    if max_duration is not None and duration > max_duration:
        return False
    return True


def best_pexels_video_file(files: Any) -> dict[str, Any] | None:
    if not isinstance(files, list):
        return None
    mp4_files = [
        item
        for item in files
        if isinstance(item, dict)
        and clean_text(item.get("link"))
        and clean_text(item.get("file_type")).lower().startswith("video/mp4")
    ]
    if not mp4_files:
        return None

    def score(item: dict[str, Any]) -> tuple[int, int, int, int, int]:
        width = clean_int(item.get("width"))
        height = clean_int(item.get("height"))
        valid_dimensions = int(width > 0 and height > 0)
        within_1080p = int(valid_dimensions == 1 and width <= 1920 and height <= 1080)
        quality = clean_text(item.get("quality")).lower()
        quality_score = {"hd": 3, "sd": 2, "hls": 1}.get(quality, 0)
        return valid_dimensions, within_1080p, quality_score, height, width

    return max(mp4_files, key=score)


def best_pixabay_video_file(files: Any) -> dict[str, Any] | None:
    if not isinstance(files, dict):
        return None

    candidates = [
        files.get(name)
        for name in ("large", "medium", "small", "tiny")
        if isinstance(files.get(name), dict) and clean_text(files[name].get("url"))
    ]
    if not candidates:
        return None

    def score(item: dict[str, Any]) -> tuple[int, int, int, int]:
        width = clean_int(item.get("width"))
        height = clean_int(item.get("height"))
        valid_dimensions = int(width > 0 and height > 0)
        within_1080p = int(valid_dimensions == 1 and width <= 1920 and height <= 1080)
        return valid_dimensions, within_1080p, height, width

    return max(candidates, key=score)


def extmetadata_text(info: dict[str, Any], key: str) -> str:
    metadata = info.get("extmetadata")
    if not isinstance(metadata, dict):
        return ""
    item = metadata.get(key)
    if isinstance(item, dict):
        return strip_html(item.get("value"))
    return ""


def clean_wikimedia_title(title: str) -> str:
    normalized = clean_text(title)
    if normalized.lower().startswith("file:"):
        normalized = normalized[5:]
    return normalized.replace("_", " ")


def attribution_required_for_license(license_name: str) -> bool:
    normalized = clean_text(license_name).lower()
    return not any(token in normalized for token in ("public domain", "cc0", "pd-"))


def creative_commons_license_key(url_or_name: Any) -> str:
    text = clean_text(url_or_name).lower().replace("_", "-")
    text = text.replace("http://", "https://").removeprefix("cc-")
    if "publicdomain/zero" in text or "cc0" in text:
        return "cc0"
    if "publicdomain/mark" in text or "public domain" in text:
        return "pdm"
    match = re.search(
        r"creativecommons\.org/(?:licenses|publicdomain)/(?:zero/)?([^/?#]+)",
        text,
    )
    if match:
        return match.group(1).strip("/")
    return text.strip("/")


def audio_license(value: Any, *, version: str = "") -> AudioLicense | None:
    key = creative_commons_license_key(value)
    if key not in AUDIO_ALLOWED_LICENSES:
        return None
    normalized_version = clean_text(version)
    if key == "cc0":
        label = f"CC0 {normalized_version}".strip()
    elif key == "pdm":
        label = f"Public Domain Mark {normalized_version}".strip()
    else:
        label = f"CC BY {normalized_version}".strip()
    return AudioLicense(
        key=key,
        label=label,
        attribution_required=key == "by",
    )


def openverse_license_key(value: Any) -> str:
    return creative_commons_license_key(value)


def openverse_license_allowed(value: Any) -> bool:
    return audio_license(value) is not None


def openverse_license_label(license_key: str, version: str) -> str:
    normalized = audio_license(license_key, version=version)
    return normalized.label if normalized else clean_text(license_key).upper()


def openverse_audio_duration_seconds(value: Any) -> float | None:
    duration_ms = clean_float(value)
    if duration_ms is None:
        return None
    return max(0.0, duration_ms / 1000.0)


def openverse_tag_names(tags: Any) -> list[str]:
    if not isinstance(tags, list):
        return []

    names: list[str] = []
    for item in tags:
        name = clean_text(item.get("name")) if isinstance(item, dict) else clean_text(item)
        if name and name not in names:
            names.append(name)
    return names[:12]


def openverse_best_audio_url(item: dict[str, Any]) -> str:
    direct = clean_text(item.get("url"))
    if direct:
        return direct

    alt_files = item.get("alt_files")
    if not isinstance(alt_files, list):
        return ""
    for alt in alt_files:
        if isinstance(alt, dict):
            url = clean_text(alt.get("url"))
            if url:
                return url
    return ""


def jamendo_license_allowed(value: Any) -> bool:
    return audio_license(value) is not None


def jamendo_license_label(value: Any) -> str:
    normalized = audio_license(value)
    return normalized.label if normalized else creative_commons_license_key(value).upper()


def jamendo_tags(item: dict[str, Any]) -> list[str]:
    musicinfo = item.get("musicinfo")
    if not isinstance(musicinfo, dict):
        return []

    values: list[str] = []
    for key in ("tags", "vartags", "genres", "instruments"):
        raw = musicinfo.get(key)
        if isinstance(raw, dict):
            source = raw.values()
        elif isinstance(raw, list):
            source = raw
        else:
            continue

        for value in source:
            text = clean_text(value.get("name")) if isinstance(value, dict) else clean_text(value)
            if text and text not in values:
                values.append(text)
    return values[:12]
