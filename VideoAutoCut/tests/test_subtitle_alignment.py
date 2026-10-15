from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock


TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS_DIR))

import align_subtitles  # noqa: E402
from subtitle_alignment import (  # noqa: E402
    apply_display_format,
    boundary_after_normalized_units,
    cue_weight,
    distribute_segments,
    fix_cue_timing,
    hard_split_long_text,
    local_display_segments,
    normalize_content_for_compare,
    normalized_units_with_indices,
    project_segments_to_original,
    sentence_words,
    split_text_by_weights,
    subtitle_display_text,
    validate_standard_segments,
    validate_timing_segments,
)


class TextNormalizationTests(unittest.TestCase):
    def test_unicode_whitespace_and_punctuation_are_ignored_for_comparison(self) -> None:
        self.assertEqual(
            normalize_content_for_compare(" 你 好，World！【测试】… "),
            "你好World测试",
        )
        self.assertNotEqual(
            normalize_content_for_compare("World"),
            normalize_content_for_compare("world"),
        )

    def test_normalized_units_keep_original_indices_and_lowercase_ascii(self) -> None:
        raw = " A，β。中!"
        units = normalized_units_with_indices(raw)
        self.assertEqual(units, [("a", 1), ("β", 3), ("中", 5)])
        self.assertEqual(boundary_after_normalized_units(raw, units, 0), 0)
        self.assertEqual(boundary_after_normalized_units(raw, units, 1), 3)
        self.assertEqual(boundary_after_normalized_units(raw, units, 2), 5)
        self.assertEqual(boundary_after_normalized_units(raw, units, 99), len(raw))

    def test_cue_weight_accounts_for_ascii_cjk_and_pause_strength(self) -> None:
        self.assertEqual(cue_weight(""), 1.0)
        self.assertAlmostEqual(cue_weight("A中，。"), 0.55 + 1.0 + 0.7 + 1.2)


class SegmentationTests(unittest.TestCase):
    def test_strong_punctuation_splits_without_rewriting_original(self) -> None:
        self.assertEqual(
            local_display_segments("第一句。 第二句！", max_chars=6, min_chars=3),
            ["第一句。", "第二句！"],
        )
        self.assertEqual(local_display_segments("", max_chars=6, min_chars=3), [])

    def test_long_ascii_tokens_are_kept_intact(self) -> None:
        raw = "中文 SuperLongRobotName 后续内容"
        parts = hard_split_long_text(raw, max_chars=5)
        self.assertIn("SuperLongRobotName", "".join(parts))
        self.assertEqual("".join(parts), raw)
        with self.assertRaisesRegex(ValueError, "max_chars"):
            hard_split_long_text(raw, max_chars=0)

    def test_soft_punctuation_fallback_preserves_all_content(self) -> None:
        raw = "这是第一部分，随后进入第二部分，然后完成第三部分"
        parts = local_display_segments(raw, max_chars=8, min_chars=4)
        self.assertGreater(len(parts), 1)
        self.assertEqual(
            normalize_content_for_compare("".join(parts)),
            normalize_content_for_compare(raw),
        )

    def test_standard_segment_validation_covers_content_length_and_boundaries(self) -> None:
        validate_standard_segments(["你好", "世界"], "你好，世界。", max_chars=4)
        with self.assertRaisesRegex(ValueError, "empty segments"):
            validate_standard_segments([], "文本", max_chars=4)
        with self.assertRaisesRegex(ValueError, "changed original text"):
            validate_standard_segments(["被改写"], "原文", max_chars=20)
        with self.assertRaisesRegex(ValueError, "did not split"):
            validate_standard_segments(["这是一条非常非常长的字幕"], "这是一条非常非常长的字幕", max_chars=4)
        with self.assertRaisesRegex(ValueError, "bad subtitle boundary"):
            validate_standard_segments(["你好，", "世界"], "你好，世界", max_chars=8)


