#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Small, dependency-free helpers for durable JSON persistence.

The command line tools frequently update state that is consumed by the next
pipeline stage.  Replacing those files atomically prevents an interrupted
process from leaving a truncated, syntactically invalid JSON document behind.
"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any


JsonContainer = dict[str, Any] | list[Any]


def _temporary_sibling(target: Path) -> Path:
    return target.with_name(f".{target.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")


def decode_json(text: str, *, label: str = "JSON") -> Any:
    """Decode JSON and attach useful context to malformed payload errors."""
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"{label} 不是有效 JSON（第 {exc.lineno} 行，第 {exc.colno} 列）"
        ) from exc


def decode_json_object(text: str, *, label: str = "JSON") -> dict[str, Any]:
    """Decode a JSON object, rejecting arrays and scalar responses."""
    value = decode_json(text, label=label)
    if not isinstance(value, dict):
        raise ValueError(f"{label} 顶层必须是 JSON 对象，实际为 {type(value).__name__}")
    return value


def load_json(path: str | Path, *, encoding: str = "utf-8-sig") -> Any:
    """Load JSON with the source path included in any decoding error."""
    source = Path(path)
    return decode_json(source.read_text(encoding=encoding), label=str(source))


def atomic_write_text(
    path: str | Path,
    text: str,
    *,
    encoding: str = "utf-8",
) -> None:
    """Write text next to the destination and atomically replace it.

    The temporary file lives in the same directory so ``os.replace`` remains
    atomic on normal local filesystems.  Exclusive creation plus a random name
    avoids following a pre-created temporary-file symlink.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = _temporary_sibling(target)
    try:
        with temporary.open("x", encoding=encoding, newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_write_bytes(path: str | Path, data: bytes) -> None:
    """Write bytes completely before making them visible at the destination."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = _temporary_sibling(target)
    try:
        with temporary.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_write_json(
    path: str | Path,
    value: JsonContainer,
    *,
    indent: int = 2,
    trailing_newline: bool = False,
) -> None:
    """Serialize a JSON object/array and replace the destination atomically."""
    if not isinstance(value, (dict, list)):
        raise TypeError("atomic_write_json only accepts a JSON object or array")
    text = json.dumps(value, ensure_ascii=False, indent=indent)
    if trailing_newline:
        text += "\n"
    atomic_write_text(path, text)
