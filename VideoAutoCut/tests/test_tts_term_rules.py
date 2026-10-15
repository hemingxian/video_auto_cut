from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS_DIR))

import prepare_voice  # noqa: E402
from tts_term_rules import (  # noqa: E402
    TtsTermError,
    apply_term_readings,
    build_ssml,
    ensure_text_resolved,
    extract_english_terms,
    has_unresolved_terms,
    merge_english_terms,
    normalize_cmu_phonemes,
    normalize_model_readings,
    normalize_term_spec,
    spelled_non_acronym_terms,
    term_ssml,
    unresolved_term_details,
)


class TermExtractionTests(unittest.TestCase):
    def test_terms_are_classified_and_deduplicated_case_insensitively(self) -> None:
        self.assertEqual(
            extract_english_terms("FANUC Robot robot 3D iPhone C++"),
            [
                {"text": "FANUC", "kind": "acronym"},
                {"text": "Robot", "kind": "term"},
                {"text": "3D", "kind": "acronym"},
                {"text": "iPhone", "kind": "term"},
                {"text": "C", "kind": "acronym"},
            ],
        )
        self.assertEqual(
            merge_english_terms(["ABB robot", "abb KUKA"]),
            [
                {"text": "ABB", "kind": "acronym"},
                {"text": "robot", "kind": "term"},
                {"text": "KUKA", "kind": "acronym"},
            ],
        )

    def test_letter_by_letter_detection_ignores_acronyms(self) -> None:
        self.assertEqual(spelled_non_acronym_terms("Robot FANUC", "r o b o t f a n u c"), ["Robot"])
        self.assertEqual(spelled_non_acronym_terms("Robot", "机器人"), [])


class CmuValidationTests(unittest.TestCase):
    def test_valid_phonemes_are_normalized(self) -> None:
        self.assertEqual(
            normalize_cmu_phonemes("r  ow1 b aa0 t"),
            ("R OW1 B AA0 T", None),
        )

    def test_empty_unknown_and_invalid_stress_are_rejected(self) -> None:
        cases = {
            "": "为空",
            "OW": "元音必须带重音",
            "B1": "辅音不能带重音",
            "XYZ1": "未知 CMU 音素",
            "OW9": "非法 CMU 音素",
        }
        for value, message in cases.items():
            with self.subTest(value=value):
                normalized, reason = normalize_cmu_phonemes(value)
                self.assertIsNone(normalized)
                self.assertIn(message, reason)


class TermSpecTests(unittest.TestCase):
    def test_acronym_defaults_to_characters_and_aliases_are_normalized(self) -> None:
        term = {"text": "ABB", "kind": "acronym"}
        self.assertEqual(
            normalize_term_spec(term, {}),
            ({"text": "ABB", "mode": "characters", "value": ""}, None),
        )
        self.assertEqual(
            normalize_term_spec(term, {"mode": "spell"}),
            ({"text": "ABB", "mode": "characters", "value": ""}, None),
        )

    def test_cmu_mode_validates_and_normalizes_model_fields(self) -> None:
        term = {"text": "Robot", "kind": "term"}
        self.assertEqual(
            normalize_term_spec(term, {"mode": "cmu", "ph": "R OW1 B AA0 T"}),
            ({"text": "Robot", "mode": "phoneme_cmu", "value": "R OW1 B AA0 T"}, None),
        )
        spec, reason = normalize_term_spec(term, {"mode": "phoneme_cmu", "value": "R OW B"})
        self.assertIsNone(spec)
        self.assertIn("元音必须带重音", reason)

    def test_text_substitution_requires_explicit_policy_and_safe_alias(self) -> None:
        term = {"text": "Robot", "kind": "term"}
        spec, reason = normalize_term_spec(term, {"mode": "sub", "value": "机器人"})
        self.assertIsNone(spec)
        self.assertIn("默认只能使用", reason)
        self.assertEqual(
            normalize_term_spec(
                term,
                {"mode": "sub", "value": "机器人"},
                allow_text_substitution=True,
            ),
            ({"text": "Robot", "mode": "sub", "value": "机器人"}, None),
        )
        for alias, message in (("Robot", "等于原词"), ("robot读法", "仍包含英文字母")):
            with self.subTest(alias=alias):
                spec, reason = normalize_term_spec(
                    term,
                    {"mode": "sub", "value": alias},
                    allow_text_substitution=True,
                )
                self.assertIsNone(spec)
                self.assertIn(message, reason)

    def test_model_readings_ignore_unknown_and_invalid_items(self) -> None:
        terms = [
            {"text": "ABB", "kind": "acronym"},
            {"text": "Robot", "kind": "term"},
        ]
        self.assertEqual(
            normalize_model_readings(
                terms,
                {
                    "ABB": {"mode": "characters"},
                    "Robot": {"mode": "phoneme_cmu", "ph": "R OW1 B AA0 T"},
                    "Unknown": {"mode": "characters"},
                },
            ),
            {
                "abb": {"text": "ABB", "mode": "characters", "value": ""},
                "robot": {"text": "Robot", "mode": "phoneme_cmu", "value": "R OW1 B AA0 T"},
            },
        )
        self.assertEqual(normalize_model_readings(terms, "invalid"), {})