class ProjectionTests(unittest.TestCase):
    def test_model_boundaries_are_projected_back_to_original_unicode_text(self) -> None:
        raw = "你好，  World！再见。"
        projected = project_segments_to_original(
            raw,
            ["你好World", "再见"],
            max_chars=10,
        )
        self.assertEqual(projected, ["你好，  World！", "再见。"])
        self.assertEqual("".join(projected), raw.replace("！再", "！再").strip())

    def test_projection_rejects_mismatched_empty_and_too_long_boundaries(self) -> None:
        with self.assertRaisesRegex(ValueError, "cannot be projected"):
            project_segments_to_original("你好世界", ["你好"], max_chars=4)
        with self.assertRaisesRegex(ValueError, "cannot be projected"):
            project_segments_to_original("，。", [""], max_chars=4)
        with self.assertRaisesRegex(ValueError, "projected segment too long"):
            project_segments_to_original("abcdefghij", ["abcdefghij"], max_chars=2)


class WeightAndWordTests(unittest.TestCase):
    def test_weight_split_preserves_unicode_content_and_count(self) -> None:
        raw = "你好，World！再见"
        parts = split_text_by_weights(raw, [1.0, 2.0, 1.0])
        self.assertEqual(len(parts), 3)
        self.assertEqual(
            normalize_content_for_compare("".join(parts)),
            normalize_content_for_compare(raw),
        )
        self.assertEqual(split_text_by_weights("", [1]), [])
        self.assertEqual(split_text_by_weights(raw, []), [])
        self.assertEqual(split_text_by_weights("，。！", [1, 1]), ["，。！", ""])

    def test_timing_segment_validation_has_stable_failure_contract(self) -> None:
        validate_timing_segments(["你好", "世界"], "你好，世界", 2)
        with self.assertRaisesRegex(ValueError, "count mismatch"):
            validate_timing_segments(["你好"], "你好世界", 2)
        with self.assertRaisesRegex(ValueError, "changed spoken text"):
            validate_timing_segments(["你好", "错误"], "你好世界", 2)

    def test_sentence_words_skips_malformed_and_non_positive_ranges(self) -> None:
        self.assertEqual(
            sentence_words(
                {
                    "words": [
                        {"start": "0.1", "end": "0.5"},
                        {"start": 1, "end": 1},
                        {"start": "bad", "end": 2},
                        {"start": 0, "end": float("inf")},
                        {"start": float("nan"), "end": 1},
                        None,
                    ]
                }
            ),
            [{"start": 0.1, "end": 0.5}],
        )


