import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import subtitle_safe_area as safe
import render_segment
import output_format


def review(boxes=()):
    return {"uncertain": False, "frames": [{"frame_index": index, "regions": [
        {"kind": "subject", "box": box, "confidence": 0.95} for box in boxes]} for index in range(3)]}


class SubtitleSafeAreaTests(unittest.TestCase):
    def test_fixed_position_avoids_union_of_protected_regions_and_stays_in_lower_half(self):
        regions = safe.validate_regions(review([[0.2, 0.77, 0.6, 0.2]]), 3)
        chosen = safe.choose_position(regions, (0, 0, 1920, 1080), 1500, 180, 76, 9)
        self.assertIsNotNone(chosen)
        self.assertLessEqual(chosen['y'], 0.77 * 1080 - 9)
        self.assertGreaterEqual(chosen['box'][1], 540)
        self.assertLessEqual(chosen['y'], 1080 - 76 - 9)
        self.assertIsNone(safe.choose_position(safe.validate_regions(review([[0, 0.5, 1, 0.5]]), 3),
                                             (0, 0, 1920, 1080), 1500, 180, 76, 9))
        narrow = safe.choose_position([], (600, 0, 720, 1080), 1500, 180, 0, 9)
        self.assertGreaterEqual(narrow['box'][0], 600)
        self.assertLessEqual(narrow['box'][0] + narrow['box'][2], 1320)
        self.assertIsNone(safe.choose_position([], (0, 400, 1920, 180), 1500, 180, 76, 9))

    def test_invalid_and_uncertain_results_never_count_as_success(self):
        for result in [{}, {**review(), 'uncertain': True}, {**review(), 'frames': []},
                       review([[0, 0, 2, 1]]), review([[0, float('nan'), 1, 1]])]:
            with self.subTest(result=result), self.assertRaises(ValueError):
                safe.validate_regions(result, 3)
        result = review([[0, 0, 0.2, 0.2]])
        result['frames'][0]['regions'][0]['confidence'] = 0.2
        with self.assertRaises(ValueError):
            safe.validate_regions(result, 3)

    def resolve(self, root, default=(999, 'bottom')):
        return safe.resolve_placement(root / 'clip.mp4', 4, (0, 0, 1920, 1080), default,
                                      1500, 180, 76, 9, root / 'cache', root / 'report.json')

    def test_disabled_and_sufficient_black_border_never_hash_sample_or_call_model(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(safe, 'sample_times') as sample, mock.patch.object(safe, 'source_hash') as digest, \
                mock.patch.object(safe, 'detect_regions') as detect:
            root = Path(directory)
            self.assertIsNone(self.resolve(root))
            os.environ['SUBTITLE_AI_SAFE_AREA'] = 'true'
            self.assertIsNone(self.resolve(root, (805, 'top')))
            self.assertEqual(json.loads((root / 'report.json').read_text(encoding='utf-8'))['status'], 'black_border')
            sample.assert_not_called()
            digest.assert_not_called()
            detect.assert_not_called()

    def test_cache_identity_includes_content_model_sampling_and_prompt_and_validates_cache(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {'SUBTITLE_AI_SAFE_AREA': 'true'}, clear=True), \
                mock.patch.object(safe, 'sample_times', return_value=[0.4, 2, 3.6]) as times, \
                mock.patch.object(safe, 'detect_regions', return_value=review()) as detect:
            root = Path(directory)
            (root / 'clip.mp4').write_bytes(b'first content')
            self.assertIsNotNone(self.resolve(root))
            self.assertIsNotNone(self.resolve(root))
            self.assertEqual(detect.call_count, 1)
            self.assertTrue(json.loads((root / 'report.json').read_text(encoding='utf-8'))['cached'])
            (root / 'clip.mp4').write_bytes(b'changed content')
            self.resolve(root)
            os.environ['DASHSCOPE_VISUAL_REVIEW_MODEL'] = 'other-model'
            self.resolve(root)
            times.return_value = [0.2, 1, 1.8]
            self.resolve(root)
            with mock.patch.object(safe, 'PROMPT', 'new prompt'):
                self.resolve(root)
            self.assertEqual(detect.call_count, 5)
            latest = json.loads((root / 'report.json').read_text(encoding='utf-8'))['cache_key']
            (root / 'cache' / f'{latest}.json').write_text('invalid')
            with mock.patch.object(safe, 'PROMPT', 'new prompt'):
                self.resolve(root)
            self.assertEqual(detect.call_count, 6)

    def test_model_failure_missing_key_or_no_space_returns_default_with_explicit_warning(self):
        for result in [SystemExit('missing key'), ValueError('bad json'), review([[0, 0.5, 1, 0.5]])]:
            with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {'SUBTITLE_AI_SAFE_AREA': 'true'}, clear=True), \
                    mock.patch.object(safe, 'sample_times', return_value=[0.1, 0.5, 0.9]), \
                    mock.patch.object(safe, 'detect_regions', **({'side_effect': result} if isinstance(result, BaseException) else {'return_value': result})), \
                    contextlib.redirect_stdout(io.StringIO()) as logs:
                root = Path(directory)
                (root / 'clip.mp4').write_bytes(b'mock video')
                self.assertIsNone(self.resolve(root))
                self.assertIn('已回到默认字幕位置', logs.getvalue())
                self.assertIn(json.loads((root / 'report.json').read_text(encoding='utf-8'))['status'], ['failed', 'no_space'])
                if isinstance(result, BaseException):
                    self.assertFalse((root / 'cache').exists())

    def test_actual_frame_sampler_passes_images_to_configured_service(self):
        with mock.patch.object(safe, 'find_ffmpeg', return_value='ffmpeg'), \
                mock.patch.object(safe.subprocess, 'run', return_value=mock.Mock(stdout=b'jpeg bytes')) as ffmpeg, \
                mock.patch.object(safe, 'call_qwen', return_value=review()) as model:
            safe.detect_regions(Path('clip.mp4'), [0.1, 0.5, 0.9], 'configured-vl')
            self.assertEqual(ffmpeg.call_count, 3)
            images = [part for part in model.call_args.args[0][0]['content'] if part['type'] == 'image_url']
            self.assertEqual(len(images), 3)
            self.assertTrue(images[0]['image_url']['url'].startswith('data:image/jpeg;base64,'))
            self.assertEqual(model.call_args.kwargs['model'], 'configured-vl')

    def test_ass_uses_selected_position_for_cues_and_plain_text(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {}, clear=True):
            output_format.configure_canvas('', '16:9', '1080p')
            for cues in [None, [{'start': 0, 'end': 1, 'text': 'Chosen subtitle'}]]:
                target = Path(directory) / 'chosen.ass'
                render_segment.write_combined_ass('Chosen subtitle', ['Chapter'], 1, 1, target, enable_progress=False,
                                                  subtitle_cues=cues, subtitle_placement={'y': 720, 'anchor': 'bottom', 'max_width': 900})
                self.assertIn(r'\pos(960,720)', target.read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
