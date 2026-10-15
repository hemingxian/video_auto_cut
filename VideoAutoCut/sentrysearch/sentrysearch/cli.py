"""Click-based CLI entry point."""

import json
import math
import os
import platform
import shutil
import subprocess

import click
from dotenv import load_dotenv

_ENV_PATH = os.path.join(os.path.expanduser("~"), ".sentrysearch", ".env")

# Load from stable config location first, then cwd as fallback
load_dotenv(_ENV_PATH)
load_dotenv()  # cwd .env can override

from .qwen_cloud_embedder import default_dashscope_embedding_model

_BACKEND_CHOICES = ["gemini", "local", "qwen-cloud"]

_MODEL_FLAG_HELP_SUFFIX = (
    " Mutually exclusive with --dashscope-model (do not pass both)."
)
_DASHSCOPE_MODEL_FLAG_HELP_SUFFIX = (
    " Mutually exclusive with --model (do not pass both)."
)


def _reject_conflicting_model_flags(
    model: str | None, dashscope_model: str | None,
) -> None:
    """Raise if both local and DashScope model selectors are set."""
    if model is not None and dashscope_model is not None:
        raise click.UsageError(
            "Use only one of --model (local backend) or --dashscope-model "
            "(qwen-cloud / DashScope), not both."
        )


def _fmt_time(seconds: float) -> str:
    """Format seconds as MM:SS."""
    m, s = divmod(int(seconds), 60)
    return f"{m:02d}:{s:02d}"


def _cache_last_clip(path: str) -> None:
    """Record path as the most-recent clip for cross-tool integration.

    Failures are non-fatal 鈥?the cache is a UX nicety, not a correctness
    requirement.
    """
    from pathlib import Path

    from . import _toolkit_cache

    try:
        _toolkit_cache.write_last_clip(Path(os.path.abspath(path)))
        click.echo("Saved clip path cached for sentryblur --last", err=True)
    except Exception as e:
        click.secho(
            f"(warning: could not write last-clip cache: {e})",
            fg="yellow", err=True,
        )


def _cache_last_search(
    results: list,
    *,
    query: str | None = None,
    image_path: str | None = None,
) -> None:
    """Record the search query + results for cross-tool integration (sentrymerge).

    Failures are non-fatal.
    """
    from pathlib import Path

    from . import _toolkit_cache

    try:
        _toolkit_cache.write_last_search(
            query=query,
            results=results,
            image_path=Path(os.path.abspath(image_path)) if image_path else None,
        )
        click.echo("Search results cached for sentrymerge --last", err=True)
    except Exception as e:
        click.secho(
            f"(warning: could not write last-search cache: {e})",
            fg="yellow", err=True,
        )


