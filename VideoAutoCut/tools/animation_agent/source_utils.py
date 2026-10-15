from __future__ import annotations

import re
from collections.abc import Collection
from pathlib import Path
from typing import Any


def strip_code_fence(text: str, languages: Collection[str]) -> str:
    """Remove one complete Markdown code fence for an expected language."""
    value = (text or "").strip()
    match = re.fullmatch(
        r"```(?P<language>[A-Za-z0-9_+-]*)\s*(?P<body>.*?)\s*```",
        value,
        flags=re.DOTALL,
    )
    if not match:
        return value
    language = match.group("language").lower()
    allowed = {item.lower() for item in languages}
    if language and language not in allowed:
        return value
    return match.group("body").strip()


def extract_source(model_result: Any, languages: Collection[str]) -> str:
    """Extract generated source from either the response object or raw text."""
    source = model_result.get("source") if isinstance(model_result, dict) else model_result
    if not source:
        raise ValueError("模型没有返回 source 代码")
    return strip_code_fence(str(source), languages)


def short_error(error: str, limit: int) -> str:
    text = str(error or "").strip()
    return text[-limit:] if len(text) > limit else text


def validate_source_filename(filename: str) -> str:
    """Reject traversal/absolute paths before joining an agent output path."""
    value = str(filename or "").strip()
    if (
        not value
        or value in {".", ".."}
        or "/" in value
        or "\\" in value
        or re.search(r"[<>:\"|?*]", value) is not None
        or Path(value).is_absolute()
        or any(ord(character) < 32 for character in value)
    ):
        raise ValueError(f"非法的生成源码文件名: {filename!r}")
    return value
