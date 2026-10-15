#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Openverse and Jamendo audio provider adapters."""
from __future__ import annotations

import os
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping, MutableMapping
from typing import Any

from material_normalization import (
    AUDIO_ALLOWED_LICENSES,
    audio_license,
    clean_bool,
    clean_float,
    clean_int,
    clean_text,
    clamped_limit,
    duration_allowed,
    jamendo_tags,
    openverse_audio_duration_seconds,
    openverse_best_audio_url,
    openverse_tag_names,
)
from material_provider_contract import (
    DEFAULT_USER_AGENT,
    FormPoster,
    JsonReader,
    ProviderError,
)


OPENVERSE_AUDIO_SEARCH_URL = "https://api.openverse.org/v1/audio/"
OPENVERSE_TOKEN_URL = "https://api.openverse.org/v1/auth_tokens/token/"
JAMENDO_TRACKS_URL = "https://api.jamendo.com/v3.0/tracks/"
OPENVERSE_AUDIO_ALLOWED_LICENSES = set(AUDIO_ALLOWED_LICENSES)
JAMENDO_AUDIO_ALLOWED_LICENSES = set(AUDIO_ALLOWED_LICENSES)
OPENVERSE_TOKEN_CACHE: dict[str, Any] = {}


def _has_authorization_header(headers: Mapping[str, str]) -> bool:
    return any(
        key.casefold() == "authorization" and bool(clean_text(value))
        for key, value in headers.items()
    )


def openverse_access_token(
    *,
    post_form_json: FormPoster,
    environ: Mapping[str, str] | None = None,
    token_cache: MutableMapping[str, Any] | None = None,
    now: Callable[[], float] = time.time,
    token_endpoint: str = OPENVERSE_TOKEN_URL,
) -> str:
    environment = environ if environ is not None else os.environ
    cache = token_cache if token_cache is not None else OPENVERSE_TOKEN_CACHE
    client_id = clean_text(environment.get("OPENVERSE_CLIENT_ID"))
    client_secret = clean_text(environment.get("OPENVERSE_CLIENT_SECRET"))
    if not client_id or not client_secret:
        return ""

    cache_key = f"{client_id}:{client_secret}"
    cached = cache.get(cache_key) or {}
    current_time = now()
    token = clean_text(cached.get("access_token"))
    expires_at = clean_float(cached.get("expires_at")) or 0
    if token and expires_at - current_time > 60:
        return token

    try:
        payload = post_form_json(
            token_endpoint,
            {
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
            },
            label="Openverse token",
        )
    except urllib.error.HTTPError as exc:
        if exc.code in {400, 401, 403}:
            raise ProviderError(
                "Openverse Client ID/Secret 无效、未完成邮箱验证，或没有访问权限。"
            ) from exc
        raise

    token = clean_text(payload.get("access_token"))
    if not token:
        raise ProviderError("Openverse token 响应缺少 access_token")
    expires_in = clean_float(payload.get("expires_in")) or 36000
    cache[cache_key] = {
        "access_token": token,
        "expires_at": current_time + max(60, expires_in),
    }
    return token