def _open_file(path: str) -> None:
    """Open a file with the system's default application."""
    try:
        system = platform.system()
        if system == "Darwin":
            subprocess.Popen(["open", path])
        elif system == "Windows":
            os.startfile(path)
        else:
            subprocess.Popen(["xdg-open", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass  # non-critical 鈥?clip is already saved


def _overlay_output_path(path: str) -> str:
    """Return the default overlay output path for a source video."""
    base, _ext = os.path.splitext(path)
    return f"{base}_overlay.mp4"


def _is_permanent_failure(exc: Exception) -> bool:
    """Return True for errors that won't resolve by retrying the same chunk."""
    msg = str(exc).lower()
    if isinstance(exc, FileNotFoundError):
        return True
    # OOM 鈥?same chunk at same settings will OOM again
    if "out of memory" in msg or "cuda out of memory" in msg:
        return True
    # Decoder failures on specific files
    if "invalid data" in msg or "could not decode" in msg:
        return True
    return False


def _embed_with_retry(
    embedder,
    embed_path: str,
    chunk: dict,
    dlq,
    *,
    max_attempts: int = 3,
    verbose: bool = False,
) -> list[float] | None:
    """Embed a chunk with retries. On permanent/exhausted failure, record
    to the DLQ and return None so the caller can continue.

    Quota errors bubble up 鈥?the user needs to stop and wait.
    """
    import time as _time
    from .gemini_embedder import GeminiAPIKeyError, GeminiQuotaError

    chunk_id = chunk["chunk_id"]
    last_exc: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return embedder.embed_video_chunk(embed_path, verbose=verbose)
        except (GeminiQuotaError, GeminiAPIKeyError):
            raise  # user-facing, stop the run
        except Exception as exc:
            last_exc = exc
            if _is_permanent_failure(exc) or attempt == max_attempts:
                dlq.record(
                    chunk_id,
                    source_file=chunk["source_file"],
                    start_time=chunk["start_time"],
                    end_time=chunk["end_time"],
                    error=repr(exc),
                    attempts=attempt,
                )
                click.secho(
                    f"  Failed after {attempt} attempt(s), recorded to DLQ: {exc}",
                    fg="yellow",
                    err=True,
                )
                return None
            wait = 2 ** attempt
            click.secho(
                f"  Embed error (attempt {attempt}/{max_attempts}), "
                f"retrying in {wait}s: {exc}",
                fg="yellow",
                err=True,
            )
            _time.sleep(wait)
    # unreachable 鈥?loop always returns or records
    if last_exc is not None:
        raise last_exc
    return None


def _handle_error(e: Exception) -> None:
    """Print a user-friendly error and exit."""
    from .gemini_embedder import GeminiAPIKeyError, GeminiQuotaError
    from .local_embedder import LocalModelError
    from .store import BackendMismatchError

    if isinstance(e, GeminiAPIKeyError):
        click.secho("Error: " + str(e), fg="red", err=True)
        raise SystemExit(1)
    if isinstance(e, GeminiQuotaError):
        click.secho("Error: " + str(e), fg="yellow", err=True)
        raise SystemExit(1)
    if isinstance(e, LocalModelError):
        click.secho("Error: " + str(e), fg="red", err=True)
        raise SystemExit(1)
    if isinstance(e, BackendMismatchError):
        click.secho("Error: " + str(e), fg="red", err=True)
        raise SystemExit(1)
    if isinstance(e, PermissionError):
        click.secho("Error: " + str(e), fg="red", err=True)
        raise SystemExit(1)
    if isinstance(e, click.UsageError):
        click.secho(str(e), fg="red", err=True)
        raise SystemExit(2)
    if isinstance(e, FileNotFoundError):
        click.secho("Error: " + str(e), fg="red", err=True)
        raise SystemExit(1)
    if isinstance(e, RuntimeError) and "ffmpeg not found" in str(e).lower():
        click.secho(
            "Error: ffmpeg is not available.\n\n"
            "Install it with one of:\n"
            "  Ubuntu/Debian:  sudo apt install ffmpeg\n"
            "  macOS:          brew install ffmpeg\n"
            "  pip fallback:   uv add imageio-ffmpeg",
            fg="red",
            err=True,
        )
        raise SystemExit(1)
    raise e


def _apply_overlay_to_clip(
    clip_path: str,
    source_file: str,
    start_time: float,
    end_time: float,
    *,
    replace: bool = True,
) -> bool:
    """Apply Tesla telemetry overlay to a clip. Returns True on success.

    When *replace* is True the overlay is written over *clip_path* in-place.
    """
    from .overlay import apply_overlay, get_metadata_samples, reverse_geocode

    samples = get_metadata_samples(source_file, start_time, end_time)
    if samples is None:
        click.secho(
            "No Tesla SEI metadata found 鈥?skipping overlay.",
            fg="yellow", err=True,
        )
        return False

    location = None
    mid = samples[len(samples) // 2]
    lat = mid.get("latitude_deg", 0.0)
    lon = mid.get("longitude_deg", 0.0)
    if lat and lon:
        click.echo("Reverse geocoding location...")
        location = reverse_geocode(lat, lon)
        if location is None:
            click.secho(
                "Geocoding failed 鈥?continuing without location. "
                "Install deps with: uv tool install \".[tesla]\"",
                fg="yellow", err=True,
            )

    overlay_path = _overlay_output_path(clip_path)
    result_path = apply_overlay(
        clip_path, overlay_path, samples, location,
        source_file=source_file,
        start_time=start_time,
    )
    if result_path == overlay_path and os.path.isfile(overlay_path):
        if replace:
            os.replace(overlay_path, clip_path)
        click.echo("Applied Tesla metadata overlay")
        return True

    click.secho("Overlay failed.", fg="yellow", err=True)
    return False


@click.group()
@click.version_option(package_name="sentrysearch")
def cli():
    """Search dashcam footage using natural language queries."""


# -----------------------------------------------------------------------
# init
# -----------------------------------------------------------------------

@cli.command()
def init():
    """Set up your Gemini API key for sentrysearch."""
    env_path = _ENV_PATH
    os.makedirs(os.path.dirname(env_path), exist_ok=True)

    # Check for existing key
    if os.path.exists(env_path):
        with open(env_path) as f:
            contents = f.read()
        if "GEMINI_API_KEY=" in contents:
            if not click.confirm("API key already configured. Overwrite?", default=False):
                return

    api_key = click.prompt(
        "Enter your Gemini API key\n"
        "  Get one at https://aistudio.google.com/apikey\n"
        "  (input is hidden)",
        hide_input=True,
    )

    # Write/update .env
    if os.path.exists(env_path):
        with open(env_path) as f:
            lines = f.readlines()
        with open(env_path, "w") as f:
            found = False
            for line in lines:
                if line.startswith("GEMINI_API_KEY="):
                    f.write(f"GEMINI_API_KEY={api_key}\n")
                    found = True
                else:
                    f.write(line)
            if not found:
                f.write(f"GEMINI_API_KEY={api_key}\n")
    else:
        with open(env_path, "w") as f:
            f.write(f"GEMINI_API_KEY={api_key}\n")

    # Validate by embedding a test string
    os.environ["GEMINI_API_KEY"] = api_key
    click.echo("Validating API key...")
    try:
        from .embedder import get_embedder

        embedder = get_embedder("gemini")
        vec = embedder.embed_query("test")
        if len(vec) != 768:
            click.secho(
                f"Unexpected embedding dimension: {len(vec)} (expected 768). "
                "The key may be valid but something is off.",
                fg="yellow",
                err=True,
            )
            raise SystemExit(1)
    except SystemExit:
        raise
    except Exception as e:
        click.secho(f"Validation failed: {e}", fg="red", err=True)
        click.secho("Please check your API key and try again.", fg="red", err=True)
        raise SystemExit(1)

    click.secho(
        "Setup complete. You're ready to go 鈥?run "
        "`sentrysearch index <directory>` to get started.",
        fg="green",
    )
    click.secho(
        "\nTip: Set a spending limit at https://aistudio.google.com/billing "
        "to prevent accidental overspending.",
        fg="yellow",
    )


# -----------------------------------------------------------------------
# index
# -----------------------------------------------------------------------

@cli.command()
@click.argument("directory", type=click.Path(exists=True, file_okay=True, dir_okay=True))
@click.option("--chunk-duration", default=30, show_default=True,
              help="Chunk duration in seconds.")
@click.option("--overlap", default=5, show_default=True,
              help="Overlap between chunks in seconds.")
@click.option("--preprocess/--no-preprocess", default=True, show_default=True,
              help="Downscale and reduce frame rate before embedding.")
@click.option("--target-resolution", default=480, show_default=True,
              help="Target video height in pixels for preprocessing.")
@click.option("--target-fps", default=5, show_default=True,
              help="Target frames per second for preprocessing.")
@click.option("--skip-still/--no-skip-still", default=True, show_default=True,
              help="Skip chunks with no meaningful visual change.")
@click.option("--backend", type=click.Choice(_BACKEND_CHOICES), default=None,
              help="Embedding backend (default: gemini, or local when --model is set).")
@click.option("--model", default=None, show_default=False,
              help="Model for local backend: qwen8b, qwen2b, or HuggingFace ID "
                   "(default: auto-detect from hardware). Implies --backend local."
                   + _MODEL_FLAG_HELP_SUFFIX)
@click.option("--dashscope-model", default=None, show_default=False,
              help="DashScope embedding model id for --backend qwen-cloud "
                   "(default: env DASHSCOPE_EMBEDDING_MODEL or qwen3-vl-embedding). "
                   "Implies --backend qwen-cloud."
                   + _DASHSCOPE_MODEL_FLAG_HELP_SUFFIX)
@click.option("--quantize/--no-quantize", default=None,
              help="Enable/disable 4-bit quantization for local backend (default: auto-detect).")
@click.option("--retry-failed", is_flag=True,
              help="Retry chunks that previously failed and were routed to the DLQ.")
@click.option("--verbose", is_flag=True, help="Show debug info.")
def index(directory, chunk_duration, overlap, preprocess, target_resolution,
          target_fps, skip_still, backend, model, dashscope_model, quantize,
          retry_failed, verbose):
    """Index videos, reusing verified content analysis across paths and tasks."""
    import time
    from .analysis_cache import analyze_file, build_profile
    from .chunker import SUPPORTED_VIDEO_EXTENSIONS, scan_directory
    from .embedder import get_embedder, reset_embedder
    from .local_embedder import detect_default_model, normalize_model_key
    from .store import SentryStore

    try:
        _reject_conflicting_model_flags(model, dashscope_model)
        if model is not None and backend is None:
            backend = "local"
        if dashscope_model is not None and backend is None:
            backend = "qwen-cloud"
        backend = backend or "gemini"
        if backend == "qwen-cloud":
            model = dashscope_model or default_dashscope_embedding_model()
        elif backend == "local":
            model = normalize_model_key(model or detect_default_model())
        else:
            model = None
        profile = build_profile(backend, model, chunk_duration, overlap, preprocess,
                                target_resolution, target_fps, skip_still, quantize)
        videos = [os.path.abspath(directory)] if os.path.isfile(directory) else scan_directory(directory)
        if not videos:
            click.echo(f"No supported video files found ({', '.join(SUPPORTED_VIDEO_EXTENSIONS)}).")
            return
        store = SentryStore(backend=backend, model=model)
        embedder = None
        def embed(path):
            nonlocal embedder
            if embedder is None:
                embedder = get_embedder(backend, model=model, quantize=quantize)
            # Each backend owns its bounded retry policy. Do not wrap cloud
            # retries in _embed_with_retry (which multiplied 6 x 3 requests).
            return embedder.embed_video_chunk(path, verbose=verbose)
        totals = {"embedded": 0, "hits": 0, "still": 0}
        for file_idx, video_path in enumerate(videos, 1):
            abs_path = os.path.abspath(video_path)
            click.echo(f"Indexing file {file_idx}/{len(videos)}: {os.path.basename(abs_path)}")
            started = time.monotonic()
            def progress(**values):
                click.echo("VACUT_INDEX_PROGRESS:" + json.dumps({
                    "file": file_idx, "files": len(videos), "path": abs_path,
                    "elapsed": round(time.monotonic() - started, 3), **values,
                }, ensure_ascii=False, separators=(",", ":")))
            try:
                result = analyze_file(abs_path, profile, store, embed, log=click.echo,
                                      verbose=verbose, progress=progress)
            except Exception:
                progress(chunks=0, chunk=0, phase="failed")
                raise
            for key in totals:
                totals[key] += result[key]
        click.echo(f"Indexed {totals['embedded']} new chunks; {totals['hits']} cache hits; "
                   f"{totals['still']} still chunks, across {len(videos)} files.")
    except Exception as exc:
        _handle_error(exc)
    finally:
        reset_embedder()


# -----------------------------------------------------------------------
# search
# -----------------------------------------------------------------------

@cli.command()
@click.argument("query")
@click.option("-n", "--results", "n_results", default=5, show_default=True,
              help="Number of results to return.")
@click.option("-o", "--output-dir", default="~/sentrysearch_clips", show_default=True,
              help="Directory to save trimmed clips.")
@click.option("--trim/--no-trim", default=True, show_default=True,
              help="Auto-trim the top result.")
@click.option("--save-top", default=None, type=click.IntRange(min=1),
              help="Save the top N matching clips instead of just the #1 result (e.g. --save-top 3).")
@click.option("--source-root", default=None,
              type=click.Path(exists=True, file_okay=False, resolve_path=True),
              help="Restrict results to indexed videos under this directory.")
@click.option("--threshold", default=0.41, show_default=True, type=float,
              help="Minimum similarity score to consider a confident match.")
@click.option("--overlay/--no-overlay", default=False, show_default=True,
              help="Burn Tesla telemetry overlay (speed, GPS, turn signals) onto trimmed clip.")
@click.option("--backend", type=click.Choice(_BACKEND_CHOICES), default=None,
              help="Embedding backend (auto-detected from index if omitted).")
@click.option("--model", default=None, show_default=False,
              help="Model for local backend: qwen8b, qwen2b, or HuggingFace ID "
                   "(default: auto-detect from index). Implies --backend local."
                   + _MODEL_FLAG_HELP_SUFFIX)
@click.option("--dashscope-model", default=None, show_default=False,
              help="DashScope model id for qwen-cloud (default: from index or "
                   "DASHSCOPE_EMBEDDING_MODEL). Implies --backend qwen-cloud."
                   + _DASHSCOPE_MODEL_FLAG_HELP_SUFFIX)
@click.option("--quantize/--no-quantize", default=None,
              help="Enable/disable 4-bit quantization for local backend (default: auto-detect).")
@click.option("--dedupe", "dedupe_threshold", default=None, type=float,
              help="Drop results whose cosine similarity to a higher-ranked "
                   "result exceeds this (e.g. 0.9).")
@click.option("--open/--no-open", "open_result", default=False, show_default=True,
              help="Open the first saved clip after trimming.")
@click.option("--verbose", is_flag=True, help="Show debug info.")
def search(
    query,
    n_results,
    output_dir,
    trim,
    save_top,
    source_root,
    threshold,
    overlay,
    backend,
    model,
    dashscope_model,
    quantize,
    dedupe_threshold,
    open_result,
    verbose,
):
    """Search indexed footage with a natural language QUERY."""
    from .embedder import get_embedder, reset_embedder
    from .local_embedder import normalize_model_key
    from .search import search_footage
    from .store import SentryStore, detect_index

    output_dir = os.path.expanduser(output_dir)

    try:
        _reject_conflicting_model_flags(model, dashscope_model)
        if dashscope_model is not None and backend is None:
            backend = "qwen-cloud"
        # --model implies --backend local
        if model is not None and backend is None:
            backend = "local"

        if backend == "local" and model is not None:
            model = normalize_model_key(model)

        # Auto-detect backend and model from whichever collection has data
        if backend is None:
            detected_backend, detected_model = detect_index()
            backend = detected_backend or "gemini"
            if model is None:
                model = detected_model
        elif backend == "local" and model is None:
            _, detected_model = detect_index()
            model = detected_model
        elif backend == "qwen-cloud":
            if dashscope_model is not None:
                model = dashscope_model
            elif model is None:
                _, detected_model = detect_index()
                model = detected_model or default_dashscope_embedding_model()

        store = SentryStore(backend=backend, model=model)

        if store.get_stats()["total_chunks"] == 0:
            # Check if data exists under a different model
            det_backend, det_model = detect_index()
            if det_backend == backend and det_model and det_model != model:
                click.echo(
                    f"No footage indexed with the {model} model. "
                    f"Your index uses {det_model}.\n\n"
                    f"Try: sentrysearch search \"{query}\" --model {det_model}"
                )
            elif det_backend and det_backend != backend:
                click.echo(
                    f"No footage indexed with the {backend} backend. "
                    f"Your index uses {det_backend}."
                )
            else:
                click.echo(
                    "No indexed footage found. "
                    "Run `sentrysearch index <directory>` first."
                )
                # A valid bound video can have no indexed chunks (for example,
                # still frames skipped during indexing). Report a normal empty
                # result so the engine can apply its explicitly enabled fallback.
                # Different-model/backend cases above keep their diagnostic path.
                if trim or save_top is not None:
                    click.echo('VACUT_CLIPS:{"schema_version":1,"paths":[]}')
            return

        if backend == "local":
            click.secho(
                "Tip: `sentrysearch shell` keeps the model loaded across queries.",
                fg="yellow", err=True,
            )

        get_embedder(backend, model=model, quantize=quantize)

        # Ensure we fetch enough results for --save-top
        if save_top is not None and save_top > n_results:
            n_results = save_top

        if verbose:
            click.echo(f"  [verbose] backend={backend}, similarity threshold: {threshold}", err=True)

        allowed_source_files = None
        if source_root:
            allowed_source_files = [
                os.path.abspath(os.path.join(root, file_name))
                for root, _, file_names in os.walk(source_root)
                for file_name in file_names
            ]
        results = search_footage(
            query,
            store,
            n_results=n_results,
            verbose=verbose,
            dedupe_threshold=dedupe_threshold,
            allowed_source_files=allowed_source_files,
        )
        _cache_last_search(results, query=query)
        _present_results(
            results, threshold, trim, save_top, output_dir, overlay, open_result, verbose,
        )

    except Exception as e:
        _handle_error(e)
    finally:
        reset_embedder()


def _present_results(
    results,
    threshold,
    trim,
    save_top,
    output_dir,
    overlay,
    open_result,
    verbose,
):
    strict_minimum = os.environ.get("VIDEOAUTO_MIN_MATCH_SCORE", "").strip()
    if strict_minimum:
        minimum = float(strict_minimum)
        if not math.isfinite(minimum) or not -1 <= minimum <= 1:
            raise click.ClickException("Invalid VIDEOAUTO_MIN_MATCH_SCORE")
        results = [result for result in results if math.isfinite(float(result["similarity_score"])) and float(result["similarity_score"]) >= minimum]
    if not results:
        click.echo(
            "No results found.\n\n"
            "Suggestions:\n"
            "  - Try a broader or different query\n"
            "  - Re-index with smaller --chunk-duration for finer granularity\n"
            "  - Check `sentrysearch stats` to see what's indexed"
        )
        if trim or save_top is not None:
            click.echo('VACUT_CLIPS:{"schema_version":1,"paths":[]}')
        return

    best_score = results[0]["similarity_score"]
    low_confidence = best_score < threshold

    if low_confidence and not trim:
        click.secho(
            f"(low confidence 鈥?best score: {best_score:.2f})",
            fg="yellow",
            err=True,
        )

    for i, r in enumerate(results, 1):
        basename = os.path.basename(r["source_file"])
        start_str = _fmt_time(r["start_time"])
        end_str = _fmt_time(r["end_time"])
        score = r["similarity_score"]
        if verbose:
            click.echo(f"  #{i} [{score:.6f}] {basename} @ {start_str}-{end_str}")
        else:
            click.echo(f"  #{i} [{score:.2f}] {basename} @ {start_str}-{end_str}")

    should_trim = trim or save_top is not None
    if should_trim:
        if low_confidence:
            click.secho(
                f"No confident match found (best score: {best_score:.2f}); "
                "saving top result(s) anyway.",
                fg="yellow",
                err=True,
            )

        from .trimmer import trim_top_results
        count = save_top if save_top is not None else 1
        clip_paths = trim_top_results(results, output_dir, count=count)

        for i, clip_path in enumerate(clip_paths):
            if overlay:
                r = results[i]
                _apply_overlay_to_clip(
                    clip_path, r["source_file"],
                    r["start_time"], r["end_time"],
                )
            click.echo(f"\nSaved clip: {clip_path}")

        click.echo("VACUT_CLIPS:" + json.dumps({
            "schema_version": 1,
            "paths": [os.path.abspath(path) for path in clip_paths],
        }, ensure_ascii=False))

        if clip_paths:
            _cache_last_clip(clip_paths[0])
            if open_result:
                _open_file(clip_paths[0])


@cli.command()
@click.argument("image", type=click.Path(exists=True, dir_okay=False))
@click.option("-n", "--results", "n_results", default=5, show_default=True,
              help="Number of results to return.")
@click.option("-o", "--output-dir", default="~/sentrysearch_clips", show_default=True,
              help="Directory to save trimmed clips.")
@click.option("--trim/--no-trim", default=True, show_default=True,
              help="Trim and save the top result as a clip.")
@click.option("--save-top", default=None, type=click.IntRange(min=1),
              help="Save the top N matches as separate clips.")
@click.option("--threshold", default=0.41, show_default=True, type=float,
              help="Minimum similarity score to consider a confident match.")
@click.option("--overlay/--no-overlay", default=False, show_default=True,
              help="Apply Tesla telemetry overlay to saved clips.")
@click.option("--backend", type=click.Choice(_BACKEND_CHOICES), default=None,
              help="Embedding backend (auto-detected from index if omitted).")
@click.option("--model", default=None,
              help="Model for local backend (default: auto-detect from index)."
                   + _MODEL_FLAG_HELP_SUFFIX)
@click.option("--dashscope-model", default=None,
              help="DashScope model id for qwen-cloud (implies --backend qwen-cloud)."
                   + _DASHSCOPE_MODEL_FLAG_HELP_SUFFIX)
@click.option("--quantize/--no-quantize", default=None,
              help="Enable/disable 4-bit quantization for local backend.")
@click.option("--dedupe", "dedupe_threshold", default=None, type=float,
              help="Drop results whose cosine similarity to a higher-ranked "
                   "result exceeds this (e.g. 0.9).")
@click.option("--open/--no-open", "open_result", default=False, show_default=True,
              help="Open the first saved clip after trimming.")
@click.option("--verbose", is_flag=True, help="Show debug info.")
def img(
    image,
    n_results,
    output_dir,
    trim,
    save_top,
    threshold,
    overlay,
    backend,
    model,
    dashscope_model,
    quantize,
    dedupe_threshold,
    open_result,
    verbose,
):
    """Search indexed footage using an IMAGE as the query."""
    from .embedder import get_embedder, reset_embedder
    from .local_embedder import normalize_model_key
    from .search import search_footage_by_image
    from .store import SentryStore, detect_index

    output_dir = os.path.expanduser(output_dir)

    try:
        _reject_conflicting_model_flags(model, dashscope_model)
        if dashscope_model is not None and backend is None:
            backend = "qwen-cloud"
        if model is not None and backend is None:
            backend = "local"
        if backend == "local" and model is not None:
            model = normalize_model_key(model)
        if backend is None:
            detected_backend, detected_model = detect_index()
            backend = detected_backend or "gemini"
            if model is None:
                model = detected_model
        elif backend == "local" and model is None:
            _, model = detect_index()
        elif backend == "qwen-cloud":
            if dashscope_model is not None:
                model = dashscope_model
            elif model is None:
                _, detected_model = detect_index()
                model = detected_model or default_dashscope_embedding_model()

        store = SentryStore(backend=backend, model=model)

        if store.get_stats()["total_chunks"] == 0:
            click.echo(
                "No indexed footage found. "
                "Run `sentrysearch index <directory>` first."
            )
            return

        get_embedder(backend, model=model, quantize=quantize)

        if save_top is not None and save_top > n_results:
            n_results = save_top

        if verbose:
            click.echo(
                f"  [verbose] backend={backend}, image={image}, "
                f"similarity threshold: {threshold}", err=True,
            )

        results = search_footage_by_image(
            image, store, n_results=n_results, verbose=verbose,
            dedupe_threshold=dedupe_threshold,
        )
        _cache_last_search(results, image_path=image)
        _present_results(
            results, threshold, trim, save_top, output_dir, overlay, open_result, verbose,
        )

    except Exception as e:
        _handle_error(e)
    finally:
        reset_embedder()


# -----------------------------------------------------------------------
# highlights
# -----------------------------------------------------------------------

@cli.command()
@click.option("-n", "--count", default=5, show_default=True, type=click.IntRange(min=1),
              help="Number of highlight clips to return.")
@click.option("--method", type=click.Choice(["centroid", "knn", "lof"]),
              default="knn", show_default=True,
              help="Anomaly scoring method.")
@click.option("-k", "--neighbors", default=10, show_default=True, type=click.IntRange(min=1),
              help="k for knn/lof methods.")
@click.option("--against", default=None,
              help="Score anomaly relative to a query (see --against-mode).")
@click.option("--against-mode", type=click.Choice(["within", "global"]),
              default="within", show_default=True,
              help="within: anomalous among matches of --against. "
                   "global: matches --against but unlike the rest of the index.")
@click.option("--dedupe", "dedupe_threshold", default=0.9, show_default=True, type=float,
              help="Drop results whose cosine similarity to a higher-ranked "
                   "result exceeds this.")
@click.option("--exclude-baseline", is_flag=True,
              help="Drop the half of the index nearest the centroid before scoring.")
@click.option("--trim/--no-trim", default=True, show_default=True,
              help="Trim and save the highlight clips.")
@click.option("-o", "--output-dir", default="~/sentrysearch_clips", show_default=True,
              help="Directory to save trimmed clips.")
@click.option("--overlay/--no-overlay", default=False, show_default=True,
              help="Burn Tesla telemetry overlay onto trimmed clips.")
@click.option("--backend", type=click.Choice(["gemini", "local"]), default=None,
              help="Embedding backend (auto-detected from index if omitted).")
@click.option("--model", default=None,
              help="Model for local backend (default: auto-detect from index).")
@click.option("--quantize/--no-quantize", default=None,
              help="Enable/disable 4-bit quantization for local backend.")
@click.option("--open/--no-open", "open_result", default=False, show_default=True,
              help="Open the first saved clip after trimming.")
@click.option("--verbose", is_flag=True, help="Show debug info.")
def highlights(
    count,
    method,
    neighbors,
    against,
    against_mode,
    dedupe_threshold,
    exclude_baseline,
    trim,
    output_dir,
    overlay,
    backend,
    model,
    quantize,
    open_result,
    verbose,
):
    """Surface the most anomalous clips in the indexed footage.

    Useful when you don't know what to search for 鈥?finds chunks whose
    embedding sits far from the rest of the index.
    """
    import numpy as np

    from .embedder import embed_query, get_embedder, reset_embedder
    from .highlights import rank_highlights
    from .local_embedder import normalize_model_key
    from .store import SentryStore, detect_index

    output_dir = os.path.expanduser(output_dir)

    try:
        if model is not None and backend is None:
            backend = "local"
        if model is not None:
            model = normalize_model_key(model)
        if backend is None:
            detected_backend, detected_model = detect_index()
            backend = detected_backend or "gemini"
            if model is None:
                model = detected_model
        elif backend == "local" and model is None:
            _, model = detect_index()

        store = SentryStore(backend=backend, model=model)
        if store.get_stats()["total_chunks"] == 0:
            click.echo(
                "No indexed footage found. "
                "Run `sentrysearch index <directory>` first."
            )
            return

        against_embedding = None
        if against is not None:
            get_embedder(backend, model=model, quantize=quantize)
            against_embedding = np.asarray(
                embed_query(against, verbose=verbose), dtype=np.float32,
            )

        if verbose:
            click.echo(
                f"  [verbose] method={method}, k={neighbors}, "
                f"dedupe={dedupe_threshold}, exclude_baseline={exclude_baseline}",
                err=True,
            )

        results = rank_highlights(
            store,
            count=count,
            method=method,
            neighbors=neighbors,
            dedupe_threshold=dedupe_threshold,
            exclude_baseline=exclude_baseline,
            against_embedding=against_embedding,
            against_mode=against_mode,
        )

        if not results:
            click.echo("No highlights found (index too small or all filtered out).")
            return

        for i, r in enumerate(results, 1):
            basename = os.path.basename(r["source_file"])
            start_str = _fmt_time(r["start_time"])
            end_str = _fmt_time(r["end_time"])
            score = r["similarity_score"]
            fmt = f"{score:.4f}" if verbose else f"{score:.3f}"
            click.echo(f"  #{i} [{fmt}] {basename} @ {start_str}-{end_str}")

        _cache_last_search(results, query=f"[highlights:{method}]")

        if trim:
            from .trimmer import trim_top_results
            clip_paths = trim_top_results(results, output_dir, count=len(results))
            for i, clip_path in enumerate(clip_paths):
                if overlay:
                    r = results[i]
                    _apply_overlay_to_clip(
                        clip_path, r["source_file"],
                        r["start_time"], r["end_time"],
                    )
                click.echo(f"\nSaved clip: {clip_path}")
            if clip_paths:
                _cache_last_clip(clip_paths[0])
                if open_result:
                    _open_file(clip_paths[0])

    except Exception as e:
        _handle_error(e)
    finally:
        reset_embedder()


# -----------------------------------------------------------------------
# shell
# -----------------------------------------------------------------------

_HISTORY_PATH = os.path.join(os.path.expanduser("~"), ".sentrysearch", "history")


def _print_shell_results(results, threshold):
    if not results:
        click.echo("  (no results)")
        return
    best = results[0]["similarity_score"]
    if best < threshold:
        click.secho(f"  (low confidence 鈥?best score: {best:.2f})", fg="yellow")
    for i, r in enumerate(results, 1):
        basename = os.path.basename(r["source_file"])
        click.echo(
            f"  #{i} [{r['similarity_score']:.2f}] {basename} "
            f"@ {_fmt_time(r['start_time'])}-{_fmt_time(r['end_time'])}"
        )


@cli.command()
@click.option("--backend", type=click.Choice(_BACKEND_CHOICES), default=None,
              help="Embedding backend (auto-detected from index if omitted).")
@click.option("--model", default=None,
              help="Model for local backend (default: auto-detect from index)."
                   + _MODEL_FLAG_HELP_SUFFIX)
@click.option("--dashscope-model", default=None,
              help="DashScope model id for qwen-cloud (implies --backend qwen-cloud)."
                   + _DASHSCOPE_MODEL_FLAG_HELP_SUFFIX)
@click.option("--quantize/--no-quantize", default=None,
              help="Enable/disable 4-bit quantization for local backend.")
@click.option("-n", "--results", "n_results", default=5, show_default=True,
              help="Number of results per query.")
@click.option("--threshold", default=0.41, show_default=True, type=float,
              help="Minimum similarity score to consider a confident match.")
@click.option("--verbose", is_flag=True, help="Show debug info.")
def shell(backend, model, dashscope_model, quantize, n_results, threshold, verbose):
    """Start an interactive search session that keeps the model loaded.

    Useful for running multiple queries back-to-back with the local
    backend, which otherwise re-loads the model on every `search`
    invocation.

    Meta-commands:
      :n <int>   change number of results
      :help      show help
      :quit      exit (Ctrl-D also works)
    """
    from .embedder import get_embedder, reset_embedder
    from .local_embedder import normalize_model_key
    from .search import search_footage
    from .store import SentryStore, detect_index

    try:
        _reject_conflicting_model_flags(model, dashscope_model)
        # Resolve backend/model (mirrors `search`)
        if dashscope_model is not None and backend is None:
            backend = "qwen-cloud"
        if model is not None and backend is None:
            backend = "local"
        if backend == "local" and model is not None:
            model = normalize_model_key(model)
        if backend is None:
            detected_backend, detected_model = detect_index()
            backend = detected_backend or "gemini"
            if model is None:
                model = detected_model
        elif backend == "local" and model is None:
            _, model = detect_index()
        elif backend == "qwen-cloud":
            if dashscope_model is not None:
                model = dashscope_model
            elif model is None:
                _, detected_model = detect_index()
                model = detected_model or default_dashscope_embedding_model()

        store = SentryStore(backend=backend, model=model)
        stats = store.get_stats()
        if stats["total_chunks"] == 0:
            click.echo("No indexed footage. Run `sentrysearch index <dir>` first.")
            return

        label = backend + (f" ({model})" if model else "")
        click.echo(f"Loading {label}...")
        get_embedder(backend, model=model, quantize=quantize)

        # Readline for arrow-key history and persistent history file
        try:
            import readline
            os.makedirs(os.path.dirname(_HISTORY_PATH), exist_ok=True)
            if os.path.exists(_HISTORY_PATH):
                try:
                    readline.read_history_file(_HISTORY_PATH)
                except OSError:
                    pass
            readline.set_history_length(1000)
        except ImportError:
            readline = None

        click.secho(
            f"Ready. {stats['total_chunks']} chunks indexed. "
            "Type a query, :help for commands, :quit to exit.",
            fg="green",
        )

        while True:
            try:
                query = input("search> ").strip()
            except EOFError:
                click.echo()
                break
            except KeyboardInterrupt:
                click.echo()
                continue
            if not query:
                continue

            if query.startswith(":"):
                cmd, _, arg = query[1:].partition(" ")
                cmd = cmd.strip().lower()
                arg = arg.strip()
                if cmd in ("q", "quit", "exit"):
                    break
                if cmd == "help":
                    click.echo(
                        ":n <int>   set result count (current: "
                        f"{n_results})\n"
                        ":help      show this help\n"
                        ":quit      exit"
                    )
                    continue
                if cmd == "n":
                    try:
                        new_n = int(arg)
                        if new_n < 1:
                            raise ValueError
                        n_results = new_n
                        click.echo(f"n_results = {n_results}")
                    except ValueError:
                        click.secho("usage: :n <positive int>", fg="yellow")
                    continue
                click.secho(f"unknown command: :{cmd}", fg="yellow")
                continue

            try:
                results = search_footage(
                    query, store, n_results=n_results, verbose=verbose,
                )
            except Exception as e:
                click.secho(f"Error: {e}", fg="red")
                continue

            _print_shell_results(results, threshold)

        if readline is not None:
            try:
                readline.write_history_file(_HISTORY_PATH)
            except OSError:
                pass

    except Exception as e:
        _handle_error(e)
    finally:
        reset_embedder()


# -----------------------------------------------------------------------
# overlay
# -----------------------------------------------------------------------

@cli.command()
@click.argument("video", type=click.Path(exists=True, dir_okay=False))
@click.option("-o", "--output", default=None,
              help="Output path (default: <video>_overlay.mp4).")
@click.option("--open/--no-open", "open_result", default=False, show_default=True,
              help="Open the output video after saving.")
def overlay(video, output, open_result):
    """Apply Tesla telemetry overlay to a VIDEO file for testing."""
    from .chunker import _get_video_duration

    video = os.path.abspath(video)
    if output is None:
        output = _overlay_output_path(video)

    try:
        duration = _get_video_duration(video)
    except Exception as e:
        _handle_error(e)

    success = _apply_overlay_to_clip(
        video, video, 0.0, duration, replace=False,
    )
    if success:
        overlay_path = _overlay_output_path(video)
        if output != overlay_path and os.path.isfile(overlay_path):
            os.replace(overlay_path, output)
        click.secho(f"Saved: {output}", fg="green")
        _cache_last_clip(output)
        if open_result:
            _open_file(output)
    else:
        raise SystemExit(1)


# -----------------------------------------------------------------------
# stats
# -----------------------------------------------------------------------

@cli.command()
def stats():
    """Print index statistics."""
    from .store import SentryStore, detect_index

    backend, model = detect_index()
    if backend is None:
        backend = "gemini"
    store = SentryStore(backend=backend, model=model)
    s = store.get_stats()

    if s["total_chunks"] == 0:
        click.echo("Index is empty. Run `sentrysearch index <directory>` first.")
        return

    click.echo(f"Total chunks:  {s['total_chunks']}")
    click.echo(f"Source files:  {s['unique_source_files']}")
    backend_label = store.get_backend()
    if model:
        backend_label += f" ({model})"
    click.echo(f"Backend:       {backend_label}")
    click.echo("\nIndexed files:")
    for f in s["source_files"]:
        exists = os.path.exists(f)
        label = "" if exists else "  [missing]"
        click.echo(f"  {f}{label}")


# -----------------------------------------------------------------------
# export-analysis
# -----------------------------------------------------------------------

@cli.command("export-analysis")
@click.argument("source_file", type=click.Path(exists=True, file_okay=True, dir_okay=False))
@click.option("--backend", type=click.Choice(["qwen-cloud"]), default="qwen-cloud")
@click.option("--model", default=None, help="DashScope embedding model id.")
def export_analysis(source_file, backend, model):
    """Export Qwen Cloud chunks for reliable material-library synchronization."""
    from .store import SentryStore

    model = model or default_dashscope_embedding_model()
    store = SentryStore(backend=backend, model=model)
    chunks = store.export_file_chunks(source_file)
    if not chunks:
        raise click.ClickException("No Qwen Cloud analysis exists for this file.")
    dimension = len(chunks[0]["embedding"])
    if dimension <= 0 or any(len(chunk["embedding"]) != dimension for chunk in chunks):
        raise click.ClickException("Stored analysis contains inconsistent vector dimensions.")
    payload = {
        "result_schema_version": 1,
        "embedding_backend": backend,
        "model_name": model,
        "model_version": model,
        "dimension": dimension,
        "chunks": chunks,
    }
    proof = store.export_analysis_provenance(source_file)
    if proof is not None:
        from .analysis_cache import manifest_from_export
        try:
            manifest_from_export(source_file, chunks, proof, backend, model)
        except (OSError, KeyError, TypeError, ValueError) as exc:
            raise click.ClickException(f"Stored analysis is incomplete or no longer matches this file: {exc}") from exc
        payload["analysis_provenance"] = proof
    click.echo(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


# -----------------------------------------------------------------------
# import-analysis
# -----------------------------------------------------------------------

@cli.command("import-analysis")
@click.argument("source_file", type=click.Path(exists=True, file_okay=True, dir_okay=False))
@click.argument("analysis_file", type=click.Path(exists=True, file_okay=True, dir_okay=False))
@click.option("--backend", type=click.Choice(["qwen-cloud"]), default="qwen-cloud")
@click.option("--model", default=None, help="DashScope embedding model id.")
def import_analysis(source_file, analysis_file, backend, model):
    """Restore authenticated cloud analysis into the local vector index."""
    from .store import SentryStore

    try:
        with open(analysis_file, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise click.ClickException(f"Analysis result file is invalid: {exc}") from exc
    if not isinstance(payload, dict) or payload.get("embedding_backend") != backend:
        raise click.ClickException("Analysis backend does not match qwen-cloud.")
    configured_model = model or str(payload.get("model_name") or "").strip()
    if not configured_model:
        raise click.ClickException("Analysis result is missing its model id.")
    if configured_model != payload.get("model_name"):
        raise click.ClickException("Analysis model differs from the requested model.")
    dimension = int(payload.get("dimension") or 0)
    chunks = payload.get("chunks")
    if dimension <= 0 or not isinstance(chunks, list) or not 1 <= len(chunks) <= 10_000:
        raise click.ClickException("Analysis result dimensions or chunks are invalid.")
    for chunk in chunks:
        embedding = chunk.get("embedding") if isinstance(chunk, dict) else None
        if (
            not isinstance(embedding, list)
            or len(embedding) != dimension
            or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in embedding)
        ):
            raise click.ClickException("Analysis result contains an invalid embedding.")
    store = SentryStore(backend=backend, model=configured_model)
    try:
        manifest = None
        proof = payload.get("analysis_provenance")
        if proof is not None:
            from .analysis_cache import manifest_from_export, seed_manifest
            manifest = manifest_from_export(source_file, chunks, proof, backend, configured_model)
        imported = store.import_file_chunks(source_file, chunks, analysis_manifest=manifest)
        if manifest is not None:
            seed_manifest(manifest)
        else:
            click.echo("Legacy analysis restored for its original path; content/profile proof missing, "
                       "so future indexing requires one verified analysis before cross-path reuse.", err=True)
    except (KeyError, TypeError, ValueError) as exc:
        raise click.ClickException(f"Analysis result contains invalid chunks: {exc}") from exc
    click.echo(json.dumps({"imported_chunks": imported}, separators=(",", ":")))


# -----------------------------------------------------------------------
# clean-missing
# -----------------------------------------------------------------------

@cli.command("clean-missing")
@click.option("--backend", type=click.Choice(_BACKEND_CHOICES), default=None,
              help="Backend to clean (auto-detected if omitted).")
@click.option("--model", default=None,
              help="Model to clean (auto-detected if omitted). Implies --backend local.")
@click.option("--dry-run", is_flag=True,
              help="Only list missing files; do not remove anything.")
def clean_missing(backend, model, dry_run):
    """Remove indexed files whose source files no longer exist."""
    from .store import SentryStore, detect_index

    if model is not None and backend is None:
        backend = "local"
    if backend is None:
        backend, detected_model = detect_index()
        if backend is None:
            backend = "gemini"
        if model is None:
            model = detected_model
    elif backend == "local" and model is None:
        _, model = detect_index()
    elif backend == "qwen-cloud" and model is None:
        _, model = detect_index()
        model = model or default_dashscope_embedding_model()

    store = SentryStore(backend=backend, model=model)
    s = store.get_stats()

    if s["total_chunks"] == 0:
        click.echo("Index is empty. Nothing to clean.")
        return

    missing = [f for f in s["source_files"] if not os.path.exists(f)]
    if not missing:
        click.echo("No missing indexed files found.")
        return

    total_chunks = 0
    for source_file in missing:
        results = store.collection.get(where={"source_file": source_file})
        count = len(results["ids"])
        total_chunks += count
        if dry_run:
            click.echo(f"Would remove {count} chunks from missing file: {source_file}")
        else:
            removed = store.remove_file(source_file)
            click.echo(f"Removed {removed} chunks from missing file: {source_file}")

    action = "Would remove" if dry_run else "Removed"
    click.echo(f"\n{action} {total_chunks} chunks from {len(missing)} missing files.")

# -----------------------------------------------------------------------
# reset
# -----------------------------------------------------------------------

@cli.command()
@click.option("--backend", type=click.Choice(_BACKEND_CHOICES), default=None,
              help="Backend to reset (auto-detected if omitted).")
@click.option("--model", default=None,
              help="Model to reset (auto-detected if omitted). Implies --backend local.")
@click.confirmation_option(prompt="This will delete all indexed data. Continue?")
def reset(backend, model):
    """Delete all indexed data."""
    from .store import SentryStore, detect_index

    if model is not None and backend is None:
        backend = "local"
    if backend is None:
        backend, detected_model = detect_index()
        backend = backend or "gemini"
        if model is None:
            model = detected_model
    elif backend == "local" and model is None:
        _, model = detect_index()
    elif backend == "qwen-cloud" and model is None:
        _, model = detect_index()
        model = model or default_dashscope_embedding_model()

    store = SentryStore(backend=backend, model=model)
    s = store.get_stats()

    if s["total_chunks"] == 0:
        click.echo("Index is already empty.")
        return

    for f in s["source_files"]:
        store.remove_file(f)

    click.echo(f"Removed {s['total_chunks']} chunks from {s['unique_source_files']} files.")


# -----------------------------------------------------------------------
# remove
# -----------------------------------------------------------------------

@cli.command()
@click.argument("files", nargs=-1, required=True)
@click.option("--backend", type=click.Choice(_BACKEND_CHOICES), default=None,
              help="Backend to remove from (auto-detected if omitted).")
@click.option("--model", default=None,
              help="Model to remove from (auto-detected if omitted). Implies --backend local.")
def remove(files, backend, model):
    """Remove specific files from the index.

    Accepts full paths or substrings that match indexed file paths.
    """
    from .store import SentryStore, detect_index

    if model is not None and backend is None:
        backend = "local"
    if backend is None:
        backend, detected_model = detect_index()
        backend = backend or "gemini"
        if model is None:
            model = detected_model
    elif backend == "local" and model is None:
        _, model = detect_index()
    elif backend == "qwen-cloud" and model is None:
        _, model = detect_index()
        model = model or default_dashscope_embedding_model()

    store = SentryStore(backend=backend, model=model)
    s = store.get_stats()

    if s["total_chunks"] == 0:
        click.echo("Index is empty.")
        return

    total_removed = 0
    for pattern in files:
        # Match against indexed source files (substring match)
        matches = [f for f in s["source_files"] if pattern in f]
        if not matches:
            click.echo(f"No indexed files matching '{pattern}'")
            continue
        for source_file in matches:
            removed = store.remove_file(source_file)
            click.echo(f"Removed {removed} chunks from {source_file}")
            total_removed += removed

    if total_removed:
        click.echo(f"\nTotal: removed {total_removed} chunks.")


# -----------------------------------------------------------------------
# dlq
# -----------------------------------------------------------------------

@cli.group()
def dlq():
    """Inspect or clear the dead-letter queue of failed chunks."""


@dlq.command("list")
def dlq_list():
    """Show chunks that failed to embed."""
    from datetime import datetime

    from .dlq import DeadLetterQueue

    q = DeadLetterQueue()
    entries = q.entries()
    if not entries:
        click.echo("DLQ is empty.")
        return

    click.echo(f"{len(entries)} chunk(s) in the DLQ:\n")
    for chunk_id, info in sorted(
        entries.items(), key=lambda kv: kv[1]["last_attempt"]
    ):
        ts = datetime.fromtimestamp(info["last_attempt"]).strftime("%Y-%m-%d %H:%M:%S")
        basename = os.path.basename(info["source_file"])
        click.echo(
            f"  {chunk_id}  {basename} "
            f"@ {_fmt_time(info['start_time'])}-{_fmt_time(info['end_time'])}  "
            f"(attempts={info['attempts']}, last={ts})"
        )
        click.echo(f"    error: {info['error']}")
    click.echo(
        "\nRetry with: sentrysearch index <directory> --retry-failed"
    )


@dlq.command("clear")
@click.confirmation_option(prompt="Clear all DLQ entries?")
def dlq_clear():
    """Remove all entries from the dead-letter queue."""
    from .dlq import DeadLetterQueue

    q = DeadLetterQueue()
    count = q.clear()
    click.echo(f"Cleared {count} DLQ entries.")
