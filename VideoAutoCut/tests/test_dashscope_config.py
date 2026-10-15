from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock


TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
SENTRYSEARCH_DIR = Path(__file__).resolve().parents[1] / "sentrysearch"
sys.path.insert(0, str(TOOLS_DIR))
sys.path.insert(0, str(SENTRYSEARCH_DIR))

import align_subtitles  # noqa: E402
import optimize_queries  # noqa: E402
import register_voice_template  # noqa: E402
import tts_dashscope  # noqa: E402
from common import dashscope_url  # noqa: E402
from normalize_script import dashscope_files_url, dashscope_openai_base_url  # noqa: E402
from sentrysearch.dashscope_config import dashscope_sdk_base_url  # noqa: E402


RELAY_ROOT = "https://api.evstai.com"


class FakeResponse:
    def __init__(self, payload: dict):
        self.payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self) -> bytes:
        return self.payload


class DashScopeRelayConfigTests(unittest.TestCase):
    def test_master_root_wins_over_legacy_endpoint_and_direct_fallback_remains(self) -> None:
        with mock.patch.dict(
            os.environ,
            {
                "DASHSCOPE_BASE_URL": f" {RELAY_ROOT}/ ",
                "DASHSCOPE_TTS_URL": "https://legacy.example/tts",
            },
            clear=True,
        ):
            self.assertEqual(
                dashscope_url(
                    "api/v1/services/audio/tts/SpeechSynthesizer",
                    override_env="DASHSCOPE_TTS_URL",
                    default="https://dashscope.aliyuncs.com/direct-tts",
                ),
                f"{RELAY_ROOT}/api/v1/services/audio/tts/SpeechSynthesizer",
            )

        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                dashscope_url(
                    "ignored",
                    override_env="DASHSCOPE_TTS_URL",
                    default="https://dashscope.aliyuncs.com/direct-tts",
                ),
                "https://dashscope.aliyuncs.com/direct-tts",
            )

    def test_chat_files_and_embedding_derive_from_one_relay_root(self) -> None:
        with mock.patch.dict(
            os.environ,
            {
                "DASHSCOPE_BASE_URL": f"{RELAY_ROOT}/",
                "DASHSCOPE_OPENAI_BASE_URL": "https://legacy.example/chat/completions",
                "DASHSCOPE_HTTP_BASE_URL": "https://legacy.example/api/v1",
            },
            clear=True,
        ):
            self.assertEqual(dashscope_openai_base_url(), f"{RELAY_ROOT}/v1")
            self.assertEqual(dashscope_files_url(), f"{RELAY_ROOT}/v1/files")
            self.assertEqual(dashscope_sdk_base_url(), f"{RELAY_ROOT}/api/v1")

    def test_chat_request_uses_relay_chat_completions(self) -> None:
        captured: list[str] = []

        def fake_open(request, **_kwargs):
            captured.append(request.full_url)
            return FakeResponse({"choices": [{"message": {"content": "{\"ok\":true}"}}]})

        with mock.patch.dict(
            os.environ,
            {"DASHSCOPE_BASE_URL": RELAY_ROOT, "DASHSCOPE_API_KEY": "test-key"},
            clear=True,
        ), mock.patch.object(optimize_queries, "load_dotenv"), mock.patch.object(
            optimize_queries, "urlopen_with_retry", side_effect=fake_open
        ):
            self.assertEqual(optimize_queries.call_qwen([{"role": "user", "content": "test"}]), {"ok": True})

        self.assertEqual(captured, [f"{RELAY_ROOT}/v1/chat/completions"])

    def test_tts_asr_and_task_polling_use_relay_native_paths(self) -> None:
        tts_urls: list[str] = []

        def fake_tts_open(request, **_kwargs):
            tts_urls.append(request.full_url)
            return FakeResponse({"output": {"audio": {"url": "https://download.example/audio.mp3"}}})

        asr_submit_urls: list[str] = []
        asr_task_urls: list[str] = []

        def fake_post(url, *_args, **_kwargs):
            asr_submit_urls.append(url)
            return {"output": {"task_id": "task-1"}}

        def fake_get(url, *_args, **_kwargs):
            asr_task_urls.append(url)
            return {
                "output": {
                    "task_status": "SUCCEEDED",
                    "result": {"transcription_url": "https://download.example/result.json"},
                }
            }

        with mock.patch.dict(
            os.environ,
            {"DASHSCOPE_BASE_URL": RELAY_ROOT, "DASHSCOPE_API_KEY": "test-key"},
            clear=True,
        ), mock.patch.object(tts_dashscope, "load_dotenv"), mock.patch.object(
            tts_dashscope, "urlopen_with_retry", side_effect=fake_tts_open
        ), mock.patch.object(tts_dashscope, "download_with_retry"), mock.patch.object(
            align_subtitles, "post_json", side_effect=fake_post
        ), mock.patch.object(align_subtitles, "get_json", side_effect=fake_get), mock.patch.object(
            align_subtitles, "download_json", return_value={"transcripts": []}
        ):
            tts_dashscope.synthesize("hello", Path("ignored.mp3"))
            self.assertEqual(align_subtitles.submit_asr_task("oss://audio"), "task-1")
            align_subtitles.wait_asr_task("task-1")

        self.assertEqual(
            tts_urls,
            [f"{RELAY_ROOT}/api/v1/services/audio/tts/SpeechSynthesizer"],
        )
        self.assertEqual(
            asr_submit_urls,
            [f"{RELAY_ROOT}/api/v1/services/audio/asr/transcription"],
        )
        self.assertEqual(asr_task_urls, [f"{RELAY_ROOT}/api/v1/tasks/task-1"])

    def test_upload_policy_and_voice_customization_use_relay(self) -> None:
        captured: list[str] = []

        def fake_open(request, **_kwargs):
            captured.append(request.full_url)
            if request.get_method() == "GET":
                return FakeResponse(
                    {
                        "data": {
                            "upload_dir": "temp",
                            "oss_access_key_id": "id",
                            "signature": "signature",
                            "policy": "policy",
                            "x_oss_object_acl": "private",
                            "x_oss_forbid_overwrite": "true",
                            "upload_host": "https://oss.example",
                        }
                    }
                )
            return FakeResponse({"output": {"voice_id": "voice-1"}})

        with mock.patch.dict(
            os.environ,
            {"DASHSCOPE_BASE_URL": RELAY_ROOT, "DASHSCOPE_API_KEY": "test-key"},
            clear=True,
        ), mock.patch.object(register_voice_template, "load_dotenv"), mock.patch.object(
            register_voice_template, "urlopen_with_retry", side_effect=fake_open
        ):
            register_voice_template.get_upload_policy("test-key", "voice-enrollment")
            voice_id, _ = register_voice_template.create_voice(
                "oss://sample.wav", "sample", "cosyvoice-v3-flash", ["zh"]
            )

        self.assertEqual(voice_id, "voice-1")
        self.assertEqual(
            captured,
            [
                f"{RELAY_ROOT}/api/v1/uploads?action=getPolicy&model=voice-enrollment",
                f"{RELAY_ROOT}/api/v1/services/audio/tts/customization",
            ],
        )


if __name__ == "__main__":
    unittest.main()
