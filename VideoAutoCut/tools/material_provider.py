#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Material source provider bridge.

This script keeps third-party material API details out of the Rust executor.
It returns a small, stable candidate JSON shape that the executor can review
and download through the common material pipeline.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import material_normalization as _normalization
import material_audio_provider as _audio_provider
import material_video_provider as _video_provider
from common import env_int, load_dotenv, transient_network_error, urlopen_with_retry
from json_io import atomic_write_text
from material_normalization import (
    attribution_required_for_license,
    clean_int,
    clean_text,
    clean_wikimedia_title,
    clamped_limit,
    extmetadata_text,
)
from material_provider_contract import DEFAULT_USER_AGENT, ProviderError
from material_video_provider import (
    pexels_search as _pexels_search,
    pixabay_search as _pixabay_search,
)

PEXELS_SEARCH_URL = _video_provider.PEXELS_SEARCH_URL
PIXABAY_VIDEO_SEARCH_URL = _video_provider.PIXABAY_VIDEO_SEARCH_URL
WIKIMEDIA_API_URL = "https://commons.wikimedia.org/w/api.php"
OPENVERSE_AUDIO_SEARCH_URL = _audio_provider.OPENVERSE_AUDIO_SEARCH_URL
OPENVERSE_TOKEN_URL = _audio_provider.OPENVERSE_TOKEN_URL
JAMENDO_TRACKS_URL = _audio_provider.JAMENDO_TRACKS_URL
OPENVERSE_AUDIO_ALLOWED_LICENSES = _audio_provider.OPENVERSE_AUDIO_ALLOWED_LICENSES
JAMENDO_AUDIO_ALLOWED_LICENSES = _audio_provider.JAMENDO_AUDIO_ALLOWED_LICENSES
_OPENVERSE_TOKEN_CACHE = _audio_provider.OPENVERSE_TOKEN_CACHE

# Compatibility aliases for callers that imported normalization helpers from
# this CLI module before they were moved to their own domain module.
strip_html = _normalization.strip_html
creative_commons_license_key = _normalization.creative_commons_license_key
openverse_license_key = _normalization.openverse_license_key
openverse_license_allowed = _normalization.openverse_license_allowed
openverse_license_label = _normalization.openverse_license_label
jamendo_license_allowed = _normalization.jamendo_license_allowed
jamendo_license_label = _normalization.jamendo_license_label


def read_json(request: str | urllib.request.Request, *, label: str) -> dict[str, Any]:
    timeout = max(1, env_int("MATERIAL_PROVIDER_HTTP_TIMEOUT", 60))
    attempts = max(
        1,
        env_int(
            "MATERIAL_PROVIDER_HTTP_ATTEMPTS",
            env_int("VIDEOAUTO_HTTP_RETRIES", 5),
        ),
    )
    with urlopen_with_retry(
        request,
        timeout=timeout,
        attempts=attempts,
        label=label,
    ) as response:
        payload = json.loads(response.read().decode("utf-8", errors="replace"))
    return payload if isinstance(payload, dict) else {}


def post_form_json(
    url: str,
    data: dict[str, str],
    *,
    label: str,
) -> dict[str, Any]:
    body = urllib.parse.urlencode(data).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": DEFAULT_USER_AGENT,
        },
        method="POST",
    )
    return read_json(request, label=label)


def pexels_search(
    query: str,
    *,
    limit: int,
    min_duration: int | None,
    max_duration: int | None,
) -> list[dict[str, Any]]:
    return _pexels_search(
        query,
        limit=limit,
        min_duration=min_duration,
        max_duration=max_duration,
        read_json=read_json,
        endpoint=PEXELS_SEARCH_URL,
        user_agent=DEFAULT_USER_AGENT,
    )


def pixabay_search(
    query: str,
    *,
    limit: int,
    min_duration: int | None,
    max_duration: int | None,
) -> list[dict[str, Any]]:
    return _pixabay_search(
        query,
        limit=limit,
        min_duration=min_duration,
        max_duration=max_duration,
        read_json=read_json,
        endpoint=PIXABAY_VIDEO_SEARCH_URL,
    )


def openverse_access_token() -> str:
    return _audio_provider.openverse_access_token(
        post_form_json=post_form_json,
        environ=os.environ,
        token_cache=_OPENVERSE_TOKEN_CACHE,
        token_endpoint=OPENVERSE_TOKEN_URL,
    )


def openverse_headers() -> dict[str, str]:
    return _audio_provider.openverse_headers(
        token_loader=openverse_access_token,
        user_agent=DEFAULT_USER_AGENT,
    )


def openverse_audio_search(
    query: str,
    *,
    limit: int,
    min_duration: int | None,
    max_duration: int | None,
) -> list[dict[str, Any]]:
    return _audio_provider.openverse_audio_search(
        query,
        limit=limit,
        min_duration=min_duration,
        max_duration=max_duration,
        read_json=read_json,
        headers=openverse_headers(),
        endpoint=OPENVERSE_AUDIO_SEARCH_URL,
    )


