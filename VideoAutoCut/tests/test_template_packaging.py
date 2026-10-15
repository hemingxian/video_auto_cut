from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from template_packaging import (
    build_composition, has_script_card_content, load_packaging_shot, packaging_content,
    packaging_enabled, renderer_dependencies, script_only,
)

SCRIPT_ONLY = "VIDEOAUTO_PACKAGING_SCRIPT_ONLY"


class TemplatePackagingTests(unittest.TestCase):
    def test_switch_is_off_without_explicit_enable(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(packaging_enabled())
        with patch.dict(os.environ, {"VIDEOAUTO_TEMPLATE_PACKAGING": "true"}):
            self.assertTrue(packaging_enabled())

    def test_three_templates_take_existing_copy_without_mutating_shot(self):
        for hint, expected in [("标题", "title"), ("参数", "parameters"), ("CTA", "cta")]:
            shot = {"title": "已有标题", "card_content": "Full words remain intact", "card_hint": hint,
                    "duration": 4, "material_url": "https://example.invalid/video", "voice_text": "narration"}
            previous = copy.deepcopy(shot)
            source, manifest = build_composition(shot, 1920, 1080, 4)
            self.assertEqual(manifest["template"], expected)
            self.assertEqual(manifest["duration"], 4)
            self.assertIn("Full words remain intact", source)
            self.assertNotIn("example.invalid", source)
            self.assertNotIn("narration", source)
            self.assertEqual(shot, previous)

    def test_html_is_escaped_and_hint_never_executes(self):
        source, _ = build_composition({"card_content": "<script>alert(1)</script>", "card_hint": "fetch('https://bad.invalid')"}, 1920, 1080, 4)
        self.assertIn("&lt;script&gt;", source)
        self.assertNotIn("<script>alert", source)
        self.assertNotIn("bad.invalid", source)

    def test_empty_display_fields_do_not_render_instruction_as_text(self):
        self.assertIsNone(build_composition({"card_hint": "Place logo here"}, 1920, 1080, 4))
        self.assertEqual(packaging_content({"title": "现有中文标题"}), ("title", "现有中文标题"))

    def test_long_copy_pages_preserve_words_and_duration(self):
        content = " ".join(f"parameter{i}" for i in range(22))
        _, manifest = build_composition({"card_hint": "parameters", "card_content": content}, 1080, 1920, 6)
        displayed = " ".join(line for page in manifest["pages"] for line in page)
        self.assertEqual(displayed, content)
        self.assertEqual(manifest["duration"], 6)
        with self.assertRaisesRegex(RuntimeError, "时长不足"):
            build_composition({"card_content": content * 10}, 1280, 720, 1)

    def test_chinese_cards_never_load_the_subtitle_tokenizer(self):
        with patch("text_layout._subtitle_tokenizer", side_effect=AssertionError("subtitle only")):
            source, manifest = build_composition(
                {"card_content": "箱体尺寸 · 重量\n托盘规格", "card_hint": "参数"},
                1920, 1080, 4,
            )
        self.assertEqual("".join(line for page in manifest["pages"] for line in page),
                         "箱体尺寸 · 重量托盘规格")
        self.assertIn("托盘规格", source)
        self.assertNotIn("white-space:pre", source)

        headline_source, headline_manifest = build_composition(
            {"card_layout": "headline_sub", "card_content": "普通标题\n普通副行"},
            1920, 1080, 4,
        )
        self.assertEqual(headline_manifest["template"], "headline")
        self.assertNotIn("white-space:pre", headline_source)

    def test_letterboxed_picture_controls_position(self):
        # 这条验的是「没写 card_content、退回 title」那条老路径的定位，所以显式关掉
        # 「只按脚本上屏」（默认开着时这一镜根本不上卡片，另见 ScriptOnlyTests）。
        with patch.dict(os.environ, {"VIDEOAUTO_PACKAGING_SCRIPT_ONLY": "0"}):
            source, manifest = build_composition({"title": "Position"}, 1920, 1080, 3, (0, 180, 1920, 720))
            self.assertIn("top:220px", source)
            self.assertEqual(manifest["picture_bounds"], [0, 180, 1920, 720])
            with self.assertRaisesRegex(RuntimeError, "画面过窄"):
                build_composition({"title": "Position"}, 1920, 1080, 3, (0, 500, 1920, 80))

    def test_missing_dependencies_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "HyperFrames.*GSAP.*Chrome"):
                renderer_dependencies(Path(directory))

    def test_load_shot_checks_index_and_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = Path(directory, "shots.json")
            plan.write_text(json.dumps({"shots": [{"title": "Example"}]}), encoding="utf-8")
            self.assertEqual(load_packaging_shot(str(plan), 1), {"title": "Example"})
            with self.assertRaises(RuntimeError):
                load_packaging_shot(str(plan), 2)


