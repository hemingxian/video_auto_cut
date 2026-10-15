import ast
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / 'tools'
sys.path.insert(0, str(TOOLS))
import material_selection_policy as policy


class CandidatePolicyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.clips = self.root / 'clips'
        self.clips.mkdir()
        self.paths = [self.clips / f'clip_{i}.mp4' for i in range(3)]
        for path in self.paths:
            path.write_bytes(b'test media bytes')
        self.request = {'clip_root': str(self.clips), 'cache_root': str(self.root / 'cache'),
                        'paths': [str(path) for path in self.paths], 'count': 1}

    def review(self, **values):
        return {'has_subtitles': False, 'has_logo': False, 'has_watermark': False,
                'uncertain': False, 'reason': 'sample inspected', **values}

    def test_disabled_policy_does_not_call_model(self):
        def fail(*args):
            raise AssertionError('disabled policy called model')
        result = policy.choose_candidates(self.request, fail)
        self.assertEqual(result['paths'], [str(self.paths[0])])

    def test_rejects_logo_uncertainty_then_selects_next_actual_candidate(self):
        responses = iter([self.review(has_logo=True), self.review(uncertain=True), self.review()])
        result = policy.choose_candidates({**self.request, 'exclude_overlays': True},
                                          lambda *_: {'review': next(responses)})
        self.assertEqual(result['paths'], [str(self.paths[2])])
        self.assertEqual(len(result['rejected']), 2)

    def test_failed_inspection_is_not_clean_and_does_not_randomize_without_opt_in(self):
        def fail(*args):
            raise SystemExit('HTTP 502')
        result = policy.choose_candidates({**self.request, 'exclude_overlays': True}, fail)
        self.assertFalse(result['ok'])
        self.assertIsNone(result['fallback'])
        self.assertTrue(all(item['inspection_failed'] for item in result['rejected']))

    def test_outside_scope_and_directory_are_rejected(self):
        outside = self.root / 'outside.mp4'
        outside.write_bytes(b'outside')
        for path in [outside, self.clips]:
            with self.assertRaises(ValueError):
                policy.choose_candidates({**self.request, 'paths': [str(path)]})

    def test_empty_bound_scope_is_not_randomly_expanded(self):
        bound = self.root / 'bound'
        bound.mkdir()
        result = policy.choose_candidates({**self.request, 'paths': [], 'random_bound_fallback': True,
                                          'bound_root': str(bound), 'shot_id': 'shot_a'})
        self.assertFalse(result['ok'])
        self.assertEqual(result['paths'], [])

    def test_malformed_review_cannot_be_treated_as_no_logo(self):
        for value in [{}, self.review(has_logo='false'), self.review(uncertain=None)]:
            self.assertFalse(policy.clean_review(value))

    def test_samples_cover_ends_and_bound_request_size(self):
        for length in [.1, 7, 30, 120]:
            times = policy.inspection_times(length)
            self.assertEqual(times[0], 0)
            self.assertLess(times[-1], length)
            self.assertGreater(times[-1], length - .1)
            self.assertLessEqual(len(times), 12)

    def test_cached_visual_result_is_bound_to_media_content_and_model(self):
        cache = self.root / 'cache'
        review_calls = []
        def review(*args, **kwargs):
            review_calls.append(kwargs['model'])
            return self.review()
        fake_run = types.SimpleNamespace(stdout=b'jpeg' * 100)
        with patch.object(policy, 'duration', return_value=2), patch.object(policy, 'find_ffmpeg', return_value='ffmpeg'), patch.object(policy.subprocess, 'run', return_value=fake_run):
            policy.inspect_clip(self.paths[0], cache, 'model_a', review)
            self.assertTrue(policy.inspect_clip(self.paths[0], cache, 'model_a', review)['cached'])
            self.paths[0].write_bytes(b'changed content')
            policy.inspect_clip(self.paths[0], cache, 'model_a', review)
            policy.inspect_clip(self.paths[0], cache, 'model_b', review)
        self.assertEqual(review_calls, ['model_a', 'model_a', 'model_b'])


