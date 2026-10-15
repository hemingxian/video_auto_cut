from __future__ import annotations

import io
import importlib.util
import json
import copy
import os
import re
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import add_progress
import common
import render_segment
import text_layout
from progress_labels import ensure_progress_labels, progress_labels_for_shots
from text_layout import fit_label, text_width, wrap_text, wrap_text_pixels


class SubtitleWrappingTests(unittest.TestCase):
    def test_p4_render_segment_uses_template_caption_hint_in_generated_ass(self):
        cases = [
            ("template_hint", {"route": "template"}, {"caption_source": "subtitle"},
             "镜内模板字幕", "参数字幕", "镜内模板字幕"),
            ("template_no_hint", {"route": "template"}, None,
             "镜内模板字幕", "参数字幕", "参数字幕"),
            ("organized_hint", {"route": "organized"}, {"caption_source": "subtitle"},
             "整理路字幕", "参数字幕", "整理路字幕"),
            ("non_template_hint", {"route": "ai"}, {"caption_source": "subtitle"},
             "镜内非模板字幕", "参数字幕", "参数字幕"),
            ("voice_fallback", None, None, "镜内旧字幕", "", "口播回退"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, source, hints, shot_subtitle, arg_subtitle, expected in cases:
                with self.subTest(name=name):
                    shot = {"subtitle": shot_subtitle}
                    if hints is not None:
                        shot["render_hints"] = hints
                    plan = {"shots": [shot]}
                    if source is not None:
                        plan["script_source"] = source
                    shots = root / f"{name}.json"
                    shots.write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
                    ass = root / f"{name}.ass"
                    args = [
                        "render_segment.py", "--clip", "unused.mp4", "--output", str(root / f"{name}.mp4"),
                        "--shots-json", str(shots), "--shot-index", "1", "--voice-text", "口播回退",
                        "--subtitle", arg_subtitle, "--no-voiceover", "--no-progress", "--no-cards",
                    ]
                    with mock.patch.object(sys, "argv", args), \
                            mock.patch.object(render_segment, "load_dotenv"), \
                            mock.patch.object(render_segment, "configure_canvas", return_value=(1920, 1080)), \
                            mock.patch.object(render_segment, "temp_path", return_value=ass), \
                            mock.patch.object(render_segment.subprocess, "check_output", return_value=b'{"streams":[{"width":1920,"height":1080,"sample_aspect_ratio":"1:1"}]}'), \
                            mock.patch.object(render_segment, "resolve_placement", return_value=None), \
                            mock.patch.object(render_segment, "find_ffmpeg", return_value="ffmpeg"), \
                            mock.patch.object(render_segment, "resolve_encoder", return_value=mock.Mock(label="test")), \
                            mock.patch.object(render_segment, "run_with_hardware_fallback"), \
                            mock.patch.object(render_segment, "settle_segment"), \
                            mock.patch.dict(os.environ, {"VIDEOAUTO_OUTPUT_WIDTH": "1920", "VIDEOAUTO_OUTPUT_HEIGHT": "1080"}):
                        render_segment.main()
                    rendered = ass.read_text(encoding="utf-8")
                    self.assertIn(expected, rendered)
                    for rejected in {"镜内模板字幕", "镜内非模板字幕", "参数字幕", "口播回退"} - {expected}:
                        self.assertNotIn(rejected, rendered)

            malformed = root / "malformed.json"
            for payload in ([], {"script_source": {"route": "template"}, "shots": {}},
                            {"script_source": {"route": "template"}, "shots": [None]}):
                malformed.write_text(json.dumps(payload), encoding="utf-8")
                self.assertEqual("严格回退", render_segment.load_render_caption(str(malformed), 1, "严格回退"))

    def test_spoken_caption_preserves_prepared_sentence_timing(self):
        text = "食品饮料码垛，先看包装怎样到位，再看机械臂如何抓取和落放。"
        cues = [
            {"text": "食品饮料码垛", "original_text": "食品饮料码垛，", "start": 0, "end": 1.664},
            {"text": "先看包装怎样到位", "original_text": "先看包装怎样到位，", "start": 1.664, "end": 3.825},
            {"text": "再看机械臂如何抓取", "original_text": "再看机械臂如何抓取", "start": 3.825, "end": 6.061},
            {"text": "和落放", "original_text": "和落放。", "start": 6.061, "end": 7.104},
        ]
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory, "spoken.ass")
            render_segment.write_combined_ass(text, ["流程"], 1, 8, target, subtitle_cues=cues, enable_progress=False)
            rendered = target.read_text(encoding="utf-8")
        for expected in ["0:00:00.00,0:00:01.66", "0:00:01.66,0:00:03.82", "0:00:03.82,0:00:06.06", "0:00:06.06,0:00:07.10"]:
            self.assertIn(expected, rendered)
        for cue in cues:
            self.assertIn(cue["text"], rendered)

    def test_engine_render_never_replaces_missing_prepared_voice_with_new_tts(self):
        with tempfile.TemporaryDirectory() as directory:
            args = ["render_segment.py", "--clip", "unused.mp4", "--output", str(Path(directory, "final.mp4")),
                    "--voice-output", str(Path(directory, "missing.mp3")), "--voice-text", "当前口播", "--require-prepared-voice"]
            with mock.patch.object(sys, "argv", args), mock.patch.object(render_segment, "load_dotenv"), mock.patch.object(render_segment, "synthesize") as synthesize:
                with self.assertRaisesRegex(RuntimeError, "口播音频缺失"):
                    render_segment.main()
                synthesize.assert_not_called()

    def test_engine_render_rejects_stale_cues_instead_of_using_another_narration_timeline(self):
        with tempfile.TemporaryDirectory() as directory:
            voice = Path(directory, "voice.mp3")
            voice.write_bytes(b"x" * 2048)
            old_cues = [{"text": "旧口播", "start": 0, "end": 1}]
            with self.assertRaisesRegex(RuntimeError, "时间轴缺失或与当前口播不一致"):
                render_segment.validate_prepared_voice(voice, old_cues, "当前口播")
            render_segment.validate_prepared_voice(voice, old_cues, "旧口播")
            render_segment.validate_prepared_voice(voice, [], "当前口播", subtitles=False)

    def test_edited_subtitle_does_not_reuse_old_voice_cue_text(self):
        old_cues = [{"text": "Original spoken sentence", "start": 0.25, "end": 2.5}]
        self.assertTrue(render_segment.subtitle_cues_match_text(old_cues, "Original spoken sentence."))
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory, "edited.ass")
            render_segment.write_combined_ass("Edited display sentence", ["Title"], 1, 3, target, subtitle_cues=old_cues, enable_progress=False)
            rendered = target.read_text(encoding="utf-8")
        self.assertIn("Edited display sentence", rendered)
        self.assertNotIn("Original spoken sentence", rendered)

    def test_bundled_noto_font_is_measured_without_system_installation(self):
        self.assertGreater(text_width("中文 English", "Noto Sans CJK SC", 30), 0)
        self.assertGreater(text_width("WWWW", "Noto Sans CJK SC", 30), text_width("iiii", "Noto Sans CJK SC", 30))
        rendered_filter = render_segment.ass_filter(Path("test.ass"))
        self.assertIn(":fontsdir=", rendered_filter)
        self.assertIn("noto-sans-cjk-sc", rendered_filter)

    def test_english_spaces_and_words_survive_wrapping(self):
        original = "Precision engineering makes industrial automation more reliable"
        lines = common.split_subtitle_lines_preserve(original, 22)
        self.assertEqual("".join(lines), original)
        self.assertIn("Precision engineering", [line.rstrip() for line in lines])

    def test_unicode_apostrophes_and_long_identifiers_are_not_cut(self):
        original = "FANUC’s CRX-10iA uses SuperLongRobotIdentifier for café automation"
        lines = common.split_subtitle_lines_preserve(original, 9)
        self.assertEqual("".join(lines), original)
        self.assertIn("SuperLongRobotIdentifier", [line.strip() for line in lines])
        self.assertIn("FANUC’s", [line.strip() for line in lines])

    def test_mixed_script_spaces_and_cjk_punctuation_survive(self):
        original = "采用 FANUC CRX-10iA 机器人，实现精密装配。"
        lines = common.split_subtitle_lines_preserve(original, 12)
        self.assertIn("FANUC CRX-10iA", "".join(lines))
        self.assertEqual("".join(lines), original)
        self.assertFalse(any(line[0] in "，。" for line in lines))

    def test_subtitle_cjk_words_avoid_splitting_food_phrase_in_both_wrap_paths(self):
        original = "先备好四样：箱体尺寸和重量、每小时箱数、托盘规格、目标垛型。"
        char_lines = common.split_subtitle_lines_preserve(original, 22)
        self.assertEqual("".join(char_lines), original)
        self.assertFalse(any(line.endswith("规") for line in char_lines))
        self.assertFalse(any(line.startswith("格") for line in char_lines))
        with mock.patch.object(text_layout, "text_width", side_effect=lambda value, *_: float(len(value))):
            pixel_lines = common.subtitle_display_pages(
                original, max_width=22, font="unused", font_size=1,
            )[0]
        self.assertEqual("".join(pixel_lines), common.subtitle_display_line(original))
        self.assertFalse(any(line.endswith("规") for line in pixel_lines))
        self.assertFalse(any(line.startswith("格") for line in pixel_lines))

        with mock.patch.object(text_layout, "text_width", side_effect=lambda value, *_: float(len(value))):
            events = common.subtitle_events_from_timed_text(
                original, 0, 2, max_width=22, font="unused", font_size=1,
            )
        visible_lines = [line.split("}", 1)[1] for line in events.splitlines() if line.startswith("Dialogue:")]
        self.assertEqual("".join(visible_lines), common.subtitle_display_line(original))

    def test_subtitle_cjk_words_survive_a_long_unpunctuated_sentence(self):
        original = "这是一个没有标点的真实工业字幕用于确认箱体尺寸重量托盘规格目标垛型和码垛节拍不会在换行边界被拆开"
        lines = common.split_subtitle_lines_preserve(original, 14)
        self.assertEqual("".join(lines), original)
        self.assertFalse(any(line.endswith("规") for line in lines))
        self.assertFalse(any(line.startswith("格") for line in lines))
        self.assertTrue(all(len(line) <= 14 for line in lines))

    def test_only_oversized_cjk_tokens_split_while_long_latin_words_stay_whole(self):
        tokenizer = mock.Mock()
        tokenizer.cut.return_value = iter(["超长中文词"])
        with mock.patch.object(text_layout, "_subtitle_tokenizer", return_value=tokenizer):
            self.assertEqual(
                wrap_text("超长中文词", lambda value: len(value) <= 2, cjk_word_boundaries=True),
                ["超长", "中文", "词"],
            )
        self.assertEqual(
            wrap_text("SuperLongRobotIdentifier", lambda value: len(value) <= 2, cjk_word_boundaries=True),
            ["SuperLongRobotIdentifier"],
        )

    def test_vendored_tokenizer_uses_memory_without_an_explicit_workspace(self):
        text_layout._subtitle_tokenizer.cache_clear()
        try:
            with tempfile.TemporaryDirectory() as directory, \
                    mock.patch.dict(os.environ, {
                        "VIDEOAUTO_TEMP_DIR": directory,
                        "VIDEOAUTO_DATA_ROOT": "",
                        "VIDEOAUTO_WORKSPACE_DIR": "",
                    }), mock.patch.object(text_layout.tempfile, "gettempdir",
                                          side_effect=AssertionError("system temp must not be used")):
                tokenizer = text_layout._subtitle_tokenizer()
                self.assertIn("规格", list(tokenizer.cut("托盘规格", HMM=True)))
                self.assertIsNone(tokenizer.cache_file)
                self.assertEqual(list(Path(directory).iterdir()), [])
        finally:
            text_layout._subtitle_tokenizer.cache_clear()

    def test_vendored_tokenizer_uses_only_the_workspace_cache(self):
        text_layout._subtitle_tokenizer.cache_clear()
        try:
            with tempfile.TemporaryDirectory() as directory:
                workspace = Path(directory, "workspace")
                outside_temp = Path(directory, "outside-temp")
                outside_temp.mkdir()
                with mock.patch.dict(os.environ, {
                    "VIDEOAUTO_DATA_ROOT": str(workspace),
                    "VIDEOAUTO_WORKSPACE_DIR": "",
                    "VIDEOAUTO_TEMP_DIR": str(outside_temp),
                }), \
                    mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
                    tokenizer = text_layout._subtitle_tokenizer()
                cache_dir = (workspace / ".videoautocut" / "cache" / "jieba").resolve()
                self.assertEqual(Path(tokenizer.tmp_dir), cache_dir)
                self.assertEqual(
                    tokenizer.cache_file,
                    "videoautocut-jieba-0.42.1-7197c3211ddd.cache",
                )
                self.assertTrue((cache_dir / tokenizer.cache_file).is_file())
                self.assertEqual(list(outside_temp.iterdir()), [])
                self.assertEqual(stderr.getvalue(), "")
        finally:
            text_layout._subtitle_tokenizer.cache_clear()

    def test_vendored_tokenizer_uses_memory_for_unavailable_or_runtime_workspace(self):
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                unavailable = root / "not-a-directory"
                unavailable.write_text("file", encoding="utf-8")
                runtime = root / "runtime"
                runtime.mkdir()
                for workspace in (unavailable, runtime, runtime / "data"):
                    with self.subTest(workspace=workspace):
                        text_layout._subtitle_tokenizer.cache_clear()
                        with mock.patch.dict(os.environ, {
                            "VIDEOAUTO_DATA_ROOT": str(workspace),
                            "VIDEOAUTO_WORKSPACE_DIR": "",
                            "VIDEOAUTO_RUNTIME_ROOT": str(runtime),
                        }):
                            tokenizer = text_layout._subtitle_tokenizer()
                        self.assertIn("规格", list(tokenizer.cut("托盘规格", HMM=True)))
                        self.assertIsNone(tokenizer.cache_file)
                self.assertFalse((runtime / ".videoautocut").exists())
        finally:
            text_layout._subtitle_tokenizer.cache_clear()

    def test_workspace_parent_of_runtime_keeps_cache_outside_runtime(self):
        text_layout._subtitle_tokenizer.cache_clear()
        try:
            with tempfile.TemporaryDirectory() as directory:
                workspace = Path(directory, "workspace")
                runtime = workspace / "runtime"
                runtime.mkdir(parents=True)
                with mock.patch.dict(os.environ, {
                    "VIDEOAUTO_DATA_ROOT": str(workspace),
                    "VIDEOAUTO_WORKSPACE_DIR": "",
                    "VIDEOAUTO_RUNTIME_ROOT": str(runtime),
                }):
                    tokenizer = text_layout._subtitle_tokenizer()
                self.assertEqual(
                    Path(tokenizer.tmp_dir),
                    (workspace / ".videoautocut" / "cache" / "jieba").resolve(),
                )
        finally:
            text_layout._subtitle_tokenizer.cache_clear()

    def test_soft_line_punctuation_rule_preserves_spaces_and_nonterminal_punctuation(self):
        self.assertEqual(common.subtitle_display_wrapped_line("正文、 "), "正文 ")
        self.assertEqual(common.subtitle_display_wrapped_line(" 正文"), " 正文")
        self.assertEqual(common.subtitle_display_wrapped_line("正文、继续"), "正文、继续")

    def test_food_shot_one_keeps_the_accepted_line_end_punctuation_style(self):
        original = "食品包装线的末端，一箱箱成品下线以后，最重复、最累人的一道活，就是码垛。"
        with mock.patch.object(text_layout, "text_width", side_effect=lambda value, *_: float(len(value))):
            events = common.subtitle_events_from_timed_text(
                original, 0, 2, max_width=22, font="unused", font_size=1,
            )
        visible_lines = [line.split("}", 1)[1] for line in events.splitlines() if line.startswith("Dialogue:")]
        self.assertEqual(visible_lines[0], "食品包装线的末端，一箱箱成品下线以后，最重复")
        self.assertEqual(visible_lines[1], "最累人的一道活，就是码垛")

    def test_soft_wrap_retains_u0020_through_wrap_and_ass_output(self):
        original = "AMR · 皮带机"
        expected = ["AMR ·", " 皮带机"]

        self.assertEqual(
            wrap_text(original, lambda value: len(value) <= 5, cjk_word_boundaries=True),
            expected,
        )
        self.assertEqual("".join(expected), original)
        self.assertEqual("".join(expected).count("\u0020"), original.count("\u0020"))

        with mock.patch.object(text_layout, "text_width", side_effect=lambda value, *_: float(len(value))), \
                mock.patch.dict(os.environ, {"VIDEOAUTO_OUTPUT_WIDTH": "1920"}):
            events = common.subtitle_events_from_timed_text(
                original, 0, 2, max_width=5, font="unused", font_size=1,
            )
        visible_lines = [line.split("}", 1)[1] for line in events.splitlines() if line.startswith("Dialogue:")]
        self.assertEqual(visible_lines, expected)
        self.assertEqual("".join(visible_lines), original)
        self.assertEqual(ord(visible_lines[1][0]), 0x20)

    def test_soft_wrap_keeps_exact_width_next_word_in_bounds(self):
        lines = wrap_text(
            "A BBBB", lambda value: len(value) <= 4, cjk_word_boundaries=True,
        )
        self.assertEqual(lines, ["A ", "BBBB"])
        self.assertEqual("".join(lines), "A BBBB")
        self.assertTrue(all(len(line) <= 4 for line in lines))

    def test_card_default_keeps_existing_cjk_character_breaking(self):
        self.assertEqual(wrap_text("最重复", lambda value: len(value) <= 2), ["最重", "复"])

    def test_explicit_line_breaks_are_retained(self):
        self.assertEqual(common.split_subtitle_lines_preserve("Hello world\nNext chapter", 40),
                         ["Hello world", "Next chapter"])

    def test_wide_letters_and_narrow_letters_use_actual_font_width(self):
        self.assertGreater(text_width("WWW", "Arial", 40), text_width("iii", "Arial", 40) * 2)
        lines = wrap_text_pixels("Wide WWW words with narrow iii letters", 230, "Arial", 40)
        self.assertEqual(" ".join(lines), "Wide WWW words with narrow iii letters")
        self.assertTrue(all(text_width(line, "Arial", 40) <= 230 for line in lines))

    def test_unbreakable_subtitle_is_scaled_inside_canvas_without_losing_text(self):
        original = "SuperLongRobotIdentifierWithNoWordBreaks"
        events = common.subtitle_events_from_timed_text(original, 0, 2, max_width=300, font="Arial", font_size=68)
        size = int(re.search(r"\\fs(\d+)", events).group(1))
        self.assertLess(size, 68)
        self.assertLessEqual(text_width(original, "Arial", size), 300)
        self.assertIn(original, events)

    def test_cue_and_sentence_paths_keep_complete_english(self):
        original = "Precision engineering makes industrial automation more reliable"
        with mock.patch.dict(os.environ, {"VIDEOAUTO_OUTPUT_WIDTH": "1080", "VIDEOAUTO_OUTPUT_HEIGHT": "1920", "SUBTITLE_FONT": "Arial"}):
            cue_events = render_segment.subtitle_events_from_cues([{"text": original, "start": 0, "end": 4}])
            with tempfile.TemporaryDirectory() as directory:
                output = Path(directory, "subtitle.ass")
                render_segment.write_combined_ass(original, ["Engineering"], 1, 4, output, enable_progress=False)
                sentence_events = output.read_text(encoding="utf-8")
        for events in (cue_events, sentence_events):
            words = []
            for line in events.splitlines():
                if line.startswith("Dialogue:") and ",Subtitle," in line:
                    words.extend(line.split("}")[-1].split())
            self.assertEqual(words, original.split())