class ScriptOnlyTests(unittest.TestCase):
    """「只按脚本上屏」：只有脚本写了 card_content 的镜才上卡片，默认开启。"""

    WITH_CARD = {"title": "分镜3", "card_content": "节拍 700 包/小时", "card_hint": "参数"}
    WITHOUT_CARD = {"title": "落盘后核对三项", "voice_text": "口播原文"}

    def test_default_is_on_and_only_the_false_words_turn_it_off(self):
        """口径与 common.parse_bool 完全一致：大小写不敏感，认不出来的值按默认（开）。"""
        for missing in ({}, {SCRIPT_ONLY: ""}, {SCRIPT_ONLY: "  "}):
            with self.subTest(env=missing), patch.dict(os.environ, missing, clear=True):
                self.assertTrue(script_only(), "缺键、空值都按开算")
        for text in ("0", "false", "FALSE", "no", "n", "off", "Off"):
            with self.subTest(value=text), patch.dict(os.environ, {SCRIPT_ONLY: text}):
                self.assertFalse(script_only())
        for text in ("1", "true", "TRUE", "yes", "y", "on", "随便写点什么"):
            with self.subTest(value=text), patch.dict(os.environ, {SCRIPT_ONLY: text}):
                self.assertTrue(script_only())

    def test_shot_without_card_content_gets_no_card(self):
        with patch.dict(os.environ, {SCRIPT_ONLY: "1"}):
            self.assertIsNone(build_composition(self.WITHOUT_CARD, 1920, 1080, 6))

    def test_card_hint_alone_is_not_script_copy(self):
        # card_hint 是版式提示，不是上屏内容——写了它也不算作者写了上屏文字。
        shot = {"title": "分镜3", "card_hint": "参数卡，列表排版"}
        self.assertFalse(has_script_card_content(shot))
        with patch.dict(os.environ, {SCRIPT_ONLY: "1"}):
            self.assertIsNone(build_composition(shot, 1920, 1080, 6))

    def test_whitespace_only_card_content_is_not_script_copy(self):
        shot = {"title": "分镜3", "card_content": "  　 "}
        self.assertFalse(has_script_card_content(shot))
        with patch.dict(os.environ, {SCRIPT_ONLY: "1"}):
            self.assertIsNone(build_composition(shot, 1920, 1080, 6))

    def test_agent_plan_cannot_put_a_card_on_a_shot_the_script_left_empty(self):
        with patch.dict(os.environ, {SCRIPT_ONLY: "1"}):
            self.assertIsNone(build_composition(self.WITHOUT_CARD, 1920, 1080, 6,
                                                plan={"template": "title", "show": True}))

    def test_shot_with_card_content_is_byte_for_byte_unchanged_by_the_switch(self):
        """写了 card_content 的镜：开关开或关，html 与 manifest 必须一模一样。"""
        for bounds in (None, (656, 0, 606, 1080)):
            with self.subTest(bounds=bounds):
                with patch.dict(os.environ, {SCRIPT_ONLY: "1"}):
                    on = build_composition(self.WITH_CARD, 1920, 1080, 6, bounds)
                with patch.dict(os.environ, {SCRIPT_ONLY: "0"}):
                    off = build_composition(self.WITH_CARD, 1920, 1080, 6, bounds)
                self.assertIsNotNone(on)
                self.assertEqual(on[0], off[0])
                self.assertEqual(on[1], off[1])

    def test_default_mode_still_lays_out_a_letterboxed_card(self):
        """默认模式下的正向样本：写了 card_content 的镜，定位/几何断言照样要跑。

        （`test_letterboxed_picture_controls_position` 那条验的是 title 兜底的老路径，
        必须关掉开关才跑，所以这里补一条开着开关的。）"""
        with patch.dict(os.environ, {SCRIPT_ONLY: "1"}):
            source, manifest = build_composition(
                {"title": "内部标签", "card_content": "Position"}, 1920, 1080, 3, (0, 180, 1920, 720))
        self.assertIn("top:220px", source)
        self.assertIn("Position", source)
        self.assertEqual(manifest["picture_bounds"], [0, 180, 1920, 720])
        with patch.dict(os.environ, {SCRIPT_ONLY: "1"}):
            with self.assertRaisesRegex(RuntimeError, "画面过窄"):
                build_composition({"card_content": "Position"}, 1920, 1080, 3, (0, 500, 1920, 80))

    def test_switch_off_restores_the_title_fallback(self):
        with patch.dict(os.environ, {SCRIPT_ONLY: "0"}):
            source, manifest = build_composition(self.WITHOUT_CARD, 1920, 1080, 6)
        self.assertEqual(manifest["template"], "title")
        self.assertEqual(manifest["content"], "落盘后核对三项")
        self.assertIn("落盘后核对三项", source)


if __name__ == "__main__":
    unittest.main()
