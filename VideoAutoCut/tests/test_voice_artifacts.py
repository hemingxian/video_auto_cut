from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import prepare_voice
from shot_plan_schema import normalize_shot_plan


class VoiceArtifactTests(unittest.TestCase):
    def test_normalization_preserves_prepared_voice_and_its_timeline(self):
        shot = {
            "shot_id": "voice-shot",
            "title": "口播",
            "voice_text": "保持音频和字幕对应。",
            "voice_audio": r"D:\任务\voice\0001_voice.mp3",
            "subtitle_cues_file": r"D:\任务\voice\0001_cues.json",
            "subtitle_cues": [{"text": "保持音频和字幕对应", "start": 0.1, "end": 2.4}],
            "duration": 3,
        }
        normalized = normalize_shot_plan({"shots": [shot]})
        for key in ("voice_audio", "subtitle_cues_file", "subtitle_cues", "duration"):
            self.assertEqual(normalized["shots"][0][key], shot[key])
        self.assertEqual(normalize_shot_plan(normalized), normalized)

    def test_prepare_voice_persists_the_same_audio_and_cues_after_schema_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan_path = root / "shots.json"
            voice_dir = root / "voice"
            plan_path.write_text(json.dumps({"script_source": {"template": "VAC-SB-1"}, "shots": [{"shot_id": "s", "title": "口播", "voice_text": "实际口播", "subtitle": "摘要", "duration": 9, "script_meta": {"review": ["w"]}, "render_hints": {"caption_source": "subtitle"}}]}), encoding="utf-8")
            cues = [{"text": "实际口播", "start": 0.1, "end": 2.4}]

            def synthesize(text, output, sentence_root, index):
                # A unit-test TTS boundary; no model request or playable-video claim.
                self.assertEqual(text, "实际口播")
                output.write_bytes(b"unit-test-audio" * 200)
                return 2.5, cues

            with mock.patch.object(sys, "argv", ["prepare_voice", "--shots-json", str(plan_path), "--voice-dir", str(voice_dir)]), \
                    mock.patch.object(prepare_voice, "load_dotenv"), \
                    mock.patch.object(prepare_voice, "load_tts_text_cache"), \
                    mock.patch.object(prepare_voice, "prepare_tts_term_readings"), \
                    mock.patch.object(prepare_voice, "tts_env_bool", return_value=True), \
                    mock.patch.object(prepare_voice, "synthesize_sentence_mode", side_effect=synthesize), \
                    contextlib.redirect_stdout(io.StringIO()):
                prepare_voice.main()
            shot = json.loads(plan_path.read_text(encoding="utf-8"))["shots"][0]
            self.assertEqual(Path(shot["voice_audio"]), voice_dir / "0001_voice.mp3")
            self.assertGreater(Path(shot["voice_audio"]).stat().st_size, 1024)
            self.assertEqual(json.loads(Path(shot["subtitle_cues_file"]).read_text(encoding="utf-8")), cues)
            self.assertEqual(shot["subtitle_cues"], cues)
            self.assertEqual(shot["duration"], 3)
            self.assertEqual(shot["subtitle"], "摘要")
            saved = json.loads(plan_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["script_source"], {"template": "VAC-SB-1"})
            self.assertEqual(shot["script_meta"], {"review": ["w"]})
            self.assertEqual(shot["render_hints"], {"caption_source": "subtitle"})

    def test_disabling_voice_removes_all_stale_voice_references(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan_path = root / "shots.json"
            plan_path.write_text(json.dumps({"shots": [{"shot_id": "s", "title": "静音", "voice_text": "old", "voice_audio": "old.mp3", "subtitle_cues_file": "old.json", "subtitle_cues": [{"text": "old", "start": 0, "end": 1}]}]}), encoding="utf-8")
            with mock.patch.object(sys, "argv", ["prepare_voice", "--shots-json", str(plan_path), "--voice-dir", str(root / "voice"), "--no-voiceover"]), \
                    mock.patch.object(prepare_voice, "load_dotenv"), \
                    mock.patch.object(prepare_voice, "load_tts_text_cache"), \
                    mock.patch.object(prepare_voice, "synthesize_sentence_mode") as synthesize, \
                    contextlib.redirect_stdout(io.StringIO()):
                prepare_voice.main()
            synthesize.assert_not_called()
            shot = json.loads(plan_path.read_text(encoding="utf-8"))["shots"][0]
            for key in ("voice_audio", "subtitle_cues_file", "subtitle_cues"):
                self.assertNotIn(key, shot)


if __name__ == "__main__":
    unittest.main()
