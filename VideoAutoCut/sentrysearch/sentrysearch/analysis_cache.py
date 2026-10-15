"""Content-addressed analysis receipts; paths only identify searchable aliases.

The lock is owned by the OS, so an interrupted worker never leaves a stale lock.
Each successful chunk is committed separately; a failure cannot certify a file.
"""

from contextlib import contextmanager
import hashlib
import json
import math
import os
import struct
from pathlib import Path
import tempfile
import time
from urllib.parse import urlsplit, urlunsplit

VERSION = 1


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def file_sha256(path):
    result = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def source_identity(path, log=lambda message: None):
    """Verify normalized bytes and, when supplied, their original content identity."""
    path = Path(path)
    size = path.stat().st_size
    content = file_sha256(path)
    identity = {"source_sha256": content, "source_size": size, "normalization_profile": None}
    sidecar = Path(str(path) + ".source.json")
    if sidecar.is_file():
        try:
            data = json.loads(sidecar.read_text(encoding="utf-8-sig"))
            original = Path(data["source_path"])
            profile = data["normalization_profile"]
            if (data.get("schema_version") != 1 or data.get("time_mapping") != "identity"
                    or data.get("normalized_sha256") != content or data.get("normalized_size") != size
                    or not isinstance(profile, dict) or profile.get("contract") != "h264-index-normalization-v1"
                    or original.stat().st_size != data["source_size"]
                    or file_sha256(original) != data["source_sha256"]):
                raise ValueError("normalization identity or content does not match")
            identity = {"source_sha256": data["source_sha256"], "source_size": data["source_size"],
                        "normalization_profile": profile}
        except (OSError, ValueError, KeyError, TypeError) as exc:
            log(f"source identity sidecar rejected; using actual input SHA: {exc}")
    return identity, content


def cache_key(identity, profile):
    return digest({"schema_version": VERSION, "source_identity": identity, "analysis_profile": profile})


def analysis_source(path, profile, log=lambda message: None):
    identity, content = source_identity(path, log)
    analysis_path = path
    if profile["preprocess"] and identity["normalization_profile"] is not None:
        data = json.loads(Path(str(path) + ".source.json").read_text(encoding="utf-8-sig"))
        analysis_path = data["source_path"]
        # Analyze exactly the same original bytes as original/cloud indexing.
        # A normalized alias must never silently claim pixel-equivalence.
        if file_sha256(analysis_path) != identity["source_sha256"]:
            raise RuntimeError("original source changed after normalization verification")
        identity = {**identity, "normalization_profile": None}
        log("verified original bytes selected for canonical preprocessing; normalized path is a search alias")
    return identity, content, analysis_path


def build_profile(backend, model, chunk_duration, overlap, preprocess, target_resolution,
                  target_fps, skip_still, quantize=None):
    from .chunker import _get_ffmpeg_executable
    from .dashscope_config import dashscope_sdk_base_url
    if chunk_duration <= 0 or overlap < 0 or overlap >= chunk_duration or target_resolution <= 0 or target_fps <= 0:
        raise ValueError("invalid chunk or preprocessing parameters")
    endpoint = urlsplit(dashscope_sdk_base_url() or "https://dashscope.aliyuncs.com/api/v1")
    # Never persist account credentials, userinfo, or signed query parameters.
    host = endpoint.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    if endpoint.port:
        host += f":{endpoint.port}"
    safe_endpoint = urlunsplit((endpoint.scheme, host, endpoint.path, "", ""))
    profile = {"contract": "sentry-analysis-v1", "backend": backend,
               "model": model or "gemini-embedding-2-preview", "dimensions": 768,
               "chunk_duration": chunk_duration, "overlap": overlap,
               "preprocess": bool(preprocess), "target_resolution": target_resolution, "target_fps": target_fps,
               "skip_still": bool(skip_still), "still_threshold": 0.98,
               "ffmpeg_sha256": file_sha256(_get_ffmpeg_executable()),
               "preprocess_codec": "libx264/crf28+aac/64k", "split": "input-seek/copy-v1",
               "still_detector": "jpeg-size-three-frames-v1", "quantize": quantize}
    if backend == "qwen-cloud":
        fps = float(os.environ.get("DASHSCOPE_VIDEO_FPS", "0.5"))
        if not math.isfinite(fps) or fps <= 0:
            raise ValueError("DASHSCOPE_VIDEO_FPS must be finite and positive")
        profile.update(video_fps=fps, endpoint=safe_endpoint, factor=1.0)
    elif backend == "local":
        profile.update(video_fps=1.0, max_frames=32, prompt="Represent the video for retrieval.")
    return profile