def openverse_headers(
    *,
    token_loader: Callable[[], str],
    user_agent: str = DEFAULT_USER_AGENT,
) -> dict[str, str]:
    headers = {
        "Accept": "application/json",
        "User-Agent": user_agent,
    }
    token = token_loader()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def openverse_audio_search(
    query: str,
    *,
    limit: int,
    min_duration: int | None,
    max_duration: int | None,
    read_json: JsonReader,
    headers: Mapping[str, str],
    endpoint: str = OPENVERSE_AUDIO_SEARCH_URL,
) -> list[dict[str, Any]]:
    requested_limit = clamped_limit(limit, default=20, minimum=1, maximum=50)
    authenticated = _has_authorization_header(headers)
    page_size_limit = 50 if authenticated else 20
    page_size = requested_limit
    if min_duration is not None or max_duration is not None:
        page_size = max(requested_limit, requested_limit * 3)
    page_size = min(page_size_limit, page_size)

    params: dict[str, Any] = {
        "q": query,
        "page_size": page_size,
        "license": ",".join(sorted(AUDIO_ALLOWED_LICENSES)),
        "mature": "false",
    }
    request = urllib.request.Request(
        f"{endpoint}?{urllib.parse.urlencode(params)}",
        headers=dict(headers),
    )
    try:
        payload = read_json(request, label="Openverse Audio search")
    except urllib.error.HTTPError as exc:
        if exc.code == 401 and authenticated:
            raise ProviderError(
                "Openverse Audio 认证失败，Access Token 无效或已过期。"
            ) from exc
        if exc.code == 401:
            raise ProviderError(
                "Openverse Audio 匿名访问被拒绝；请配置 "
                "OPENVERSE_CLIENT_ID/OPENVERSE_CLIENT_SECRET 后重试。"
            ) from exc
        if exc.code == 403 and authenticated:
            raise ProviderError(
                "Openverse Audio 已认证，但当前应用或账号没有访问权限。"
            ) from exc
        if exc.code == 403:
            raise ProviderError(
                "Openverse Audio 匿名访问被拒绝；请配置 "
                "OPENVERSE_CLIENT_ID/OPENVERSE_CLIENT_SECRET 并确认账号权限。"
            ) from exc
        raise

    results = payload.get("results")
    if not isinstance(results, list):
        return []

    items: list[dict[str, Any]] = []
    for result in results:
        if not isinstance(result, dict) or clean_bool(result.get("mature"), False):
            continue
        version = clean_text(result.get("license_version"))
        license_info = audio_license(result.get("license"), version=version)
        if license_info is None:
            continue
        duration = openverse_audio_duration_seconds(result.get("duration"))
        if not duration_allowed(
            duration,
            min_duration=min_duration,
            max_duration=max_duration,
        ):
            continue
        download_url = openverse_best_audio_url(result)
        if not download_url:
            continue

        item_id = clean_text(result.get("id"))
        title = clean_text(result.get("title")) or f"Openverse Audio {item_id}".strip()
        creator = clean_text(result.get("creator"))
        items.append(
            {
                "id": f"openverse-audio:{item_id}" if item_id else download_url,
                "source": "openverse-audio",
                "provider": clean_text(result.get("provider")) or clean_text(result.get("source")),
                "media_type": "audio",
                "title": title,
                "description": clean_text(result.get("attribution")),
                "uploader": creator,
                "creator": creator,
                "creator_url": clean_text(result.get("creator_url")),
                "webpage_url": clean_text(result.get("foreign_landing_url")),
                "download_url": download_url,
                "thumbnail": clean_text(result.get("thumbnail")),
                "duration": duration,
                "filetype": clean_text(result.get("filetype")),
                "filesize": clean_int(result.get("filesize")),
                "bit_rate": clean_int(result.get("bit_rate")),
                "sample_rate": clean_int(result.get("sample_rate")),
                "license": license_info.label,
                "license_key": license_info.key,
                "license_version": version,
                "license_url": clean_text(result.get("license_url")),
                "commercial_use": True,
                "attribution_required": license_info.attribution_required,
                "attribution_recommended": True,
                "attribution": clean_text(result.get("attribution")),
                "tags": openverse_tag_names(result.get("tags")),
            }
        )
    return items[:requested_limit]


