import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import optimize_queries


class QueryResumeTests(unittest.TestCase):
    def test_invalid_model_results_are_corrected_without_changing_source(self):
        shot = {'shot': 7, 'visual_query': '家电金属组件'}
        good = {'download_query': 'CNC automotive parts', 'visual_query': 'machined appliance metal components', 'quality': {'ok': True}}
        invalid_results = [
            {'download_query': 'automotive parts CNC machining', 'visual_query': 'metal part,家电金属组件', 'quality': {'ok': True}},
            {**good, 'quality': {'ok': False, 'issues': ['too broad']}},
            ValueError('invalid JSON'),
        ]
        for invalid in invalid_results:
            with self.subTest(invalid=invalid), mock.patch.object(optimize_queries, 'load_prompt_template', return_value='prompt'), mock.patch.object(optimize_queries, 'call_qwen', side_effect=[invalid, good]) as model:
                result = optimize_queries.optimize_one(shot, 'pexels')
                self.assertEqual(result['visual_query'], good['visual_query'])
                self.assertEqual(model.call_count, 2)
                self.assertIn('未通过校验', model.call_args.args[0][-1]['content'])
                self.assertEqual(shot, {'shot': 7, 'visual_query': '家电金属组件'})

    def test_persistent_invalid_output_stops_after_three_attempts(self):
        with mock.patch.object(optimize_queries, 'load_prompt_template', return_value='prompt'), mock.patch.object(optimize_queries, 'call_qwen', return_value={'download_query': '中文', 'visual_query': 'robot'}) as model:
            with self.assertRaisesRegex(SystemExit, '已尝试 3 次'):
                optimize_queries.optimize_one({'shot': 7}, 'pexels')
            self.assertEqual(model.call_count, 3)

    def test_service_failure_is_not_retried_as_model_correction(self):
        with mock.patch.object(optimize_queries, 'load_prompt_template', return_value='prompt'), mock.patch.object(optimize_queries, 'call_qwen', side_effect=SystemExit('HTTP 401')) as model:
            with self.assertRaisesRegex(SystemExit, 'HTTP 401'):
                optimize_queries.optimize_one({'shot': 7}, 'pexels')
            self.assertEqual(model.call_count, 1)

    def test_interruption_preserves_finished_shots_and_resume_skips_them(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'shots.json'
            target.write_text(json.dumps({'shots': [
                {'shot_id': 'a', 'shot': 1, 'title': 'first', 'script_meta': {'x': [1]}},
                {'shot_id': 'b', 'shot': 2, 'title': 'second', 'render_hints': {'caption_source': 'subtitle'}},
            ], 'script_source': {'template': 'VAC-SB-1'}}), encoding='utf-8')
            args = ['optimize_queries', '--shots-json', str(target), '--source', 'pexels']
            optimized = {'download_query': 'robot', 'visual_query': 'robot arm'}
            with mock.patch.object(sys, 'argv', args), mock.patch.object(optimize_queries, 'load_dotenv'), mock.patch.object(
                optimize_queries, 'optimize_one', side_effect=[optimized, SystemExit('interrupted')]
            ):
                with self.assertRaisesRegex(SystemExit, 'interrupted'):
                    optimize_queries.main()
            saved = json.loads(target.read_text(encoding='utf-8'))
            self.assertEqual(saved['script_source'], {'template': 'VAC-SB-1'})
            self.assertEqual(saved['shots'][0]['script_meta'], {'x': [1]})
            self.assertEqual(saved['shots'][1]['render_hints'], {'caption_source': 'subtitle'})
            self.assertTrue(saved['shots'][0]['query_optimized'])
            self.assertFalse(saved['shots'][1].get('query_optimized', False))
            with mock.patch.object(sys, 'argv', args), mock.patch.object(optimize_queries, 'load_dotenv'), mock.patch.object(
                optimize_queries, 'optimize_one', return_value=optimized
            ) as model:
                optimize_queries.main()
                self.assertEqual(model.call_count, 1)
                self.assertEqual(model.call_args.args[0]['shot_id'], 'b')
            saved = json.loads(target.read_text(encoding='utf-8'))
            self.assertEqual(saved['script_source'], {'template': 'VAC-SB-1'})
            self.assertEqual(saved['shots'][0]['script_meta'], {'x': [1]})
            self.assertEqual(saved['shots'][1]['render_hints'], {'caption_source': 'subtitle'})


if __name__ == '__main__':
    unittest.main()
