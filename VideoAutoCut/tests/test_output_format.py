import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import output_format
import render_segment
import add_progress


class OutputFormatTests(unittest.TestCase):
    def test_supported_sizes_saved_configuration_and_legacy_default(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {}, clear=True):
            root = Path(directory)
            for (ratio, resolution), size in output_format.RESOLUTION_SIZES.items():
                with self.subTest(ratio=ratio, resolution=resolution):
                    (root / "output-format.json").write_text(json.dumps({
                        "aspect_ratio": ratio, "resolution": resolution, "width": size[0], "height": size[1],
                    }), encoding="utf-8")
                    self.assertEqual(output_format.configure_canvas(str(root / "shots.json")), size)
            (root / "output-format.json").write_text('{"aspect_ratio":"3:4","width":1080,"height":1440}', encoding="utf-8")
            self.assertEqual(output_format.configure_canvas(str(root / "shots.json")), (1080, 1440))

    def test_invalid_combinations_and_corrupted_saved_size_are_rejected(self):
        for ratio, resolution in [("9:16", "720p"), ("4:3", "4k"), ("3:4", "4k"), ("16:9", "8k")]:
            with self.assertRaises(ValueError):
                output_format.dimensions(ratio, resolution)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "output-format.json").write_text('{"aspect_ratio":"16:9","resolution":"4k","width":3840,"height":210}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "不一致"):
                output_format.configure_canvas(str(root / "shots.json"))

    def test_subtitle_and_progress_geometry_scale_with_output_resolution(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {
            "SUBTITLE_FONT_SIZE": "68", "SUBTITLE_LINE_GAP": "80", "SUBTITLE_MARGIN_L": "120",
            "SUBTITLE_MARGIN_R": "120", "PROGRESS_FONT_SIZE": "30", "PROGRESS_BAR_HEIGHT": "76",
            "PROGRESS_TEMPLATE": "classic", "PROGRESS_FONT": "Arial", "SUBTITLE_FONT": "Arial",
        }, clear=True), mock.patch.object(add_progress, "selected_template", return_value={"PROGRESS_FONT_SIZE": "30", "PROGRESS_BAR_HEIGHT": "76"}):
            for ratio, resolution, size, scale in [
                ("16:9", "720p", (1280, 720), 2 / 3), ("16:9", "4k", (3840, 2160), 2),
                ("9:16", "4k", (2160, 3840), 2),
            ]:
                with self.subTest(resolution=resolution, ratio=ratio):
                    self.assertEqual(output_format.configure_canvas("", ratio, resolution), size)
                    self.assertEqual(render_segment.subtitle_font_size(), round(68 * scale))
                    self.assertEqual(render_segment.subtitle_line_gap(), round(80 * scale))
                    self.assertEqual(render_segment.subtitle_picture_position((0, 0, *size)),
                                     (int(size[1] - 76 * scale - round(5 * scale)), "bottom"))
                    target = Path(directory) / "scaled.ass"
                    render_segment.write_combined_ass("A complete subtitle line", ["Chapter one", "Chapter two"], 1, 1, target, picture_bounds=(0, 0, *size))
                    text = target.read_text(encoding="utf-8")
                    self.assertIn(f"PlayResX: {size[0]}", text)
                    self.assertIn(f"PlayResY: {size[1]}", text)
                    self.assertIn(f"Style: ProgressText,Arial,{round(30 * scale)},", text)
                    self.assertIn(f"Style: Subtitle,Arial,{round(68 * scale)},", text)


if __name__ == "__main__":
    unittest.main()
