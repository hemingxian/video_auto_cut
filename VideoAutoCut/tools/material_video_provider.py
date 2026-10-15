#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pexels and Pixabay video provider adapters.

The adapters own provider authentication, request construction, HTTP error
translation, and conversion into VideoAutoCut's stable candidate contract.
Transport is injected so callers and tests can provide the shared retrying JSON
reader without coupling this module back to the CLI entrypoint.
"""
from __future__ import annotations

import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from typing import Any

from material_normalization import (
    best_pexels_video_file,
    best_pixabay_video_file,
    clean_float,
    clean_int,
    clean_text,
    clamped_limit,
    duration_allowed,
)
from material_provider_contract import DEFAULT_USER_AGENT, JsonReader, ProviderError


PEXELS_SEARCH_URL = "https://api.pexels.com/v1/videos/search"
PIXABAY_VIDEO_SEARCH_URL = "https://pixabay.com/api/videos/"
def pexels_search(
    query: str,
    *,
    limit: int,
    min_duration: int | None,
    max_duration: int | None,
    read_json: JsonReader,
    environ: Mapping[str, str] | None = None,
    endpoint: str = PEXELS_SEARCH_URL,
    user_agent: str = DEFAULT_USER_AGENT,
) -> list[dict[str, Any]]:
    environment = environ if environ is not None else os.environ
    api_key = clean_text(environment.get("PEXELS_API_KEY"))
    if not api_key:
        raise ProviderError("缺少 PEXELS_API_KEY，请先在设置里填写 Pexels API Key。")

    params: dict[str, Any] = {
        "query": query,
        "per_page": clamped_limit(limit, default=20, minimum=1, maximum=80),
        "orientation": clean_text(environment.get("PEXELS_ORIENTATION")) or "landscape",
    }
    if min_duration is not None:
        params["min_duration"] = max(0, min_duration)
    if max_duration is not None:
        params["max_duration"] = max(1, max_duration)

    request = urllib.request.Request(
        f"{endpoint}?{urllib.parse.urlencode(params)}",
        headers={
            "Authorization": api_key,
            "Accept": "application/json",
            "User-Agent": user_agent,
        },
    )
    try:
        payload = read_json(request, label="Pexels 素材搜索")
    except urllib.error.HTTPError as exc:
        if exc.code in {401, 403}:
            raise ProviderError("Pexels API Key 无效或没有权限。") from exc
        raise

    videos = payload.get("videos")
    if not isinstance(videos, list):
        return []

    items: list[dict[str, Any]] = []
    for video in videos:
        if not isinstance(video, dict):
            continue
        selected_file = best_pexels_video_file(video.get("video_files") or [])
        if not selected_file:
            continue

        video_id = clean_text(video.get("id"))
        user = video.get("user") if isinstance(video.get("user"), dict) else {}
        uploader = clean_text(user.get("name"))
        page_url = clean_text(video.get("url"))
        duration = clean_float(video.get("duration"))
        title = f"{query} - Pexels {video_id}".strip(" -")
        items.append(
            {
                "id": f"pexels:{video_id}" if video_id else clean_text(selected_file.get("link")),
                "source": "pexels",
                "title": title,
                "description": f"Pexels video result for: {query}",
                "uploader": uploader,
                "webpage_url": page_url,
                "download_url": clean_text(selected_file.get("link")),
                "thumbnail": clean_text(video.get("image")),
                "duration": duration,
                "width": clean_int(selected_file.get("width")),
                "height": clean_int(selected_file.get("height")),
                "fps": clean_float(selected_file.get("fps")),
                "license": "Pexels License",
                "commercial_use": True,
                "attribution_required": False,
                "attribution_recommended": True,
                "tags": [],
            }
        )
    return items


def pixabay_search(
    query: str,
    *,
    limit: int,
    min_duration: int | None,
    max_duration: int | None,
    read_json: JsonReader,
    environ: Mapping[str, str] | None = None,
    endpoint: str = PIXABAY_VIDEO_SEARCH_URL,
) -> list[dict[str, Any]]:
    environment = environ if environ is not None else os.environ
    api_key = clean_text(environment.get("PIXABAY_API_KEY"))
    if not api_key:
        raise ProviderError("缺少 PIXABAY_API_KEY，请先在设置里填写 Pixabay API Key。")

    params: dict[str, Any] = {
        "key": api_key,
        "q": query,
        "per_page": clamped_limit(limit, default=20, minimum=3, maximum=200),
        "video_type": clean_text(environment.get("PIXABAY_VIDEO_TYPE")) or "film",
        "orientation": clean_text(environment.get("PIXABAY_ORIENTATION")) or "horizontal",
        "safesearch": "true",
        "order": clean_text(environment.get("PIXABAY_ORDER")) or "popular",
    }
    if min_duration is not None:
        params["min_duration"] = max(0, min_duration)
    if max_duration is not None:
        params["max_duration"] = max(1, max_duration)

    try:
        payload = read_json(
            f"{endpoint}?{urllib.parse.urlencode(params)}",
            label="Pixabay 素材搜索",
        )
    except urllib.error.HTTPError as exc:
        if exc.code in {400, 401, 403}:
            raise ProviderError("Pixabay API Key 无效、额度不足或请求被拒绝。") from exc
        raise

    hits = payload.get("hits")
    if not isinstance(hits, list):
        return []

    items: list[dict[str, Any]] = []
    for hit in hits:
        if not isinstance(hit, dict):
            continue
        duration = clean_float(hit.get("duration"))
        if not duration_allowed(
            duration,
            min_duration=min_duration,
            max_duration=max_duration,
        ):
            continue
        selected_file = best_pixabay_video_file(hit.get("videos") or {})
        if not selected_file:
            continue

        video_id = clean_text(hit.get("id"))
        tags = [
            item.strip()
            for item in clean_text(hit.get("tags")).split(",")
            if item.strip()
        ]
        items.append(
            {
                "id": f"pixabay:{video_id}" if video_id else clean_text(selected_file.get("url")),
                "source": "pixabay",
                "title": f"{query} - Pixabay {video_id}".strip(" -"),
                "description": f"Pixabay video result for: {query}",
                "uploader": clean_text(hit.get("user")),
                "webpage_url": clean_text(hit.get("pageURL")),
                "download_url": clean_text(selected_file.get("url")),
                "thumbnail": clean_text(selected_file.get("thumbnail")),
                "duration": duration,
                "width": clean_int(selected_file.get("width")),
                "height": clean_int(selected_file.get("height")),
                "view_count": clean_int(hit.get("views")),
                "license": "Pixabay Content License",
                "commercial_use": True,
                "attribution_required": False,
                "attribution_recommended": True,
                "tags": tags[:12],
            }
        )
    return items[:limit]
