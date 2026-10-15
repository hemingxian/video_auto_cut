from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

SENTRYSEARCH_DIR = Path(__file__).resolve().parents[1] / "sentrysearch"
sys.path.insert(0, str(SENTRYSEARCH_DIR))


def _load_sentry_store():
    """Load the real store when Chroma is installed, without leaking a test double."""
    try:
        import chromadb  # noqa: F401
    except ModuleNotFoundError as error:
        if error.name != "chromadb":
            raise
        store_path = Path(__file__).resolve().parents[1] / "sentrysearch" / "sentrysearch" / "store.py"
        spec = importlib.util.spec_from_file_location("_test_sentry_store_without_chromadb", store_path)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load sentrysearch store from {store_path}")
        module = importlib.util.module_from_spec(spec)
        fake = types.SimpleNamespace(Collection=object)
        with mock.patch.dict(sys.modules, {"chromadb": fake}):
            spec.loader.exec_module(module)
        return module.SentryStore

    from sentrysearch.store import SentryStore
    return SentryStore


SentryStore = _load_sentry_store()


class FakeCollection:
    def __init__(self):
        self.deleted = []
        self.upserts = []

    def get(self, **_kwargs):
        return {
            "ids": ["chunk_late", "chunk_early"],
            "metadatas": [
                {"source_file": "private", "start_time": 1.5, "end_time": 2.5},
                {"source_file": "private", "start_time": 0.0, "end_time": 1.0},
            ],
            "embeddings": [[0.2, 0.3], [0.0, 0.1]],
        }

    def delete(self, *, ids):
        self.deleted.extend(ids)

    def upsert(self, **kwargs):
        self.upserts.append(kwargs)


class SentryStoreExportTests(unittest.TestCase):
    def test_export_file_chunks_orders_ranges_and_does_not_return_local_path(self):
        store = object.__new__(SentryStore)
        store._collection = FakeCollection()

        with mock.patch.object(os.path, "abspath", return_value="C:/private/video.mp4"):
            chunks = store.export_file_chunks("video.mp4")

        self.assertEqual([chunk["chunk_id"] for chunk in chunks], ["chunk_early", "chunk_late"])
        self.assertEqual(chunks[0]["start_ms"], 0)
        self.assertEqual(chunks[1]["end_ms"], 2500)
        self.assertTrue(all("source_file" not in chunk for chunk in chunks))

    def test_import_file_chunks_rekeys_cloud_chunks_for_the_current_local_path(self):
        store = object.__new__(SentryStore)
        collection = FakeCollection()
        store._collection = collection

        with mock.patch.object(os.path, "abspath", return_value="C:/restored/video.mp4"):
            imported = store.import_file_chunks("video.mp4", [{
                "chunk_id": "remote_chunk",
                "start_ms": 0,
                "end_ms": 1000,
                "caption": "工业机械臂",
                "embedding": [0.1, 0.2],
            }])

        self.assertEqual(imported, 1)
        self.assertEqual(collection.deleted, ["chunk_late", "chunk_early"])
        self.assertEqual(collection.upserts[0]["metadatas"][0]["source_file"], "C:/restored/video.mp4")
        self.assertNotEqual(collection.upserts[0]["ids"][0], "remote_chunk")

    def test_collection_import_uses_an_available_chromadb_without_leaking_a_double(self):
        """A discover-time import must bind production store to an available package."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "chromadb"
            package.mkdir()
            (package / "__init__.py").write_text(
                "class Collection: pass\nclass PersistentClient: pass\n",
                encoding="utf-8",
            )
            result = self._run_import_probe(root, "")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_chromadb_double_is_scoped_to_the_private_import(self):
        """The fallback must restore sys.modules and avoid caching production store."""
        blocker = """
import importlib.abc
import sys
class BlockChromadb(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "chromadb":
            raise ModuleNotFoundError("blocked for isolation probe", name="chromadb")
sys.meta_path.insert(0, BlockChromadb())
"""
        result = self._run_import_probe(None, blocker)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @staticmethod
    def _run_import_probe(chromadb_root: Path | None, prelude: str) -> subprocess.CompletedProcess:
        tests = Path(__file__).resolve().parent
        extra = [str(chromadb_root)] if chromadb_root is not None else []
        script = prelude + """
import sys
sys.path[:0] = sys.argv[2:]
import test_sentry_store_export
if sys.argv[1] == "installed":
    import chromadb
    from sentrysearch import store
    assert hasattr(chromadb, "PersistentClient")
    assert store.chromadb is chromadb
else:
    assert "chromadb" not in sys.modules
    assert "sentrysearch.store" not in sys.modules
"""
        return subprocess.run(
            [sys.executable, "-c", script, "installed" if chromadb_root else "missing",
             *extra, str(SENTRYSEARCH_DIR), str(tests)],
            capture_output=True,
            text=True,
            timeout=30,
        )


if __name__ == "__main__":
    unittest.main()