class ProgressLanguageTests(unittest.TestCase):
    def test_chinese_script_prefers_existing_chinese_title(self):
        shots = [{"module_label": "Introduction", "title": "精密装配", "subtitle": "介绍精密装配的工作流程。"}]
        self.assertEqual(progress_labels_for_shots(shots), ["精密装配"])
        reviewer = mock.Mock()
        ensure_progress_labels({"shots": shots}, reviewer)
        reviewer.assert_not_called()

    def test_wrong_language_without_title_uses_complete_original_clause(self):
        shots = [{"module_label": "Introduction", "title": "Assembly", "subtitle": "机器人完成精密装配，然后自动检测质量。"}]
        self.assertEqual(progress_labels_for_shots(shots), ["机器人完成精密装配"])

    def test_english_script_repairs_chinese_label_and_preserves_brand(self):
        shots = [{"module_label": "开场", "title": "Precision engineering", "subtitle": "Precision engineering improves quality."},
                 {"module_label": "FANUC", "title": "机器人", "subtitle": "FANUC 机器人提高生产效率。"}]
        self.assertEqual(progress_labels_for_shots(shots), ["Precision engineering", "FANUC"])

    def test_language_review_only_changes_labels_and_retries_invalid_language(self):
        shots = [{"module_label": "Introduction", "title": "Assembly", "subtitle": "机器人完成精密装配。", "shot_id": "stable", "voice_text": "原口播"}]
        original = copy.deepcopy(shots[0])
        reviewer = mock.Mock(side_effect=[{"labels": [{"shot": 1, "module_label": "Assembly"}]},
                                          {"labels": [{"shot": 1, "module_label": "精密装配"}]}])
        plan = ensure_progress_labels({"shots": shots}, reviewer)
        self.assertEqual(reviewer.call_count, 2)
        self.assertEqual(plan["shots"][0], {**original, "module_label": "精密装配"})
        self.assertEqual(plan["shots"][0]["voice_text"], "原口播")

    def test_failed_review_and_old_plan_render_remain_in_target_language(self):
        plan = {"shots": [{"title": "Assembly", "module_label": "Introduction", "subtitle": "机器人完成精密装配。"}]}
        ensure_progress_labels(plan, mock.Mock(side_effect=RuntimeError("offline")))
        self.assertEqual(plan["shots"][0]["module_label"], "机器人完成精密装配。")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "shots.json")
            path.write_text(json.dumps(plan), encoding="utf-8")
            self.assertEqual(render_segment.load_progress_labels(str(path), ["Introduct"]), ["机器人完成精密装配"])


