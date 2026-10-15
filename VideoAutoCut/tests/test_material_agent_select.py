#!/usr/bin/env python3
"""Plumbing tests for the agent selection trial. Run: python -m unittest tests.test_material_agent_select

Uses real ffmpeg to build tiny synthetic clips; model and vector search are faked.
"""
from __future__ import annotations

import ast
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
import urllib.error
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / 'tools'
sys.path.insert(0, str(TOOLS))
os.environ.setdefault("VIDEOAUTO_PYTHON_PROMPT_DIR", str(TOOLS / "prompts"))

import material_agent_select as mas  # noqa: E402

# The standalone orientation pass is the only call whose system prompt says this.
ORIENTATION_MARKER = "方向检查员"


def orientation_reply(*verdicts: str) -> dict:
    return {"images": [{"index": number, "orientation": verdict, "evidence": "测试"}
                       for number, verdict in enumerate(verdicts, 1)]}


def make_clip(path: Path, seconds: float = 2.0, colour: str = "red") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={colour}:s=320x180:d={seconds}",
            "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", str(path),
        ],
        check=True,
    )


class ParsingTests(unittest.TestCase):
    def test_dashscope_thinking_is_opt_in(self):
        for value, expected in (("", None), ("off", False), ("on", True)):
            with self.subTest(value=value), patch.dict(os.environ, {"MATERIAL_AGENT_DASHSCOPE_THINKING": value}), \
                 patch("optimize_queries.call_qwen", return_value={"pick": []}) as call:
                mas.ask_dashscope("system", "user", [], timeout=30)
                if expected is None:
                    self.assertNotIn("enable_thinking", call.call_args.kwargs)
                else:
                    self.assertIs(call.call_args.kwargs["enable_thinking"], expected)

    def test_dashscope_invalid_thinking_setting_does_not_call_model(self):
        with patch.dict(os.environ, {"MATERIAL_AGENT_DASHSCOPE_THINKING": "invalid"}), \
             patch("optimize_queries.call_qwen") as call:
            with self.assertRaises(ValueError):
                mas.ask_dashscope("system", "user", [], timeout=30)
        call.assert_not_called()

    def test_qwen_wire_payload_preserves_default_and_passes_explicit_thinking(self):
        from optimize_queries import call_qwen
        messages = [{"role": "user", "content": "Return JSON"}]
        for thinking in (None, False, True):
            with self.subTest(thinking=thinking):
                response = io.BytesIO(json.dumps({"choices": [{"message": {"content": '{"pick":[]}'}}]}).encode())
                with patch.dict(os.environ, {"DASHSCOPE_API_KEY": "test-not-a-real-key"}), \
                     patch("optimize_queries.load_dotenv"), \
                     patch("optimize_queries.urlopen_with_retry", return_value=response) as send:
                    self.assertEqual(call_qwen(messages, model="test-model", enable_thinking=thinking), {"pick": []})
                body = json.loads(send.call_args.args[0].data)
                expected = {"model": "test-model", "messages": messages, "temperature": 0.2,
                            "response_format": {"type": "json_object"}}
                if thinking is not None:
                    expected["enable_thinking"] = thinking
                self.assertEqual(body, expected)

    def json_generation_error(self):
        error = SystemExit("Model output became abnormal while generating a JSON response for response_format")
        error.__cause__ = urllib.error.HTTPError("https://example.invalid/v1/chat/completions", 400, "Bad Request", {}, None)
        return error

    def test_dashscope_retries_transient_json_generation_with_identical_request(self):
        expected = {"ranking": [], "pick": []}
        with patch("optimize_queries.call_qwen", side_effect=[self.json_generation_error(), expected]) as call:
            self.assertEqual(mas.ask_dashscope("system", "user", [], timeout=30), expected)
        self.assertEqual(call.call_count, 2)
        self.assertEqual(call.call_args_list[0], call.call_args_list[1])

    def test_dashscope_json_generation_retry_is_bounded(self):
        with patch("optimize_queries.call_qwen", side_effect=self.json_generation_error()) as call:
            with self.assertRaises(RuntimeError):
                mas.ask_dashscope("system", "user", [], timeout=30)
        self.assertEqual(call.call_count, 2)

    def test_dashscope_does_not_retry_nontransient_http_errors(self):
        for status in (400, 401, 404):
            with self.subTest(status=status):
                error = SystemExit(f"HTTP {status}: request rejected")
                error.__cause__ = urllib.error.HTTPError("https://example.invalid", status, "Rejected", {}, None)
                with patch("optimize_queries.call_qwen", side_effect=error) as call:
                    with self.assertRaises(RuntimeError):
                        mas.ask_dashscope("system", "user", [], timeout=30)
                self.assertEqual(call.call_count, 1)

    def test_parse_search_output(self):
        output = "\n".join([
            "  #1 [0.412345] a.mp4 @ 00:00-00:30",
            "  #2 [0.201000] b.mp4 @ 00:30-01:00",
            'VACUT_CLIPS:{"schema_version":1,"paths":["/x/a_0_30.mp4","/x/b_30_60.mp4"]}',
        ])
        hits, clips = mas.parse_search_output(output)
        self.assertEqual([h["score"] for h in hits], [0.412345, 0.201])
        self.assertEqual(clips, ["/x/a_0_30.mp4", "/x/b_30_60.mp4"])

    def test_pi_event_text(self):
        events = "\n".join([
            json.dumps({"type": "agent_start"}),
            json.dumps({"type": "message_end", "message": {"role": "user", "content": "hi"}}),
            json.dumps({"type": "message_end", "message": {"role": "assistant", "content": [
                {"type": "text", "text": "```json\n{\"queries\":[{\"text\":\"robot arm grinding\",\"strategy\":\"english\"}]}\n```"}]}}),
            json.dumps({"type": "agent_end"}),
        ])
        text = mas.assistant_text_from_pi_events(events)
        self.assertEqual(mas.extract_json_object(text)["queries"][0]["text"], "robot arm grinding")

    def test_pi_provider_error_is_raised(self):
        events = json.dumps({"type": "message_end", "message": {
            "role": "assistant", "content": [], "stopReason": "error",
            "errorMessage": "401: Incorrect API key provided"}})
        with self.assertRaises(RuntimeError) as raised:
            mas.assistant_text_from_pi_events(events)
        self.assertIn("401", str(raised.exception))

    def test_plain_text_fallback(self):
        self.assertEqual(mas.extract_json_object('前言 {"pick":[2]} 后记')["pick"], [2])


class QueryConcretenessTests(unittest.TestCase):
    """2026-09-17 附录里的真实反例，必须在重搜之前被拦下。"""

    ABSTRACT = "box spillage slip simulation pallet stability test real world failure"
    FABRICATED = "aerial shot pickup station conveyor palletizer alignment metal parts moving between stations"
    EDITING = "操作员调整机器人示教器上袋料/箱体两组参数，画面切至传送带上袋料歪斜、箱体端正的对比"

    def test_keyword_string_without_an_action_is_refused(self):
        ok, reason = mas.query_is_concrete(self.ABSTRACT)
        self.assertFalse(ok)
        self.assertIn("simulation", reason)

    def test_editing_narration_is_refused(self):
        for text, term in ((self.FABRICATED, "shot"), (self.EDITING, "切至")):
            with self.subTest(text=text):
                ok, reason = mas.query_is_concrete(text)
                self.assertFalse(ok)
                self.assertIn(term, reason)

    def test_noun_pile_without_any_verb_is_refused(self):
        ok, reason = mas.query_is_concrete("pallet corner alignment robot cell layout tolerance")
        self.assertFalse(ok)
        self.assertIn("动作词", reason)

    def test_any_shot_word_is_refused_but_shot_blasting_is_not(self):
        """黑名单只有 aerial/wide/close/medium/establishing shot 时，top-down shot 漏了过去。"""
        for text in (
            "top-down shot showing pickup station next to conveyor belt and palletizer",
            "medium shot of the robot arm placing a package",
            "wide shot as the conveyor feeds the palletizer",
        ):
            with self.subTest(text=text):
                ok, reason = mas.query_is_concrete(text)
                self.assertFalse(ok)
                self.assertIn("shot", reason)
        for text in (
            "robot arm holding a steel casting inside the shot blasting cabinet",
            "operator loads springs into the shot-peening drum",
        ):
            with self.subTest(text=text):
                self.assertEqual(mas.query_is_concrete(text), (True, None))

    def test_plain_verbs_are_not_mistaken_for_noun_piles(self):
        """2026-09-17 误拒：connects 不在词表里，整条被判「没有任何动作词」。"""
        for text in (
            "conveyor belt connects pickup station to palletizer with all three visible from above",
            "overhead view of conveyor feeding boxes to palletizer",
            "packages queue on the roller and enter the wrapping station",
            "cartons line up along the conveyor before the robot arm",
            "输送线连接取料工位与码垛工位，包装经过时不停",
        ):
            with self.subTest(text=text):
                self.assertEqual(mas.query_is_concrete(text), (True, None))

    def test_sizes_the_script_never_states_are_refused(self):
        script = {"voice_text": "机械臂把包装放到托盘上", "visual_query": "robot places package on pallet"}
        numbers = mas.shot_numbers(script)
        for text in ("吸盘已离开箱面5厘米", "gripper lifts the package 30 cm above the pallet",
                     "机械臂把包装转过90度"):
            with self.subTest(text=text):
                ok, reason = mas.query_is_concrete(text, numbers)
                self.assertFalse(ok)
                self.assertIn("尺寸/角度", reason)
        # a number the script itself carries is kept
        stated = mas.shot_numbers({"voice_text": "抓具把包装抬高 30 厘米后旋转 90 度"})
        self.assertEqual(mas.query_is_concrete("抓具把包装抬高30厘米", stated), (True, None))
        self.assertEqual(mas.query_is_concrete("gripper rotates the package 90 degrees", stated), (True, None))
        # engine metadata (duration / shot number) must not whitelist a size
        self.assertEqual(mas.shot_numbers({"shot": 5, "duration": 5, "voice_text": "机械臂把包装放到托盘上"}), set())

    def test_concrete_queries_pass(self):
        for text in (
            "robot arm places carton on pallet and retracts the gripper vertically",
            "conveyor stops with cartons stacked on pallet, robot arm extends and suction cup contacts top carton",
            "机械臂用吸盘抓纸箱放到托盘上，箱体长边与托盘边缘平行",
            "robot arm holding a steel casting inside the shot blasting cabinet",
        ):
            with self.subTest(text=text):
                self.assertEqual(mas.query_is_concrete(text), (True, None))

    def test_blocklist_matches_whole_words_only(self):
        self.assertTrue(mas.query_is_concrete("robot arm lifts the latest carton off the conveyor")[0])