class CueTimelineTests(unittest.TestCase):
    def test_weighted_distribution_covers_full_span_monotonically(self) -> None:
        cues = distribute_segments(["甲", "乙乙"], 0.0, 3.0)
        self.assertEqual(
            cues,
            [
                {"text": "甲", "start": 0.0, "end": 1.0, "source": "original_asr_weight"},
                {"text": "乙乙", "start": 1.0, "end": 3.0, "source": "original_asr_weight"},
            ],
        )
        self.assertEqual(distribute_segments([], 0, 1), [])
        self.assertEqual(distribute_segments(["文本"], 1, 1), [])

    def test_word_distribution_uses_asr_boundaries_and_full_final_span(self) -> None:
        words = [
            {"start": 0.1, "end": 0.5},
            {"start": 0.5, "end": 1.0},
            {"start": 1.1, "end": 2.0},
            {"start": 2.0, "end": 2.8},
        ]
        cues = distribute_segments(["第一段", "第二段"], 0.0, 3.0, words)
        self.assertEqual([cue["source"] for cue in cues], ["original_asr_words"] * 2)
        self.assertEqual((cues[0]["start"], cues[0]["end"]), (0.1, 1.0))
        self.assertEqual((cues[1]["start"], cues[1]["end"]), (1.1, 3.0))

    def test_extremely_short_span_never_produces_negative_or_reversed_cues(self) -> None:
        cues = distribute_segments(["甲", "乙", "丙"], 0.0, 0.2, min_duration=0.45)
        self.assertEqual(cues[0]["start"], 0.0)
        self.assertEqual(cues[-1]["end"], 0.2)
        for previous, current in zip(cues, cues[1:]):
            self.assertLess(previous["start"], previous["end"])
            self.assertLessEqual(previous["end"], current["start"])
        self.assertLess(cues[-1]["start"], cues[-1]["end"])

    def test_fix_timing_rejects_invalid_span_and_does_not_require_positive_floor(self) -> None:
        with self.assertRaisesRegex(ValueError, "end must be greater"):
            fix_cue_timing([{"start": 0, "end": 0}], 1, 1)
        cues = fix_cue_timing(
            [{"start": 0, "end": 0.2}, {"start": 0.2, "end": 0.4}],
            0,
            0.4,
            min_duration=-1,
        )
        self.assertEqual(cues[-1]["end"], 0.4)

    def test_out_of_range_and_non_finite_word_times_are_clamped_monotonically(self) -> None:
        cues = distribute_segments(
            ["第一", "第二", "第三"],
            0.0,
            1.0,
            words=[
                {"start": 99, "end": float("inf")},
                {"start": float("nan"), "end": float("nan")},
                {"start": -5, "end": 5},
            ],
        )
        self.assertEqual(len(cues), 3)
        previous_end = 0.0
        for cue in cues:
            self.assertGreaterEqual(cue["start"], 0.0)
            self.assertGreaterEqual(cue["start"], previous_end)
            self.assertGreaterEqual(cue["end"], cue["start"])
            self.assertLessEqual(cue["end"], 1.0)
            previous_end = cue["end"]
        self.assertEqual(cues[-1]["end"], 1.0)

        direct = fix_cue_timing(
            [
                {"start": 50, "end": float("inf")},
                {"start": float("nan"), "end": float("nan")},
            ],
            0.0,
            1.0,
        )
        self.assertLessEqual(direct[0]["start"], direct[0]["end"])
        self.assertLessEqual(direct[0]["end"], direct[1]["start"])
        self.assertLessEqual(direct[1]["start"], direct[1]["end"])
        self.assertEqual(direct[-1]["end"], 1.0)


class DisplayFormattingTests(unittest.TestCase):
    def test_default_trailing_and_full_punctuation_modes(self) -> None:
        self.assertEqual(subtitle_display_text("你好，世界！"), "你好，世界")
        self.assertEqual(
            subtitle_display_text("你好，世界！", strip_trailing_punctuation=False),
            "你好，世界！",
        )
        self.assertEqual(
            subtitle_display_text("你好，世界！", hide_punctuation=True),
            "你好 世界",
        )
        self.assertEqual(subtitle_display_text("文本……"), "文本")

    def test_apply_format_copies_input_preserves_original_and_drops_empty_display(self) -> None:
        source = [
            {"text": "你好！", "start": 0, "end": 1},
            {"text": "。", "start": 1, "end": 2},
        ]
        formatted = apply_display_format(source)
        self.assertEqual(
            formatted,
            [{"text": "你好", "original_text": "你好！", "start": 0, "end": 1}],
        )
        self.assertEqual(source[0]["text"], "你好！")


class AlignSubtitlesCompatibilityTests(unittest.TestCase):
    def test_environment_backed_segmentation_and_display_signatures_are_preserved(self) -> None:
        with mock.patch.dict(
            os.environ,
            {
                "SUBTITLE_DISPLAY_MAX_CHARS": "6",
                "SUBTITLE_DISPLAY_MIN_CHARS": "3",
                "SUBTITLE_HIDE_PUNCTUATION": "true",
            },
            clear=False,
        ):
            self.assertEqual(
                align_subtitles.local_display_segments("第一句。第二句！"),
                local_display_segments("第一句。第二句！", max_chars=6, min_chars=3),
            )
            self.assertEqual(align_subtitles.subtitle_display_text("你好，世界！"), "你好 世界")

    def test_environment_minimum_duration_is_forwarded_by_original_signature(self) -> None:
        with mock.patch.dict(os.environ, {"SUBTITLE_MIN_DURATION": "0.1"}, clear=False):
            cues = align_subtitles.distribute_segments(["甲", "乙"], 0, 0.3)
        self.assertEqual(cues[-1]["end"], 0.3)
        self.assertIs(align_subtitles.normalize_content_for_compare, normalize_content_for_compare)


if __name__ == "__main__":
    unittest.main()
