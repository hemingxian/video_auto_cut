from __future__ import annotations

import gzip
import importlib.util
import json
import math
import os
import sys
import subprocess
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock


TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS_DIR))

import common  # noqa: E402
import json_io  # noqa: E402
import prepare_cards  # noqa: E402
from normalize_script import compact_plan  # noqa: E402
from shot_plan_schema import compact_json_value, normalize_duration, normalize_shot_plan  # noqa: E402


class EnvironmentParsingTests(unittest.TestCase):
    def test_parse_bool_supports_conventional_values(self) -> None:
        for value in (True, "true", "TRUE", "1", "yes", "on", "y"):
            with self.subTest(value=value):
                self.assertIs(common.parse_bool(value), True)
        for value in (False, "false", "FALSE", "0", "no", "off", "n"):
            with self.subTest(value=value):
                self.assertIs(common.parse_bool(value), False)

    def test_env_int_handles_boolean_and_invalid_values(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"TEST_TRUE": "on", "TEST_FALSE": "no", "TEST_BAD": "12px"},
            clear=False,
        ):
            self.assertEqual(common.env_int("TEST_TRUE", 7), 1)
            self.assertEqual(common.env_int("TEST_FALSE", 7), 0)
            self.assertEqual(common.env_int("TEST_BAD", 7), 7)


class HttpClientTests(unittest.TestCase):
    def test_default_user_agent_is_added_to_request_objects_and_urls(self) -> None:
        request = common.with_default_user_agent(urllib.request.Request("https://example.com"))
        url_request = common.with_default_user_agent("https://example.com/file")

        self.assertEqual(request.get_header("User-agent"), common.DEFAULT_HTTP_USER_AGENT)
        self.assertEqual(url_request.get_header("User-agent"), common.DEFAULT_HTTP_USER_AGENT)

    def test_explicit_and_environment_user_agents_take_precedence(self) -> None:
        explicit = common.with_default_user_agent(
            urllib.request.Request("https://example.com", headers={"User-Agent": "Provider/2.0"})
        )
        with mock.patch.dict(os.environ, {"VIDEOAUTO_HTTP_USER_AGENT": "VideoAutoCut/Test"}):
            configured = common.with_default_user_agent("https://example.com")

        self.assertEqual(explicit.get_header("User-agent"), "Provider/2.0")
        self.assertEqual(configured.get_header("User-agent"), "VideoAutoCut/Test")

    def test_retry_entrypoint_applies_default_user_agent(self) -> None:
        sentinel = object()
        with mock.patch.object(common.urllib.request, "urlopen", return_value=sentinel) as urlopen:
            result = common.urlopen_with_retry("https://example.com", attempts=1)

        request = urlopen.call_args.args[0]
        self.assertIs(result, sentinel)
        self.assertEqual(request.get_header("User-agent"), common.DEFAULT_HTTP_USER_AGENT)

    def test_response_reader_decompresses_gzip_with_or_without_header(self) -> None:
        class Response:
            def __init__(self, payload: bytes, content_encoding: str = "") -> None:
                self.payload = payload
                self.headers = {"Content-Encoding": content_encoding}

            def read(self) -> bytes:
                return self.payload

        payload = b'{"id":"file-test"}'
        compressed = gzip.compress(payload)

        self.assertEqual(common.read_http_response_bytes(Response(compressed, "gzip")), payload)
        self.assertEqual(common.read_http_response_bytes(Response(compressed)), payload)
        self.assertEqual(common.read_http_response_bytes(Response(payload, "gzip")), payload)
        self.assertEqual(common.read_http_response_text(Response(payload)), payload.decode())