def default_cache_root():
    root = os.environ.get("VIDEOAUTO_DATA_ROOT", "").strip()
    return (Path(root) / "video" if root else Path.home() / ".sentrysearch") / "analysis-cache" / "v1"


@contextmanager
def file_lock(path, timeout=900, log=lambda message: None):
    """Cross-process Windows/POSIX advisory lock, automatically released on exit."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        started = time.monotonic()
        reported = False
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if not reported:
                    log("waiting for identical content analysis owned by another worker")
                    reported = True
                if time.monotonic() - started > timeout:
                    raise TimeoutError(f"analysis cache lock wait exceeded {timeout}s")
                time.sleep(0.1)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".receipt-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(canonical(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def receipt(start, end, embedding=None, *, still=False):
    data = {"start_time": float(start), "end_time": float(end),
            "status": "still" if still else "embedded"}
    if not still:
        # Chroma persists float32; sign exactly those values so a DB receipt can
        # rebuild the shared cache without a precision-dependent checksum miss.
        data["embedding"] = [struct.unpack("f", struct.pack("f", float(value)))[0] for value in embedding]
    return {**data, "sha256": digest(data)}


def valid_receipt(value, span, dimensions):
    if not isinstance(value, dict):
        return False
    try:
        data = {key: item for key, item in value.items() if key != "sha256"}
        if (value["sha256"] != digest(data) or value["start_time"] != span[0]
                or value["end_time"] != span[1] or value["status"] not in ("still", "embedded")):
            return False
        if value["status"] == "embedded":
            vector = value["embedding"]
            return (isinstance(vector, list) and len(vector) == dimensions
                    and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in vector)
                    and any(v != 0 for v in vector))
        return True
    except (KeyError, TypeError, ValueError):
        return False


def provenance(manifest):
    return {key: manifest[key] for key in
            ("schema_version", "source_identity", "analysis_profile", "duration", "spans")} | {
        "still_spans": [[r["start_time"], r["end_time"]] for r in manifest["chunks"].values()
                        if r.get("status") == "still"],
    }


def manifest_from_export(path, chunks, proof, backend, model):
    """Validate a cloud/local export before giving it a reusable content key.

    No inference from a model name or a path-only legacy index is permitted.
    The imported profile is preserved; a later index can use it only if its
    full requested profile matches this key.
    """
    from .chunker import _get_video_duration, expected_chunk_spans
    if not isinstance(proof, dict) or proof.get("schema_version") != VERSION:
        raise ValueError("unsupported analysis provenance")
    profile = proof.get("analysis_profile")
    required = {"contract", "backend", "model", "dimensions", "chunk_duration", "overlap", "preprocess",
                "target_resolution", "target_fps", "skip_still", "still_threshold", "ffmpeg_sha256",
                "preprocess_codec", "split", "still_detector", "quantize"}
    if (not isinstance(profile, dict) or not required <= profile.keys()
            or profile["contract"] != "sentry-analysis-v1" or profile["backend"] != backend
            or profile["model"] != model or profile["dimensions"] != 768):
        raise ValueError("analysis provenance profile/backend/model is incompatible")
    identity, _, analysis_path = analysis_source(path, profile)
    if proof.get("source_identity") != identity:
        raise ValueError("analysis provenance does not match actual source content")
    duration = _get_video_duration(analysis_path)
    spans = [list(span) for span in expected_chunk_spans(duration, profile["chunk_duration"], profile["overlap"])]
    if proof.get("duration") != duration or proof.get("spans") != spans:
        raise ValueError("analysis provenance time spans do not match actual media")
    still_spans = proof.get("still_spans", [])
    if not isinstance(still_spans, list) or any(span not in spans for span in still_spans):
        raise ValueError("invalid still chunk receipt")
    if still_spans and not profile["skip_still"]:
        raise ValueError("still receipts contradict analysis profile")
    by_range = {}
    for chunk in chunks:
        span = (int(chunk["start_ms"]), int(chunk["end_ms"]))
        if span in by_range:
            raise ValueError("duplicate analysis range")
        by_range[span] = chunk
    records = {}
    for i, span in enumerate(spans):
        row = by_range.pop((round(span[0] * 1000), round(span[1] * 1000)), None)
        if span in still_spans:
            if row is not None:
                raise ValueError("still span also has an embedding")
            value = receipt(*span, still=True)
        elif row is not None:
            value = receipt(*span, row["embedding"])
        else:
            raise ValueError("analysis export is incomplete")
        if not valid_receipt(value, span, profile["dimensions"]):
            raise ValueError("invalid analysis vector receipt")
        records[str(i)] = value
    if by_range:
        raise ValueError("analysis contains unexpected spans")
    result = {"schema_version": VERSION, "key": cache_key(identity, profile), "source_identity": identity,
              "analysis_profile": profile, "duration": duration, "spans": spans, "chunks": records, "complete": True}
    result["header_sha256"] = digest(provenance(result))
    return result


def seed_manifest(manifest, cache_root=None):
    directory = Path(cache_root or default_cache_root()) / manifest["key"]
    with file_lock(directory / "analysis.lock"):
        atomic_json(directory / "manifest.json", manifest)


def analyze_file(path, profile, store, embed, *, cache_root=None, log=print, verbose=False,
                 progress=lambda **values: None):
    """Analyze missing chunks once, then mount receipts under this exact source path."""
    from . import chunker

    path = os.path.abspath(path)
    started = time.monotonic()
    identity, input_sha, analysis_path = analysis_source(path, profile, log)
    analysis_sha = file_sha256(analysis_path)
    key = cache_key(identity, profile)
    cache_dir = Path(cache_root or default_cache_root()) / key
    manifest_path = cache_dir / "manifest.json"
    log(f"content {identity['source_sha256'][:12]} profile {digest(profile)[:12]} hash checked in {time.monotonic()-started:.2f}s")
    with file_lock(cache_dir / "analysis.lock", log=log):
        manifest = None
        try:
            candidate = json.loads(manifest_path.read_text(encoding="utf-8"))
            if (candidate["schema_version"] == VERSION and candidate["key"] == key
                    and candidate["source_identity"] == identity and candidate["analysis_profile"] == profile
                    and candidate["header_sha256"] == digest(provenance(candidate))):
                manifest = candidate
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            pass
        if manifest is None:
            t0 = time.monotonic()
            progress(chunks=0, chunk=0, completed_chunks=0, cached_chunks=0, phase="probe")
            duration = chunker._get_video_duration(analysis_path)
            if not math.isfinite(duration) or duration <= 0:
                raise ValueError("video has no finite positive duration")
            spans = [list(span) for span in chunker.expected_chunk_spans(duration, profile["chunk_duration"], profile["overlap"])]
            manifest = {"schema_version": VERSION, "key": key, "source_identity": identity,
                        "analysis_profile": profile, "duration": duration, "spans": spans,
                        "chunks": {}, "complete": False}
            log(f"probe completed in {time.monotonic()-t0:.2f}s; {len(spans)} chunks")
            # Verified local/imported vectors survive a missing receipt file. Legacy
            # path-only vectors have no proof of compatible parameters and are ignored.
            recovered = store.cache_records(key)
            for record in recovered:
                i = record.get("index")
                if isinstance(i, int) and 0 <= i < len(spans) and valid_receipt(record.get("receipt"), spans[i], profile["dimensions"]):
                    manifest["chunks"][str(i)] = record["receipt"]
            if recovered:
                log(f"recovered {len(manifest['chunks'])} compatible stored chunks")
        # Remove every previous range for this path, including spans from old
        # profiles or a replaced file. Only verified receipts will be mounted.
        store.remove_file(path)
        manifest["complete"] = False
        def save():
            manifest["header_sha256"] = digest(provenance(manifest))
            atomic_json(manifest_path, manifest)
        def invalidate_changed_input():
            manifest["chunks"] = {}
            manifest["complete"] = False
            store.remove_file(path)
            save()
        save()
        embedded = hits = still = 0
        for index, span in enumerate(manifest["spans"]):
            def event(phase):
                progress(chunks=len(manifest["spans"]), chunk=index+1, completed_chunks=index,
                         cached_chunks=hits, phase=phase)
            label = f"chunk {index+1}/{len(manifest['spans'])} {span[0]:.3f}-{span[1]:.3f}s"
            result = manifest["chunks"].get(str(index))
            if not valid_receipt(result, span, profile["dimensions"]):
                manifest["chunks"].pop(str(index), None)
                save()
                try:
                    with tempfile.TemporaryDirectory(prefix="sentrysearch_analysis_") as temporary:
                        chunk_path = str(Path(temporary) / "chunk.mp4")
                        t0 = time.monotonic()
                        log(f"{label}: split started")
                        event("split")
                        chunker.extract_chunk(analysis_path, span[0], span[1], chunk_path)
                        log(f"{label}: split completed in {time.monotonic()-t0:.2f}s")
                        is_still = False
                        if profile["skip_still"]:
                            t0 = time.monotonic()
                            log(f"{label}: still detection started")
                            event("still")
                            is_still = chunker.is_still_frame_chunk(chunk_path, threshold=profile["still_threshold"], verbose=verbose, strict=True)
                            log(f"{label}: still detection completed in {time.monotonic()-t0:.2f}s")
                        if is_still:
                            result = receipt(*span, still=True)
                        else:
                            if profile["preprocess"]:
                                t0 = time.monotonic()
                                log(f"{label}: preprocess started")
                                event("preprocess")
                                chunk_path = chunker.preprocess_chunk(chunk_path, profile["target_resolution"], profile["target_fps"], strict=True)
                                log(f"{label}: preprocess completed in {time.monotonic()-t0:.2f}s")
                            t0 = time.monotonic()
                            log(f"{label}: embedding request started")
                            event("embedding")
                            vector = embed(chunk_path)
                            result = receipt(*span, vector)
                            if not valid_receipt(result, span, profile["dimensions"]):
                                raise ValueError("embedding has invalid values or dimensions")
                            log(f"{label}: embedding completed in {time.monotonic()-t0:.2f}s")
                            embedded += 1
                        manifest["chunks"][str(index)] = result
                        save()
                except Exception as exc:
                    # Failed attempts may coincide with an input replacement.
                    # Such partial receipts must never be reusable under the old SHA.
                    try:
                        changed = file_sha256(path) != input_sha or file_sha256(analysis_path) != analysis_sha
                    except OSError:
                        changed = True
                    if changed:
                        invalidate_changed_input()
                    event("failed")
                    log(f"{label}: FAILED {type(exc).__name__}: {exc}; successful receipts retained for resume")
                    raise
            else:
                hits += 1
                event("cache")
                log(f"{label}: cache hit ({result['status']})")
            if result["status"] == "still":
                still += 1
            else:
                store.add_chunk(store.make_chunk_id(path, span[0]), result["embedding"], {
                    "source_file": path, "start_time": span[0], "end_time": span[1],
                    "analysis_key": key, "analysis_chunk_index": index,
                    "analysis_receipt_sha256": result["sha256"],
                    "analysis_receipt": canonical(result),
                    "analysis_provenance": canonical(provenance(manifest)),
                })
            progress(chunks=len(manifest["spans"]), chunk=index+1, completed_chunks=index+1,
                     cached_chunks=hits, phase="chunk_complete")
        if file_sha256(path) != input_sha or file_sha256(analysis_path) != analysis_sha:
            invalidate_changed_input()
            raise RuntimeError("source content changed during analysis; file not completed")
        # Every alias receives final provenance (including all still spans).
        store.set_analysis_provenance(path, canonical(provenance(manifest)))
        manifest["complete"] = True
        save()
        progress(chunks=len(manifest["spans"]), chunk=len(manifest["spans"]),
                 completed_chunks=len(manifest["spans"]), cached_chunks=hits, phase="complete")
        log(f"file complete: {embedded} new embeddings, {hits} cache hits, {still} still chunks; {time.monotonic()-started:.2f}s")
        return {"embedded": embedded, "hits": hits, "still": still, "key": key}
