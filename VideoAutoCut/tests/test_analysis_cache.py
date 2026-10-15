"""Offline media integration: real FFmpeg, counted embeddings, no provider calls."""
from concurrent.futures import ThreadPoolExecutor
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sentrysearch"))
from sentrysearch import analysis_cache as cache, chunker


class MemoryStore:
    def __init__(self):
        self.rows = {}

    def make_chunk_id(self, path, start):
        return f"{path}:{start}"

    def remove_file(self, path):
        self.rows = {k: v for k, v in self.rows.items() if v["metadata"]["source_file"] != path}

    def add_chunk(self, key, vector, metadata):
        self.rows[key] = {"embedding": vector, "metadata": metadata}

    def set_analysis_provenance(self, path, proof):
        for row in self.rows.values():
            if row["metadata"]["source_file"] == path:
                row["metadata"]["analysis_provenance"] = proof

    def cache_records(self, key):
        result = []
        for row in self.rows.values():
            meta = row["metadata"]
            if meta.get("analysis_key") == key:
                record = cache.receipt(meta["start_time"], meta["end_time"], row["embedding"])
                if record["sha256"] == meta.get("analysis_receipt_sha256"):
                    result.append({"index": meta["analysis_chunk_index"], "receipt": record})
        return result


@unittest.skipUnless(shutil.which("ffmpeg"), "real FFmpeg is required")
class ContentAnalysisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media_dir = tempfile.TemporaryDirectory()
        cls.source = Path(cls.media_dir.name) / "motion.mp4"
        subprocess.run([shutil.which("ffmpeg"), "-y", "-f", "lavfi", "-i", "testsrc2=size=192x108:rate=12:duration=2.2",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(cls.source)], capture_output=True, check=True, timeout=30)
        cls.base_profile = cache.build_profile("qwen-cloud", "qwen3-vl-embedding", 30, 5, True, 48, 5, False)

    @classmethod
    def tearDownClass(cls):
        cls.media_dir.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / "original.mp4"
        shutil.copyfile(self.source, self.path)
        self.profile = copy.deepcopy(self.base_profile)
        self.store = MemoryStore()
        self.calls = []
        self.events = []

    def embed(self, path):
        self.assertGreater(Path(path).stat().st_size, 0)
        self.calls.append(path)
        return [0.1, 0.2, 0.3] + [0.0] * 765

    def analyze(self, path=None, profile=None, embed=None, store=None):
        return cache.analyze_file(str(path or self.path), profile or self.profile, store or self.store,
                                  embed or self.embed, cache_root=self.root / "cache", log=lambda _: None,
                                  progress=lambda **event: self.events.append(event))

    def alias(self, name):
        directory = self.root / name
        directory.mkdir()
        path = directory / "bound.mp4"
        subprocess.run([shutil.which("ffmpeg"), "-y", "-i", str(self.path), "-vf", "scale=160:90,fps=30",
                        "-c:v", "libx264", str(path)], capture_output=True, check=True, timeout=30)
        cache.atomic_json(str(path) + ".source.json", {
            "schema_version": 1, "source_path": str(self.path.resolve()),
            "source_sha256": cache.file_sha256(self.path), "source_size": self.path.stat().st_size,
            "normalized_sha256": cache.file_sha256(path), "normalized_size": path.stat().st_size,
            "normalization_profile": {"contract": "h264-index-normalization-v1", "encoder": "cpu",
                                      "ffmpeg_sha256": "test", "ffmpeg_arguments": ["scale=160:90,fps=30"]},
            "time_mapping": "identity",
        })
        return path

    def test_original_and_two_normalized_shots_embed_once(self):
        first = self.analyze()
        a, b = self.alias("shot1"), self.alias("shot2")
        self.assertNotEqual(cache.file_sha256(a), cache.file_sha256(self.path))
        self.assertEqual(self.analyze(a)["key"], first["key"])
        self.assertEqual(self.analyze(b)["key"], first["key"])
        self.assertEqual(len(self.calls), 1)
        paths = {row["metadata"]["source_file"] for row in self.store.rows.values()}
        self.assertEqual(paths, {str(self.path), str(a), str(b)})
        self.assertEqual(self.events[-1]["completed_chunks"], 1)
        self.assertEqual(self.events[-1]["cached_chunks"], 1)

    def test_profile_model_and_replaced_content_invalidate(self):
        self.analyze()
        self.analyze(profile={**self.profile, "target_fps": 3})
        self.analyze(profile={**self.profile, "model": "changed-model"})
        self.path.write_bytes(self.path.read_bytes() + b"new-container-content")
        self.analyze()
        self.assertEqual(len(self.calls), 4)
        self.assertEqual(len(self.store.rows), 1)

    def test_corrupt_receipt_recomputes_instead_of_mounting(self):
        result = self.analyze()
        target = self.root / "cache" / result["key"] / "manifest.json"
        manifest = json.loads(target.read_text())
        manifest["chunks"]["0"]["embedding"][0] = 0.99
        cache.atomic_json(target, manifest)
        self.analyze()
        self.assertEqual(len(self.calls), 2)

    def test_broken_manifest_recovers_verified_store_but_not_legacy_rows(self):
        result = self.analyze()
        target = self.root / "cache" / result["key"] / "manifest.json"
        target.write_text("broken", encoding="utf-8")
        self.analyze()
        self.assertEqual(len(self.calls), 1)
        target.write_text("broken", encoding="utf-8")
        for row in self.store.rows.values():
            row["metadata"].pop("analysis_key")
        self.analyze()
        self.assertEqual(len(self.calls), 2)

    def test_partial_failure_resumes_only_missing_chunks(self):
        profile = {**self.profile, "chunk_duration": 1, "overlap": 0}
        def fail_second(path):
            if len(self.calls) == 1:
                raise TimeoutError("mock request timeout")
            return self.embed(path)
        with self.assertRaisesRegex(TimeoutError, "mock request timeout"):
            self.analyze(profile=profile, embed=fail_second)
        manifest_path = next((self.root / "cache").glob("*/manifest.json"))
        manifest = json.loads(manifest_path.read_text())
        self.assertFalse(manifest["complete"])
        self.assertEqual(len(manifest["chunks"]), 1)
        result = self.analyze(profile=profile)
        self.assertEqual(result["hits"], 1)
        self.assertEqual(len(self.calls), len(manifest["spans"]))

    def test_preprocess_failure_is_not_certified(self):
        with patch.object(chunker, "preprocess_chunk", side_effect=subprocess.TimeoutExpired("ffmpeg", 1)):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.analyze()
        self.assertEqual(self.calls, [])
        manifest = json.loads(next((self.root / "cache").glob("*/manifest.json")).read_text())
        self.assertFalse(manifest["complete"])
        self.assertEqual(manifest["chunks"], {})
        self.analyze()
        self.assertEqual(len(self.calls), 1)

    def test_input_changed_during_request_cannot_leave_reusable_receipts(self):
        def mutate(path):
            vector = self.embed(path)
            self.path.write_bytes(self.path.read_bytes() + b"changed-during-request")
            return vector
        with self.assertRaisesRegex(RuntimeError, "changed during analysis"):
            self.analyze(embed=mutate)
        manifest = json.loads(next((self.root / "cache").glob("*/manifest.json")).read_text())
        self.assertFalse(manifest["complete"])
        self.assertEqual(manifest["chunks"], {})
        self.assertEqual(self.store.rows, {})

    def test_still_receipt_skips_repeated_processing(self):
        profile = {**self.profile, "skip_still": True}
        with patch.object(chunker, "is_still_frame_chunk", return_value=True) as detector:
            self.analyze(profile=profile)
            self.analyze(profile=profile)
        self.assertEqual(detector.call_count, 1)
        self.assertEqual(len(self.calls), 0)
        self.assertEqual(len(self.store.rows), 0)

    def test_concurrent_identical_files_embed_once(self):
        other = self.root / "other.mp4"
        shutil.copyfile(self.path, other)
        def slow_embed(path):
            time.sleep(0.1)
            return self.embed(path)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.analyze, path, None, slow_embed) for path in (self.path, other)]
            for future in futures:
                future.result(timeout=30)
        self.assertEqual(len(self.calls), 1)

    def test_export_proof_seeds_another_task_and_rejects_wrong_source(self):
        result = self.analyze()
        manifest = json.loads((self.root / "cache" / result["key"] / "manifest.json").read_text())
        proof = cache.provenance(manifest)
        chunks = [{"start_ms": round(row["start_time"] * 1000), "end_ms": round(row["end_time"] * 1000),
                   "embedding": row["embedding"]} for row in manifest["chunks"].values()]
        imported = cache.manifest_from_export(str(self.path), chunks, proof, "qwen-cloud", self.profile["model"])
        cache.seed_manifest(imported, self.root / "cloud-cache")
        fresh = MemoryStore()
        cache.analyze_file(str(self.alias("new-task")), self.profile, fresh, self.embed,
                           cache_root=self.root / "cloud-cache", log=lambda _: None)
        self.assertEqual(len(self.calls), 1)
        proof["source_identity"]["source_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "actual source content"):
            cache.manifest_from_export(str(self.path), chunks, proof, "qwen-cloud", self.profile["model"])

    def test_unverified_sidecar_cannot_claim_original_identity(self):
        self.analyze()
        alias = self.alias("bad-sidecar")
        sidecar = Path(str(alias) + ".source.json")
        data = json.loads(sidecar.read_text())
        data["source_sha256"] = "0" * 64
        cache.atomic_json(sidecar, data)
        self.analyze(alias)
        self.assertEqual(len(self.calls), 2)

    @unittest.skipUnless(importlib.util.find_spec("chromadb"), "Chroma integration uses the packaged Python runtime")
    def test_real_chroma_alias_queries_remain_strictly_scoped(self):
        from sentrysearch.store import SentryStore
        store = SentryStore(self.root / "db", backend="qwen-cloud", model=self.profile["model"])
        self.addCleanup(store._client._system.stop)
        original = self.analyze(store=store)
        a, b = self.alias("shot1"), self.alias("shot2")
        self.analyze(a, store=store)
        self.analyze(b, store=store)
        self.assertEqual(len(self.calls), 1)
        vector = [0.1, 0.2, 0.3] + [0.0] * 765
        for path in (a, b):
            results = store.search(vector, n_results=20, allowed_source_files=[str(path)])
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]["source_file"], str(path))
        self.assertEqual(store.search(vector, allowed_source_files=[]), [])
        # A new worker can recover float32 DB vectors after a torn cache file.
        (self.root / "cache" / original["key"] / "manifest.json").write_text("broken")
        self.analyze(a, store=store)
        self.assertEqual(len(self.calls), 1)

    @unittest.skipUnless(importlib.util.find_spec("chromadb"), "CLI integration uses the packaged Python runtime")
    def test_real_cli_index_export_import_and_cloud_reuse(self):
        from click.testing import CliRunner
        from sentrysearch.cli import cli
        from sentrysearch import embedder as provider, store as storage
        runner = CliRunner()
        fake = type("CountedEmbedder", (), {"embed_video_chunk": lambda _, path, **kw: self.embed(path)})()
        args = ["--backend", "qwen-cloud", "--no-skip-still", "--target-resolution", "48", "--target-fps", "5"]
        with patch.dict(os.environ, {"VIDEOAUTO_DATA_ROOT": str(self.root / "data")}), \
                patch.object(storage, "DEFAULT_DB_PATH", self.root / "cli-db"), \
                patch.object(provider, "get_embedder", return_value=fake) as factory, \
                patch.object(provider, "reset_embedder"):
            indexed = runner.invoke(cli, ["index", str(self.path), *args])
            self.assertEqual(indexed.exit_code, 0, indexed.output)
            self.assertIn('"phase":"complete"', indexed.output)
            exported = runner.invoke(cli, ["export-analysis", str(self.path)])
            self.assertEqual(exported.exit_code, 0, exported.output)
            payload = json.loads(exported.output)
            self.assertIn("analysis_provenance", payload)
            backup = self.root / "cloud.json"
            cache.atomic_json(backup, payload)
            alias = self.alias("cloud-task")
            imported = runner.invoke(cli, ["import-analysis", str(alias), str(backup)])
            self.assertEqual(imported.exit_code, 0, imported.output)
            resumed = runner.invoke(cli, ["index", str(alias), *args])
            self.assertEqual(resumed.exit_code, 0, resumed.output)
            self.assertIn("1 cache hits", resumed.output)
            self.assertEqual(len(self.calls), 1)
            self.assertEqual(factory.call_count, 1, "cache hit must not initialize a model")
            # Authenticated but legacy payloads remain readable at their path;
            # no compatibility claim is invented from a model name alone.
            payload.pop("analysis_provenance")
            cache.atomic_json(backup, payload)
            legacy = runner.invoke(cli, ["import-analysis", str(alias), str(backup)])
            self.assertEqual(legacy.exit_code, 0, legacy.output)
            self.assertIn("proof missing", legacy.output)
            db = storage.SentryStore(backend="qwen-cloud", model=self.profile["model"])
            self.addCleanup(db._client._system.stop)


if __name__ == "__main__":
    unittest.main()
