from __future__ import annotations

import contextlib
import copy
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "VideoAutoCut" / "tools"
sys.path.insert(0, str(TOOLS))

import normalize_script
import optimize_queries
import script_voice


CLAUSES = [f"第{i}段：确认口播正文包含唯一内容{i}。" for i in range(1, 10)]
BODY = "\n".join(CLAUSES)
DFE_BASELINE = "dfe947ec9ca5d7e0df3eecf23c7812b3ca97c57a"


def raw_plan(markers=None):
    markers = markers or [clause[:10] for clause in CLAUSES]
    return {"topic": "口播稿", "shots": [
        {"shot": index, "voice_start": marker, "title": f"标题{index}",
         "module_label": f"章节{index}", "duration": 3,
         "visual_query": f"画面{index}", "download_query": f"检索{index}",
         "voice_text": "", "subtitle": "", "voiceover": False,
         "shot_size": "不限", "camera_move": "不限", "camera_angle": "不限",
         "transition": "", "evidence": {}}
        for index, marker in enumerate(markers, 1)]}


class VoiceScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.script = self.root / "source.txt"
        self.script.write_text("原文件里的标题和说明不应重新进入确认正文", encoding="utf-8")
        self.body = self.root / "body.txt"
        self.body.write_text(BODY, encoding="utf-8")
        self.output = self.root / "shots.json"

    def run_main(self, result, *, body=None, extra_patches=()):
        argv = ["normalize_script.py", "--input", str(self.script), "--output", str(self.output),
                "--topic", "口播稿", "--voice-script-body", str(body or self.body)]
        stdout = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(sys, "argv", argv))
            parse = stack.enter_context(mock.patch.object(normalize_script, "normalize_voice_script_with_ai",
                                                          return_value=copy.deepcopy(result)))
            upload = stack.enter_context(mock.patch.object(normalize_script, "upload_script_file",
                                                           side_effect=AssertionError("upload")))
            review = stack.enter_context(mock.patch.object(normalize_script, "review_voice_and_subtitles_with_ai",
                                                           side_effect=AssertionError("voice review")))
            progress = stack.enter_context(mock.patch.object(normalize_script, "review_progress_labels_with_ai",
                                                             side_effect=AssertionError("progress review")))
            for patcher in extra_patches:
                stack.enter_context(patcher)
            stack.enter_context(contextlib.redirect_stdout(stdout))
            try:
                normalize_script.main()
            finally:
                self.last_stdout = stdout.getvalue()
        return json.loads(self.output.read_text(encoding="utf-8")), stdout.getvalue(), (parse, upload, review, progress)

    def assert_blocked(self, result, code, *, body=None, extra_patches=()):
        with self.assertRaises(SystemExit) as raised:
            self.run_main(result, body=body, extra_patches=extra_patches)
        self.assertEqual(2, raised.exception.code)
        self.assertFalse(self.output.exists())
        events = [json.loads(line.removeprefix("VACUT_EVENT:"))
                  for line in self.last_stdout.splitlines() if line.startswith("VACUT_EVENT:")]
        self.assertEqual(1, len(events))
        event = events[0]
        self.assertEqual("failed", event["workflowStatus"])
        blocked = event["scriptImport"]["blocked"]
        self.assertEqual([code], [item["code"] for item in blocked])
        return blocked

    def test_v1_nine_shots_slice_and_concat_exactly(self):
        plan, _, _ = self.run_main(raw_plan())
        self.assertEqual(9, len(plan["shots"]))
        self.assertEqual("".join(BODY.split()), "".join("".join(s["voice_text"] for s in plan["shots"]).split()))
        self.assertEqual([[sum(len("".join(x.split())) for x in CLAUSES[:i]),
                           sum(len("".join(x.split())) for x in CLAUSES[:i + 1])]
                          for i in range(9)], [s["script_meta"]["source"]["voice_span"] for s in plan["shots"]])

    def test_v2_internal_deleted_added_or_changed_character_cannot_locate(self):
        marker = CLAUSES[3][:10]
        variants = (marker[:4] + marker[5:], marker[:4] + "额" + marker[4:], marker[:4] + "错" + marker[5:])
        for variant in variants:
            with self.subTest(marker=variant):
                candidate = raw_plan()
                candidate["shots"][3]["voice_start"] = variant
                self.assert_blocked(candidate, "voice_start_not_found")

    def test_v3_first_start_and_reversed_order_block(self):
        first_wrong = raw_plan()
        first_wrong["shots"][0]["voice_start"] = CLAUSES[0][2:12]
        self.assert_blocked(first_wrong, "voice_start_out_of_order")
        reversed_plan = raw_plan()
        reversed_plan["shots"][4]["voice_start"], reversed_plan["shots"][5]["voice_start"] = (
            reversed_plan["shots"][5]["voice_start"], reversed_plan["shots"][4]["voice_start"])
        blocked = self.assert_blocked(reversed_plan, "voice_start_out_of_order")
        self.assertIn("顺序倒置", blocked[0]["message"])

    def test_v4_whitespace_linebreak_and_fullwidth_space_differences_pass(self):
        markers = [" \n　".join(clause[:10]) for clause in CLAUSES]
        plan, _, _ = self.run_main(raw_plan(markers))
        self.assertEqual(9, len(plan["shots"]))

    def test_v5_punctuation_width_difference_blocks(self):
        candidate = raw_plan()
        candidate["shots"][1]["voice_start"] = CLAUSES[1][:10].replace("：", ":")
        self.assert_blocked(candidate, "voice_start_not_found")

    def test_v6_main_runs_independent_final_concat_gate(self):
        real_slicer = script_voice.slice_voices
        def wrong_slices(body, starts):
            voices, spans = real_slicer(body, starts)
            voices[4] = voices[4][:-1]
            return voices, spans
        self.assert_blocked(raw_plan(), "voice_script_mismatch",
                            extra_patches=(mock.patch.object(script_voice, "slice_voices", side_effect=wrong_slices),))

    def test_v7_standard_xlsx_and_markdown_ignore_option_without_plan_byte_change(self):
        baseline_source = subprocess.run(
            ["git", "show", f"{DFE_BASELINE}:VideoAutoCut/tools/normalize_script.py"],
            cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
        ).stdout
        baseline_module = types.ModuleType("normalize_script_dfe_baseline")
        baseline_module.__file__ = str(TOOLS / "normalize_script.py")
        exec(compile(baseline_source, baseline_module.__file__, "exec"), baseline_module.__dict__)
        paths = [ROOT / "docs" / "script-template-v1" / "分镜脚本示例_上下料_v1.xlsx",
                 ROOT / "docs" / "script-template-v1" / "示例_食品码垛_v1.md"]
        for path in paths:
            with self.subTest(path=path.name):
                results = []
                output = self.root / f"{path.suffix}.json"
                for module, enabled in ((baseline_module, False), (normalize_script, False),
                                        (normalize_script, True)):
                    argv = ["normalize_script.py", "--input", str(path), "--output", str(output)]
                    if enabled:
                        argv += ["--voice-script-body", str(self.body)]
                    stdout = io.StringIO()
                    with mock.patch.object(sys, "argv", argv), \
                         mock.patch.object(module, "upload_script_file", side_effect=AssertionError("upload")), \
                         contextlib.redirect_stdout(stdout):
                        module.main()
                    results.append((output.read_bytes(), stdout.getvalue()))
                    output.unlink()
                self.assertEqual(results[0], results[1])
                self.assertEqual(results[0][0], results[2][0])
                self.assertNotIn("voice_script_ignored", results[1][1])
                self.assertIn("voice_script_ignored", results[2][1])

    def test_v7_no_option_ordinary_ai_paths_match_full_dfe_tools_byte_for_byte(self):
        archive = subprocess.run(
            ["git", "archive", DFE_BASELINE, "VideoAutoCut/tools"],
            cwd=ROOT, check=True, capture_output=True,
        ).stdout
        baseline_root = self.root / "dfe"
        baseline_root.mkdir()
        with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
            bundle.extractall(baseline_root)

        probe = r'''
import contextlib, copy, io, json, sys, uuid
from pathlib import Path
from unittest import mock
sys.path.insert(0, sys.argv[1])
import normalize_script, shot_plan_schema
needs_review = sys.argv[4] == "1"
raw = {"topic":"固定","shots":[{"shot":1,"title":"标题","module_label":"固定章节",
    "duration":3,"visual_query":"机器人","download_query":"robot arm",
    "voice_text":"原文口播","subtitle":"" if needs_review else "原文字幕",
    "voiceover":True,"shot_size":"不限","camera_move":"不限","camera_angle":"不限",
    "transition":"","evidence":{}}]}
reviewed = copy.deepcopy(raw)
reviewed["shots"][0]["subtitle"] = "原文字幕"
stdout = io.StringIO()
argv = ["normalize_script.py", "--input", sys.argv[2], "--output", sys.argv[3], "--topic", "固定"]
with mock.patch.object(sys, "argv", argv), \
     mock.patch.object(shot_plan_schema.uuid, "uuid4", return_value=uuid.UUID(int=1)), \
     mock.patch.object(normalize_script, "upload_script_file", return_value="fixed-file"), \
     mock.patch.object(normalize_script, "normalize_with_ai", return_value=copy.deepcopy(raw)), \
     mock.patch.object(normalize_script, "review_voice_and_subtitles_with_ai", return_value=copy.deepcopy(reviewed)), \
     mock.patch.object(normalize_script, "review_progress_labels_with_ai", return_value={"labels": []}), \
     mock.patch.object(normalize_script, "verify_card_fields", return_value={}), \
     contextlib.redirect_stdout(stdout):
    normalize_script.main()
sys.stdout.write(json.dumps({"stdout": stdout.getvalue()}, ensure_ascii=False))
'''
        source = self.root / "ordinary.txt"
        source.write_text("原文口播\n原文字幕\n固定章节", encoding="utf-8")
        output = self.root / "ordinary.json"
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        tool_roots = (baseline_root / "VideoAutoCut" / "tools", TOOLS)
        for needs_review in (False, True):
            results = []
            for tool_root in tool_roots:
                completed = subprocess.run(
                    [sys.executable, "-B", "-X", "utf8", "-c", probe, str(tool_root),
                     str(source), str(output), "1" if needs_review else "0"],
                    cwd=self.root, env=env, check=True, capture_output=True,
                )
                results.append((output.read_bytes(), json.loads(completed.stdout)["stdout"]))
                output.unlink()
            if not needs_review:
                self.assertEqual(results[0], results[1])
                continue
            baseline_plan = json.loads(results[0][0])
            candidate_plan = json.loads(results[1][0])
            self.assertEqual("原文字幕", baseline_plan["shots"][0]["subtitle"])
            self.assertNotIn("subtitle", candidate_plan["shots"][0])
            self.assertIn("AI 复核口播字幕", results[0][1])
            self.assertNotIn("AI 复核口播字幕", results[1][1])
            baseline_shot = baseline_plan["shots"][0]
            baseline_shot.pop("subtitle")
            baseline_shot.pop("render_hints", None)
            baseline_shot["script_meta"]["script_values"]["subtitle"] = ""
            baseline_shot["script_meta"]["field_origin"]["subtitle"] = "default"
            self.assertEqual(baseline_plan, candidate_plan)

            def without_review_lines(value):
                return [line for line in value.splitlines()
                        if not line.startswith("AI 复核口播字幕:")
                        and not line.startswith("AI 口播字幕复核完成:")]
            self.assertEqual(without_review_lines(results[0][1]),
                             without_review_lines(results[1][1]))

    def test_v8_voice_origin_pending_subtitle_and_body_metadata(self):
        plan, _, _ = self.run_main(raw_plan())
        expected_sha = script_voice.body_sha256(self.body)
        self.assertEqual("verbatim", plan["script_source"]["voice_mode"])
        self.assertEqual(expected_sha, plan["script_source"]["voice_body_sha256"])
        for shot in plan["shots"]:
            self.assertEqual("script", shot["script_meta"]["field_origin"]["voice_text"])
            self.assertNotIn("voice_text", shot["script_meta"]["review"]["ai_suggested"])
            self.assertNotIn("subtitle", shot)

    def test_v9_missing_body_blocks_without_fallback_or_output(self):
        self.assert_blocked(raw_plan(), "voice_script_missing", body=self.root / "missing.txt")

    def test_v10_exactly_one_main_model_call_and_no_upload_or_reviews(self):
        _, _, calls = self.run_main(raw_plan())
        parse, upload, review, progress = calls
        self.assertEqual((1, 0, 0, 0),
                         (parse.call_count, upload.call_count, review.call_count, progress.call_count))

    def test_v10_call_qwen_http_attempt_override_and_default_compatibility(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        response.read.return_value = json.dumps({"choices": [{"message": {"content": "{}"}}]}).encode()
        with mock.patch.dict("os.environ", {"DASHSCOPE_API_KEY": "test"}, clear=True), \
             mock.patch.object(optimize_queries, "load_dotenv"), \
             mock.patch.object(optimize_queries, "urlopen_with_retry", return_value=response) as request:
            optimize_queries.call_qwen([], http_attempts=1)
            self.assertEqual(1, request.call_args.kwargs["attempts"])
            request.reset_mock()
            optimize_queries.call_qwen([])
            self.assertNotIn("attempts", request.call_args.kwargs)

        with mock.patch.object(normalize_script, "call_qwen", return_value={}) as request:
            normalize_script.normalize_voice_script_with_ai(BODY, {"file_name": "x.txt"})
            self.assertEqual(1, request.call_args.kwargs["http_attempts"])

    def test_v11_bom_gb18030_crlf_and_raw_byte_hash(self):
        samples = [("bom.txt", b"\xef\xbb\xbf" + BODY.replace("\n", "\r\n").encode("utf-8")),
                   ("gb.txt", BODY.encode("gb18030"))]
        for name, payload in samples:
            with self.subTest(name=name):
                path = self.root / name
                path.write_bytes(payload)
                text = script_voice.read_body(path)
                self.assertEqual("".join(BODY.split()), "".join(text.split()))
                self.assertEqual(__import__("hashlib").sha256(payload).hexdigest(), script_voice.body_sha256(path))

    def test_v12_short_first_shot_passes_and_cross_shot_marker_reports_overlap(self):
        short_body = self.root / "short-body.txt"
        short_body.write_text("大家好。\n今天我们来看一条食品码垛产线…", encoding="utf-8")

        plan, _, _ = self.run_main(raw_plan(["大家好。", "今天我们来看一条"]), body=short_body)
        self.assertEqual("大家好。", plan["shots"][0]["voice_text"])
        self.assertEqual("今天我们来看一条食品码垛产线…", plan["shots"][1]["voice_text"])
        self.assertEqual("大家好。今天我们来看一条食品码垛产线…",
                         "".join(shot["voice_text"] for shot in plan["shots"]))
        self.output.unlink()

        overlapping = raw_plan(["大家好。今天我们来", "今天我们来看一条"])
        blocked = self.assert_blocked(overlapping, "voice_start_out_of_order", body=short_body)
        self.assertIn("重叠", blocked[0]["message"])


if __name__ == "__main__":
    unittest.main()