class ProgressLayoutTests(unittest.TestCase):
    def test_long_labels_are_not_character_truncated(self):
        label = "Precision engineering"
        self.assertEqual(common.clean_label(label, 1), label)
        self.assertIsNotNone(fit_label(label, 350, 72, "Arial", 30, 18))

    def test_narrow_segments_show_full_current_label_with_timeline(self):
        label = "Precision engineering improves manufacturing reliability"
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {
            "VIDEOAUTO_OUTPUT_WIDTH": "1080", "VIDEOAUTO_OUTPUT_HEIGHT": "1920", "PROGRESS_FONT": "Arial",
        }), mock.patch.object(add_progress, "_PROGRESS_TEMPLATES_CACHE", None):
            path = Path(directory, "progress.ass")
            add_progress.write_progress_ass([label] * 12, 4, 3, path)
            result = path.read_text(encoding="utf-8")
        self.assertIn(label, result)
        self.assertIn("4 / 12", result)
        self.assertNotIn("…", result)
        self.assertIn(r"\t(0,3000,\clip(", result)

    def test_two_line_layout_keeps_complete_words(self):
        label = "Precision engineering"
        lines, size = fit_label(label, 205, 90, "Arial", 30, 18)
        self.assertEqual(" ".join(lines), label)
        self.assertTrue(all(text_width(line, "Arial", size) <= 205 for line in lines))