class TermApplicationTests(unittest.TestCase):
    def test_plain_application_replaces_only_explicit_substitution(self) -> None:
        specs = {
            "abb": {"text": "ABB", "mode": "characters", "value": ""},
            "robot": {"text": "Robot", "mode": "sub", "value": "机器人"},
        }
        self.assertEqual(
            apply_term_readings(
                "ABB Robot",
                specs,
                allow_text_substitution=True,
            ),
            "ABB 机器人",
        )
        with self.assertRaisesRegex(TtsTermError, "TTS 术语读法未确认"):
            apply_term_readings("ABB Missing", specs)

    def test_unresolved_detection_and_text_resolution_contract(self) -> None:
        specs = {"abb": {"text": "ABB", "mode": "characters", "value": ""}}
        self.assertFalse(has_unresolved_terms("ABB", specs))
        self.assertTrue(has_unresolved_terms("ABB Robot", specs))
        ensure_text_resolved("纯中文文本", "结果")
        with self.assertRaisesRegex(TtsTermError, "结果仍包含未确认读法的英文术语: Robot"):
            ensure_text_resolved("包含 Robot", "结果")

    def test_ssml_escapes_content_and_supports_each_mode(self) -> None:
        specs = {
            "abb": {"text": "ABB", "mode": "characters", "value": ""},
            "robot": {"text": "Robot", "mode": "phoneme_cmu", "value": "R OW1 B AA0 T"},
            "kuka": {"text": "KUKA", "mode": "sub", "value": "库卡&机器人"},
        }
        ssml = build_ssml(
            "ABB & Robot / KUKA",
            specs,
            allow_text_substitution=True,
        )
        self.assertEqual(
            ssml,
            '<speak><say-as interpret-as="characters">ABB</say-as> &amp; '
            '<phoneme alphabet="cmu" ph="R OW1 B AA0 T">Robot</phoneme> / '
            '<sub alias="库卡&amp;机器人">KUKA</sub></speak>',
        )

    def test_ssml_disabled_missing_strategy_and_invalid_mode_fail_clearly(self) -> None:
        with self.assertRaisesRegex(TtsTermError, "TTS_ENABLE_SSML=false"):
            build_ssml("ABB", {}, enable_ssml=False)
        with self.assertRaisesRegex(TtsTermError, "SSML 术语读法未确认"):
            build_ssml("ABB", {})
        with self.assertRaisesRegex(TtsTermError, "不支持的 SSML 发音模式"):
            term_ssml("ABB", {"mode": "unknown", "value": ""})

    def test_cjk_adjacent_character_mode_stays_inline_without_ssml_wrapper(self) -> None:
        specs = {"abb": {"text": "ABB", "mode": "characters", "value": ""}}
        self.assertIsNone(build_ssml("使用ABB机器人", specs))
        self.assertIsNone(build_ssml("纯中文", {}))

    def test_unresolved_detail_limit_is_deterministic(self) -> None:
        terms = [{"text": f"T{index}", "kind": "term"} for index in range(4)]
        self.assertEqual(unresolved_term_details(terms, limit=2), "T0、T1 等 4 个")


