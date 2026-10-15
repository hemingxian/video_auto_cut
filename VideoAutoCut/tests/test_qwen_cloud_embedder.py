from __future__ import annotations

from http import HTTPStatus
from pathlib import Path
import json
import os
import subprocess
import sys
import time
import unittest
from unittest.mock import patch


SENTRYSEARCH_DIR = Path(__file__).resolve().parents[1] / "sentrysearch"
sys.path.insert(0, str(SENTRYSEARCH_DIR))

from sentrysearch.qwen_cloud_embedder import DashScopeAPIError, QwenCloudEmbedder  # noqa: E402
from sentrysearch import qwen_cloud_embedder as qwen


class _NoopLimiter:
    def wait(self) -> None:
        pass


class _Response(dict):
    status_code = HTTPStatus.OK


class _FakeMultiModalEmbedding:
    calls: list[dict] = []

    @classmethod
    def call(cls, **kwargs):
        cls.calls.append(kwargs)
        dimensions = int(kwargs["dimension"])
        return _Response(output={"embeddings": [{"embedding": [0.0] * dimensions}]})


def _embedder(dimensions: int = 3) -> QwenCloudEmbedder:
    embedder = object.__new__(QwenCloudEmbedder)
    embedder._MultiModalEmbedding = _FakeMultiModalEmbedding
    embedder._api_key = "test-key"
    embedder._model = "qwen3-vl-embedding"
    embedder._dimensions = dimensions
    embedder._limiter = _NoopLimiter()
    return embedder


class QwenCloudEmbedderTests(unittest.TestCase):
    def test_dashscope_dimension_is_sent_as_a_top_level_parameter(self):
        _FakeMultiModalEmbedding.calls.clear()

        vector = _embedder().embed_query("paper airplane")

        self.assertEqual(len(vector), 3)
        self.assertEqual(_FakeMultiModalEmbedding.calls[0]["dimension"], 3)
        self.assertNotIn("parameters", _FakeMultiModalEmbedding.calls[0])
        self.assertEqual(_FakeMultiModalEmbedding.calls[0]["request_timeout"], 120)

    def test_dimension_mismatch_is_rejected(self):
        embedder = _embedder(dimensions=3)
        embedder._MultiModalEmbedding = type(
            "WrongDimensionEmbedding",
            (),
            {"call": classmethod(lambda cls, **kwargs: _Response(output={"embeddings": [{"embedding": [0.0]}]}))},
        )

        with self.assertRaisesRegex(DashScopeAPIError, "expected 3"):
            embedder.embed_query("paper airplane")

    def test_video_retries_only_three_attempts_and_two_backoffs(self):
        embedder = _embedder()
        with patch.object(embedder, "_video_request", side_effect=TimeoutError("bounded request")) as request, \
                patch.object(qwen.time, "sleep") as sleep:
            with self.assertRaises(TimeoutError):
                embedder._embed_one([{"video": "dummy"}], {"dimension": 3}, verbose=False, label="video")
        self.assertEqual(request.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2, 4])

    def test_permanent_provider_error_is_not_retried(self):
        embedder = _embedder()
        with patch.object(embedder, "_video_request", side_effect=DashScopeAPIError("HTTP 401 invalid key")) as request:
            with self.assertRaises(DashScopeAPIError):
                embedder._embed_one([{"video": "dummy"}], {"dimension": 3}, verbose=False, label="video")
        self.assertEqual(request.call_count, 1)

    def test_worker_has_hard_timeout_and_no_key_in_payload(self):
        embedder = _embedder()
        response = subprocess.CompletedProcess([], 0, "VACUT_EMBED_RESULT:" + json.dumps({"ok": True, "embedding": [1, 2, 3]}), "")
        with patch.object(qwen.subprocess, "run", return_value=response) as run:
            self.assertEqual(embedder._video_request([{"video": "dummy"}], {"dimension": 3}), [1, 2, 3])
        self.assertEqual(run.call_args.kwargs["timeout"], 180)
        self.assertNotIn("test-key", run.call_args.kwargs["input"])
        self.assertNotIn("api_key", run.call_args.kwargs["input"])

    def test_hung_upload_worker_is_actually_killed_by_deadline(self):
        original_run = subprocess.run

        def hung_worker(_args, **kwargs):
            return original_run([sys.executable, "-c", "import time; time.sleep(5)"], **kwargs)

        started = time.monotonic()
        with patch.dict(os.environ, {"VIDEOAUTO_QWEN_ATTEMPT_TIMEOUT_SECONDS": "1"}), \
                patch.object(qwen.subprocess, "run", side_effect=hung_worker):
            with self.assertRaisesRegex(TimeoutError, "exceeded 1"):
                _embedder()._video_request([{"video": "dummy"}], {"dimension": 3})
        self.assertLess(time.monotonic() - started, 3)


if __name__ == "__main__":
    unittest.main()
