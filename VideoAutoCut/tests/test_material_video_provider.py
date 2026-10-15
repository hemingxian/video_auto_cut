from __future__ import annotations

import os
import sys
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest import mock


TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS_DIR))

import material_provider  # noqa: E402
from material_video_provider import (  # noqa: E402
    ProviderError,
    pexels_search,
    pixabay_search,
)


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        url="https://provider.example/api",
        code=code,
        msg="failed",
        hdrs=None,
        fp=None,
    )


class PexelsAdapterTests(unittest.TestCase):
    def test_response_is_mapped_to_exact_candidate_contract(self) -> None:
        captured: dict[str, object] = {}

        def reader(request: str | urllib.request.Request, *, label: str) -> dict:
            captured.update(request=request, label=label)
            return {
                "videos": [
                    "malformed",
                    {
                        "id": 42,
                        "url": "https://pexels.example/video/42",
                        "image": "https://pexels.example/thumb.jpg",
                        "duration": "7.5",
                        "user": {"name": "Uploader"},
                        "video_files": [
                            {
                                "link": "https://cdn.example/4k.mp4",
                                "file_type": "video/mp4",
                                "quality": "hd",
                                "width": 3840,
                                "height": 2160,
                                "fps": 60,
                            },
                            {
                                "link": "https://cdn.example/1080.mp4",
                                "file_type": "video/mp4",
                                "quality": "hd",
                                "width": 1920,
                                "height": 1080,
                                "fps": "30",
                            },
                        ],
                    },
                ]
            }

        items = pexels_search(
            "factory robot",
            limit=5,
            min_duration=2,
            max_duration=12,
            read_json=reader,
            environ={"PEXELS_API_KEY": "secret", "PEXELS_ORIENTATION": "portrait"},
        )

        self.assertEqual(
            items,
            [
                {
                    "id": "pexels:42",
                    "source": "pexels",
                    "title": "factory robot - Pexels 42",
                    "description": "Pexels video result for: factory robot",
                    "uploader": "Uploader",
                    "webpage_url": "https://pexels.example/video/42",
                    "download_url": "https://cdn.example/1080.mp4",
                    "thumbnail": "https://pexels.example/thumb.jpg",
                    "duration": 7.5,
                    "width": 1920,
                    "height": 1080,
                    "fps": 30.0,
                    "license": "Pexels License",
                    "commercial_use": True,
                    "attribution_required": False,
                    "attribution_recommended": True,
                    "tags": [],
                }
            ],
        )
        request = captured["request"]
        self.assertIsInstance(request, urllib.request.Request)
        query = urllib.parse.parse_qs(urllib.parse.urlparse(request.full_url).query)
        self.assertEqual(
            query,
            {
                "query": ["factory robot"],
                "per_page": ["5"],
                "orientation": ["portrait"],
                "min_duration": ["2"],
                "max_duration": ["12"],
            },
        )
        self.assertEqual(request.get_header("Authorization"), "secret")
        self.assertEqual(captured["label"], "Pexels 素材搜索")

    def test_missing_key_fails_without_transport(self) -> None:
        reader = mock.Mock()
        with self.assertRaisesRegex(ProviderError, "PEXELS_API_KEY"):
            pexels_search(
                "query",
                limit=5,
                min_duration=None,
                max_duration=None,
                read_json=reader,
                environ={},
            )
        reader.assert_not_called()

    def test_auth_failures_are_translated_and_server_errors_propagate(self) -> None:
        for code in (401, 403):
            with self.subTest(code=code), self.assertRaisesRegex(ProviderError, "API Key 无效"):
                pexels_search(
                    "query",
                    limit=5,
                    min_duration=None,
                    max_duration=None,
                    read_json=mock.Mock(side_effect=http_error(code)),
                    environ={"PEXELS_API_KEY": "bad"},
                )
        with self.assertRaises(urllib.error.HTTPError):
            pexels_search(
                "query",
                limit=5,
                min_duration=None,
                max_duration=None,
                read_json=mock.Mock(side_effect=http_error(500)),
                environ={"PEXELS_API_KEY": "key"},
            )

    def test_cli_compatibility_wrapper_uses_current_shared_reader(self) -> None:
        reader = mock.Mock(return_value={"videos": []})
        with mock.patch.dict(os.environ, {"PEXELS_API_KEY": "key"}, clear=False), mock.patch.object(
            material_provider, "read_json", reader
        ), mock.patch.object(
            material_provider, "PEXELS_SEARCH_URL", "https://mock.example/pexels"
        ), mock.patch.object(
            material_provider, "DEFAULT_USER_AGENT", "CompatibilityTest/1"
        ):
            self.assertEqual(
                material_provider.pexels_search(
                    "query", limit=5, min_duration=None, max_duration=None
                ),
                [],
            )
        reader.assert_called_once()
        request = reader.call_args.args[0]
        self.assertTrue(request.full_url.startswith("https://mock.example/pexels?"))
        self.assertEqual(request.get_header("User-agent"), "CompatibilityTest/1")
        self.assertIs(material_provider.ProviderError, ProviderError)