class PrepareVoiceCompatibilityTests(unittest.TestCase):
    def test_english_narration_does_not_require_pronunciation_model(self) -> None:
        text = "Next, the operator checks both ends of the CNC conveyors."
        with mock.patch.object(prepare_voice, "call_qwen", side_effect=AssertionError("unexpected model request")):
            prepare_voice.prepare_tts_term_readings([text])
            self.assertEqual(prepare_voice.tts_request_text(text), (text, text, False))
            self.assertFalse(prepare_voice.has_unresolved_english_terms(text))

    def test_english_sentence_ignores_mixed_language_cached_readings(self) -> None:
        text = "Connect the ends."
        with mock.patch.object(prepare_voice, "_TTS_TERM_SPECS", {"connect": {"mode": "characters", "value": ""}}):
            self.assertEqual(prepare_voice.tts_request_text(text), (text, text, False))

    def test_environment_policy_is_preserved_by_compatibility_facade(self) -> None:
        term = {"text": "Robot", "kind": "term"}
        item = {"mode": "sub", "value": "机器人"}
        with mock.patch.dict(os.environ, {"TTS_ALLOW_TEXT_SUBSTITUTION": "false"}, clear=False):
            self.assertIsNotNone(prepare_voice.normalize_term_spec(term, item)[1])
        with mock.patch.dict(os.environ, {"TTS_ALLOW_TEXT_SUBSTITUTION": "true"}, clear=False):
            self.assertEqual(
                prepare_voice.normalize_term_spec(term, item),
                ({"text": "Robot", "mode": "sub", "value": "机器人"}, None),
            )

    def test_facade_keeps_system_exit_failure_contract(self) -> None:
        with mock.patch.object(prepare_voice, "_TTS_TERM_SPECS", {}):
            with self.assertRaisesRegex(SystemExit, "SSML 术语读法未确认"):
                prepare_voice.build_tts_ssml("使用 ABB 机器人")
        with self.assertRaisesRegex(SystemExit, "不支持的 SSML 发音模式"):
            prepare_voice.term_ssml("ABB", {"mode": "bad", "value": ""})

    def test_model_response_facade_uses_pure_normalizer(self) -> None:
        response = {"readings": [{"text": "ABB", "mode": "characters"}]}
        with mock.patch.object(prepare_voice, "call_qwen", return_value=response), mock.patch.object(
            prepare_voice, "load_prompt_template", return_value="prompt"
        ):
            self.assertEqual(
                prepare_voice.call_tts_term_model(
                    [{"text": "ABB", "kind": "acronym"}],
                    ["ABB robot"],
                ),
                {"abb": {"text": "ABB", "mode": "characters", "value": ""}},
            )


