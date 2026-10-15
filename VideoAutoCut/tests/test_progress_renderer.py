#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS_DIR))

import add_progress  # noqa: E402
import render_segment  # noqa: E402


class ProgressColorTests(unittest.TestCase):
    def test_ass_color_splits_alpha_from_override_color(self) -> None:
        color = add_progress.parse_ass_color("&H99787878&", "&H00FFFFFF&")

        self.assertEqual(color.bgr, "787878")
        self.assertEqual(color.alpha, "99")
        self.assertEqual(color.style_value, "&H99787878&")
        self.assertEqual(color.override_tags(), r"\1c&H787878&\1a&H99&")

    def test_web_color_is_opaque_and_converted_to_bgr(self) -> None:
        color = add_progress.parse_ass_color("#3377FF", "&H00FFFFFF&")

        self.assertEqual(color.style_value, "&H00FF7733&")


class ProgressAssTests(unittest.TestCase):
    def test_user_template_is_loaded_and_selected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "progress-templates.user.json").write_text(json.dumps([{
                "key": "user-news",
                "settings": {
                    "PROGRESS_BOTTOM_MARGIN": "18",
                    "PROGRESS_BAR_HEIGHT": "46",
                },
            }]), encoding="utf-8")
            with mock.patch.dict(
                os.environ,
                {"VIDEOAUTO_CONFIG_ROOT": tmp, "PROGRESS_TEMPLATE": "user-news"},
                clear=False,
            ), mock.patch.object(add_progress, "_PROGRESS_TEMPLATES_CACHE", None):
                selected = add_progress.selected_template()

        self.assertEqual(selected["PROGRESS_BOTTOM_MARGIN"], "18")
        self.assertEqual(selected["PROGRESS_BAR_HEIGHT"], "46")

    def test_unknown_template_falls_back_to_bottom_aligned_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            os.environ,
            {"VIDEOAUTO_CONFIG_ROOT": tmp, "PROGRESS_TEMPLATE": "missing"},
            clear=False,
        ), mock.patch.object(add_progress, "_PROGRESS_TEMPLATES_CACHE", None):
            templates = add_progress.progress_templates()
            selected = add_progress.selected_template()

        self.assertEqual(set(templates), {"classic"})
        self.assertEqual(selected, templates["classic"])
        self.assertEqual(selected["PROGRESS_BOTTOM_MARGIN"], "0")

    def test_malformed_user_template_file_falls_back_to_classic(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "progress-templates.user.json").write_text("{broken", encoding="utf-8")
            with mock.patch.dict(
                os.environ,
                {"VIDEOAUTO_CONFIG_ROOT": tmp, "PROGRESS_TEMPLATE": "user-broken"},
                clear=False,
            ), mock.patch.object(add_progress, "_PROGRESS_TEMPLATES_CACHE", None):
                selected = add_progress.selected_template()

        self.assertEqual(selected["PROGRESS_BOTTOM_MARGIN"], "0")

    def test_progress_uses_separate_alpha_tags_and_animated_clip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            os.environ,
            {"PROGRESS_TEMPLATE": "classic"},
            clear=False,
        ), mock.patch.object(add_progress, "_PROGRESS_TEMPLATES_CACHE", None):
            output = Path(tmp) / "progress.ass"
            add_progress.write_progress_ass(["开场", "内容"], 2, 5.0, output)
            rendered = output.read_text(encoding="utf-8")

        self.assertIn(r"\1c&H181818&\1a&HBF&", rendered)
        self.assertIn(r"\1c&H787878&\1a&H99&", rendered)
        self.assertIn(r"\t(0,5000,\clip(", rendered)
        self.assertNotIn(r"\1c&H99787878&", rendered)


class PictureProgressTests(unittest.TestCase):
    def test_bar_tracks_letterboxed_picture_not_canvas(self):
        from output_format import fitted_picture_bounds
        bounds = fitted_picture_bounds(1920, 1080, 1440, 1080)
        self.assertEqual(bounds, (0, 134, 1440, 810))
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {
            'VIDEOAUTO_OUTPUT_WIDTH': '1440', 'VIDEOAUTO_OUTPUT_HEIGHT': '1080',
        }):
            target = Path(tmp) / 'progress.ass'
            add_progress.write_progress_ass(['A'], 1, 2, target, picture_bounds=bounds)
            text = target.read_text(encoding='utf-8')
            self.assertIn('944', text)
            self.assertNotIn('l 1440 1080', text)

    def test_portrait_picture_limits_horizontal_bar_extent(self):
        from output_format import fitted_picture_bounds
        self.assertEqual(fitted_picture_bounds(1080, 1440, 1440, 1080), (314, 0, 810, 1080))


class SubtitleStyleTests(unittest.TestCase):
    def test_preview_examples_follow_rendering_anchor_and_ignore_obsolete_y(self):
        with mock.patch.dict(os.environ, {'VIDEOAUTO_OUTPUT_WIDTH': '1920', 'VIDEOAUTO_OUTPUT_HEIGHT': '1080', 'SUBTITLE_FONT_SIZE': '68', 'SUBTITLE_Y': '620'}), mock.patch.object(render_segment, 'progress_float', return_value=38):
            self.assertEqual(render_segment.subtitle_picture_position((0, 0, 1920, 1080)), (1037, 'bottom'))
            self.assertEqual(render_segment.subtitle_picture_position((0, 0, 1920, 1080), False), (1075, 'bottom'))
            self.assertEqual(render_segment.subtitle_picture_position((0, 220, 1920, 640)), (865, 'top'))
            with mock.patch.dict(os.environ, {'SUBTITLE_FONT_SIZE': '96'}):
                self.assertEqual(render_segment.subtitle_picture_position((0, 220, 1920, 640)), (817, 'bottom'))

    def test_subtitle_uses_black_space_or_sits_above_progress(self):
        with mock.patch.dict(os.environ, {'VIDEOAUTO_OUTPUT_WIDTH': '1080', 'VIDEOAUTO_OUTPUT_HEIGHT': '1920'}):
            self.assertEqual(render_segment.subtitle_picture_position((0, 656, 1080, 606)), (1267, 'top'))
        with mock.patch.dict(os.environ, {'VIDEOAUTO_OUTPUT_WIDTH': '1920', 'VIDEOAUTO_OUTPUT_HEIGHT': '1080'}), mock.patch.object(render_segment, 'progress_float', return_value=76):
            self.assertEqual(render_segment.subtitle_picture_position((0, 0, 1920, 1080)), (999, 'bottom'))
            self.assertEqual(render_segment.subtitle_picture_position((0, 0, 1920, 1080), False), (1075, 'bottom'))

    def test_subtitle_stays_bold_when_legacy_config_disables_it(self) -> None:
        with mock.patch.dict(os.environ, {"SUBTITLE_BOLD": "0"}, clear=False):
            fields = render_segment.subtitle_style_line().strip().split(",")

        self.assertEqual(fields[7], "1")


if __name__ == "__main__":
    unittest.main()