class StrictSearchTests(unittest.TestCase):
    def run_search_branch(self, *, total_chunks=0, detected=(None, None), embed_error=None):
        # Run the real search callback body; only the optional embedding/store
        # dependencies are substituted, so no account or model is contacted.
        source = TOOLS.parent / 'sentrysearch/sentrysearch/cli.py'
        tree = ast.parse(source.read_text(encoding='utf-8'))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'search')
        function.decorator_list = []
        class Click:
            @staticmethod
            def echo(value): print(value)
            @staticmethod
            def secho(value, **_): print(value)
        def propagate(error):
            raise error
        namespace = {'os': os, 'click': Click, '__name__': 'sentrysearch.cli', '__package__': 'sentrysearch',
                     '_reject_conflicting_model_flags': lambda *_: None, '_handle_error': propagate}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
        def embed(*_, **__):
            if embed_error:
                raise embed_error
            raise AssertionError('empty index must not initialize an embedding model')
        modules = {}
        for name, attributes in {
            'embedder': {'get_embedder': embed, 'reset_embedder': lambda: None},
            'local_embedder': {'normalize_model_key': lambda value: value},
            'search': {'search_footage': lambda *_, **__: self.fail('unexpected search')},
            'store': {'SentryStore': lambda **_: types.SimpleNamespace(get_stats=lambda: {'total_chunks': total_chunks}),
                      'detect_index': lambda: detected},
        }.items():
            module = types.ModuleType(f'sentrysearch.{name}')
            module.__dict__.update(attributes)
            modules[module.__name__] = module
        output = io.StringIO()
        with patch.dict(sys.modules, modules), redirect_stdout(output):
            namespace['search']('query', 5, '/tmp', True, 1, '/tmp', .6, False,
                                'qwen-cloud', 'test-model', None, None, None, False, False)
        return output.getvalue()

    def test_empty_index_search_reports_empty_clip_protocol_without_model(self):
        output = self.run_search_branch()
        records = [json.loads(line.removeprefix('VACUT_CLIPS:')) for line in output.splitlines() if line.startswith('VACUT_CLIPS:')]
        self.assertEqual(records, [{'schema_version': 1, 'paths': []}])

    def test_different_model_and_backend_are_not_normal_empty_matches(self):
        for detected in [('qwen-cloud', 'other-model'), ('gemini', 'other-model')]:
            self.assertNotIn('VACUT_CLIPS:', self.run_search_branch(detected=detected))

    def test_embedding_network_error_is_not_swallowed_as_empty_match(self):
        with self.assertRaisesRegex(RuntimeError, 'HTTP 502'):
            self.run_search_branch(total_chunks=1, embed_error=RuntimeError('HTTP 502'))

    def test_engine_threshold_filters_before_trimming_and_reports_empty_paths(self):
        # Compile the actual output function without importing heavyweight embedding backends.
        source = TOOLS.parent / 'sentrysearch/sentrysearch/cli.py'
        tree = ast.parse(source.read_text(encoding='utf-8'))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                        and any(isinstance(n, ast.Constant) and n.value == 'VIDEOAUTO_MIN_MATCH_SCORE' for n in ast.walk(node)))
        import math
        class Click:
            ClickException = ValueError
            @staticmethod
            def echo(value): print(value)
            @staticmethod
            def secho(value, **_): print(value)
        namespace = {'os': os, 'math': math, 'json': json, 'click': Click, '__name__': 'sentrysearch.cli', '__package__': 'sentrysearch',
                     '_fmt_time': str, '_cache_last_clip': lambda *_: None}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
        trim_calls = []
        trimmer = types.ModuleType('sentrysearch.trimmer')
        trimmer.trim_top_results = lambda results, _output, count: trim_calls.append([r['similarity_score'] for r in results]) or ['/tmp/accepted.mp4']
        results = [{'source_file': '/tmp/asset.mp4', 'start_time': 0, 'end_time': 4, 'similarity_score': score} for score in [.60001, .59999, .1]]
        output = io.StringIO()
        with patch.dict(os.environ, {'VIDEOAUTO_MIN_MATCH_SCORE': '0.6'}), patch.dict(sys.modules, {'sentrysearch.trimmer': trimmer}), redirect_stdout(output):
            namespace[function.name](results, 0, False, 3, '/tmp', False, False, True)
            namespace[function.name](results[1:], 0, False, 3, '/tmp', False, False, True)
        self.assertEqual(trim_calls, [[.60001]])
        self.assertIn('"paths":[]', output.getvalue())


if __name__ == '__main__':
    unittest.main()
