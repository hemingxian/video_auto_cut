from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sentrysearch"))
cli = importlib.import_module("sentrysearch.cli")


def present(paths):
    results = [{"source_file": "source.mp4", "start_time": 0, "end_time": 2,
                "similarity_score": 0.9} for _ in paths] or [
        {"source_file": "source.mp4", "start_time": 0, "end_time": 2,
         "similarity_score": 0.9}]
    with mock.patch("sentrysearch.trimmer.trim_top_results", return_value=paths), \
            mock.patch.object(cli, "_cache_last_clip"), \
            mock.patch.object(cli.click, "echo") as echo:
        cli._present_results(results, 0, True, 2, "unused", False, False, False)
    events = [call.args[0] for call in echo.call_args_list
              if call.args and str(call.args[0]).startswith("VACUT_CLIPS:")]
    assert len(events) == 1
    return json.loads(events[0].removeprefix("VACUT_CLIPS:"))


class ClipPathHandoffTests(unittest.TestCase):
    def test_handoff_contains_exact_actual_paths_in_match_order(self):
        with tempfile.TemporaryDirectory() as temporary:
            tmp_path = Path(temporary)
            paths = [str(tmp_path / '01 · 中文 / z_"quoted".mp4'), str(tmp_path / "a.mp4")]
            result = present(paths)
            self.assertEqual(result, {"schema_version": 1, "paths": [os.path.abspath(p) for p in paths]})


    def test_empty_trim_result_cannot_report_stale_directory_files(self):
        self.assertEqual(present([]), {"schema_version": 1, "paths": []})


    def test_failed_trim_does_not_publish_a_success_result(self):
        with mock.patch("sentrysearch.trimmer.trim_top_results", side_effect=RuntimeError("trim failed")), \
                mock.patch.object(cli.click, "echo") as echo:
            with self.assertRaises(RuntimeError):
                cli._present_results([{"source_file": "source.mp4", "start_time": 0,
                                       "end_time": 2, "similarity_score": 0.9}],
                                     0, True, 1, "unused", False, False, False)
        self.assertFalse(any(str(call.args[0]).startswith("VACUT_CLIPS:") for call in echo.call_args_list))


if __name__ == "__main__":
    unittest.main()
