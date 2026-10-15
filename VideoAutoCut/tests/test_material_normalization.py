from __future__ import annotations

import math
import os
import sys
import unittest
from pathlib import Path
from unittest import mock


TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS_DIR))

import material_provider  # noqa: E402
from material_normalization import (  # noqa: E402
    attribution_required_for_license,
    audio_license,
    best_pexels_video_file,
    best_pixabay_video_file,
    clean_bool,
    clean_float,
    clamped_limit,
    creative_commons_license_key,
    duration_allowed,
    extmetadata_text,
    jamendo_tags,
    openverse_best_audio_url,
    openverse_tag_names,
)


class ScalarNormalizationTests(unittest.TestCase):
    def test_float_rejects_invalid_and_non_finite_values(self) -> None:
        self.assertEqual(clean_float("2.5"), 2.5)
        self.assertIsNone(clean_float("not-a-number"))
        self.assertIsNone(clean_float(math.nan))
        self.assertIsNone(clean_float(math.inf))

    def test_bool_accepts_common_api_encodings(self) -> None:
        for value in (True, "true", "1", "yes", "on"):
            with self.subTest(value=value):
                self.assertTrue(clean_bool(value))
        for value in (False, "false", "0", "no", "off"):
            with self.subTest(value=value):
                self.assertFalse(clean_bool(value, True))

    def test_limit_clamps_and_rejects_invalid_bounds(self) -> None:
        self.assertEqual(clamped_limit("500", default=20, minimum=1, maximum=80), 80)
        self.assertEqual(clamped_limit("bad", default=20, minimum=1, maximum=80), 20)
        with self.assertRaisesRegex(ValueError, "minimum"):
            clamped_limit(5, default=5, minimum=10, maximum=1)

    def test_duration_policy_handles_unknown_bounds_and_invalid_values(self) -> None:
        self.assertTrue(duration_allowed(None, min_duration=5, max_duration=10))
        self.assertTrue(duration_allowed(7.5, min_duration=5, max_duration=10))
        self.assertFalse(duration_allowed(3, min_duration=5, max_duration=10))
        self.assertFalse(duration_allowed(11, min_duration=5, max_duration=10))
        self.assertFalse(duration_allowed(math.nan, min_duration=None, max_duration=None))
        self.assertFalse(duration_allowed(-1, min_duration=None, max_duration=None))


class MediaSelectionTests(unittest.TestCase):
    def test_pexels_selection_ignores_malformed_and_oversized_candidates(self) -> None:
        selected = best_pexels_video_file(
            [
                "invalid",
                {"link": "missing-dimensions.mp4", "file_type": "video/mp4", "quality": "hd"},
                {
                    "link": "4k.mp4",
                    "file_type": "video/mp4",
                    "quality": "hd",
                    "width": 3840,
                    "height": 2160,
                },
                {
                    "link": "1080.mp4",
                    "file_type": "video/mp4",
                    "quality": "hd",
                    "width": 1920,
                    "height": 1080,
                },
            ]
        )
        self.assertIsNotNone(selected)
        self.assertEqual(selected["link"], "1080.mp4")
        self.assertIsNone(best_pexels_video_file({"not": "a list"}))

    def test_pixabay_selection_prefers_valid_1080p_variant(self) -> None:
        selected = best_pixabay_video_file(
            {
                "large": {"url": "4k.mp4", "width": 3840, "height": 2160},
                "medium": {"url": "1080.mp4", "width": 1920, "height": 1080},
                "tiny": {"url": "unknown.mp4"},
            }
        )
        self.assertIsNotNone(selected)
        self.assertEqual(selected["url"], "1080.mp4")
        self.assertIsNone(best_pixabay_video_file([]))


