from __future__ import annotations

import contextlib
import http.client
import io
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
from material_audio_provider import (  # noqa: E402
    jamendo_search,
    openverse_access_token,
    openverse_audio_search,
    openverse_headers,
)
from material_provider_contract import ProviderError  # noqa: E402


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        url="https://provider.example/api",
        code=code,
        msg="failed",
        hdrs=None,
        fp=None,
    )


class MaterialProviderTransportTests(unittest.TestCase):
    def test_read_json_honors_provider_timeout_and_attempt_limits(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'{"ok": true}'

        with mock.patch.dict(
            os.environ,
            {
                "MATERIAL_PROVIDER_HTTP_TIMEOUT": "17",
                "MATERIAL_PROVIDER_HTTP_ATTEMPTS": "2",
            },
            clear=False,
        ), mock.patch.object(
            material_provider,
            "urlopen_with_retry",
            return_value=response,
        ) as opener:
            payload = material_provider.read_json("https://provider.example/api", label="provider")

        self.assertEqual(payload, {"ok": True})
        opener.assert_called_once_with(
            "https://provider.example/api",
            timeout=17,
            attempts=2,
            label="provider",
        )

    def test_main_normalizes_exhausted_transient_network_errors(self) -> None:
        parser = mock.Mock()
        parser.parse_args.return_value = mock.Mock(
            handler=mock.Mock(side_effect=http.client.RemoteDisconnected("connection closed")),
        )
        stderr = io.StringIO()

        with mock.patch.object(material_provider, "load_dotenv"), mock.patch.object(
            material_provider,
            "build_parser",
            return_value=parser,
        ), contextlib.redirect_stderr(stderr):
            exit_code = material_provider.main()

        self.assertEqual(exit_code, 2)
        self.assertIn("素材服务请求失败", stderr.getvalue())


class OpenverseTokenTests(unittest.TestCase):
    def test_missing_or_partial_credentials_use_anonymous_access(self) -> None:
        poster = mock.Mock()
        for environment in ({}, {"OPENVERSE_CLIENT_ID": "id"}, {"OPENVERSE_CLIENT_SECRET": "secret"}):
            with self.subTest(environment=environment):
                self.assertEqual(
                    openverse_access_token(post_form_json=poster, environ=environment),
                    "",
                )
        poster.assert_not_called()

    def test_token_is_fetched_cached_and_reused_before_expiry_margin(self) -> None:
        poster = mock.Mock(return_value={"access_token": "token-1", "expires_in": 120})
        cache: dict[str, object] = {}
        environment = {
            "OPENVERSE_CLIENT_ID": "client",
            "OPENVERSE_CLIENT_SECRET": "secret",
        }

        first = openverse_access_token(
            post_form_json=poster,
            environ=environment,
            token_cache=cache,
            now=lambda: 1000,
            token_endpoint="https://mock.example/token",
        )
        second = openverse_access_token(
            post_form_json=poster,
            environ=environment,
            token_cache=cache,
            now=lambda: 1010,
            token_endpoint="https://mock.example/token",
        )

        self.assertEqual((first, second), ("token-1", "token-1"))
        poster.assert_called_once_with(
            "https://mock.example/token",
            {
                "grant_type": "client_credentials",
                "client_id": "client",
                "client_secret": "secret",
            },
            label="Openverse token",
        )
        self.assertEqual(cache["client:secret"]["expires_at"], 1120)

    def test_expiring_token_is_refreshed(self) -> None:
        cache = {"client:secret": {"access_token": "old", "expires_at": 1060}}
        poster = mock.Mock(return_value={"access_token": "new", "expires_in": 300})
        token = openverse_access_token(
            post_form_json=poster,
            environ={"OPENVERSE_CLIENT_ID": "client", "OPENVERSE_CLIENT_SECRET": "secret"},
            token_cache=cache,
            now=lambda: 1000,
        )
        self.assertEqual(token, "new")
        poster.assert_called_once()

    def test_token_errors_are_classified_and_missing_token_is_rejected(self) -> None:
        environment = {"OPENVERSE_CLIENT_ID": "client", "OPENVERSE_CLIENT_SECRET": "secret"}
        for code in (400, 401, 403):
            with self.subTest(code=code), self.assertRaisesRegex(ProviderError, "Client ID/Secret"):
                openverse_access_token(
                    post_form_json=mock.Mock(side_effect=http_error(code)),
                    environ=environment,
                    token_cache={},
                )
        with self.assertRaises(urllib.error.HTTPError):
            openverse_access_token(
                post_form_json=mock.Mock(side_effect=http_error(500)),
                environ=environment,
                token_cache={},
            )
        with self.assertRaisesRegex(ProviderError, "缺少 access_token"):
            openverse_access_token(
                post_form_json=mock.Mock(return_value={"expires_in": 60}),
                environ=environment,
                token_cache={},
            )

    def test_headers_add_bearer_only_when_token_exists(self) -> None:
        self.assertEqual(
            openverse_headers(token_loader=lambda: "", user_agent="Test/1"),
            {"Accept": "application/json", "User-Agent": "Test/1"},
        )
        self.assertEqual(
            openverse_headers(token_loader=lambda: "abc", user_agent="Test/1"),
            {
                "Accept": "application/json",
                "User-Agent": "Test/1",
                "Authorization": "Bearer abc",
            },
        )


class OpenverseSearchTests(unittest.TestCase):
    def test_anonymous_search_caps_oversampling_at_twenty(self) -> None:
        captured: dict[str, urllib.request.Request] = {}

        def reader(request: str | urllib.request.Request, *, label: str) -> dict:
            self.assertEqual(label, "Openverse Audio search")
            self.assertIsInstance(request, urllib.request.Request)
            captured["request"] = request
            return {"results": []}

        openverse_audio_search(
            "calm",
            limit=20,
            min_duration=15,
            max_duration=300,
            read_json=reader,
            headers={"User-Agent": "Test/1"},
        )

        query = urllib.parse.parse_qs(
            urllib.parse.urlparse(captured["request"].full_url).query
        )
        self.assertEqual(query["page_size"], ["20"])

    def test_authenticated_search_can_oversample_up_to_fifty(self) -> None:
        captured: dict[str, urllib.request.Request] = {}

        def reader(request: str | urllib.request.Request, *, label: str) -> dict:
            self.assertEqual(label, "Openverse Audio search")
            self.assertIsInstance(request, urllib.request.Request)
            captured["request"] = request
            return {"results": []}

        openverse_audio_search(
            "calm",
            limit=20,
            min_duration=15,
            max_duration=300,
            read_json=reader,
            headers={"authorization": "Bearer token", "User-Agent": "Test/1"},
        )

        query = urllib.parse.parse_qs(
            urllib.parse.urlparse(captured["request"].full_url).query
        )
        self.assertEqual(query["page_size"], ["50"])

    def test_license_duration_and_mature_filters_preserve_exact_output_contract(self) -> None:
        captured: dict[str, object] = {}

        def reader(request: str | urllib.request.Request, *, label: str) -> dict:
            captured.update(request=request, label=label)
            valid = {
                "id": "audio-1",
                "provider": "provider-name",
                "source": "source-name",
                "title": "Calm Track",
                "attribution": "Attribution text",
                "creator": "Artist",
                "creator_url": "https://artist.example",
                "foreign_landing_url": "https://landing.example/audio-1",
                "url": "https://cdn.example/audio-1.mp3",
                "thumbnail": "https://cdn.example/audio-1.jpg",
                "duration": 7500,
                "filetype": "mp3",
                "filesize": "1024",
                "bit_rate": "320",
                "sample_rate": "44100",
                "license": "by",
                "license_version": "4.0",
                "license_url": "https://creativecommons.org/licenses/by/4.0/",
                "tags": [{"name": "calm"}, "calm", "ambient"],
                "mature": False,
            }
            return {
                "results": [
                    valid,
                    {**valid, "id": "mature", "mature": True},
                    {**valid, "id": "nc", "license": "by-nc"},
                    {**valid, "id": "long", "duration": 15000},
                    {**valid, "id": "missing-url", "url": "", "alt_files": []},
                ]
            }

        items = openverse_audio_search(
            "calm",
            limit=2,
            min_duration=5,
            max_duration=10,
            read_json=reader,
            headers={"Authorization": "Bearer token", "User-Agent": "Test/1"},
            endpoint="https://mock.example/audio",
        )

        self.assertEqual(
            items,
            [
                {
                    "id": "openverse-audio:audio-1",
                    "source": "openverse-audio",
                    "provider": "provider-name",
                    "media_type": "audio",
                    "title": "Calm Track",
                    "description": "Attribution text",
                    "uploader": "Artist",
                    "creator": "Artist",
                    "creator_url": "https://artist.example",
                    "webpage_url": "https://landing.example/audio-1",
                    "download_url": "https://cdn.example/audio-1.mp3",
                    "thumbnail": "https://cdn.example/audio-1.jpg",
                    "duration": 7.5,
                    "filetype": "mp3",
                    "filesize": 1024,
                    "bit_rate": 320,
                    "sample_rate": 44100,
                    "license": "CC BY 4.0",
                    "license_key": "by",
                    "license_version": "4.0",
                    "license_url": "https://creativecommons.org/licenses/by/4.0/",
                    "commercial_use": True,
                    "attribution_required": True,
                    "attribution_recommended": True,
                    "attribution": "Attribution text",
                    "tags": ["calm", "ambient"],
                }
            ],
        )
        request = captured["request"]
        self.assertIsInstance(request, urllib.request.Request)
        query = urllib.parse.parse_qs(urllib.parse.urlparse(request.full_url).query)
        self.assertEqual(query["page_size"], ["6"])
        self.assertEqual(query["license"], ["by,cc0,pdm"])
        self.assertEqual(request.get_header("Authorization"), "Bearer token")
        self.assertEqual(captured["label"], "Openverse Audio search")

    def test_search_auth_errors_are_translated_but_server_errors_propagate(self) -> None:
        args = {
            "query": "calm",
            "limit": 2,
            "min_duration": None,
            "max_duration": None,
            "headers": {},
        }
        for code in (401, 403):
            with self.subTest(code=code), self.assertRaisesRegex(ProviderError, "访问被拒绝"):
                openverse_audio_search(
                    **args,
                    read_json=mock.Mock(side_effect=http_error(code)),
                )
        with self.assertRaises(urllib.error.HTTPError):
            openverse_audio_search(
                **args,
                read_json=mock.Mock(side_effect=http_error(500)),
            )

    def test_search_unauthorized_error_distinguishes_anonymous_and_token_requests(self) -> None:
        common = {
            "query": "calm",
            "limit": 2,
            "min_duration": None,
            "max_duration": None,
            "read_json": mock.Mock(side_effect=http_error(401)),
        }

        with self.assertRaisesRegex(ProviderError, "匿名访问被拒绝"):
            openverse_audio_search(**common, headers={})

        with self.assertRaisesRegex(ProviderError, "Token 无效或已过期"):
            openverse_audio_search(
                **{**common, "read_json": mock.Mock(side_effect=http_error(401))},
                headers={"Authorization": "Bearer expired"},
            )

    def test_cli_wrappers_keep_token_transport_cache_and_constants_patchable(self) -> None:
        poster = mock.Mock(return_value={"access_token": "wrapped", "expires_in": 120})
        material_provider._OPENVERSE_TOKEN_CACHE.clear()
        with mock.patch.dict(
            os.environ,
            {"OPENVERSE_CLIENT_ID": "client", "OPENVERSE_CLIENT_SECRET": "secret"},
            clear=False,
        ), mock.patch.object(material_provider, "post_form_json", poster), mock.patch.object(
            material_provider, "OPENVERSE_TOKEN_URL", "https://mock.example/token"
        ):
            self.assertEqual(material_provider.openverse_access_token(), "wrapped")
        self.assertEqual(poster.call_args.args[0], "https://mock.example/token")
        self.assertIs(material_provider.ProviderError, ProviderError)


class JamendoAdapterTests(unittest.TestCase):
    def test_response_filters_and_exact_candidate_contract(self) -> None:
        captured: dict[str, object] = {}

        def reader(request: str | urllib.request.Request, *, label: str) -> dict:
            captured.update(request=request, label=label)
            valid = {
                "id": "track-1",
                "name": "Track",
                "artist_name": "Artist",
                "artist_url": "https://artist.example",
                "album_name": "Album",
                "shareurl": "https://jamendo.example/track-1",
                "audiodownload_allowed": True,
                "license_ccurl": "https://creativecommons.org/licenses/by/4.0/",
                "duration": "8.5",
                "audiodownload": "https://cdn.example/track-1.mp3",
                "image": "https://cdn.example/track-1.jpg",
                "musicinfo": {"tags": ["ambient", {"name": "soft"}]},
            }
            return {
                "results": [
                    valid,
                    {**valid, "id": "blocked-download", "audiodownload_allowed": False},
                    {**valid, "id": "nc", "license_ccurl": "https://creativecommons.org/licenses/by-nc/4.0/"},
                    {**valid, "id": "long", "duration": 20},
                ]
            }

        items = jamendo_search(
            "ambient",
            limit=3,
            min_duration=5,
            max_duration=10,
            read_json=reader,
            environ={
                "JAMENDO_CLIENT_ID": "client",
                "JAMENDO_AUDIO_FORMAT": "mp31",
                "JAMENDO_AUDIO_DOWNLOAD_FORMAT": "mp32",
                "JAMENDO_ORDER": "downloads_total",
                "JAMENDO_GROUP_BY": "album_id",
                "JAMENDO_VOCAL_INSTRUMENTAL": "instrumental",
            },
            endpoint="https://mock.example/tracks",
            user_agent="Test/1",
        )

        self.assertEqual(
            items,
            [
                {
                    "id": "jamendo-audio:track-1",
                    "source": "jamendo-audio",
                    "provider": "jamendo",
                    "media_type": "audio",
                    "title": "Track",
                    "description": "Album",
                    "uploader": "Artist",
                    "creator": "Artist",
                    "creator_url": "https://artist.example",
                    "webpage_url": "https://jamendo.example/track-1",
                    "download_url": "https://cdn.example/track-1.mp3",
                    "thumbnail": "https://cdn.example/track-1.jpg",
                    "duration": 8.5,
                    "filetype": "mp3",
                    "license": "CC BY",
                    "license_key": "by",
                    "license_url": "https://creativecommons.org/licenses/by/4.0/",
                    "commercial_use": True,
                    "attribution_required": True,
                    "attribution_recommended": True,
                    "attribution": '"Track" by Artist (CC BY)',
                    "tags": ["ambient", "soft"],
                }
            ],
        )
        request = captured["request"]
        self.assertIsInstance(request, urllib.request.Request)
        query = urllib.parse.parse_qs(urllib.parse.urlparse(request.full_url).query)
        self.assertEqual(query["limit"], ["9"])
        self.assertEqual(query["durationbetween"], ["5_10"])
        self.assertEqual(query["audioformat"], ["mp31"])
        self.assertEqual(query["ccnc"], ["false"])
        self.assertEqual(request.get_header("User-agent"), "Test/1")
        self.assertEqual(captured["label"], "Jamendo Audio search")

    def test_missing_or_rejected_credentials_and_server_errors(self) -> None:
        reader = mock.Mock()
        with self.assertRaisesRegex(ProviderError, "JAMENDO_CLIENT_ID"):
            jamendo_search(
                "track",
                limit=2,
                min_duration=None,
                max_duration=None,
                read_json=reader,
                environ={},
            )
        reader.assert_not_called()

        for code in (400, 401, 403):
            with self.subTest(code=code), self.assertRaisesRegex(ProviderError, "client id"):
                jamendo_search(
                    "track",
                    limit=2,
                    min_duration=None,
                    max_duration=None,
                    read_json=mock.Mock(side_effect=http_error(code)),
                    environ={"JAMENDO_CLIENT_ID": "bad"},
                )
        with self.assertRaises(urllib.error.HTTPError):
            jamendo_search(
                "track",
                limit=2,
                min_duration=None,
                max_duration=None,
                read_json=mock.Mock(side_effect=http_error(500)),
                environ={"JAMENDO_CLIENT_ID": "client"},
            )


if __name__ == "__main__":
    unittest.main()
