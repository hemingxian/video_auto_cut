"""Dependency-free DashScope endpoint configuration for SentrySearch."""

from __future__ import annotations

import os


def dashscope_sdk_base_url() -> str:
    """Resolve the SDK's ``/api/v1`` base from the shared relay root."""
    relay_root = os.environ.get("DASHSCOPE_BASE_URL", "").strip().rstrip("/")
    if relay_root:
        return f"{relay_root}/api/v1"
    return os.environ.get("DASHSCOPE_HTTP_BASE_URL", "").strip()