class LegacyWhitespaceDifferentialTests(unittest.TestCase):
    """Default and card wrapping remain list-output compatible with a3e64b4."""

    @classmethod
    def setUpClass(cls):
        repository = Path(__file__).resolve().parents[2]
        source = subprocess.run(
            ["git", "show", "a3e64b4:VideoAutoCut/tools/text_layout.py"],
            cwd=repository,
            check=True,
            capture_output=True,
        ).stdout
        cls.baseline_directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.baseline_directory.cleanup)
        path = Path(cls.baseline_directory.name, "text_layout_a3e64b4.py")
        path.write_bytes(source)
        spec = importlib.util.spec_from_file_location("text_layout_a3e64b4", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("无法加载 a3e64b4 text_layout oracle")
        cls.baseline = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.baseline)

    def assert_matches_baseline(self, text: str, width: int, kinsoku: bool):
        fits = lambda value: len(value) <= width
        self.assertEqual(
            wrap_text(text, fits, kinsoku=kinsoku),
            self.baseline.wrap_text(text, fits, kinsoku=kinsoku),
        )

    def test_required_whitespace_cases_match_a3e64b4_in_both_modes(self):
        cases = [
            ("ABC DEF GHI", 7),
            ("第一行\n  缩进", 20),
            ("A  B", 20),
            ("Step 1 上料", 6),
            ("工位 ABC-123 托盘 ready", 9),
            ("全角　空格 与 ASCII", 8),
            ("第一行\r\n  第二行", 20),
        ]
        for text, width in cases:
            for kinsoku in (False, True):
                with self.subTest(text=text, width=width, kinsoku=kinsoku):
                    self.assert_matches_baseline(text, width, kinsoku)

    def test_deterministic_whitespace_matrix_matches_a3e64b4(self):
        corpus = [
            "", " ", "  ", "A B", " A B ", "A\tB", "A\nB", "A\r\nB",
            "A  B C", "中文 English 混排", "中文　English", "700 包/小时",
            "Step 1 上料", "参数（测试）", "路径确认", "A/B · C", "尾随空格  ",
            "第一行\n  缩进\n第三行",
        ]
        for text in corpus:
            for width in (1, 2, 3, 4, 5, 6, 7, 8, 12, 20):
                for kinsoku in (False, True):
                    with self.subTest(text=text, width=width, kinsoku=kinsoku):
                        self.assert_matches_baseline(text, width, kinsoku)