def jamendo_search(
    query: str,
    *,
    limit: int,
    min_duration: int | None,
    max_duration: int | None,
) -> list[dict[str, Any]]:
    return _audio_provider.jamendo_search(
        query,
        limit=limit,
        min_duration=min_duration,
        max_duration=max_duration,
        read_json=read_json,
        environ=os.environ,
        endpoint=JAMENDO_TRACKS_URL,
        user_agent=DEFAULT_USER_AGENT,
    )


def wikimedia_search(
    query: str,
    *,
    limit: int,
    min_duration: int | None,
    max_duration: int | None,
) -> list[dict[str, Any]]:
    _ = (min_duration, max_duration)
    params = {
        "action": "query",
        "format": "json",
        "formatversion": "2",
        "generator": "search",
        "gsrnamespace": "6",
        "gsrlimit": clamped_limit(limit, default=20, minimum=1, maximum=50),
        "gsrsearch": f"{query} filetype:video",
        "prop": "imageinfo",
        "iiprop": "url|mime|size|extmetadata",
        "iiurlwidth": "640",
    }
    url = f"{WIKIMEDIA_API_URL}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": DEFAULT_USER_AGENT,
        },
    )
    payload = read_json(request, label="Wikimedia Commons 素材搜索")

    pages = payload.get("query", {}).get("pages", [])
    if not isinstance(pages, list):
        return []

    items: list[dict[str, Any]] = []
    for page in pages:
        if not isinstance(page, dict):
            continue
        infos = page.get("imageinfo")
        if not isinstance(infos, list) or not infos:
            continue
        info = infos[0]
        if not isinstance(info, dict):
            continue
        if not clean_text(info.get("mime")).lower().startswith("video/"):
            continue

        download_url = clean_text(info.get("url"))
        if not download_url:
            continue

        title = clean_wikimedia_title(clean_text(page.get("title")))
        license_name = (
            extmetadata_text(info, "LicenseShortName")
            or extmetadata_text(info, "UsageTerms")
            or "Wikimedia Commons license"
        )
        artist = extmetadata_text(info, "Artist")
        attribution = extmetadata_text(info, "Attribution") or extmetadata_text(info, "Credit")
        description = (
            extmetadata_text(info, "ImageDescription")
            or extmetadata_text(info, "ObjectName")
            or f"Wikimedia Commons video result for: {query}"
        )

        items.append(
            {
                "id": f"wikimedia:{clean_text(page.get('pageid'))}",
                "source": "wikimedia-commons",
                "title": title,
                "description": description,
                "uploader": artist,
                "webpage_url": clean_text(info.get("descriptionurl")),
                "download_url": download_url,
                "thumbnail": clean_text(info.get("thumburl")),
                "duration": None,
                "width": clean_int(info.get("width")),
                "height": clean_int(info.get("height")),
                "license": license_name,
                "license_url": extmetadata_text(info, "LicenseUrl"),
                "commercial_use": True,
                "attribution_required": attribution_required_for_license(license_name),
                "attribution": attribution,
                "tags": [],
            }
        )

    return items[:limit]


def search(args: argparse.Namespace) -> dict[str, Any]:
    source = clean_text(args.source).lower()
    query = clean_text(args.query)
    if not query:
        raise ProviderError("搜索词不能为空。")

    if source == "pexels":
        items = pexels_search(
            query,
            limit=args.limit,
            min_duration=args.min_duration,
            max_duration=args.max_duration,
        )
    elif source == "pixabay":
        items = pixabay_search(
            query,
            limit=args.limit,
            min_duration=args.min_duration,
            max_duration=args.max_duration,
        )
    elif source in {"wikimedia-commons", "wikimedia"}:
        items = wikimedia_search(
            query,
            limit=args.limit,
            min_duration=args.min_duration,
            max_duration=args.max_duration,
        )
    elif source in {"openverse-audio", "openverse_audio"}:
        items = openverse_audio_search(
            query,
            limit=args.limit,
            min_duration=args.min_duration,
            max_duration=args.max_duration,
        )
    elif source in {"jamendo-audio", "jamendo_audio"}:
        items = jamendo_search(
            query,
            limit=args.limit,
            min_duration=args.min_duration,
            max_duration=args.max_duration,
        )
    else:
        raise ProviderError(f"当前素材 Provider 尚未接入来源: {source}")

    return {
        "source": source,
        "query": query,
        "items": items,
    }


def write_result(result: dict[str, Any], output: str | None) -> None:
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if output:
        atomic_write_text(output, text + "\n")
        return
    print(text)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="VideoAutoCut material provider bridge")
    subparsers = parser.add_subparsers(dest="command", required=True)

    search_parser = subparsers.add_parser("search", help="search provider candidates")
    search_parser.add_argument("--source", required=True)
    search_parser.add_argument("--query", required=True)
    search_parser.add_argument("--limit", type=int, default=20)
    search_parser.add_argument("--min-duration", type=int)
    search_parser.add_argument("--max-duration", type=int)
    search_parser.add_argument("--output")
    search_parser.set_defaults(handler=search)

    return parser


def main() -> int:
    load_dotenv()
    parser = build_parser()
    args = parser.parse_args()
    try:
        result = args.handler(args)
        write_result(result, args.output)
        return 0
    except ProviderError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        if transient_network_error(exc):
            print(f"错误: 素材服务请求失败: {exc}", file=sys.stderr)
            return 2
        raise


if __name__ == "__main__":
    raise SystemExit(main())