class PrepareVoiceLanguageTests(unittest.TestCase):
    def setUp(self) -> None:
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(mock.patch.dict(os.environ, {
            "TTS_LLM_PRONUNCIATION": "true",
            "TTS_ENABLE_SSML": "true",
            "TTS_ALLOW_TEXT_SUBSTITUTION": "false",
        }))
        stack.enter_context(mock.patch.object(prepare_voice, "_TTS_TEXT_CACHE", {}))
        stack.enter_context(mock.patch.object(prepare_voice, "_TTS_TERM_SPECS", {}))
        stack.enter_context(mock.patch.object(prepare_voice, "_TTS_TEXT_CACHE_PATH", None))
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.model = stack.enter_context(mock.patch.object(
            prepare_voice, "call_qwen", side_effect=AssertionError("Unexpected pronunciation request")
        ))

    def test_english_narration_reaches_tts_without_per_word_pronunciation(self) -> None:
        text = "Four seconds for cell tending. How are vertical machining centres designed?"
        prepare_voice.prepare_tts_term_readings([text])
        self.assertEqual(prepare_voice.tts_request_text(text), (text, text, False))
        self.model.assert_not_called()

    def test_english_does_not_require_llm_or_ssml_and_ignores_old_readings(self) -> None:
        text = "The Robot moves a part to the CNC machine."
        prepare_voice._TTS_TEXT_CACHE[text] = "过期的中文读法"
        prepare_voice._TTS_TERM_SPECS["robot"] = {
            "text": "Robot", "mode": "characters", "value": "",
        }
        with mock.patch.object(prepare_voice, "call_qwen", None):
            for enabled in ("true", "false"):
                with self.subTest(pronunciation=enabled), mock.patch.dict(os.environ, {
                    "TTS_LLM_PRONUNCIATION": enabled,
                    "TTS_ENABLE_SSML": "false",
                }):
                    prepare_voice.prepare_tts_term_readings([text])
                    self.assertEqual(prepare_voice.tts_request_text(text), (text, text, False))

    def test_mixed_language_shots_only_prepare_terms_in_chinese_narration(self) -> None:
        chinese = "工厂内，Robot 正在搬运工件。"
        english = "The Robot moves a part in four seconds."
        self.model.side_effect = None
        self.model.return_value = {"readings": [{
            "text": "Robot", "mode": "phoneme_cmu", "value": "R OW1 B AA0 T",
        }]}

        prepare_voice.prepare_tts_term_readings([english, chinese, "车间开始生产。"])
        self.model.assert_called_once()
        payload = json.loads(self.model.call_args.args[0][1]["content"])
        self.assertEqual(payload["english_terms"], [{"text": "Robot", "kind": "term"}])
        self.assertEqual(payload["context_samples"], [chinese])
        spoken, ssml, enabled = prepare_voice.tts_request_text(chinese)
        self.assertEqual(spoken, chinese)
        self.assertTrue(enabled)
        self.assertIn('<phoneme alphabet="cmu" ph="R OW1 B AA0 T">Robot</phoneme>', ssml)
        self.assertEqual(prepare_voice.tts_request_text(english), (english, english, False))
        self.model.assert_called_once()

    def test_missing_chinese_term_reading_still_reports_a_failure(self) -> None:
        self.model.side_effect = None
        self.model.return_value = {"readings": []}
        with self.assertRaisesRegex(SystemExit, "TTS 术语读法未确认: Robot"):
            prepare_voice.prepare_tts_term_readings(["工厂内，Robot 正在搬运工件。"])
        self.assertEqual(self.model.call_count, 3)

    def test_english_sentence_mode_passes_each_sentence_directly_to_tts(self) -> None:
        sentences = ["How does the robot move a part?", "Watch the next four seconds!"]
        text = " ".join(sentences)
        prepare_voice.prepare_tts_term_readings([text])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "voice.mp3"
            with (
                mock.patch.dict(os.environ, {"TTS_SENTENCE_GAP": "0"}),
                mock.patch.object(prepare_voice, "synthesize") as synthesize,
                mock.patch.object(prepare_voice, "audio_duration_seconds", return_value=4.0),
                mock.patch.object(prepare_voice, "standard_cues_for_span", return_value=[]),
                mock.patch.object(prepare_voice, "ffmpeg_concat_mp3") as concat,
            ):
                duration, cues = prepare_voice.synthesize_sentence_mode(text, output, root, 1)

            parts = [root / f"0001_{index:02d}.mp3" for index in (1, 2)]
            self.assertEqual(synthesize.call_args_list, [
                mock.call(sentence, part, enable_ssml=False)
                for sentence, part in zip(sentences, parts)
            ])
            concat.assert_called_once_with(parts, output)
            self.assertEqual(duration, 8.0)
            self.assertEqual([cue["text"] for cue in cues], sentences)
            self.assertEqual([(cue["start"], cue["end"]) for cue in cues], [(0.0, 4.0), (4.0, 8.0)])
            self.model.assert_not_called()

    def test_six_english_shots_pass_voice_preparation_and_preserve_subtitles(self) -> None:
        texts = [
            "Four seconds for cell tending.",
            "How does the robot move a part?",
            "Vertical machining centres are ready.",
            "Choose a single or dual gripper design.",
            "The shop keeps production running.",
            "Start your next automation project.",
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shots_path = root / "shots.json"
            voice_dir = root / "voice"
            shots_path.write_text(json.dumps({"shots": [
                {"title": f"Shot {index}", "voice_text": text, "voiceover": True, "subtitle": text}
                for index, text in enumerate(texts, 1)
            ]}), encoding="utf-8")

            def fake_synthesize(text, output, *, enable_ssml=False):
                self.assertIn(text, texts)
                self.assertFalse(enable_ssml)
                output.write_bytes(b"test-audio" * 200)

            def fake_align(audio, text, **kwargs):
                self.assertEqual(kwargs["spoken_text"], text)
                return [{"text": text, "start": 0.0, "end": 4.0}], {}

            with (
                mock.patch.object(sys, "argv", [
                    "prepare_voice.py", "--shots-json", str(shots_path), "--voice-dir", str(voice_dir),
                ]),
                mock.patch.dict(os.environ, {"TTS_SENTENCE_MODE": "false"}),
                mock.patch.object(prepare_voice, "load_dotenv"),
                mock.patch.object(prepare_voice, "synthesize", side_effect=fake_synthesize) as synthesize,
                mock.patch.object(prepare_voice, "audio_duration_seconds", return_value=4.0),
                mock.patch.object(prepare_voice, "align_voice_to_subtitle", side_effect=fake_align),
            ):
                prepare_voice.main()

            self.assertEqual(synthesize.call_count, len(texts))
            self.model.assert_not_called()
            result = json.loads(shots_path.read_text(encoding="utf-8"))
            for index, (shot, text) in enumerate(zip(result["shots"], texts), 1):
                self.assertEqual(shot["voice_text"], text)
                self.assertEqual(shot["subtitle"], text)
                self.assertEqual(shot["subtitle_cues"][0]["text"], text)
                self.assertEqual(shot["duration"], 5)
                self.assertEqual((voice_dir / f"{index:04d}_voice.tts.txt").read_text(encoding="utf-8"), text)


if __name__ == "__main__":
    unittest.main()
