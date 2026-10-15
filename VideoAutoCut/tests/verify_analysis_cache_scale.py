"""74-candidate offline scale check: real FFmpeg/Chroma, counted mock embeddings.

This standalone verifier runs the production index/search CLI in an isolated
child process. Its parent deletes only the generated temporary media/database
directory after the worker exits; persistent output contains logs and a report.
No model provider or user database is used.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

VIDEO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(VIDEO_ROOT / "sentrysearch"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def worker(root: Path, output: Path) -> dict:
    started = time.perf_counter()
    assert root.is_absolute() and root.name.startswith("videoauto_analysis_scale_")
    isolated_home = root / "home"
    isolated_home.mkdir()
    data_root = root / "data"
    os.environ.update({
        "VIDEOAUTO_DATA_ROOT": str(data_root),
        "USERPROFILE": str(isolated_home), "HOME": str(isolated_home),
        "ANONYMIZED_TELEMETRY": "False", "PYTHONUTF8": "1",
        "DASHSCOPE_BASE_URL": "https://example.invalid",
        "DASHSCOPE_EMBEDDING_MODEL": "qwen3-vl-embedding",
        "DASHSCOPE_VIDEO_FPS": "0.5",
        "VIDEOAUTO_MIN_MATCH_SCORE": "0",
    })
    from click.testing import CliRunner
    import chromadb
    from sentrysearch import analysis_cache, chunker, embedder, store as storage, _toolkit_cache
    from sentrysearch.cli import cli

    source_dir = root / "originals"
    source_dir.mkdir()
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg, "FFmpeg is required"
    fixtures_started = time.perf_counter()
    sources = []
    for index, size in enumerate(("192x108", "160x120", "108x192")):
        source = source_dir / f"real_motion_{index}.mp4"
        command = [ffmpeg, "-y", "-f", "lavfi", "-i",
            f"testsrc2=size={size}:rate=12:duration=2.2",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)]
        completed = subprocess.run(command, capture_output=True, timeout=30, check=True)
        (output / f"fixture-{index}.ffmpeg.log").write_bytes(completed.stderr)
        assert source.stat().st_size > 1024
        sources.append(source)
    assert len({sha256(path) for path in sources}) == 3
    # A shared textual prefix checks that --source-root is not a startswith match.
    shots = [root / "shot_01", root / "shot_010"]
    candidate_paths = []
    for shot in shots:
        index_root = shot / "_indexed_h264"
        index_root.mkdir(parents=True)
        paths = []
        for index in range(74):
            candidate = index_root / f"candidate_{index + 1:03d}.mp4"
            shutil.copyfile(sources[index % 3], candidate)
            paths.append(candidate)
        assert len({sha256(path) for path in paths}) == 3
        candidate_paths.append(paths)
    fixture_seconds = time.perf_counter() - fixtures_started

    video_calls = []
    text_calls = []

    class CountedMockEmbedder:
        def embed_video_chunk(self, path, **_kwargs):
            candidate = Path(path)
            assert candidate.is_file() and candidate.stat().st_size > 0
            video_calls.append({"processed_sha256": sha256(candidate), "size": candidate.stat().st_size})
            vector = [0.0] * 768
            vector[(len(video_calls) - 1) % 3] = 1.0
            return vector

        def embed_query(self, text, **_kwargs):
            text_calls.append(text)
            return [1.0, 0.4, 0.2] + [0.0] * 765

    fake = CountedMockEmbedder()
    runner = CliRunner()
    stages = []
    query_reports = []
    index_args = ["--backend", "qwen-cloud", "--dashscope-model", "qwen3-vl-embedding",
        "--chunk-duration", "30", "--no-skip-still", "--preprocess",
        "--target-resolution", "48", "--target-fps", "5"]
    last_search = root / "search-results.json"
    db_path = data_root / "video/vector-db/sentrysearch"
    with ExitStack() as stack:
        # All storage/media helpers remain real. Only the external embedding
        # boundary is replaced, and outbound Python sockets are denied.
        stack.enter_context(patch.object(embedder, "get_embedder", return_value=fake))
        stack.enter_context(patch.object(embedder, "reset_embedder"))
        stack.enter_context(patch.object(storage, "DEFAULT_DB_PATH", db_path))
        stack.enter_context(patch.object(_toolkit_cache, "_last_search_path", return_value=last_search))
        stack.enter_context(patch.object(socket.socket, "connect", side_effect=AssertionError("Outbound network disabled in scale verifier")))
        stack.enter_context(patch.object(socket.socket, "connect_ex", side_effect=AssertionError("Outbound network disabled in scale verifier")))
        split_spy = stack.enter_context(patch.object(chunker, "extract_chunk", wraps=chunker.extract_chunk))
        preprocess_spy = stack.enter_context(patch.object(chunker, "preprocess_chunk", wraps=chunker.preprocess_chunk))
        for shot_index, shot in enumerate(shots):
            before = len(video_calls)
            before_splits, before_preprocess = split_spy.call_count, preprocess_spy.call_count
            stage_started = time.perf_counter()
            indexed = runner.invoke(cli, ["index", str(shot / "_indexed_h264"), *index_args])
            elapsed = time.perf_counter() - stage_started
            (output / f"shot-{shot_index + 1}.index.log").write_text(indexed.output, encoding="utf-8")
            assert indexed.exit_code == 0, indexed.output[-4000:]
            events = [json.loads(line.split(":", 1)[1]) for line in indexed.output.splitlines()
                if line.startswith("VACUT_INDEX_PROGRESS:")]
            completed_files = [event for event in events if event.get("phase") == "complete"]
            assert len(completed_files) == 74
            assert {event["file"] for event in completed_files} == set(range(1, 75))
            assert all(event["completed_chunks"] == event["chunks"] == 1 for event in completed_files)
            embedded = len(video_calls) - before
            assert embedded == (3 if shot_index == 0 else 0), video_calls
            assert sum(event["cached_chunks"] for event in completed_files) == (71 if shot_index == 0 else 74)
            assert sum(event.get("phase") == "embedding" for event in events) == embedded
            assert split_spy.call_count - before_splits == embedded
            assert preprocess_spy.call_count - before_preprocess == embedded
            stages.append({"shot": shot_index + 1, "candidates": 74, "seconds": round(elapsed, 3),
                "mock_video_embeddings": embedded, "cache_hits": 74 - embedded,
                "real_split_calls": split_spy.call_count - before_splits,
                "real_preprocess_calls": preprocess_spy.call_count - before_preprocess})

        real_store = storage.SentryStore(db_path, backend="qwen-cloud", model="qwen3-vl-embedding")
        assert real_store.collection.count() == 148
        metadata = real_store.collection.get(include=["metadatas"])["metadatas"]
        assert {row["source_file"] for row in metadata} == {str(path) for paths in candidate_paths for path in paths}
        assert len({row["analysis_key"] for row in metadata}) == 3

        empty_root = root / "empty"
        empty_root.mkdir()
        for name, source_root, allowed in [
            ("shot-1", shots[0] / "_indexed_h264", candidate_paths[0]),
            ("shot-2", shots[1] / "_indexed_h264", candidate_paths[1]),
            ("empty", empty_root, []),
        ]:
            stage_started = time.perf_counter()
            searched = runner.invoke(cli, ["search", "explicit mock query for scope verification",
                "--backend", "qwen-cloud", "--dashscope-model", "qwen3-vl-embedding",
                "--source-root", str(source_root), "--results", "200", "--threshold", "0", "--no-trim"])
            elapsed = time.perf_counter() - stage_started
            (output / f"{name}.search.log").write_text(searched.output, encoding="utf-8")
            assert searched.exit_code == 0, searched.output[-4000:]
            results = json.loads(last_search.read_text("utf-8"))["results"]
            found = {row["source_file"] for row in results}
            assert len(results) == len(allowed)
            assert found == {str(path) for path in allowed}, (name, found)
            query_reports.append({"scope": name, "results": len(results), "out_of_scope_results": 0,
                "seconds": round(elapsed, 3)})

        manifests = list(analysis_cache.default_cache_root().glob("*/manifest.json"))
        assert len(manifests) == 3
        assert all(json.loads(path.read_text("utf-8"))["complete"] for path in manifests)
        assert len(video_calls) == 3 and len({call["processed_sha256"] for call in video_calls}) == 3
        assert len(text_calls) == 3
        real_store._client._system.stop()

    result = {"ok": True, "embedding_mode": "explicit_counted_mock_not_real_model",
        "network_access": "Python socket connections denied; Chroma telemetry disabled",
        "real_components": ["FFmpeg fixture generation", "production CLI", "production analysis cache",
            "FFmpeg split and preprocessing", "persistent Chroma", "source-root filtered search"],
        "chroma_version": chromadb.__version__, "fixture_seconds": round(fixture_seconds, 3),
        "unique_video_contents": 3, "candidates_per_shot": 74, "searchable_path_aliases": 148,
        "mock_video_embeddings_total": len(video_calls), "mock_query_embeddings_total": len(text_calls),
        "analysis_cache_entries": 3, "stages": stages, "queries": query_reports,
        "worker_total_seconds": round(time.perf_counter() - started, 3),
        "limitation": "Mock embedding latency and scores do not measure actual cloud model speed or matching quality."}
    (output / "report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--worker-root", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if args.worker_root:
        print(json.dumps(worker(args.worker_root.resolve(), output), ensure_ascii=False))
        return
    with tempfile.TemporaryDirectory(prefix="videoauto_analysis_scale_") as directory:
        root = Path(directory).resolve()
        assert root.parent == Path(tempfile.gettempdir()).resolve()
        assert root.name.startswith("videoauto_analysis_scale_")
        assert output != root and root not in output.parents
        run = subprocess.run([sys.executable, str(Path(__file__).resolve()),
            "--output-dir", str(output), "--worker-root", str(root)],
            capture_output=True, text=True, encoding="utf-8", timeout=300,
            env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
        (output / "worker.stdout.log").write_text(run.stdout, encoding="utf-8")
        (output / "worker.stderr.log").write_text(run.stderr, encoding="utf-8")
        if run.returncode:
            raise RuntimeError(f"Scale verification failed ({run.returncode}); see {output / 'worker.stderr.log'}")
    result = json.loads((output / "report.json").read_text("utf-8"))
    result["temporary_media_database_removed"] = not root.exists()
    assert result["temporary_media_database_removed"]
    (output / "report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