class JsonIoTests(unittest.TestCase):
    def test_decode_json_error_includes_label_and_location(self) -> None:
        with self.assertRaisesRegex(ValueError, r"API 响应.*第 1 行"):
            json_io.decode_json('{"broken":', label="API 响应")

    def test_decode_json_object_rejects_non_object(self) -> None:
        with self.assertRaisesRegex(ValueError, "顶层必须是 JSON 对象"):
            json_io.decode_json_object("[]", label="模型输出")

    def test_atomic_json_round_trip_and_no_temp_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "nested" / "state.json"
            payload = {"title": "中文", "items": [1, 2]}

            json_io.atomic_write_json(target, payload)

            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), payload)
            self.assertEqual(list(target.parent.glob(f".{target.name}.*.tmp")), [])

    def test_failed_replace_preserves_previous_file_and_cleans_temp(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "state.json"
            target.write_text('{"version": 1}', encoding="utf-8")

            with mock.patch.object(json_io.os, "replace", side_effect=OSError("locked")):
                with self.assertRaisesRegex(OSError, "locked"):
                    json_io.atomic_write_json(target, {"version": 2})

            self.assertEqual(target.read_text(encoding="utf-8"), '{"version": 1}')
            self.assertEqual(list(target.parent.glob(f".{target.name}.*.tmp")), [])

    def test_atomic_bytes_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "voice.mp3"
            json_io.atomic_write_bytes(target, b"ID3\x00voice")
            self.assertEqual(target.read_bytes(), b"ID3\x00voice")


class ShotPlanNormalizationTests(unittest.TestCase):
    def test_prepare_cards_main_preserves_unknown_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan_path = root / "shots.json"
            cards_dir = root / "cards"
            plan_path.write_text(json.dumps({
                "script_source": {"template": "VAC-SB-1"},
                "shots": [{"shot_id": "s", "title": "A", "card_content": "card",
                           "script_meta": {"review": ["w"]},
                           "render_hints": {"caption_source": "subtitle"}}],
            }), encoding="utf-8")

            def fake_run(command: list[str]) -> None:
                output = Path(command[command.index("--output") + 1])
                if output.suffix == ".json":
                    output.write_text('{"type":"title_card"}', encoding="utf-8")
                else:
                    output.write_text("[Script Info]\n", encoding="utf-8")

            with mock.patch.object(sys, "argv", ["prepare_cards", "--shots-json", str(plan_path),
                                                  "--cards-dir", str(cards_dir)]), \
                    mock.patch.object(prepare_cards, "load_dotenv"), \
                    mock.patch.object(prepare_cards, "run", side_effect=fake_run):
                prepare_cards.main()
            saved = json.loads(plan_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["script_source"], {"template": "VAC-SB-1"})
            self.assertEqual(saved["shots"][0]["script_meta"], {"review": ["w"]})
            self.assertEqual(saved["shots"][0]["render_hints"], {"caption_source": "subtitle"})

    def test_unknown_plan_and_shot_keys_are_deep_copied_after_known_keys(self) -> None:
        source = {
            "topic": "demo",
            "script_source": {"字典": ["甲", None]},
            "顶层空": None,
            "shots": [{
                "shot_id": "shot_keep",
                "title": "A",
                "script_meta": {"review": {"warnings": ["w"]}},
                "render_hints": {"caption_source": "subtitle"},
                "中文键": [1, {"x": None}],
            }],
        }
        normalized = normalize_shot_plan(source)
        self.assertEqual(normalized["script_source"], source["script_source"])
        self.assertIsNone(normalized["顶层空"])
        self.assertEqual(normalized["shots"][0]["script_meta"], source["shots"][0]["script_meta"])
        self.assertEqual(normalized["shots"][0]["render_hints"], source["shots"][0]["render_hints"])
        self.assertEqual(normalized["shots"][0]["中文键"], source["shots"][0]["中文键"])
        self.assertEqual(list(normalized)[-2:], ["script_source", "顶层空"])
        self.assertEqual(list(normalized["shots"][0])[-3:], ["script_meta", "render_hints", "中文键"])
        source["script_source"]["字典"].append("乙")
        source["shots"][0]["中文键"][1]["x"] = "changed"
        self.assertEqual(normalized["script_source"], {"字典": ["甲", None]})
        self.assertEqual(normalized["shots"][0]["中文键"], [1, {"x": None}])

    def test_known_only_normalization_keeps_the_previous_exact_json(self) -> None:
        source = {
            "schema_version": 99,
            "task_revision": 3,
            "topic": "demo",
            "shots": [{
                "shot_id": "s1", "shot": 88, "title": "A", "download_query": "q",
                "visual_query": "v", "download_material": True, "card_layout": "invalid",
                "duration": "9.5", "voiceover": False,
            }],
        }
        normalized = normalize_shot_plan(source)
        self.assertEqual(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")),
            '{"schema_version":2,"task_revision":3,"topic":"demo","shots":[{"shot_id":"s1",'
            '"shot":1,"title":"A","download_query":"q","visual_query":"v",'
            '"download_material":true,"material_bindings":[],"duration":10,"voiceover":false}]}')
        repository = Path(__file__).resolve().parents[2]
        baseline_source = subprocess.run(
            ["git", "show", "1bc0fdb:VideoAutoCut/tools/shot_plan_schema.py"],
            cwd=repository, check=True, capture_output=True,
        ).stdout
        with tempfile.TemporaryDirectory() as directory:
            baseline_path = Path(directory) / "shot_plan_schema_1bc0fdb.py"
            baseline_path.write_bytes(baseline_source)
            spec = importlib.util.spec_from_file_location("shot_plan_schema_1bc0fdb", baseline_path)
            self.assertIsNotNone(spec)
            self.assertIsNotNone(spec.loader)
            baseline = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(baseline)
            self.assertEqual(
                json.dumps(normalized, ensure_ascii=False, separators=(",", ":")),
                json.dumps(baseline.normalize_shot_plan(source), ensure_ascii=False,
                           separators=(",", ":")),
            )
            full_source = {
                "schema_version": 2, "task_revision": 4, "topic": "all",
                "background_music": {"enabled": True}, "content_blocks": [{"kind": "intro"}],
                "extra_requirements": ["plan note"], "shots": [{
                    "shot_id": "full", "shot": 9, "title": "Full", "module_label": "M",
                    "download_query": "dq", "visual_query": "vq", "visual_mode": "stock_video",
                    "query_optimized": True, "duration": 3.2, "voice_text": "voice",
                    "voiceover": False, "subtitle": "sub", "clip_requirements": "clip",
                    "progress_text": "progress", "highlight_rule": "highlight",
                    "subtitle_effect": "effect", "voice_requirements": "requirements",
                    "time_range": "0-3", "card_content": "card", "card_hint": "hint",
                    "card_layout": "equal_lines", "download_material": False,
                    "material_bindings": [{"binding_type": "material", "material_id": "m"}],
                    "raw_download_query": "raw dq", "raw_visual_query": "raw vq",
                    "voice_audio": "voice.wav", "subtitle_cues_file": "cues.json",
                    "subtitle_cues": [{"text": "voice", "start": 0, "end": 3}],
                    "card_plan": "card.json", "card_ass": "card.ass",
                    "extra_requirements": ["shot note"], "production_notes": [{"x": 1}],
                    "content_blocks": [{"kind": "body"}],
                }],
            }
            self.assertEqual(normalize_shot_plan(full_source), baseline.normalize_shot_plan(full_source))

    def test_duration_rounding_modes_and_non_finite_values(self) -> None:
        self.assertEqual(normalize_duration(1.2), 2)
        self.assertEqual(normalize_duration(1.2, rounding="nearest"), 1)
        self.assertEqual(normalize_duration(1.8, rounding="nearest"), 2)
        self.assertIsNone(normalize_duration(math.nan))
        self.assertIsNone(normalize_duration(math.inf))
        with self.assertRaisesRegex(ValueError, "rounding mode"):
            normalize_duration(2, rounding="invalid")  # type: ignore[arg-type]

    def test_compaction_can_collapse_nested_whitespace_and_drop_nan(self) -> None:
        value = {
            " title ": "  one\n  two  ",
            "nested": [" a\t b ", math.nan, None],
        }
        self.assertEqual(
            compact_json_value(value, collapse_whitespace=True),
            {"title": "one two", "nested": ["a b"]},
        )

    def test_compact_plan_preserves_previous_nearest_duration_semantics(self) -> None:
        plan = compact_plan(
            {
                "topic": " demo ",
                "extra_requirements": ["  first\n requirement "],
                "shots": [
                    {
                        "title": " A   title ",
                        "download_query": " factory   robot ",
                        "duration": 1.2,
                    }
                ],
            },
            topic="fallback",
        )

        self.assertEqual(plan["shots"][0]["duration"], 1)
        self.assertEqual(plan["shots"][0]["title"], "A title")
        self.assertEqual(plan["extra_requirements"], ["first requirement"])

    def test_shot_identity_and_minimal_material_bindings_survive_normalization(self) -> None:
        plan = normalize_shot_plan({
            "topic": "demo",
            "shots": [{
                "shot_id": "shot_keep",
                "title": "A",
                "download_material": False,
                "material_bindings": [
                    {
                        "binding_type": "material",
                        "material_id": "mat_1",
                        "local_path": "C:/private.mp4",
                    },
                    {
                        "binding_type": "folder",
                        "folder_id": "fld_1",
                        "include_subfolders": True,
                        "object_key": "private",
                    },
                ],
            }],
        })

        shot = plan["shots"][0]
        self.assertEqual(plan["schema_version"], 2)
        self.assertEqual(plan["task_revision"], 0)
        self.assertEqual(shot["shot_id"], "shot_keep")
        self.assertFalse(shot["download_material"])
        self.assertEqual(shot["material_bindings"], [
            {"binding_type": "material", "material_id": "mat_1"},
            {
                "binding_type": "folder",
                "folder_id": "fld_1",
                "include_subfolders": True,
            },
        ])

        with self.assertRaisesRegex(ValueError, "download_material is true"):
            normalize_shot_plan({
                "shots": [{
                    "shot_id": "shot_conflict",
                    "download_material": True,
                    "material_bindings": [{
                        "binding_type": "material",
                        "material_id": "mat_1",
                    }],
                }],
            })


if __name__ == "__main__":
    unittest.main()