class LicenseAndMetadataTests(unittest.TestCase):
    def test_audio_license_normalizes_allowed_commercial_licenses(self) -> None:
        by = audio_license("cc_by", version="4.0")
        self.assertIsNotNone(by)
        self.assertEqual((by.key, by.label, by.attribution_required), ("by", "CC BY 4.0", True))

        cc0 = audio_license("https://creativecommons.org/publicdomain/zero/1.0/")
        self.assertIsNotNone(cc0)
        self.assertEqual((cc0.key, cc0.label, cc0.attribution_required), ("cc0", "CC0", False))

        pdm = audio_license("https://creativecommons.org/publicdomain/mark/1.0/")
        self.assertIsNotNone(pdm)
        self.assertEqual(pdm.key, "pdm")
        self.assertIsNone(audio_license("https://creativecommons.org/licenses/by-nc/4.0/"))

    def test_license_helpers_handle_public_domain_and_attribution(self) -> None:
        self.assertEqual(
            creative_commons_license_key("https://creativecommons.org/licenses/by/4.0/"),
            "by",
        )
        self.assertFalse(attribution_required_for_license("Public Domain"))
        self.assertTrue(attribution_required_for_license("CC BY 4.0"))

    def test_metadata_and_tags_are_cleaned_deduplicated_and_bounded(self) -> None:
        info = {"extmetadata": {"Artist": {"value": "<b>A &amp; B</b>"}}}
        self.assertEqual(extmetadata_text(info, "Artist"), "A & B")
        self.assertEqual(openverse_tag_names([{"name": "calm"}, "calm", "video"]), ["calm", "video"])
        self.assertEqual(
            jamendo_tags({"musicinfo": {"tags": ["ambient", {"name": "ambient"}, "soft"]}}),
            ["ambient", "soft"],
        )

    def test_audio_url_uses_direct_then_valid_alternative(self) -> None:
        self.assertEqual(openverse_best_audio_url({"url": "direct.mp3"}), "direct.mp3")
        self.assertEqual(
            openverse_best_audio_url({"alt_files": [None, {"url": "fallback.mp3"}]}),
            "fallback.mp3",
        )
        self.assertEqual(openverse_best_audio_url({"alt_files": "invalid"}), "")


class ProviderIntegrationTests(unittest.TestCase):
    def test_openverse_response_uses_central_license_and_duration_rules(self) -> None:
        payload = {
            "results": [
                {
                    "id": "ok",
                    "title": "Calm",
                    "creator": "Artist",
                    "license": "by",
                    "license_version": "4.0",
                    "duration": 2500,
                    "url": "https://cdn.example/calm.mp3",
                    "tags": [{"name": "calm"}, "calm"],
                    "mature": "false",
                },
                {
                    "id": "blocked",
                    "license": "by-nc",
                    "duration": 2500,
                    "url": "https://cdn.example/blocked.mp3",
                },
            ]
        }
        with mock.patch.dict(
            os.environ,
            {"OPENVERSE_CLIENT_ID": "", "OPENVERSE_CLIENT_SECRET": ""},
            clear=False,
        ), mock.patch.object(material_provider, "read_json", return_value=payload):
            items = material_provider.openverse_audio_search(
                "calm", limit=10, min_duration=2, max_duration=3
            )

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["duration"], 2.5)
        self.assertEqual(items[0]["license"], "CC BY 4.0")
        self.assertTrue(items[0]["attribution_required"])

    def test_jamendo_cc0_response_does_not_require_attribution(self) -> None:
        payload = {
            "results": [
                {
                    "id": "track",
                    "name": "Track",
                    "artist_name": "Artist",
                    "audiodownload_allowed": True,
                    "license_ccurl": "https://creativecommons.org/publicdomain/zero/1.0/",
                    "duration": 8,
                    "audiodownload": "https://cdn.example/track.mp3",
                }
            ]
        }
        with mock.patch.dict(os.environ, {"JAMENDO_CLIENT_ID": "client"}, clear=False), mock.patch.object(
            material_provider, "read_json", return_value=payload
        ):
            items = material_provider.jamendo_search(
                "track", limit=5, min_duration=None, max_duration=None
            )

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["license_key"], "cc0")
        self.assertFalse(items[0]["attribution_required"])

    def test_missing_provider_credentials_fail_before_network_access(self) -> None:
        with mock.patch.dict(os.environ, {"JAMENDO_CLIENT_ID": ""}, clear=False), mock.patch.object(
            material_provider, "read_json"
        ) as read_json:
            with self.assertRaises(material_provider.ProviderError):
                material_provider.jamendo_search(
                    "track", limit=5, min_duration=None, max_duration=None
                )
        read_json.assert_not_called()


if __name__ == "__main__":
    unittest.main()