def jamendo_search(
    query: str,
    *,
    limit: int,
    min_duration: int | None,
    max_duration: int | None,
    read_json: JsonReader,
    environ: Mapping[str, str] | None = None,
    endpoint: str = JAMENDO_TRACKS_URL,
    user_agent: str = DEFAULT_USER_AGENT,
) -> list[dict[str, Any]]:
    environment = environ if environ is not None else os.environ
    client_id = clean_text(environment.get("JAMENDO_CLIENT_ID"))
    if not client_id:
        raise ProviderError(
            "Missing JAMENDO_CLIENT_ID. Jamendo Audio requires a registered API client id."
        )

    requested_limit = clamped_limit(limit, default=20, minimum=1, maximum=50)
    fetch_limit = requested_limit
    if min_duration is not None or max_duration is not None:
        fetch_limit = min(50, max(requested_limit, requested_limit * 3))

    params: dict[str, Any] = {
        "client_id": client_id,
        "format": "json",
        "limit": fetch_limit,
        "search": query,
        "include": "licenses musicinfo",
        "audioformat": clean_text(environment.get("JAMENDO_AUDIO_FORMAT")) or "mp32",
        "audiodlformat": clean_text(environment.get("JAMENDO_AUDIO_DOWNLOAD_FORMAT")) or "mp32",
        "order": clean_text(environment.get("JAMENDO_ORDER")) or "relevance",
        "groupby": clean_text(environment.get("JAMENDO_GROUP_BY")) or "artist_id",
    }
    vocal_instrumental = clean_text(environment.get("JAMENDO_VOCAL_INSTRUMENTAL")) or "instrumental"
    if vocal_instrumental:
        params["vocalinstrumental"] = vocal_instrumental
    if clean_text(environment.get("JAMENDO_STRICT_LICENSE_FILTER")).lower() != "false":
        params.update({"ccsa": "false", "ccnd": "false", "ccnc": "false"})
    if min_duration is not None or max_duration is not None:
        low = max(0, min_duration or 0)
        high = max(low + 1, max_duration or 3600)
        params["durationbetween"] = f"{low}_{high}"

    request = urllib.request.Request(
        f"{endpoint}?{urllib.parse.urlencode(params)}",
        headers={"Accept": "application/json", "User-Agent": user_agent},
    )
    try:
        payload = read_json(request, label="Jamendo Audio search")
    except urllib.error.HTTPError as exc:
        if exc.code in {400, 401, 403}:
            raise ProviderError("Jamendo API client id is invalid or not allowed.") from exc
        raise

    results = payload.get("results")
    if not isinstance(results, list):
        return []

    items: list[dict[str, Any]] = []
    for result in results:
        if not isinstance(result, dict) or not clean_bool(
            result.get("audiodownload_allowed"), False
        ):
            continue
        license_url = clean_text(result.get("license_ccurl"))
        license_info = audio_license(license_url)
        if license_info is None:
            continue
        duration = clean_float(result.get("duration"))
        if not duration_allowed(
            duration,
            min_duration=min_duration,
            max_duration=max_duration,
        ):
            continue
        download_url = clean_text(result.get("audiodownload")) or clean_text(result.get("audio"))
        if not download_url:
            continue

        item_id = clean_text(result.get("id"))
        title = clean_text(result.get("name")) or f"Jamendo Track {item_id}".strip()
        creator = clean_text(result.get("artist_name"))
        webpage_url = (
            clean_text(result.get("shareurl"))
            or clean_text(result.get("shorturl"))
            or clean_text(result.get("album_shareurl"))
        )
        attribution = f'"{title}" by {creator} ({license_info.label})'.strip()
        items.append(
            {
                "id": f"jamendo-audio:{item_id}" if item_id else download_url,
                "source": "jamendo-audio",
                "provider": "jamendo",
                "media_type": "audio",
                "title": title,
                "description": clean_text(result.get("album_name")),
                "uploader": creator,
                "creator": creator,
                "creator_url": clean_text(result.get("artist_url")),
                "webpage_url": webpage_url,
                "download_url": download_url,
                "thumbnail": clean_text(result.get("image")) or clean_text(result.get("album_image")),
                "duration": duration,
                "filetype": "mp3",
                "license": license_info.label,
                "license_key": license_info.key,
                "license_url": license_url,
                "commercial_use": True,
                "attribution_required": license_info.attribution_required,
                "attribution_recommended": True,
                "attribution": attribution,
                "tags": jamendo_tags(result),
            }
        )
    return items[:requested_limit]