class PixabayAdapterTests(unittest.TestCase):
    def test_response_is_filtered_and_mapped_to_exact_candidate_contract(self) -> None:
        captured: dict[str, object] = {}

        def reader(request: str | urllib.request.Request, *, label: str) -> dict:
            captured.update(request=request, label=label)
            return {
                "hits": [
                    {
                        "id": 7,
                        "duration": "8",
                        "tags": "one, two, three",
                        "user": "Creator",
                        "pageURL": "https://pixabay.example/video/7",
                        "views": "99",
                        "videos": {
                            "large": {
                                "url": "https://cdn.example/4k.mp4",
                                "width": 3840,
                                "height": 2160,
                            },
                            "medium": {
                                "url": "https://cdn.example/1080.mp4",
                                "width": 1920,
                                "height": 1080,
                                "thumbnail": "https://cdn.example/thumb.jpg",
                            },
                        },
                    },
                    {
                        "id": 8,
                        "duration": 30,
                        "videos": {"small": {"url": "too-long.mp4", "width": 640, "height": 360}},
                    },
                ]
            }

        items = pixabay_search(
            "robot",
            limit=4,
            min_duration=5,
            max_duration=10,
            read_json=reader,
            environ={
                "PIXABAY_API_KEY": "secret",
                "PIXABAY_VIDEO_TYPE": "animation",
                "PIXABAY_ORIENTATION": "vertical",
                "PIXABAY_ORDER": "latest",
            },
        )

        self.assertEqual(
            items,
            [
                {
                    "id": "pixabay:7",
                    "source": "pixabay",
                    "title": "robot - Pixabay 7",
                    "description": "Pixabay video result for: robot",
                    "uploader": "Creator",
                    "webpage_url": "https://pixabay.example/video/7",
                    "download_url": "https://cdn.example/1080.mp4",
                    "thumbnail": "https://cdn.example/thumb.jpg",
                    "duration": 8.0,
                    "width": 1920,
                    "height": 1080,
                    "view_count": 99,
                    "license": "Pixabay Content License",
                    "commercial_use": True,
                    "attribution_required": False,
                    "attribution_recommended": True,
                    "tags": ["one", "two", "three"],
                }
            ],
        )
        request = captured["request"]
        self.assertIsInstance(request, str)
        query = urllib.parse.parse_qs(urllib.parse.urlparse(request).query)
        self.assertEqual(query["key"], ["secret"])
        self.assertEqual(query["per_page"], ["4"])
        self.assertEqual(query["video_type"], ["animation"])
        self.assertEqual(query["orientation"], ["vertical"])
        self.assertEqual(query["order"], ["latest"])
        self.assertEqual(captured["label"], "Pixabay 素材搜索")

    def test_missing_key_and_malformed_payload_return_stable_results(self) -> None:
        reader = mock.Mock()
        with self.assertRaisesRegex(ProviderError, "PIXABAY_API_KEY"):
            pixabay_search(
                "query",
                limit=5,
                min_duration=None,
                max_duration=None,
                read_json=reader,
                environ={},
            )
        reader.assert_not_called()
        self.assertEqual(
            pixabay_search(
                "query",
                limit=5,
                min_duration=None,
                max_duration=None,
                read_json=mock.Mock(return_value={"hits": "invalid"}),
                environ={"PIXABAY_API_KEY": "key"},
            ),
            [],
        )

    def test_request_failures_are_classified(self) -> None:
        for code in (400, 401, 403):
            with self.subTest(code=code), self.assertRaisesRegex(ProviderError, "请求被拒绝"):
                pixabay_search(
                    "query",
                    limit=5,
                    min_duration=None,
                    max_duration=None,
                    read_json=mock.Mock(side_effect=http_error(code)),
                    environ={"PIXABAY_API_KEY": "bad"},
                )
        with self.assertRaises(urllib.error.HTTPError):
            pixabay_search(
                "query",
                limit=5,
                min_duration=None,
                max_duration=None,
                read_json=mock.Mock(side_effect=http_error(500)),
                environ={"PIXABAY_API_KEY": "key"},
            )


if __name__ == "__main__":
    unittest.main()