class SelectionFlowTests(unittest.TestCase):
    def setUp(self):
        if not shutil.which("ffmpeg"):
            self.skipTest("ffmpeg not available")
        self.temp = Path(tempfile.mkdtemp(prefix="agent-select-"))
        run = self.temp / "run"
        self.clip_root = run / "clips" / "abc" / "shot-1"
        self.index_root = run / "raw" / "01 · 打磨" / "index"
        self.clip_root.mkdir(parents=True)
        self.index_root.mkdir(parents=True)
        (run / "shots.json").write_text(json.dumps({
            "topic": "去毛刺", "shots": [{
                "shot_id": "shot_a", "shot": 1, "title": "机器人去毛刺",
                "visual_query": "robot deburring", "raw_visual_query": "机械臂去毛刺",
                "voice_text": "机械臂夹着工件贴向砂带", "duration": 5,
            }],
        }, ensure_ascii=False), encoding="utf-8")
        make_clip(self.clip_root / "engine_red.mp4", colour="red")
        make_clip(self.clip_root / "engine_blue.mp4", colour="blue")
        make_clip(self.index_root / "source.mp4", seconds=4, colour="green")

    def tearDown(self):
        shutil.rmtree(self.temp, ignore_errors=True)

    def request(self, **extra):
        base = {
            "clip_root": str(self.clip_root), "cache_root": str(self.temp / "cache"), "count": 1,
            "duration": 5, "shot_id": "shot_a", "exclude_overlays": True,
            "random_bound_fallback": True, "bound_root": str(self.index_root),
            "paths": [str(self.clip_root / "engine_red.mp4"), str(self.clip_root / "engine_blue.mp4")],
        }
        base.update(extra)
        return base

    def test_agent_picks_from_research_and_logs(self):
        calls = []

        def fake_search(query, source_root, output_dir, *, save_top, results, timeout):
            calls.append(query)
            clip = output_dir / "source_0_4.mp4"
            make_clip(clip, colour="green")
            return [{"path": str(clip), "score": 0.31, "source_name": "source.mp4", "start": "00:00", "end": "00:04"}]

        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": [{"text": "robot arm pressing part on belt grinder with sparks", "strategy": "visible_scene"}]}
            # three candidates → pick the agent-found one (index 3)
            return {"ranking": [
                {"candidate": 1, "score": 20, "acceptable": False, "orientation": "upright",
                 "visible": ["纯红色画面"], "missing": ["机械臂", "砂带"], "reason": "red frame, nothing visible"},
                {"candidate": 2, "score": 25, "acceptable": False, "orientation": "upright",
                 "visible": ["纯蓝色画面"], "missing": ["机械臂"], "reason": "blue frame"},
                {"candidate": 3, "score": 88, "acceptable": True, "orientation": "upright",
                 "visible": ["机械臂夹持工件贴向砂带"], "missing": [], "reason": "green frame matches"},
            ], "pick": [3], "summary": "ok"}

        report = mas.run_agent_selection(self.request(), search=fake_search, ask=fake_ask)
        self.assertTrue(report["ok"])
        self.assertEqual(len(report["paths"]), 1)
        self.assertTrue(Path(report["paths"][0]).name.startswith("source_0_4"))
        self.assertTrue(Path(report["paths"][0]).resolve().is_relative_to(self.clip_root.resolve()))
        self.assertIsNone(report["fallback"])
        self.assertEqual(len(report["rejected"]), 2)
        self.assertEqual(calls, ["robot arm pressing part on belt grinder with sparks"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual(log["picked"][0]["origin"], "agent")
        self.assertEqual(len(log["queries"]), 2)
        self.assertTrue(all(Path(f).is_file() for c in log["candidates"] for f in c["frames"]))
        # the model's visible/missing evidence is kept verbatim for the audit
        self.assertEqual(log["judge"]["ranking"][2]["visible"], ["机械臂夹持工件贴向砂带"])
        self.assertEqual(log["judge"]["ranking"][0]["missing"], ["机械臂", "砂带"])

    def test_ranking_without_visible_missing_or_orientation_still_parses(self):
        """Older/looser model replies must not break selection, only lose priority."""
        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": []}
            return {"ranking": [{"candidate": 2, "score": 95, "acceptable": True, "reason": "bare reply"}],
                    "pick": [2]}

        report = mas.run_agent_selection(self.request(), search=lambda *a, **k: [], ask=fake_ask)
        self.assertTrue(report["ok"])
        self.assertEqual(Path(report["paths"][0]).name, "engine_blue.mp4")
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual(log["picked"][0]["orientation"], "unsure")
        # missing obstruction / camera_angle degrade to the safe value, they never raise
        self.assertEqual(log["picked"][0]["obstruction"], "partial")
        self.assertEqual(log["picked"][0]["camera_angle"], "unsure")
        # 候选 1 没被评审（ranking 只回了候选 2），review 里按未评审单列，按序号取行
        self.assertEqual(next(item for item in log["review"] if item["candidate"] == 2)["adjusted_score"], 65.0)
        self.assertEqual(log["unreviewed"], [1])

    def engine_clips(self, count: int = 10) -> list[str]:
        paths = []
        for number in range(count):
            clip = self.clip_root / f"match_src{number:02d}_00m00s-00m10s.mp4"
            make_clip(clip, seconds=0.4, colour="red")
            paths.append(str(clip))
        return paths

    def search_returning(self, groups: list[list[str]]):
        """Fake re-search: query "... #N" returns the N-th group of source stems."""
        def fake_search(query, source_root, output_dir, *, save_top, results, timeout):
            found = []
            for base in groups[int(query.rsplit("#", 1)[-1])]:
                clip = output_dir / f"match_{base}_00m00s-00m10s.mp4"
                make_clip(clip, seconds=0.4, colour="green")
                found.append({"path": str(clip), "score": 0.5 - 0.01 * len(found),
                              "source_name": f"{base}.mp4", "start": "00m00s", "end": "00m10s"})
            return found
        return fake_search

    def ask_with_queries(self, count: int):
        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": [{"text": f"robot arm stacking cartons on pallet #{number}", "strategy": "visible_scene"}
                                    for number in range(count)]}
            return {"ranking": [{"candidate": 1, "score": 80, "acceptable": True, "orientation": "upright",
                                 "obstruction": "none", "reason": "ok"}], "pick": [1]}
        return fake_ask

    def test_abstract_rewrites_are_not_searched_and_are_logged(self):
        searched = []

        def fake_search(query, source_root, output_dir, *, save_top, results, timeout):
            searched.append(query)
            clip = output_dir / "source_0_4.mp4"
            make_clip(clip, colour="green")
            return [{"path": str(clip), "score": 0.31, "source_name": "source.mp4",
                     "start": "00:00", "end": "00:04"}]

        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": [
                    {"text": QueryConcretenessTests.ABSTRACT, "strategy": "english"},
                    {"text": QueryConcretenessTests.EDITING, "strategy": "process_action"},
                    {"text": "机械臂夹持工件贴向砂带，接触处有火花", "strategy": "visible_scene"},
                ]}
            return {"ranking": [{"candidate": 1, "score": 90, "acceptable": True, "orientation": "upright",
                                 "obstruction": "none", "camera_angle": "eye_level", "reason": "ok"}],
                    "pick": [1]}

        report = mas.run_agent_selection(self.request(), search=fake_search, ask=fake_ask)
        self.assertTrue(report["ok"])
        self.assertEqual(searched, ["机械臂夹持工件贴向砂带，接触处有火花"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual([item["text"] for item in log["rejected_queries"]],
                         [QueryConcretenessTests.ABSTRACT, QueryConcretenessTests.EDITING])
        self.assertTrue(all(item["reason"] for item in log["rejected_queries"]))
        # refused rewrites never become a query entry, so they cost no search
        self.assertEqual(len(log["queries"]), 2)
        self.assertEqual(report["agent"]["rejected_queries"], log["rejected_queries"])

    def test_fabricated_size_is_not_searched(self):
        """分镜 duration=5，但文案里没有 5；「5厘米」仍然是编的，不许重搜。"""
        searched = []

        def fake_search(query, source_root, output_dir, *, save_top, results, timeout):
            searched.append(query)
            clip = output_dir / "source_0_4.mp4"
            make_clip(clip, colour="green")
            return [{"path": str(clip), "score": 0.31, "source_name": "source.mp4",
                     "start": "00:00", "end": "00:04"}]

        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": [
                    {"text": "吸盘已离开箱面5厘米，工件静止在砂带上", "strategy": "another_detail"},
                    {"text": "机械臂夹持工件贴向砂带，接触处有火花", "strategy": "visible_scene"},
                ]}
            if ORIENTATION_MARKER in system:
                return orientation_reply("upright", "upright", "upright")
            return {"ranking": [{"candidate": 1, "score": 90, "acceptable": True, "orientation": "upright",
                                 "obstruction": "none", "camera_angle": "eye_level",
                                 "visible": ["机械臂贴向砂带"], "missing": [], "reason": "画面对上"}],
                    "pick": [1]}

        report = mas.run_agent_selection(self.request(), search=fake_search, ask=fake_ask)
        self.assertTrue(report["ok"])
        self.assertEqual(searched, ["机械臂夹持工件贴向砂带，接触处有火花"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual(len(log["rejected_queries"]), 1)
        self.assertIn("5厘米", log["rejected_queries"][0]["reason"])

    def test_oversized_judge_fields_are_truncated_and_flagged(self):
        """28/48 条 reason 超过 40 字（最长 72）；提示词收不住就在解析后截断。"""
        long_reason = "唯" * 80
        ask = self.judging([
            {"candidate": 1, "score": 80, "acceptable": True, "orientation": "upright",
             "obstruction": "none", "camera_angle": "eye_level",
             "visible": ["机械臂" * 10, "托盘", "输送线", "网栏", "第五条多余的"],
             "missing": [], "reason": long_reason},
            {"candidate": 2, "score": 70, "acceptable": True, "orientation": "upright",
             "obstruction": "none", "camera_angle": "eye_level",
             "visible": ["机械臂"], "missing": [], "reason": "短理由"},
        ], [1, 2])
        report = mas.run_agent_selection(self.request(), search=lambda *a, **k: [], ask=ask)
        self.assertTrue(report["ok"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        first = log["judge"]["ranking"][0]
        self.assertEqual(len(first["reason"]), mas.JUDGE_REASON_LIMIT)
        self.assertEqual(first["reason"], long_reason[:mas.JUDGE_REASON_LIMIT])
        self.assertEqual(len(first["visible"]), mas.JUDGE_LIST_LIMIT)
        self.assertTrue(all(len(value) <= mas.JUDGE_LIST_ITEM_LIMIT for value in first["visible"]))
        self.assertTrue(first["truncated"])
        self.assertTrue(next(item for item in log["review"] if item["candidate"] == 1)["truncated"])
        # a reply that already fits is left alone and never flagged
        second = log["judge"]["ranking"][1]
        self.assertEqual(second["reason"], "短理由")
        self.assertNotIn("truncated", second)
        self.assertFalse(next(item for item in log["review"] if item["candidate"] == 2)["truncated"])
        # the truncated reason is what the picked entry carries too
        self.assertEqual(len(log["picked"][0]["reason"]), mas.JUDGE_REASON_LIMIT)

    def test_log_records_per_stage_timings(self):
        """elapsed_seconds alone cannot say where a shot's 40+ seconds went."""
        def fake_search(query, source_root, output_dir, *, save_top, results, timeout):
            clip = output_dir / "source_0_4.mp4"
            make_clip(clip, colour="green")
            return [{"path": str(clip), "score": 0.31, "source_name": "source.mp4",
                     "start": "00:00", "end": "00:04"}]

        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": [{"text": "机械臂夹持工件贴向砂带，接触处有火花", "strategy": "visible_scene"}]}
            # no "summary" field any more: parsing must not depend on it
            return {"ranking": [{"candidate": 3, "score": 88, "acceptable": True, "orientation": "upright",
                                 "obstruction": "none", "camera_angle": "eye_level",
                                 "visible": ["机械臂贴向砂带"], "missing": [], "reason": "画面对上"}],
                    "pick": [3]}

        report = mas.run_agent_selection(self.request(), search=fake_search, ask=fake_ask)
        self.assertTrue(report["ok"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        timings = log["timings"]
        self.assertEqual(sorted(timings), ["frames_seconds", "judge_seconds", "orientation_seconds",
                                           "probe_seconds", "rewrite_seconds", "search_seconds"])
        for name, value in timings.items():
            with self.subTest(name=name):
                self.assertIsInstance(value, (int, float))
                self.assertGreaterEqual(value, 0)
        # frames and probe really ran, and the parts never exceed the whole
        self.assertGreater(timings["frames_seconds"], 0)
        self.assertGreater(timings["probe_seconds"], 0)
        self.assertLessEqual(sum(timings.values()), log["elapsed_seconds"] + 0.5)
        self.assertEqual(report["agent"]["timings"], timings)

    def test_timings_are_written_even_when_the_model_fails(self):
        def failing_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": []}
            raise RuntimeError("pi exit 1")

        report = mas.run_agent_selection(self.request(), search=lambda *a, **k: [], ask=failing_ask)
        self.assertFalse(report["ok"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual(len(log["timings"]), 6)
        self.assertGreaterEqual(log["timings"]["judge_seconds"], 0)
        self.assertGreaterEqual(log["timings"]["orientation_seconds"], 0)

    def test_agent_candidates_keep_a_reserved_share_of_the_pool(self):
        """10 engine + 6 agent candidates (2 of them repeats) must not starve the agent."""
        engine_paths = self.engine_clips()
        # The first two re-search hits repeat engine segments: same source file and
        # same span, but exported into _agent_qNN instead of the shot clip directory.
        report = mas.run_agent_selection(
            self.request(paths=engine_paths),
            search=self.search_returning([["src00", "src01", "src20"], ["src21", "src22", "src23"]]),
            ask=self.ask_with_queries(2),
        )
        self.assertTrue(report["ok"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        pool = log["candidates"]
        origins = [item["origin"] for item in pool]
        self.assertLessEqual(len(pool), 8)
        # the agent side is "agent" (new segments) plus "both" (engine segments it also found)
        self.assertGreaterEqual(origins.count("agent") + origins.count("both"), 3)
        self.assertGreaterEqual(origins.count("engine"), 1)
        self.assertEqual(log["candidate_pool"]["origins"],
                         {"engine": origins.count("engine"), "agent": origins.count("agent"),
                          "both": origins.count("both")})
        self.assertEqual(log["candidate_pool"]["found"], {"engine": 8, "agent": 4, "both": 2})
        keys = [mas.dedupe_key(item) for item in pool]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertEqual(log["candidate_pool"]["merged"], 2)
        # the two repeated engine segments are kept and re-labelled, not dropped
        both = {Path(item["path"]).name: item for item in pool if item["origin"] == "both"}
        self.assertEqual(sorted(both), ["match_src00_00m00s-00m10s.mp4", "match_src01_00m00s-00m10s.mp4"])
        self.assertEqual(both["match_src00_00m00s-00m10s.mp4"]["agent_hits"], 1)
        self.assertEqual(both["match_src00_00m00s-00m10s.mp4"]["agent_queries"], ["robot arm stacking cartons on pallet #0"])
        self.assertEqual(both["match_src00_00m00s-00m10s.mp4"]["agent_rank"], 1)
        # every merge entry says which pool candidate it was folded into
        self.assertTrue(all(entry["merged_into"]["candidate"] in {item["index"] for item in pool}
                            and entry["merged_into"]["origin"] == "both" for entry in log["merged"]))
        # engine-only candidates keep the vector order the engine handed over
        engine_in_pool = [Path(item["path"]).name for item in pool if item["origin"] == "engine"]
        remaining = [Path(path).name for path in engine_paths[2:]]
        self.assertEqual(engine_in_pool, remaining[:len(engine_in_pool)])
        self.assertEqual([item["index"] for item in pool], list(range(1, len(pool) + 1)))

    def test_re_search_hits_on_low_ranked_engine_candidates_enter_the_pool(self):
        """9 agent hits that all repeat engine #8/#9/#10: those three must reach the pool."""
        engine_paths = self.engine_clips()
        repeats = [["src07", "src08", "src09"]] * 3
        report = mas.run_agent_selection(
            self.request(paths=engine_paths),
            search=self.search_returning(repeats), ask=self.ask_with_queries(3),
        )
        self.assertTrue(report["ok"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        pool = {Path(item["path"]).name: item for item in log["candidates"]}
        self.assertEqual(log["candidate_pool"]["merged"], 9)
        self.assertEqual(log["candidate_pool"]["found"], {"engine": 7, "agent": 0, "both": 3})
        self.assertEqual(log["candidate_pool"]["origins"]["both"], 3)
        for name, rank in (("match_src07_00m00s-00m10s.mp4", 1),
                           ("match_src08_00m00s-00m10s.mp4", 2),
                           ("match_src09_00m00s-00m10s.mp4", 3)):
            with self.subTest(name=name):
                # engine #8/#9/#10 used to be both "duplicate" and "past the cut"
                self.assertIn(name, pool)
                self.assertEqual(pool[name]["origin"], "both")
                self.assertEqual(pool[name]["agent_hits"], 3)
                self.assertEqual(len(pool[name]["agent_queries"]), 3)
                self.assertEqual(pool[name]["agent_rank"], rank)
        # most-hit candidates lead the agent quota, so they are judged, not truncated
        self.assertEqual([item["origin"] for item in log["candidates"]][-3:], ["both"] * 3)

    def test_agent_and_both_candidates_share_the_agent_quota(self):
        engine_paths = self.engine_clips()
        report = mas.run_agent_selection(
            self.request(paths=engine_paths),
            search=self.search_returning([["src08", "src09"], ["src30", "src31"]]),
            ask=self.ask_with_queries(2),
        )
        self.assertTrue(report["ok"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        origins = [item["origin"] for item in log["candidates"]]
        self.assertEqual(len(log["candidates"]), 8)
        # quota is ceil(8 * 0.4) = 4 and both + agent fill it together
        self.assertEqual(origins.count("both") + origins.count("agent"), 4)
        self.assertEqual(origins.count("both"), 2)
        self.assertEqual(origins.count("agent"), 2)
        self.assertEqual(origins.count("engine"), 4)
        self.assertEqual(log["candidate_pool"]["found"], {"engine": 8, "agent": 2, "both": 2})

    def test_merge_quota_hands_unused_slots_to_the_other_side(self):
        engine = [{"path": f"/e/{number}.mp4", "origin": "engine"} for number in range(10)]
        agent = [{"path": f"/a/{number}.mp4", "origin": "agent"} for number in range(6)]
        merged = mas.merge_candidates(engine, agent, limit=8, reserve_ratio=0.4)
        self.assertEqual(len(merged), 8)
        self.assertEqual(sum(1 for item in merged if item["origin"] == "agent"), 4)
        self.assertEqual(mas.merge_candidates(engine, [], limit=8, reserve_ratio=0.4), engine[:8])
        self.assertEqual(len(mas.merge_candidates(engine[:2], agent, limit=8, reserve_ratio=0.4)), 8)
        self.assertEqual(
            sum(1 for item in mas.merge_candidates(engine[:2], agent, limit=8, reserve_ratio=0.4)
                if item["origin"] == "agent"), 6)
        self.assertEqual(mas.merge_candidates(engine, agent, limit=8, reserve_ratio=0.0), engine[:8])

    def test_dedupe_key_matches_the_same_span_across_export_directories(self):
        engine = {"path": "/run/clips/shot/match_A_B_00m25s-00m51s.mp4"}
        agent = {"path": "/run/clips/shot/_agent_q02/match_A_B_00m25s-00m51s.mp4",
                 "source_name": "A B.mp4", "start": "00m25s", "end": "00m51s"}
        other = {"path": "/run/clips/shot/_agent_q02/match_A_B_00m51s-01m10s.mp4"}
        self.assertEqual(mas.dedupe_key(engine), mas.dedupe_key(agent))
        self.assertNotEqual(mas.dedupe_key(engine), mas.dedupe_key(other))
        # falls back to the span carried by the search result when the name has none
        unnamed = {"path": "/run/clips/shot/_agent_q01/source_0_4.mp4",
                   "source_name": "A B.mp4", "start": "00:25", "end": "00:51"}
        self.assertEqual(mas.dedupe_key(unnamed), mas.dedupe_key(engine))
        # and to the bare file name when neither is available
        self.assertEqual(mas.dedupe_key({"path": "/x/Plain.MP4"}), "plain.mp4")

    def test_rotated_candidate_is_refused_even_with_the_top_model_score(self):
        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": []}
            return {"ranking": [
                {"candidate": 1, "score": 95, "acceptable": True, "orientation": "rotated",
                 "reason": "标准的俯视视角，机械臂码垛清晰"},
                {"candidate": 2, "score": 60, "acceptable": True, "orientation": "upright",
                 "reason": "机械臂与托盘方向正常"},
            ], "pick": [1, 2], "summary": "ok"}

        report = mas.run_agent_selection(self.request(), search=lambda *a, **k: [], ask=fake_ask)
        self.assertTrue(report["ok"])
        self.assertEqual(Path(report["paths"][0]).name, "engine_blue.mp4")
        self.assertTrue(any("engine_red.mp4" in item["path"] and "rotated" in item["reason"]
                            for item in report["rejected"]))
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual(log["picked"][0]["orientation"], "upright")
        self.assertEqual({item["candidate"]: item["orientation"] for item in log["review"]},
                         {1: "rotated", 2: "upright"})
        self.assertTrue(any("方向兜底否决" in error for error in log["errors"]))

    def test_independent_orientation_call_overrides_an_upright_judge(self):
        """第 5 镜：同一张横倒 sheet，在「口播要俯视」的上下文里被评审说成 upright/overhead 85 分。"""
        asked: dict[str, str] = {}

        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": []}
            if ORIENTATION_MARKER in system:
                asked["user"] = user
                return {"images": [
                    {"index": 1, "orientation": "upright", "evidence": "立柱竖直、地面在下方"},
                    {"index": 2, "orientation": "rotated", "evidence": "地面在画面左侧"},
                ]}
            return {"ranking": [
                {"candidate": 1, "score": 70, "acceptable": True, "orientation": "upright",
                 "obstruction": "none", "camera_angle": "eye_level",
                 "visible": ["机械臂贴向砂带"], "missing": [], "reason": "方向正常"},
                {"candidate": 2, "score": 85, "acceptable": True, "orientation": "upright",
                 "obstruction": "none", "camera_angle": "overhead",
                 "visible": ["绿色地面俯视视角"], "missing": [], "reason": "唯一符合口播要求的俯视机位"},
            ], "pick": [2, 1]}

        report = mas.run_agent_selection(self.request(), search=lambda *a, **k: [], ask=fake_ask)
        self.assertTrue(report["ok"])
        # candidate 2 was the model's first pick at 85; it must not be used
        self.assertEqual(Path(report["paths"][0]).name, "engine_red.mp4")
        # the orientation call must not know what this shot wants
        self.assertNotIn("砂带", asked["user"])
        self.assertNotIn("去毛刺", asked["user"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        row = next(item for item in log["review"] if item["candidate"] == 2)
        self.assertEqual(row["orientation_independent"], "rotated")
        self.assertEqual(row["orientation_judge"], "upright")
        self.assertEqual(row["orientation_final"], "rotated")
        self.assertTrue(row["blocked"])
        self.assertEqual(row["block_kind"], "orientation")
        self.assertFalse(row["orientation_cache_hit"])
        self.assertEqual(log["orientation"]["results"][1]["evidence"], "地面在画面左侧")
        self.assertGreaterEqual(log["timings"]["orientation_seconds"], 0)
        self.assertTrue(any("engine_blue.mp4" in item["path"] and "rotated" in item["reason"]
                            for item in report["rejected"]))

    def test_orientation_cache_refuses_a_clip_judged_rotated_earlier_in_the_run(self):
        digest = mas.clip_sha256(self.clip_root / "engine_red.mp4")
        cache = mas.orientation_cache_path(self.clip_root)
        self.assertEqual(cache.parent.parent.name, "clips")
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"schema_version": 1, "entries": {
            digest: {"verdicts": ["rotated"], "name": "engine_red.mp4"}}}), encoding="utf-8")
        calls: list[str] = []

        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": []}
            if ORIENTATION_MARKER in system:
                calls.append("orientation")
                return orientation_reply("upright", "upright")
            calls.append("judge")
            return {"ranking": [
                {"candidate": 1, "score": 95, "acceptable": True, "orientation": "upright",
                 "obstruction": "none", "camera_angle": "eye_level",
                 "visible": ["机械臂"], "missing": [], "reason": "画面正常"},
                {"candidate": 2, "score": 70, "acceptable": True, "orientation": "upright",
                 "obstruction": "none", "camera_angle": "eye_level",
                 "visible": ["机械臂"], "missing": [], "reason": "画面正常"},
            ], "pick": [1, 2]}

        report = mas.run_agent_selection(self.request(), search=lambda *a, **k: [], ask=fake_ask)
        self.assertTrue(report["ok"])
        self.assertEqual(Path(report["paths"][0]).name, "engine_blue.mp4")
        # a cache hit never skips the call, it only overrides its answer
        self.assertEqual(calls, ["orientation", "judge"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        row = next(item for item in log["review"] if item["candidate"] == 1)
        self.assertTrue(row["orientation_cache_hit"])
        self.assertEqual(row["orientation_independent"], "upright")
        self.assertEqual(row["orientation_final"], "rotated")
        self.assertEqual(row["block_kind"], "orientation")
        self.assertEqual(row["clip_sha256"], digest)
        self.assertTrue(any("命中方向缓存" in error for error in log["errors"]))
        # this shot's verdicts are appended for the next shot of the same run
        entries = json.loads(cache.read_text(encoding="utf-8"))["entries"]
        self.assertEqual(entries[digest]["verdicts"], ["rotated", "rotated"])
        self.assertEqual(entries[mas.clip_sha256(self.clip_root / "engine_blue.mp4")]["verdicts"], ["upright"])

    def test_orientation_merge_rules(self):
        self.assertEqual(mas.combine_orientation("rotated", "upright", cached=[]), "rotated")
        self.assertEqual(mas.combine_orientation("upright", "rotated", cached=[]), "rotated")
        self.assertEqual(mas.combine_orientation("unsure", "unsure", cached=[]), "unsure")
        self.assertEqual(mas.combine_orientation("unsure", "upright", cached=[]), "upright")
        self.assertEqual(mas.combine_orientation("upright", "upright", cached=["upright", "rotated"]), "rotated")
        self.assertEqual(mas.combine_orientation("upright", "upright", cached=["upright"]), "upright")

    def test_orientation_cache_damage_is_ignored(self):
        cache = mas.orientation_cache_path(self.clip_root)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text("{not json", encoding="utf-8")
        self.assertEqual(mas.load_orientation_cache(cache), {})
        self.assertEqual(mas.load_orientation_cache(cache.parent / "missing.json"), {})

    def test_missing_orientation_is_treated_as_unsure_and_penalised(self):
        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": []}
            return {"ranking": [
                {"candidate": 1, "score": 80, "acceptable": True, "reason": "没写 orientation"},
                {"candidate": 2, "score": 70, "acceptable": True, "orientation": "upright", "reason": "方向正常"},
            ], "pick": [1, 2], "summary": "ok"}

        report = mas.run_agent_selection(self.request(), search=lambda *a, **k: [], ask=fake_ask)
        self.assertTrue(report["ok"])
        self.assertEqual(Path(report["paths"][0]).name, "engine_blue.mp4")
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        unsure = next(item for item in log["review"] if item["candidate"] == 1)
        self.assertEqual(unsure["orientation"], "unsure")
        self.assertEqual(unsure["adjusted_score"], 50.0)

    def judging(self, ranking, pick):
        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": []}
            return {"ranking": ranking, "pick": pick}
        return fake_ask

    def test_heavy_obstruction_caps_the_score_and_refuses_the_candidate(self):
        """第 3 镜：前景大面积安全网栏，模型仍写「无遮挡」并给 95 分。"""
        ask = self.judging([
            {"candidate": 1, "score": 95, "acceptable": True, "orientation": "upright",
             "obstruction": "heavy", "camera_angle": "eye_level",
             "visible": ["橙色六轴机械臂", "银色抓具"], "missing": [], "reason": "抓具夹持包装悬空"},
            {"candidate": 2, "score": 70, "acceptable": True, "orientation": "upright",
             "obstruction": "none", "camera_angle": "eye_level",
             "visible": ["抓具与包装"], "missing": [], "reason": "主体无遮挡"},
        ], [1, 2])
        report = mas.run_agent_selection(self.request(), search=lambda *a, **k: [], ask=ask)
        self.assertTrue(report["ok"])
        self.assertEqual(Path(report["paths"][0]).name, "engine_blue.mp4")
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        blocked = next(item for item in log["review"] if item["candidate"] == 1)
        self.assertEqual(blocked["model_score"], 95.0)
        self.assertEqual(blocked["adjusted_score"], 50.0)
        self.assertTrue(blocked["blocked"])
        self.assertEqual(blocked["block_kind"], "obstruction")
        self.assertTrue(any("遮挡兜底否决" in error for error in log["errors"]))
        self.assertTrue(any("engine_red.mp4" in item["path"] and "遮挡" in item["reason"]
                            for item in report["rejected"]))

    def test_partial_obstruction_keeps_a_candidate_out_of_the_90_band(self):
        ask = self.judging([
            {"candidate": 1, "score": 95, "acceptable": True, "orientation": "upright",
             "obstruction": "partial", "camera_angle": "high",
             "visible": ["机械臂"], "missing": [], "reason": "隔着网栏但动作看得清"},
        ], [1])
        report = mas.run_agent_selection(self.request(), search=lambda *a, **k: [], ask=ask)
        self.assertTrue(report["ok"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual(log["review"][0]["adjusted_score"], 75.0)
        self.assertFalse(log["review"][0]["blocked"])
        self.assertEqual(log["picked"][0]["adjusted_score"], 75.0)
        self.assertEqual(log["picked"][0]["camera_angle"], "high")

    def low_score_but_acceptable(self):
        """第 7 镜：missing 列全了，reason 写「内容不对」，却 45 分 acceptable=true。"""
        return self.judging([
            {"candidate": 1, "score": 45, "acceptable": True, "orientation": "upright",
             "obstruction": "partial", "camera_angle": "eye_level",
             "visible": ["橙色六轴机械臂", "蓝色托盘"],
             "missing": ["没有新包装样件", "没有目标垛型图纸", "没有布局图"],
             "reason": "内容不对，勉强可用的环境空镜"},
            {"candidate": 2, "score": 30, "acceptable": False, "orientation": "upright",
             "obstruction": "none", "camera_angle": "eye_level",
             "visible": ["空场地"], "missing": ["没有人员", "没有样件"], "reason": "同类车间但动作不对"},
        ], [1])

    def test_barely_usable_low_score_is_refused_and_logged_as_a_fallback_suggestion(self):
        with patch.dict(os.environ, {"MATERIAL_AGENT_FALLBACK": "stop"}):
            report = mas.run_agent_selection(
                self.request(), search=lambda *a, **k: [], ask=self.low_score_but_acceptable())
        self.assertFalse(report["ok"])
        self.assertEqual(report["paths"], [])
        self.assertIsNone(report["fallback"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        refused = next(item for item in log["review"] if item["candidate"] == 1)
        self.assertTrue(refused["blocked"])
        self.assertEqual(refused["block_kind"], "min_score")
        self.assertEqual(refused["min_accept_score"], 60.0)
        suggestion = log["fallback_suggestion"]
        self.assertEqual(suggestion["candidate"], 1)
        self.assertEqual(suggestion["adjusted_score"], 45.0)
        self.assertEqual(suggestion["missing"], ["没有新包装样件", "没有目标垛型图纸", "没有布局图"])
        self.assertTrue(suggestion["note"])
        # every refused candidate's missing list is in errors so the stop is explainable
        self.assertTrue(any("没有目标垛型图纸" in error for error in log["errors"]))
        self.assertTrue(any("候选 2" in error and "没有样件" in error for error in log["errors"]))

    def test_empty_pick_is_a_refusal_and_never_a_score_fallback(self):
        """第 2 镜：judge.pick=[]，ranking 里却有 acceptable=true 的 85 分候选。"""
        ask = self.judging([
            {"candidate": 1, "score": 85, "acceptable": True, "orientation": "upright",
             "obstruction": "none", "camera_angle": "high",
             "visible": ["红色机械臂抓取白色瓶组"], "missing": [], "reason": "单一工件的处理演示"},
        ], [])
        with patch.dict(os.environ, {"MATERIAL_AGENT_FALLBACK": "stop"}):
            report = mas.run_agent_selection(self.request(), search=lambda *a, **k: [], ask=ask)
        self.assertFalse(report["ok"])
        self.assertEqual(report["paths"], [])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual(log["picked"], [])
        self.assertTrue(any("pick 为空" in error for error in log["errors"]))
        self.assertTrue(any("engine_red.mp4" in item["path"] and "pick" in item["reason"]
                            for item in report["rejected"]))

    def test_three_missing_items_cap_the_score_at_55(self):
        """第 2 镜候选 7：missing 三条（袋料/箱体/对比）却给了 85 分并入选。"""
        ask = self.judging([
            {"candidate": 1, "score": 85, "acceptable": True, "orientation": "upright",
             "obstruction": "none", "camera_angle": "high",
             "visible": ["红色机械臂抓取白色瓶组"],
             "missing": ["没有袋料", "没有箱体", "未展示工件对比"],
             "reason": "作为单一工件的处理演示，视觉要素完整"},
        ], [1])
        with patch.dict(os.environ, {"MATERIAL_AGENT_FALLBACK": "stop"}):
            report = mas.run_agent_selection(self.request(), search=lambda *a, **k: [], ask=ask)
        self.assertFalse(report["ok"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        review = next(item for item in log["review"] if item["candidate"] == 1)
        self.assertEqual(review["missing_count"], 3)
        self.assertEqual(review["missing_cap"], 55.0)
        self.assertEqual(review["adjusted_score"], 55.0)
        self.assertTrue(review["blocked"])
        self.assertEqual(review["block_kind"], "min_score")

    def test_missing_count_caps_are_graded(self):
        for count, cap in ((0, None), (1, 89.0), (2, 75.0), (3, 55.0), (5, 55.0)):
            with self.subTest(count=count):
                self.assertEqual(mas.missing_score_cap(count), cap)
                review = mas.deterministic_review(
                    {"score": 95, "orientation": "upright", "obstruction": "none",
                     "missing": [f"缺{number}" for number in range(count)]}, min_score=0)
                self.assertEqual(review["adjusted_score"], cap if cap is not None else 95.0)

    def third_clip(self) -> str:
        clip = self.clip_root / "engine_green.mp4"
        make_clip(clip, colour="green")
        return str(clip)

    def tie_verdict(self):
        """三个候选同为 25 分：heavy 的排在前面，upright+none 的在后面。"""
        return self.judging([
            {"candidate": 1, "score": 25, "acceptable": False, "orientation": "upright",
             "obstruction": "heavy", "camera_angle": "eye_level",
             "visible": ["网栏后的机械臂"], "missing": ["网栏严重遮挡主体"], "reason": "网栏挡住主体"},
            {"candidate": 2, "score": 25, "acceptable": False, "orientation": "upright",
             "obstruction": "none", "camera_angle": "eye_level",
             "visible": ["机械臂与托盘"], "missing": ["无破包测试"], "reason": "同类车间但动作不对"},
            {"candidate": 3, "score": 25, "acceptable": False, "orientation": "rotated",
             "obstruction": "none", "camera_angle": "unsure",
             "visible": ["横倒的立柱"], "missing": ["画面整体旋转90度"], "reason": "画面横倒"},
        ], [])

    def test_fallback_suggestion_prefers_an_unobstructed_candidate_on_a_tie(self):
        paths = [str(self.clip_root / "engine_red.mp4"), str(self.clip_root / "engine_blue.mp4"),
                 self.third_clip()]
        with patch.dict(os.environ, {"MATERIAL_AGENT_FALLBACK": "stop"}):
            report = mas.run_agent_selection(
                self.request(paths=paths), search=lambda *a, **k: [], ask=self.tie_verdict())
        self.assertFalse(report["ok"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        suggestion = log["fallback_suggestion"]
        # same 25 points, so the clean one wins over the mesh one
        self.assertEqual(suggestion["candidate"], 2)
        self.assertEqual(suggestion["obstruction"], "none")
        self.assertEqual(suggestion["mode"], "stop")
        self.assertIsNone(log["fallback_used"])

    def test_fill_mode_cuts_in_a_marked_placeholder_instead_of_stopping(self):
        paths = [str(self.clip_root / "engine_red.mp4"), str(self.clip_root / "engine_blue.mp4"),
                 self.third_clip()]
        ask = self.judging([
            {"candidate": 1, "score": 50, "acceptable": True, "orientation": "upright",
             "obstruction": "heavy", "camera_angle": "eye_level",
             "visible": ["网栏后的机械臂"], "missing": ["网栏严重遮挡主体"], "reason": "分最高但被网栏挡住"},
            {"candidate": 2, "score": 30, "acceptable": False, "orientation": "upright",
             "obstruction": "none", "camera_angle": "eye_level",
             "visible": ["机械臂与托盘"], "missing": ["无破包测试"], "reason": "同类车间但动作不对"},
            {"candidate": 3, "score": 40, "acceptable": True, "orientation": "rotated",
             "obstruction": "none", "camera_angle": "unsure",
             "visible": ["横倒的立柱"], "missing": ["画面整体旋转90度"], "reason": "画面横倒"},
        ], [])
        with patch.dict(os.environ, {"MATERIAL_AGENT_FALLBACK": "fill"}):
            report = mas.run_agent_selection(
                self.request(paths=paths), search=lambda *a, **k: [], ask=ask)
        self.assertTrue(report["ok"])
        self.assertTrue(report["fallback_used"])
        self.assertIn("占位", report["fallback_reason"])
        # 方向正常 + 无遮挡的候选 2 占位，而不是分数最高（50）但 heavy 的候选 1
        self.assertEqual(len(report["paths"]), 1)
        self.assertEqual(Path(report["paths"][0]).name, "engine_blue.mp4")
        # the placeholder is not also reported as rejected
        self.assertTrue(all("engine_blue.mp4" not in item["path"] for item in report["rejected"]))
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual(len(log["picked"]), 1)
        self.assertTrue(log["picked"][0]["reason"].startswith("【占位】"))
        self.assertTrue(log["picked"][0]["fallback"])
        self.assertEqual(log["fallback_used"]["candidate"], 2)
        self.assertEqual(log["fallback_used"]["mode"], "fill")
        self.assertEqual(log["fallback_used"]["missing"], ["无破包测试"])
        self.assertIsNone(log["fallback_suggestion"])
        # every candidate's missing list is still in errors, placeholder included
        self.assertTrue(any("网栏严重遮挡主体" in error for error in log["errors"]))
        self.assertTrue(any(error.startswith("【占位】") for error in log["errors"]))
        self.assertEqual(report["agent"]["fallback_mode"], "fill")

    def test_placeholder_order_prefers_upright_then_unobstructed(self):
        entries = [
            {"candidate": 1, "adjusted_score": 50.0, "orientation": "upright", "obstruction": "heavy", "agent_hits": 3},
            {"candidate": 2, "adjusted_score": 30.0, "orientation": "upright", "obstruction": "none", "agent_hits": 0},
            {"candidate": 3, "adjusted_score": 40.0, "orientation": "rotated", "obstruction": "none", "agent_hits": 2},
            {"candidate": 4, "adjusted_score": 30.0, "orientation": "upright", "obstruction": "none", "agent_hits": 2},
        ]
        self.assertEqual([item["candidate"] for item in sorted(entries, key=mas.fill_placeholder_rank)],
                         [4, 2, 1, 3])
        # the suggestion ranks by score first, so the same tie falls to 发现顺序
        self.assertEqual([item["candidate"] for item in sorted(entries, key=mas.stop_suggestion_rank)],
                         [1, 3, 2, 4])

    def test_min_accept_score_zero_restores_the_model_verdict(self):
        with patch.dict(os.environ, {"MATERIAL_AGENT_MIN_ACCEPT_SCORE": "0"}):
            report = mas.run_agent_selection(
                self.request(), search=lambda *a, **k: [], ask=self.low_score_but_acceptable())
        self.assertTrue(report["ok"])
        self.assertEqual(Path(report["paths"][0]).name, "engine_red.mp4")
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual(log["min_accept_score"], 0.0)
        self.assertIsNone(log["fallback_suggestion"])

    def test_metadata_rotation_is_only_recorded(self):
        rotated = self.clip_root / "engine_red.mp4"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-display_rotation", "90", "-i", str(rotated),
             "-c", "copy", str(self.clip_root / "rotated_meta.mp4")],
            check=True,
        )
        self.assertEqual(mas.probe_rotation(self.clip_root / "rotated_meta.mp4"), 90)
        self.assertIsNone(mas.probe_rotation(self.clip_root / "engine_blue.mp4"))
        self.assertIsNone(mas.probe_rotation(self.clip_root / "does-not-exist.mp4"))

        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": []}
            return {"ranking": [{"candidate": 1, "score": 90, "acceptable": True,
                                 "orientation": "upright", "reason": "ok"}], "pick": [1]}

        report = mas.run_agent_selection(
            self.request(paths=[str(self.clip_root / "rotated_meta.mp4")]),
            search=lambda *a, **k: [], ask=fake_ask,
        )
        # metadata alone never rejects a candidate: ffmpeg already rotates frames on extract
        self.assertTrue(report["ok"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual(log["candidates"][0]["metadata_rotation"], 90)
        self.assertTrue(any("旋转元数据" in error for error in log["errors"]))

    def test_no_acceptable_means_not_ok_and_no_fallback(self):
        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": []}
            return {"ranking": [
                {"candidate": 1, "score": 10, "acceptable": False, "orientation": "upright", "reason": "no"},
                {"candidate": 2, "score": 12, "acceptable": False, "orientation": "upright", "reason": "no"},
            ], "pick": [], "summary": "nothing fits"}

        with patch.dict(os.environ, {"MATERIAL_AGENT_FALLBACK": "stop"}):
            report = mas.run_agent_selection(self.request(), search=lambda *a, **k: [], ask=fake_ask)
        self.assertFalse(report["ok"])
        self.assertEqual(report["paths"], [])
        self.assertIsNone(report["fallback"])
        self.assertFalse(report["fallback_used"])
        self.assertTrue((self.clip_root / mas.LOG_FILE_NAME).is_file())

    def test_paths_outside_scope_are_ignored(self):
        outside = self.temp / "outside.mp4"
        make_clip(outside)

        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": []}
            return {"ranking": [{"candidate": 1, "score": 90, "acceptable": True,
                                 "orientation": "upright", "reason": "ok"}], "pick": [1]}

        report = mas.run_agent_selection(
            self.request(paths=[str(outside), str(self.clip_root / "engine_red.mp4")]),
            search=lambda *a, **k: [], ask=fake_ask,
        )
        self.assertTrue(report["ok"])
        self.assertEqual(Path(report["paths"][0]).name, "engine_red.mp4")
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertTrue(any("不在本分镜的素材范围内" in e for e in log["errors"]))

    def test_model_failure_is_reported_not_swallowed(self):
        def failing_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": []}
            raise RuntimeError("pi exit 1")

        report = mas.run_agent_selection(self.request(), search=lambda *a, **k: [], ask=failing_ask)
        self.assertFalse(report["ok"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertTrue(any("模型判断失败" in e for e in log["errors"]))

    def test_dashscope_http_exit_writes_failure_report_and_log(self):
        with patch.dict(os.environ, {"MATERIAL_AGENT_BACKEND": "dashscope", "MATERIAL_AGENT_MAX_QUERIES": "0"}), \
             patch("optimize_queries.call_qwen", side_effect=SystemExit("Qwen query optimize HTTP 401")):
            report = mas.run_agent_selection(self.request())
        self.assertFalse(report["ok"])
        self.assertEqual(report["paths"], [])
        self.assertIsNone(report["fallback"])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertFalse(log["ok"])
        self.assertTrue(any("401" in error for error in log["errors"]))

    def test_dashscope_query_exit_still_judges_engine_candidates(self):
        # ranking 要覆盖两个候选：漏评会触发补要求重试，多消耗一次 call_qwen
        verdict = {"ranking": [{"candidate": 1, "score": 90, "acceptable": True,
                                "orientation": "upright", "reason": "visible match"},
                               {"candidate": 2, "score": 20, "acceptable": False,
                                "orientation": "upright", "reason": "蓝屏"}], "pick": [1]}
        with patch.dict(os.environ, {"MATERIAL_AGENT_BACKEND": "dashscope", "MATERIAL_AGENT_MAX_QUERIES": "1"}), \
             patch("optimize_queries.call_qwen",
                   side_effect=[SystemExit("query request HTTP 500"), orientation_reply("upright"), verdict]):
            report = mas.run_agent_selection(self.request())
        self.assertTrue(report["ok"])
        self.assertEqual(Path(report["paths"][0]).name, "engine_red.mp4")
        self.assertTrue(any("检索词改写失败" in error and "500" in error for error in report["agent"]["errors"]))

    # ---- ranking 覆盖率：漏评候选 -------------------------------------------------

    def judge_calls_counting(self, replies):
        """Fake ask that hands out ``replies`` to the judge call, one per call, in order."""
        seen: list[str] = []

        def fake_ask(system, user, images, *, timeout):
            if not images:
                return {"queries": []}
            if ORIENTATION_MARKER in system:
                return orientation_reply(*(["upright"] * len(images)))
            seen.append(user)
            return replies[min(len(seen), len(replies)) - 1]

        return fake_ask, seen

    @staticmethod
    def ranking_for(indexes):
        return [{"candidate": index, "score": 88 if index == 1 else 40,
                 "acceptable": index == 1, "orientation": "upright", "obstruction": "none",
                 "camera_angle": "eye_level", "visible": ["机械臂"], "missing": [],
                 "reason": "第 {} 条".format(index)} for index in indexes]

    def test_partial_ranking_is_asked_again_with_every_candidate_spelled_out(self):
        """Windows flash 实测：8 个候选只回了 4 条 ranking，漏掉的会被当成"全被拒"。"""
        ask, seen = self.judge_calls_counting([
            {"ranking": self.ranking_for([1, 4, 5, 6]), "pick": [1]},
            {"ranking": self.ranking_for([1, 2, 3, 4, 5, 6, 7, 8]), "pick": [1]},
        ])
        report = mas.run_agent_selection(
            self.request(paths=self.engine_clips(8)), search=lambda *a, **k: [], ask=ask)
        self.assertTrue(report["ok"])
        self.assertEqual(len(seen), 2)
        self.assertNotIn("ranking 必须包含全部", seen[0])
        self.assertIn("ranking 必须包含全部 8 个候选", seen[1])
        # 重试用的是同一份候选清单，只在末尾多一句要求
        self.assertTrue(seen[1].startswith(seen[0]))
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual(log["unreviewed"], [])
        self.assertEqual([item["candidate"] for item in log["judge"]["ranking"]], list(range(1, 9)))
        self.assertEqual([item["candidate"] for item in log["review"]], list(range(1, 9)))
        self.assertTrue(all(item["reviewed"] for item in log["review"]))
        self.assertEqual(log["picked"][0]["candidate"], 1)

    def test_candidates_missing_from_both_rankings_are_logged_as_unreviewed(self):
        ask, seen = self.judge_calls_counting([
            {"ranking": self.ranking_for([1, 4, 5, 6]), "pick": [2, 1]},
        ])
        report = mas.run_agent_selection(
            self.request(paths=self.engine_clips(8)), search=lambda *a, **k: [], ask=ask)
        # 本镜不中断：有结论的候选照常选
        self.assertTrue(report["ok"])
        self.assertEqual(len(seen), 2)  # 只重试一次
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual(log["unreviewed"], [2, 3, 7, 8])
        self.assertTrue(any("评审漏评候选 2、3、7、8" in error for error in log["errors"]))
        self.assertTrue(any("未评审的候选 2" in error for error in log["errors"]))
        # 未评审的候选既不进 ranking 也不拿分，只在 review 里留一条 reviewed=false
        self.assertEqual([item["candidate"] for item in log["judge"]["ranking"]], [1, 4, 5, 6])
        unreviewed_rows = [item for item in log["review"] if not item["reviewed"]]
        self.assertEqual([item["candidate"] for item in unreviewed_rows], [2, 3, 7, 8])
        self.assertTrue(all("adjusted_score" not in item and "blocked" not in item
                            for item in unreviewed_rows))
        # pick 里那条未评审的候选不参与选择
        self.assertEqual([item["candidate"] for item in log["picked"]], [1])
        self.assertEqual(len(report["paths"]), 1)
        picked_name = Path(report["paths"][0]).name
        self.assertEqual(picked_name, Path(log["candidates"][0]["path"]).name)

    def test_complete_ranking_is_never_asked_twice(self):
        ask, seen = self.judge_calls_counting([
            {"ranking": self.ranking_for([1, 2, 3, 4, 5, 6, 7, 8]), "pick": [1]},
        ])
        report = mas.run_agent_selection(
            self.request(paths=self.engine_clips(8)), search=lambda *a, **k: [], ask=ask)
        self.assertTrue(report["ok"])
        self.assertEqual(len(seen), 1)
        self.assertNotIn("ranking 必须包含全部", seen[0])
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual(log["unreviewed"], [])

    def test_repeated_candidate_entries_keep_the_first_verdict(self):
        ask, seen = self.judge_calls_counting([
            {"ranking": self.ranking_for([1, 2]) + [
                {"candidate": 1, "score": 10, "acceptable": False, "orientation": "rotated",
                 "reason": "同一条候选的第二份结论"}], "pick": [1]},
        ])
        report = mas.run_agent_selection(
            self.request(paths=[str(self.clip_root / "engine_red.mp4"), str(self.clip_root / "engine_blue.mp4")]),
            search=lambda *a, **k: [], ask=ask)
        self.assertTrue(report["ok"])
        self.assertEqual(len(seen), 1)
        log = json.loads((self.clip_root / mas.LOG_FILE_NAME).read_text(encoding="utf-8"))
        self.assertEqual([item["candidate"] for item in log["judge"]["ranking"]], [1, 2])
        self.assertEqual(log["judge"]["duplicate_candidates"], [1])
        self.assertEqual(log["picked"][0]["orientation"], "upright")
        self.assertTrue(any("各写了多条结论" in error for error in log["errors"]))


class PolicyEntryTests(unittest.TestCase):

    """The patched policy script must behave exactly like the original when the flag is off."""

    def test_policy_imports_and_branches(self):
        import importlib

        import material_selection_policy as policy
        importlib.reload(policy)
        self.assertTrue(hasattr(policy, "choose_candidates"))
        self.assertTrue(hasattr(policy, "run_agent_selection"))
        os.environ.pop("MATERIAL_AGENT_SELECT", None)
        self.assertFalse(mas.agent_enabled())
        os.environ["MATERIAL_AGENT_SELECT"] = "1"
        self.assertTrue(mas.agent_enabled())
        os.environ.pop("MATERIAL_AGENT_SELECT", None)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class DashscopeListRetryTests(unittest.TestCase):
    def test_top_level_array_answer_is_retried_once_with_object_nudge(self):
        import material_agent_select as mas_module
        calls = []

        def fake_call_qwen(messages, **kwargs):
            calls.append(messages[1]["content"][0]["text"])
            if len(calls) == 1:
                raise ValueError("Qwen 模型输出 顶层必须是 JSON 对象，实际为 list")
            return {"images": [{"index": 1, "orientation": "upright"}]}

        import types, sys as _sys
        fake_module = types.ModuleType("optimize_queries")
        fake_module.call_qwen = fake_call_qwen
        saved = _sys.modules.get("optimize_queries")
        _sys.modules["optimize_queries"] = fake_module
        try:
            with tempfile.TemporaryDirectory() as tmp:
                image = Path(tmp) / "sheet.jpg"
                image.write_bytes(b"\xff\xd8\xff\xd9")
                result = mas_module.ask_dashscope("sys", "user text", [image], timeout=5)
        finally:
            if saved is not None:
                _sys.modules["optimize_queries"] = saved
            else:
                _sys.modules.pop("optimize_queries", None)
        self.assertEqual(result["images"][0]["orientation"], "upright")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], "user text")
        self.assertIn("顶层必须是一个 JSON 对象", calls[1])

    def test_other_value_errors_are_not_retried(self):
        import material_agent_select as mas_module
        import types, sys as _sys
        fake_module = types.ModuleType("optimize_queries")
        fake_module.call_qwen = lambda messages, **kwargs: (_ for _ in ()).throw(ValueError("Qwen 模型输出 不是有效 JSON"))
        saved = _sys.modules.get("optimize_queries")
        _sys.modules["optimize_queries"] = fake_module
        try:
            with self.assertRaises(RuntimeError):
                mas_module.ask_dashscope("sys", "user", [], timeout=5)
        finally:
            if saved is not None:
                _sys.modules["optimize_queries"] = saved
            else:
                _sys.modules.pop("optimize_queries", None)


class PiApiKeySourceTests(unittest.TestCase):
    def test_gateway_provider_reuses_dashscope_key(self):
        with unittest.mock.patch.dict(os.environ, {"MATERIAL_AGENT_PI_PROVIDER": "evst-gateway", "DASHSCOPE_API_KEY": "k1", "MATERIAL_AGENT_PI_API_KEY": "", "MATERIAL_AGENT_PI_API_KEY_FROM": ""}):
            self.assertEqual(mas.pi_api_key(), "k1")

    def test_other_provider_does_not_leak_dashscope_key_unless_asked(self):
        with unittest.mock.patch.dict(os.environ, {"MATERIAL_AGENT_PI_PROVIDER": "deepseek", "DASHSCOPE_API_KEY": "k1", "MATERIAL_AGENT_PI_API_KEY": "", "MATERIAL_AGENT_PI_API_KEY_FROM": ""}):
            self.assertEqual(mas.pi_api_key(), "")
        with unittest.mock.patch.dict(os.environ, {"MATERIAL_AGENT_PI_PROVIDER": "deepseek", "DASHSCOPE_API_KEY": "k1", "MATERIAL_AGENT_PI_API_KEY": "", "MATERIAL_AGENT_PI_API_KEY_FROM": "dashscope"}):
            self.assertEqual(mas.pi_api_key(), "k1")


class IsolatedRuntimeRootMixin:
    """把 `runtime_root()` 指到一棵空目录，隔离「包内自带 pi / 包内 node-runtime」的探测。

    `5a00226` 起 `pi_executable()` 先看包内 `…/pi/node_modules/…/dist/bundle/cli.js`、
    `node_executable()` 先看包内 `node-runtime/node.exe`。机器上真装了 pi 时（打包机
    必装），只 patch `shutil.which` / PATH 的用例会命中仓库里那份真文件而变红——
    Windows 侧实测 `test_missing_pi_returns_none` 等 3 条就是这么红的。这里统一在
    setUp 把 root 挪到空 tmp 目录，装没装都不影响结果。

    需要验证「包内探测」本身的用例（`BundledPiTests` / `PiProviderConfigTests`）不用
    这个 mixin：它们各自造真实文件并自己 patch `runtime_root`。

    同理要清掉两个 node 覆盖键：`node_executable()` 依次读 `MATERIAL_AGENT_NODE_EXE` 和
    `VIDEOAUTO_NODE_EXE`，外部环境里设了任意一个（比如为了让真 lint 用例跑起来而指向运行包
    的 node），`test_cmd_shim_falls_back_to_node_on_path` 这类用例就会红——2026-09-18
    Windows 侧实测 5 项。
    """

    NODE_ENV_KEYS = ("MATERIAL_AGENT_NODE_EXE", "VIDEOAUTO_NODE_EXE")

    def setUp(self):
        super().setUp()
        environment = patch.dict(os.environ, {}, clear=False)
        environment.start()
        self.addCleanup(environment.stop)
        for key in self.NODE_ENV_KEYS:
            os.environ.pop(key, None)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.empty_runtime_root = Path(directory.name)
        patcher = patch.object(mas, "runtime_root", return_value=self.empty_runtime_root)
        patcher.start()
        self.addCleanup(patcher.stop)


class PiCommandTests(IsolatedRuntimeRootMixin, unittest.TestCase):
    """Windows: npm's pi.CMD truncates the arguments at the first newline, so the
    multi-line system prompt never reaches pi. Launch the bundled cli.js with node."""

    CLI_PARTS = ("node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")

    def npm_dir(self, tmp: str, *, shim: str = "pi.CMD", with_cli: bool = True, with_node: bool = True) -> Path:
        root = Path(tmp)
        (root / shim).write_text("@echo off\n", encoding="utf-8")
        if with_cli:
            cli = root.joinpath(*self.CLI_PARTS)
            cli.parent.mkdir(parents=True, exist_ok=True)
            cli.write_text("#!/usr/bin/env node\n", encoding="utf-8")
        if with_node:
            (root / "node.exe").write_text("", encoding="utf-8")
        return root

    def test_env_pointing_at_cli_js_gets_node_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = Path(tmp) / "cli.js"
            cli.write_text("#!/usr/bin/env node\n", encoding="utf-8")
            with patch.dict(os.environ, {"MATERIAL_AGENT_PI_EXE": str(cli), "MATERIAL_AGENT_NODE_EXE": ""}), \
                 patch.object(mas.shutil, "which", return_value="/usr/local/bin/node"):
                self.assertEqual(mas.pi_command(), ["/usr/local/bin/node", str(cli)])

    def test_env_node_exe_wins_over_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = Path(tmp) / "cli.mjs"
            cli.write_text("", encoding="utf-8")
            node = Path(tmp) / "node-runtime-node"
            node.write_text("", encoding="utf-8")
            with patch.dict(os.environ, {"MATERIAL_AGENT_PI_EXE": str(cli), "MATERIAL_AGENT_NODE_EXE": str(node)}), \
                 patch.object(mas.shutil, "which", return_value="/usr/local/bin/node"):
                self.assertEqual(mas.pi_command(), [str(node), str(cli)])

    def test_cmd_shim_resolves_bundled_cli_js_with_sibling_node(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.npm_dir(tmp)
            shim = root / "pi.CMD"
            with patch.dict(os.environ, {"MATERIAL_AGENT_PI_EXE": "", "MATERIAL_AGENT_NODE_EXE": ""}), \
                 patch.object(mas.shutil, "which", return_value=str(shim)):
                self.assertEqual(
                    mas.pi_command(),
                    [str(root / "node.exe"), str(root.joinpath(*self.CLI_PARTS))],
                )

    def test_cmd_shim_falls_back_to_node_on_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.npm_dir(tmp, shim="pi.bat", with_node=False)
            with patch.dict(os.environ, {"MATERIAL_AGENT_PI_EXE": str(root / "pi.bat"), "MATERIAL_AGENT_NODE_EXE": ""}), \
                 patch.object(mas.shutil, "which", return_value="C:\\Program Files\\nodejs\\node.exe"):
                self.assertEqual(
                    mas.pi_command(),
                    ["C:\\Program Files\\nodejs\\node.exe", str(root.joinpath(*self.CLI_PARTS))],
                )

    def test_cmd_shim_without_cli_js_raises_with_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.npm_dir(tmp, with_cli=False)
            shim = root / "pi.CMD"
            with patch.dict(os.environ, {"MATERIAL_AGENT_PI_EXE": str(shim), "MATERIAL_AGENT_NODE_EXE": ""}), \
                 patch.object(mas.shutil, "which", return_value=str(shim)):
                with self.assertRaises(RuntimeError) as caught:
                    mas.pi_command()
        message = str(caught.exception)
        self.assertIn(str(shim), message)
        self.assertIn("cli.js", message)

    def test_cmd_shim_without_node_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.npm_dir(tmp, with_node=False)
            shim = root / "pi.CMD"
            with patch.dict(os.environ, {"MATERIAL_AGENT_PI_EXE": str(shim), "MATERIAL_AGENT_NODE_EXE": ""}), \
                 patch.object(mas.shutil, "which", return_value=None):
                with self.assertRaises(RuntimeError) as caught:
                    mas.pi_command()
        self.assertIn("node", str(caught.exception))

    def test_plain_pi_path_is_used_as_is(self):
        with patch.dict(os.environ, {"MATERIAL_AGENT_PI_EXE": "", "MATERIAL_AGENT_NODE_EXE": ""}), \
             patch.object(mas.shutil, "which", return_value="/usr/local/bin/pi"):
            self.assertEqual(mas.pi_command(), ["/usr/local/bin/pi"])

    def test_missing_pi_returns_none(self):
        with patch.dict(os.environ, {"MATERIAL_AGENT_PI_EXE": "", "MATERIAL_AGENT_NODE_EXE": ""}), \
             patch.object(mas.shutil, "which", return_value=None):
            self.assertIsNone(mas.pi_command())

    def test_ask_pi_runs_node_with_cli_js(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.npm_dir(tmp)
            shim = root / "pi.CMD"
            completed = subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout=json.dumps({
                    "type": "message_end",
                    "message": {"role": "assistant", "content": '{"ok": true}'},
                }),
                stderr="",
            )
            env = {
                "MATERIAL_AGENT_PI_EXE": str(shim), "MATERIAL_AGENT_NODE_EXE": "",
                "MATERIAL_AGENT_PI_PROVIDER": "dashscope", "DASHSCOPE_API_KEY": "",
                "MATERIAL_AGENT_PI_API_KEY": "", "MATERIAL_AGENT_PI_API_KEY_FROM": "",
            }
            with patch.dict(os.environ, env), \
                 patch.object(mas.shutil, "which", return_value=str(shim)), \
                 patch.object(mas.subprocess, "run", return_value=completed) as run:
                result = mas.ask_pi("多行\nsystem prompt", "用户文本\n第二行", [], timeout=5)
        self.assertEqual(result, {"ok": True})
        command = run.call_args.args[0]
        self.assertEqual(command[:2], [str(root / "node.exe"), str(root.joinpath(*self.CLI_PARTS))])
        self.assertEqual(command[2], "-p")
        self.assertEqual(command[-1], "用户文本\n第二行")
        self.assertIn("多行\nsystem prompt", command)


class PiPromptShapeTests(IsolatedRuntimeRootMixin, unittest.TestCase):
    """ask_pi 的命令行拼装 + 顶层数组重试 + 调试打印脱敏。

    顺序结论（2026-09-17 实证 pi 0.85.1）：pi 把 `--` 之后的位置参数按 `@` 前缀
    拆进 fileArgs / messages 两个数组，再固定拼成「文本在前、图片在后」，命令行
    上的先后并不传递给模型。所以命令行保持 `-- @图片… user_text`，user_text 仍在
    最后一个；这里把这个契约钉死，免得后人以为改顺序能改模型输入。
    """

    CLI_PARTS = PiCommandTests.CLI_PARTS
    ENV = {
        "MATERIAL_AGENT_PI_EXE": "", "MATERIAL_AGENT_NODE_EXE": "",
        "MATERIAL_AGENT_PI_PROVIDER": "dashscope", "DASHSCOPE_API_KEY": "",
        "MATERIAL_AGENT_PI_API_KEY": "", "MATERIAL_AGENT_PI_API_KEY_FROM": "",
        "MATERIAL_AGENT_PI_DEBUG_COMMAND": "",
    }

    def pi_event(self, payload: str) -> str:
        return json.dumps({"type": "message_end", "message": {"role": "assistant", "content": payload}})

    def completed(self, payload: str) -> subprocess.CompletedProcess:
        return subprocess.CompletedProcess(args=[], returncode=0, stdout=self.pi_event(payload), stderr="")

    def run_ask_pi(self, payloads, images=(), env_extra=None, user_text="用户文本\n第二行"):
        env = dict(self.ENV)
        env.update(env_extra or {})
        results = [self.completed(p) for p in payloads]
        with patch.dict(os.environ, env), \
             patch.object(mas.shutil, "which", return_value="/usr/local/bin/pi"), \
             patch.object(mas.subprocess, "run", side_effect=results) as run:
            try:
                value = mas.ask_pi("多行\nsystem prompt", user_text, list(images), timeout=5)
            except Exception as error:  # noqa: BLE001 - surfaced to the caller for assertions
                return None, error, run
        return value, None, run

    # -- 图文顺序 ---------------------------------------------------------
    def test_user_text_is_the_last_positional_after_the_image_args(self):
        with tempfile.TemporaryDirectory() as tmp:
            images = [Path(tmp) / "a.jpg", Path(tmp) / "b.jpg"]
            value, error, run = self.run_ask_pi(['{"ok": true}'], images=images)
        self.assertIsNone(error)
        self.assertEqual(value, {"ok": True})
        command = run.call_args.args[0]
        separator = command.index("--")
        self.assertEqual(command[separator + 1:], [f"@{images[0]}", f"@{images[1]}", "用户文本\n第二行"])
        # user_text 必须是单个位置参数：多个非 @ 参数会被 pi 当成多轮对话逐条发送。
        self.assertEqual(sum(1 for item in command[separator + 1:] if not item.startswith("@")), 1)

    # -- 顶层数组重试 -----------------------------------------------------
    def test_top_level_array_is_retried_once_with_object_nudge(self):
        buffer = io.StringIO()
        with patch("sys.stdout", buffer):
            value, error, run = self.run_ask_pi(['[{"index": 1}, {"index": 2}]', '{"images": [{"index": 1}]}'])
        self.assertIsNone(error)
        self.assertEqual(value, {"images": [{"index": 1}]})
        self.assertEqual(run.call_count, 2)
        first, second = run.call_args_list[0].args[0], run.call_args_list[1].args[0]
        self.assertEqual(first[-1], "用户文本\n第二行")
        self.assertEqual(second[-1], "用户文本\n第二行" + mas.TOP_LEVEL_LIST_NUDGE)
        self.assertIn("顶层必须是一个 JSON 对象", second[-1])
        self.assertIn(mas.TOP_LEVEL_LIST_RETRY_LOG, buffer.getvalue())

    def test_single_element_array_also_counts_as_a_top_level_array(self):
        buffer = io.StringIO()
        with patch("sys.stdout", buffer):
            value, error, run = self.run_ask_pi(['[{"index": 1}]', '{"images": []}'])
        self.assertIsNone(error)
        self.assertEqual(value, {"images": []})
        self.assertEqual(run.call_count, 2)

    def test_two_arrays_in_a_row_raise(self):
        buffer = io.StringIO()
        with patch("sys.stdout", buffer):
            value, error, run = self.run_ask_pi(['[{"index": 1}, {"index": 2}]', '[{"index": 3}, {"index": 4}]'])
        self.assertIsNone(value)
        self.assertIsInstance(error, ValueError)
        self.assertIn(mas.TOP_LEVEL_LIST_MARKER, str(error))
        self.assertEqual(run.call_count, 2)

    def test_non_array_parse_failure_is_not_retried(self):
        value, error, run = self.run_ask_pi(["这不是 JSON"])
        self.assertIsNone(value)
        self.assertIsInstance(error, ValueError)
        self.assertNotIn(mas.TOP_LEVEL_LIST_MARKER, str(error))
        self.assertEqual(run.call_count, 1)

    # -- 调试打印 ---------------------------------------------------------
    def test_debug_command_masks_api_key_and_clips_long_text(self):
        long_text = "很长的用户文本" * 40
        buffer = io.StringIO()
        with patch("sys.stdout", buffer):
            value, error, _ = self.run_ask_pi(
                ['{"ok": true}'],
                env_extra={"MATERIAL_AGENT_PI_DEBUG_COMMAND": "1", "MATERIAL_AGENT_PI_API_KEY": "sk-super-secret-key"},
                user_text=long_text,
            )
        self.assertIsNone(error)
        self.assertEqual(value, {"ok": True})
        printed = buffer.getvalue()
        self.assertIn("[agent] pi command: ", printed)
        self.assertNotIn("sk-super-secret-key", printed)
        self.assertIn("--api-key ***", printed)
        # 长文本只留前 60 字 + 总长，system prompt 的换行也不会把日志打成多行。
        self.assertIn(f"|len={len(long_text)}>", printed)
        self.assertNotIn(long_text, printed)
        self.assertIn("多行\\nsystem prompt", printed)
        self.assertEqual(len(printed.strip().splitlines()), 1)

    def test_debug_command_is_off_by_default(self):
        buffer = io.StringIO()
        with patch("sys.stdout", buffer):
            self.run_ask_pi(['{"ok": true}'], env_extra={"MATERIAL_AGENT_PI_API_KEY": "sk-super-secret-key"})
        self.assertNotIn("[agent] pi command:", buffer.getvalue())


class BundledPiTests(unittest.TestCase):
    """运行包自带 pi：`tools/material_gen/pi/…/cli.js` 与 `node-runtime/node.exe` 自动探测。

    root 的算法与 template_packaging 一致（`tools/` 的上级），这里造一棵假运行包再
    patch `runtime_root`，不依赖真实安装。
    """

    ENV = {
        "MATERIAL_AGENT_PI_EXE": "", "MATERIAL_AGENT_NODE_EXE": "", "VIDEOAUTO_NODE_EXE": "",
    }

    def make_root(self, tmp: str, *, with_pi: bool = True, node: str | None = "node-runtime/node.exe") -> Path:
        root = Path(tmp)
        if with_pi:
            cli = root.joinpath(*mas.BUNDLED_PI_CLI_PARTS)
            cli.parent.mkdir(parents=True, exist_ok=True)
            cli.write_text("#!/usr/bin/env node\n", encoding="utf-8")
        if node:
            executable = root.joinpath(*node.split("/"))
            executable.parent.mkdir(parents=True, exist_ok=True)
            executable.write_text("", encoding="utf-8")
        return root

    def test_runtime_root_is_the_parent_of_tools(self):
        self.assertEqual(mas.runtime_root(), Path(mas.__file__).resolve().parents[1])
        self.assertTrue((mas.runtime_root() / "tools").is_dir())

    def test_bundled_cli_beats_pi_on_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp)
            with patch.dict(os.environ, self.ENV), patch.object(mas, "runtime_root", return_value=root), \
                 patch.object(mas.shutil, "which", return_value="/usr/local/bin/pi"):
                self.assertEqual(mas.pi_executable(), str(root.joinpath(*mas.BUNDLED_PI_CLI_PARTS)))

    def test_env_exe_beats_the_bundled_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp)
            elsewhere = root / "elsewhere.js"
            elsewhere.write_text("", encoding="utf-8")
            with patch.dict(os.environ, {**self.ENV, "MATERIAL_AGENT_PI_EXE": str(elsewhere)}), \
                 patch.object(mas, "runtime_root", return_value=root), \
                 patch.object(mas.shutil, "which", return_value="/usr/local/bin/pi"):
                self.assertEqual(mas.pi_executable(), str(elsewhere))

    def test_without_a_bundled_cli_it_falls_back_to_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp, with_pi=False)
            with patch.dict(os.environ, self.ENV), patch.object(mas, "runtime_root", return_value=root), \
                 patch.object(mas.shutil, "which", return_value="/usr/local/bin/pi"):
                self.assertEqual(mas.pi_executable(), "/usr/local/bin/pi")

    def test_pi_command_pairs_the_bundled_cli_with_the_bundled_node(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp)
            with patch.dict(os.environ, self.ENV), patch.object(mas, "runtime_root", return_value=root), \
                 patch.object(mas.shutil, "which", return_value=None):
                self.assertEqual(
                    mas.pi_command(),
                    [str(root / "node-runtime" / "node.exe"), str(root.joinpath(*mas.BUNDLED_PI_CLI_PARTS))],
                )

    def test_node_resolution_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp)
            bundled = str(root / "node-runtime" / "node.exe")
            explicit = root / "explicit-node"
            explicit.write_text("", encoding="utf-8")
            shared = root / "shared-node"
            shared.write_text("", encoding="utf-8")
            cases = [
                ({"MATERIAL_AGENT_NODE_EXE": str(explicit), "VIDEOAUTO_NODE_EXE": str(shared)}, str(explicit)),
                ({"VIDEOAUTO_NODE_EXE": str(shared)}, str(shared)),
                ({}, bundled),
            ]
            for extra, expected in cases:
                with self.subTest(extra=sorted(extra)):
                    with patch.dict(os.environ, {**self.ENV, **extra}), \
                         patch.object(mas, "runtime_root", return_value=root), \
                         patch.object(mas.shutil, "which", return_value="/usr/local/bin/node"):
                        self.assertEqual(mas.node_executable(), expected)

    def test_node_slash_node_exe_is_the_second_bundled_location(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp, node="node/node.exe")
            with patch.dict(os.environ, self.ENV), patch.object(mas, "runtime_root", return_value=root), \
                 patch.object(mas.shutil, "which", return_value="/usr/local/bin/node"):
                self.assertEqual(mas.node_executable(), str(root / "node" / "node.exe"))

    def test_node_falls_back_to_the_sibling_then_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp, node=None)
            sibling = root / "npm"
            sibling.mkdir()
            (sibling / "node.exe").write_text("", encoding="utf-8")
            with patch.dict(os.environ, self.ENV), patch.object(mas, "runtime_root", return_value=root), \
                 patch.object(mas.shutil, "which", return_value="/usr/local/bin/node"):
                self.assertEqual(mas.node_executable(sibling), str(sibling / "node.exe"))
                self.assertEqual(mas.node_executable(), "/usr/local/bin/node")


class BackendDefaultTests(unittest.TestCase):
    """包内自带 pi 后，「找得到 pi 就默认 pi」会让所有安装静默换后端，所以默认收紧成 dashscope。"""

    def test_default_is_dashscope_even_when_pi_is_found(self):
        with patch.dict(os.environ, {"MATERIAL_AGENT_BACKEND": ""}), \
             patch.object(mas, "pi_executable", return_value="/anywhere/cli.js") as found:
            self.assertEqual(mas.backend_name(), "dashscope")
        found.assert_not_called()

    def test_only_an_explicit_setting_selects_pi(self):
        for value, expected in (("pi", "pi"), ("PI", "pi"), ("dashscope", "dashscope"),
                                ("", "dashscope"), ("nonsense", "dashscope")):
            with self.subTest(value=value), patch.dict(os.environ, {"MATERIAL_AGENT_BACKEND": value}), \
                 patch.object(mas, "pi_executable", return_value="/anywhere/cli.js"):
                self.assertEqual(mas.backend_name(), expected)


class PiProviderConfigTests(unittest.TestCase):
    """首启把包内 models.{provider}.json 并进 pi 的 models.json：只动 providers[该 provider]。"""

    def test_tracked_provider_templates_reference_environment_key(self):
        runtime_template = TOOLS / "material_gen" / "pi" / "models.evst-gateway.json"
        docs_template = Path(__file__).resolve().parents[2] / "docs" / "pi-models.evst-gateway.json"
        runtime_document = json.loads(runtime_template.read_text(encoding="utf-8"))
        docs_document = json.loads(docs_template.read_text(encoding="utf-8"))
        expected = "$DASHSCOPE_API_KEY"
        self.assertTrue(runtime_document["providers"]["evst-gateway"]["apiKey"] == expected, "runtime provider template must use the approved environment reference")
        self.assertTrue(docs_document == runtime_document, "documented provider template must match the runtime template")

    PROVIDER = "evst-gateway"
    WANTED = {"name": "EVST gateway", "baseUrl": "https://api.evstai.com/v1", "api": "openai-completions"}

    def setup_root(self, tmp: str, *, provider: str = PROVIDER, body: dict | None = None) -> tuple[Path, Path]:
        root = Path(tmp) / "runtime"
        directory = root.joinpath(*mas.BUNDLED_PI_DIR_PARTS)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"models.{provider}.json").write_text(
            json.dumps({"providers": {provider: body if body is not None else self.WANTED}}), encoding="utf-8")
        return root, Path(tmp) / "agent"

    @contextlib.contextmanager
    def bundled(self, root: Path, agent: Path, **extra: str):
        env = {"PI_CODING_AGENT_DIR": str(agent), "MATERIAL_AGENT_PI_PROVIDER": self.PROVIDER,
               "MATERIAL_AGENT_PI_SKIP_PROVIDER_MERGE": "", **extra}
        buffer = io.StringIO()
        with patch.dict(os.environ, env), patch.object(mas, "runtime_root", return_value=root), \
             patch("sys.stdout", buffer):
            yield buffer

    def test_missing_models_json_is_created_with_its_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, agent = self.setup_root(tmp)
            with self.bundled(root, agent) as buffer:
                mas.ensure_pi_provider_config()
            written = json.loads((agent / "models.json").read_text(encoding="utf-8"))
        self.assertEqual(written, {"providers": {self.PROVIDER: self.WANTED}})
        self.assertIn(mas.PI_PROVIDER_CONFIG_LOG, buffer.getvalue())

    def test_other_providers_and_other_top_level_keys_survive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, agent = self.setup_root(tmp)
            agent.mkdir(parents=True)
            (agent / "models.json").write_text(json.dumps({
                "providers": {"deepseek": {"name": "mine"}, self.PROVIDER: {"name": "旧的"}},
                "somethingElse": [1, 2],
            }), encoding="utf-8")
            with self.bundled(root, agent):
                mas.ensure_pi_provider_config()
            written = json.loads((agent / "models.json").read_text(encoding="utf-8"))
        self.assertEqual(written["providers"]["deepseek"], {"name": "mine"})
        self.assertEqual(written["providers"][self.PROVIDER], self.WANTED)
        self.assertEqual(written["somethingElse"], [1, 2])

    def test_identical_content_is_not_rewritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, agent = self.setup_root(tmp)
            agent.mkdir(parents=True)
            target = agent / "models.json"
            target.write_text(json.dumps({"providers": {self.PROVIDER: self.WANTED}}), encoding="utf-8")
            before = target.stat().st_mtime_ns, target.read_text(encoding="utf-8")
            with self.bundled(root, agent) as buffer:
                mas.ensure_pi_provider_config()
            self.assertEqual((target.stat().st_mtime_ns, target.read_text(encoding="utf-8")), before)
        self.assertIn("已一致，跳过", buffer.getvalue())

    def test_the_switch_turns_the_merge_off(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, agent = self.setup_root(tmp)
            with self.bundled(root, agent, MATERIAL_AGENT_PI_SKIP_PROVIDER_MERGE="1") as buffer:
                mas.ensure_pi_provider_config()
            self.assertFalse((agent / "models.json").exists())
        self.assertEqual(buffer.getvalue(), "")

    def test_a_provider_without_a_bundled_file_is_a_silent_no_op(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, agent = self.setup_root(tmp)
            with self.bundled(root, agent, MATERIAL_AGENT_PI_PROVIDER="dashscope") as buffer:
                mas.ensure_pi_provider_config()
            self.assertFalse((agent / "models.json").exists())
        self.assertEqual(buffer.getvalue(), "")

    def test_a_damaged_models_json_warns_and_keeps_the_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, agent = self.setup_root(tmp)
            agent.mkdir(parents=True)
            target = agent / "models.json"
            target.write_text("{ 这不是 JSON", encoding="utf-8")
            with self.bundled(root, agent) as buffer:
                mas.ensure_pi_provider_config()  # 不抛
            self.assertEqual(target.read_text(encoding="utf-8"), "{ 这不是 JSON")
            self.assertEqual(list(agent.iterdir()), [target])  # 临时文件已清掉
        self.assertIn("合并失败", buffer.getvalue())

    def test_an_unwritable_target_does_not_raise(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, agent = self.setup_root(tmp)
            with self.bundled(root, agent) as buffer, \
                 patch.object(mas.os, "replace", side_effect=OSError("只读盘")):
                mas.ensure_pi_provider_config()
        self.assertIn("合并失败", buffer.getvalue())

    def test_pi_backend_merges_before_the_first_model_call(self):
        """调用点：run_agent_selection 判完 backend 就合并一次，dashscope 后端不碰用户目录。"""
        source = Path(mas.__file__).read_text(encoding="utf-8")
        self.assertIn('if backend == "pi":\n', source)
        self.assertIn("ensure_pi_provider_config()", source)


class PiProviderMissingWarningTests(unittest.TestCase):
    """backend=pi 但 provider 查无定义 → 第一次调用前一行醒目告警（不阻断、不改降级）。

    2026-09-21 Windows 回帖 51296044 第五节：只开 `PACKAGING_AGENT_BACKEND=pi`、
    不配 `MATERIAL_AGENT_PI_PROVIDER` 时取默认 `dashscope`，而运行包只带
    `models.evst-gateway.json` → pi 报 Unknown provider → 每镜 0.2s 静默降级。
    """

    @contextlib.contextmanager
    def environment(self, tmp: str, *, provider: str = "dashscope", bundled: str | None = None,
                    **extra: str):
        root = Path(tmp) / "runtime"
        directory = root.joinpath(*mas.BUNDLED_PI_DIR_PARTS)
        directory.mkdir(parents=True, exist_ok=True)
        if bundled:
            (directory / f"models.{bundled}.json").write_text(
                json.dumps({"providers": {bundled: {"name": "x"}}}), encoding="utf-8")
        agent = Path(tmp) / "agent"
        buffer = io.StringIO()
        mas._PI_PROVIDER_WARNED.clear()
        self.addCleanup(mas._PI_PROVIDER_WARNED.clear)
        environment = {"PI_CODING_AGENT_DIR": str(agent),
                       "MATERIAL_AGENT_PI_PROVIDER": provider,
                       "MATERIAL_AGENT_PI_API_KEY": "",
                       "MATERIAL_AGENT_PI_SKIP_PROVIDER_MERGE": "", **extra}
        with patch.dict(os.environ, environment), \
             patch.object(mas, "runtime_root", return_value=root), patch("sys.stdout", buffer):
            yield agent, buffer

    def test_warns_once_per_process_when_nothing_defines_the_provider(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.environment(tmp, bundled="evst-gateway") as (_agent, buffer):
                self.assertIs(mas.make_ask("pi"), mas.ask_pi)
                self.assertIs(mas.make_ask("pi"), mas.ask_pi)
                output = buffer.getvalue()
        self.assertEqual(output.count(mas.PI_PROVIDER_MISSING_LOG), 1)
        self.assertIn("MATERIAL_AGENT_PI_PROVIDER", output)
        self.assertIn("降级", output)

    def test_silent_when_the_bundled_config_carries_the_provider(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.environment(tmp, provider="evst-gateway", bundled="evst-gateway") as (_a, buffer):
                mas.make_ask("pi")
            self.assertEqual(buffer.getvalue(), "")

    def test_silent_when_the_user_models_json_carries_the_provider(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.environment(tmp, provider="mine") as (agent, buffer):
                agent.mkdir(parents=True)
                (agent / "models.json").write_text(
                    json.dumps({"providers": {"mine": {"name": "x"}}}), encoding="utf-8")
                mas.make_ask("pi")
            self.assertEqual(buffer.getvalue(), "")

    def test_silent_for_every_real_pi_config_layout(self):
        """pi 用户目录的布局随版本变，命中任一线索文件都不许告警（不许打假告警）。

        0.85 实测：provider 目录是 `models-store.json`，默认 provider 记在
        `settings.json.defaultProvider`，`pi /login` 过的写 `auth.json`，
        不一定存在 `models.json`。
        """
        layouts = [
            ("models.json", {"providers": {"mine": {"name": "x"}}}),
            ("models-store.json", {"providers": {"mine": {"name": "x"}}}),
            ("models-store.json", {"mine": {"models": []}}),
            ("auth.json", {"mine": {"token": "x"}}),
            ("auth.json", {"providers": {"mine": {"token": "x"}}}),
            ("settings.json", {"defaultProvider": "mine"}),
        ]
        for name, document in layouts:
            with self.subTest(file=name, keys=list(document)), tempfile.TemporaryDirectory() as tmp:
                with self.environment(tmp, provider="mine") as (agent, buffer):
                    agent.mkdir(parents=True)
                    (agent / name).write_text(json.dumps(document), encoding="utf-8")
                    mas.make_ask("pi")
                self.assertEqual(buffer.getvalue(), "")

    def test_silent_when_an_explicit_api_key_is_given(self):
        """docs 里推荐的另一条配法：直接给 key（换 provider 时用），不许被当成没配。"""
        with tempfile.TemporaryDirectory() as tmp:
            with self.environment(tmp, provider="anthropic",
                                  MATERIAL_AGENT_PI_API_KEY="sk-xxx") as (_agent, buffer):
                mas.make_ask("pi")
            self.assertEqual(buffer.getvalue(), "")

    def test_bundled_config_does_not_count_when_the_merge_is_switched_off(self):
        """关掉首启合并时包里那份进不了用户目录，不能拿它当「配好了」的证据。"""
        with tempfile.TemporaryDirectory() as tmp:
            with self.environment(tmp, provider="evst-gateway", bundled="evst-gateway",
                                  MATERIAL_AGENT_PI_SKIP_PROVIDER_MERGE="1") as (_agent, buffer):
                mas.make_ask("pi")
            self.assertIn(mas.PI_PROVIDER_MISSING_LOG, buffer.getvalue())

    def test_dashscope_backend_never_warns(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.environment(tmp, bundled="evst-gateway") as (_agent, buffer):
                self.assertIs(mas.make_ask("dashscope"), mas.ask_dashscope)
            self.assertEqual(buffer.getvalue(), "")

    def test_an_unreadable_config_is_not_evidence_of_a_missing_provider(self):
        """读不出来（损坏 / 没权限）≠ 查不到：这时不下结论、不告警，也绝不抛。"""
        with tempfile.TemporaryDirectory() as tmp:
            with self.environment(tmp, provider="mine") as (agent, buffer):
                agent.mkdir(parents=True)
                (agent / "models.json").write_text("{ 这不是 JSON", encoding="utf-8")
                mas.make_ask("pi")  # 不抛
            self.assertEqual(buffer.getvalue(), "")

    def test_the_warning_survives_a_gbk_stdout(self):
        """中文 Windows 重定向到文件时按 gbk 编码：这条提醒自己不许把调用方打断。"""
        with tempfile.TemporaryDirectory() as tmp:
            with self.environment(tmp, bundled="evst-gateway") as (_agent, buffer):
                mas.make_ask("pi")
                output = buffer.getvalue()
        self.assertIn(mas.PI_PROVIDER_MISSING_LOG, output)
        output.encode("gbk")  # 编不出就抛，等价于 Windows 上那次崩溃

    def test_the_warning_sits_on_the_shared_backend_entry(self):
        """两条线（选材 / 包装）都经 make_ask，告警必须挂在那里，不许各写一份。"""
        source = Path(mas.__file__).read_text(encoding="utf-8")
        self.assertIn("def make_ask(", source)
        self.assertIn("warn_if_pi_provider_missing()", source)
        packaging = (TOOLS / "packaging_agent.py").read_text(encoding="utf-8")
        self.assertIn("make_ask(backend)", packaging)


# install_pi.py 在 tools/material_gen/pi/ 下，不在 tools/ 根，单独加进 sys.path。
sys.path.insert(0, str(TOOLS / "material_gen" / "pi"))
sys.path.insert(0, str(TOOLS / "material_gen" / "hyperframes"))
import install_hyperframes  # noqa: E402
import install_pi  # noqa: E402


class InstallScriptEncodingTests(unittest.TestCase):
    """两个装组件脚本在中文 Windows 上把 stdout 重定向到文件时不许因为 `✓` 崩。

    gbk 编不出 U+2713（`'✓'.encode('gbk')` 直接抛），所以
    `install_pi.py --check > out.txt` 会 `UnicodeEncodeError` 退出 1，
    在控制台直接跑却没事。2026-09-21 Windows 实测（回帖 51296044 第五节第 3 条）。
    """

    MODULES = (install_pi, install_hyperframes)

    def gbk_stream(self) -> io.TextIOWrapper:
        return io.TextIOWrapper(io.BytesIO(), encoding="gbk", errors="strict", write_through=True)

    def test_gbk_stdout_would_have_crashed(self):
        stream = self.gbk_stream()
        with self.assertRaises(UnicodeEncodeError):
            stream.write("[install_pi] ✓ cli.js")

    def test_entry_point_switches_the_streams_to_utf8(self):
        for module in self.MODULES:
            with self.subTest(module=module.__name__):
                stream = self.gbk_stream()
                with patch.object(sys, "stdout", stream), patch.object(sys, "stderr", stream):
                    module.use_utf8_output()
                    stream.write("[x] ✓ ok")
                    stream.flush()
                self.assertEqual(stream.encoding, "utf-8")
                self.assertIn("✓", stream.buffer.getvalue().decode("utf-8"))

    def test_main_reconfigures_before_doing_anything(self):
        """`reconfigure` 只影响之后写出的字节，所以它必须是 `main()` 的**第一句**。

        用 AST 判，不钉签名字符串——给 main 加个参数不该让这条红。
        """
        for module in self.MODULES:
            with self.subTest(module=module.__name__):
                tree = ast.parse(Path(module.__file__).read_text(encoding="utf-8"))
                main = next(node for node in tree.body
                            if isinstance(node, ast.FunctionDef) and node.name == "main")
                first = main.body[0]
                if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
                    first = main.body[1]  # 跳过 docstring
                self.assertIsInstance(first, ast.Expr)
                self.assertIsInstance(first.value, ast.Call)
                self.assertEqual(getattr(first.value.func, "id", None), "use_utf8_output")

    def test_any_reconfigure_failure_is_tolerated(self):
        class Hostile(io.StringIO):
            def reconfigure(self, *args, **kwargs):  # 签名不兼容的包装流
                raise TypeError("不认识的参数")

        for module in self.MODULES:
            for stream in (io.StringIO(), Hostile(), None):
                with self.subTest(module=module.__name__, stream=type(stream).__name__):
                    with patch.object(sys, "stdout", stream), patch.object(sys, "stderr", stream):
                        module.use_utf8_output()  # 不抛


class InstallPiChordCheckTests(unittest.TestCase):
    """`install_pi.py --check` 找 chord 的方式。

    Windows 实测：pi 自带 `npm-shrinkwrap.json`，npm 把依赖装进 pi 包**自己**的
    `node_modules/` 里不提升，chord 落在
    `…/pi-coding-agent/node_modules/@earendil-works/chord`，顶层 `@earendil-works/`
    下只有 `pi-coding-agent`——写死顶层路径的旧自检必红。提升与否随 npm 版本变，所以
    自检首选让 node 按运行时规则解析，找不到 node 才退回两处路径检查。
    """

    @contextlib.contextmanager
    def layout(self, *, nested: bool = False, hoisted: bool = False):
        """造一棵装好的 pi：cli.js + package.json(0.85.1)，chord 放嵌套 / 提升位。"""
        with tempfile.TemporaryDirectory() as tmp:
            node_modules = Path(tmp) / "node_modules"
            package_dir = node_modules / "@earendil-works" / "pi-coding-agent"
            cli = package_dir / "dist" / "bundle" / "cli.js"
            cli.parent.mkdir(parents=True)
            cli.write_text("#!/usr/bin/env node\n", encoding="utf-8")
            (package_dir / "package.json").write_text(
                json.dumps({"name": install_pi.PI_PACKAGE, "version": install_pi.PI_VERSION}),
                encoding="utf-8",
            )
            nested_dir = package_dir / "node_modules" / "@earendil-works" / "chord"
            hoisted_dir = node_modules / "@earendil-works" / "chord"
            for wanted, directory in ((nested, nested_dir), (hoisted, hoisted_dir)):
                if not wanted:
                    continue
                directory.mkdir(parents=True)
                (directory / "package.json").write_text(
                    json.dumps({"name": "@earendil-works/chord", "version": "0.0.0-test"}),
                    encoding="utf-8",
                )
            with unittest.mock.patch.multiple(
                install_pi,
                NODE_MODULES=node_modules,
                PACKAGE_DIR=package_dir,
                CLI_JS=cli,
                NESTED_CHORD_DIR=nested_dir,
                HOISTED_CHORD_DIR=hoisted_dir,
            ):
                yield nested_dir, hoisted_dir

    def test_runtime_root_is_the_parent_of_tools(self):
        self.assertEqual(install_pi.runtime_root(), TOOLS.parent)

    def test_nested_shrinkwrap_layout_passes_the_path_fallback(self):
        with self.layout(nested=True) as (nested_dir, _hoisted_dir), \
             patch.object(install_pi, "node_executable", return_value=None):
            ok, lines, problem = install_pi.check_chord()
        self.assertTrue(ok, problem)
        self.assertEqual(problem, "")
        self.assertIn("未找到 node，按路径检查", "\n".join(lines))
        self.assertIn(str(nested_dir), "\n".join(lines))

    def test_hoisted_layout_also_passes_the_path_fallback(self):
        with self.layout(hoisted=True) as (_nested_dir, hoisted_dir), \
             patch.object(install_pi, "node_executable", return_value=None):
            ok, lines, problem = install_pi.check_chord()
        self.assertTrue(ok, problem)
        self.assertIn(str(hoisted_dir), "\n".join(lines))

    def test_chord_missing_from_both_places_fails(self):
        with self.layout() as (nested_dir, hoisted_dir), \
             patch.object(install_pi, "node_executable", return_value=None):
            ok, lines, problem = install_pi.check_chord()
        self.assertFalse(ok)
        self.assertIn("未找到 node，按路径检查", "\n".join(lines))
        self.assertIn(str(nested_dir), problem)
        self.assertIn(str(hoisted_dir), problem)
        self.assertIn("ERR_MODULE_NOT_FOUND", problem)

    @unittest.skipUnless(shutil.which("node"), "需要 node 才能验证运行时解析")
    def test_node_resolves_chord_inside_the_nested_layout(self):
        node = shutil.which("node")
        with self.layout(nested=True) as (nested_dir, _hoisted_dir), \
             patch.object(install_pi, "node_executable", return_value=node):
            ok, lines, problem = install_pi.check_chord()
            resolved = nested_dir / "package.json"
        self.assertTrue(ok, problem)
        self.assertIn(str(resolved), "\n".join(lines))
        self.assertNotIn("未找到 node", "\n".join(lines))

    @unittest.skipUnless(shutil.which("node"), "需要 node 才能验证运行时解析")
    def test_node_reports_a_missing_chord_instead_of_passing(self):
        with self.layout() as (_nested_dir, _hoisted_dir), \
             patch.object(install_pi, "node_executable", return_value=shutil.which("node")):
            ok, _lines, problem = install_pi.check_chord()
        self.assertFalse(ok)
        self.assertIn(install_pi.CHORD_SPECIFIER, problem)