CJK = "Noto Sans CJK SC"
# 字幕与进度条的换行样本。kinsoku 那一层加进来之后，这些结果必须一个字都不能变——
# 值是 2026-09-21 改动前实跑出来的（Mac/PIL 量宽；Windows/GDI 只差几像素，用的是同一批断点）。
UNTOUCHED_WRAPPING = [
    ("节拍 700 包/小时｜输送带连续来料", 300, ["节拍 700 包/小", "时｜输送带连续", "来料"]),
    ("整线 12件/分 达标", 200, ["整线 12件", "/分 达标"]),
    ("新包装样件｜目标垛型｜现场布局｜抓具调整｜路径确认", 462,
     ["新包装样件｜目标", "垛型｜现场布局｜", "抓具调整｜路径确", "认"]),
    ("换型前逐项确认（抓具与路径都要看）", 200, ["换型前逐", "项确认（", "抓具与路", "径都要看）"]),
    ("抓取位居中不压袋角并逐项核对来料朝向与输送节拍确认", 940,
     ["抓取位居中不压袋角并逐项核对来料朝向与输送节", "拍确认"]),
]


class PackagingKinsokuTests(unittest.TestCase):
    """模板包装卡片专用的换行禁则。只有 kinsoku=True 这条路才有，字幕/进度条不受影响。"""

    def wrap(self, text, width, size=42, **kwargs):
        return wrap_text_pixels(text, width, CJK, size, True, **kwargs)

    def test_subtitle_and_progress_wrapping_is_untouched(self):
        """默认（不带 kinsoku）的换行结果必须与加禁则之前逐字不差。

        字幕走 common.subtitle_display_pages、进度条走 add_progress，两边调的都是不带
        kinsoku 的这条路；它们的排版是「模板包装关闭时成片与基线逐字节一致」的前提。
        """
        for text, width, expected in UNTOUCHED_WRAPPING:
            size = 54 if width == 462 else 42
            with self.subTest(text=text[:8], width=width):
                self.assertEqual(wrap_text_pixels(text, width, CJK, size), expected)

    def test_orphan_single_character_line_borrows_from_the_line_above(self):
        """docs §9.1 的原例：「路径确认」被切成「路径确」+「认」，第二页只剩一个字。"""
        text = "新包装样件｜目标垛型｜现场布局｜抓具调整｜路径确认"
        before = self.wrap(text, 462, size=54)
        after = self.wrap(text, 462, size=54, kinsoku=True)
        self.assertEqual(before[-1], "认", "样本前提变了：旧行为本来就不该只剩一个字")
        self.assertEqual(after, ["新包装样件｜目标", "垛型｜现场布局｜", "抓具调整｜路径", "确认"])
        self.assertEqual("".join(after), text, "只挪断点，一个字都不许丢")
        self.assertEqual(len(after), len(before), "回退不许多出一行")

    def test_number_and_its_unit_never_split(self):
        text = "节拍 700 包/小时｜输送带连续来料"
        self.assertEqual(self.wrap(text, 300), ["节拍 700 包/小", "时｜输送带连续", "来料"],
                         "样本前提变了：旧行为本来就不该把「小时」劈开")
        self.assertEqual(self.wrap(text, 300, kinsoku=True),
                         ["节拍", "700 包/小时｜", "输送带连续来料"])
        # 数字与单位之间没有空格的写法一样要黏住。
        self.assertEqual(self.wrap("整线 12件/分 达标", 200), ["整线 12件", "/分 达标"])
        self.assertEqual(self.wrap("整线 12件/分 达标", 200, kinsoku=True),
                         ["整线", "12件/分", "达标"])

    def test_glued_unit_that_cannot_fit_falls_back_instead_of_failing(self):
        """窄到放不下「700 包/小时」时退回逐字换行，不能把卡片逼出「超长词」错误。"""
        text = "节拍 700 包/小时｜输送带连续来料"
        narrow = self.wrap(text, 120, kinsoku=True)
        # 换行只允许在断点处丢掉一个空格，别的字符一个都不能变。
        self.assertEqual(re.sub(r"\s+", "", "".join(narrow)), re.sub(r"\s+", "", text))
        for line in narrow:
            self.assertLessEqual(text_width(line, CJK, 42), 120,
                                 "黏合放不下时必须退回，不许留下超宽的行")

    def test_kinsoku_never_widens_a_line_beyond_plain(self):
        """**本层最硬的一条不变量**：kinsoku 不许比不加禁则时多造出任何一条超宽的行。

        上层 template_packaging.build_composition 会为超宽行一路压字号，压到下限还超就抛
        「模板上屏文字包含无法完整显示的超长词」——排版规则把本来能出片的卡片弄挂就是本末倒置。
        2026-09-21 复审就是在这里抓到真 bug 的（`%` / `℃` / `…` 走行首禁则被无条件硬拼）。

        顺带锁住另外两条：一个字符都不许丢（断点处的空格除外），行数不会凭空变少。

        **行首/行尾禁则不在这里断言**：它们是 best-effort——挪不动（挪完那一行放不下、或者本行
        只剩这一个单元）时按设计退回普通换行，宁可让符号落在行首，也不肯造出超宽的行。
        禁则真正生效的样本由 test_closing_punctuation_never_starts_a_line /
        test_opening_bracket_never_ends_a_line 两条钉住。
        """
        samples = [
            "上料、码垛、缠膜、入库……四步闭环确认",
            "产能提升 35%，人工下降 2 人",
            "缺陷率 0.3%｜产能 35%｜落盘确认",
            "温度 180℃ 保压 3 秒 冷却 20 秒后脱模确认",
            "换型前逐项确认（抓具与路径都要看）",
            "节拍 700 包/小时｜输送带连续来料｜托盘满垛下线",
            "新包装样件｜目标垛型｜现场布局｜抓具调整｜路径确认",
            "抓取位居中不压袋角并逐项核对来料朝向与输送节拍确认",
            "工序（PALLETIZING）闭环｜Vision-Guided 抓取",
            "满垛",
        ]
        for text in samples:
            for width, size in [(1136, 54), (1136, 42), (462, 54), (462, 42),
                                (300, 42), (228, 54), (200, 42), (108, 54)]:
                plain = self.wrap(text, width, size)
                kinsoku = self.wrap(text, width, size, kinsoku=True)
                over = lambda lines: [l for l in lines if text_width(l, CJK, size) > width]  # noqa: E731
                with self.subTest(text=text[:10], width=width, size=size):
                    self.assertLessEqual(
                        len(over(kinsoku)), len(over(plain)),
                        f"kinsoku 多造了超宽行：{over(kinsoku)!r} vs {over(plain)!r}")
                    self.assertEqual(re.sub(r"\s+", "", "".join(kinsoku)),
                                     re.sub(r"\s+", "", text), "换行不许丢字改字")
                    self.assertGreaterEqual(len(kinsoku), len(plain), "断点只会前移，不会凭空少一行")

    def test_closing_punctuation_never_starts_a_line(self):
        lines = self.wrap("抓取位居中，不压袋角；满垛下线。", 170, kinsoku=True)
        self.assertGreater(len(lines), 1, "样本必须真的换行，否则这条测试没有意义")
        for line in lines:
            self.assertNotIn(line[0], "，。；：、！？）》」%")

    def test_opening_bracket_never_ends_a_line(self):
        text = "换型前逐项确认（抓具与路径都要看）"
        self.assertEqual(self.wrap(text, 200)[1][-1], "（",
                         "样本前提变了：旧行为本来就不该把开括号留在行尾")
        lines = self.wrap(text, 200, kinsoku=True)
        for line in lines:
            self.assertNotIn(line[-1], "（(【《「")
        self.assertEqual("".join(lines), text)

    def test_pure_chinese_two_character_word_split_is_a_known_limitation(self):
        """04 第 5 镜的「节｜拍」：整句没有任何标点，不引入分词库判不出词边界。

        这条钉住**当前**行为，免得以后有人以为它已经修好了。真要修得换成带词典的分词。
        """
        text = "抓取位居中不压袋角并逐项核对来料朝向与输送节拍确认"
        lines = self.wrap(text, 940, kinsoku=True)
        self.assertEqual(lines[-1], "拍确认")
        self.assertEqual("".join(lines), text)


if __name__ == "__main__":
    unittest.main()
