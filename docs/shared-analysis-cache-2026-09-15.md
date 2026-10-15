# Shared content analysis cache (2026-09-15)

This document describes the Python portion of the cross-shot/cross-task indexing fix. Rust normalization, process supervision, desktop/cloud provenance transport, real provider validation and release are coordinated separately by the root task.

## Cause and behavior

The earlier index identified a vector by `source_file:start_time`. Every shot staged the same assets under a new directory, so the path-based index missed even when source bytes were identical. Original-library/cloud vectors were also bound to their original path. Existing per-shot resume did not solve reuse across shots or tasks.

`analysis_cache.py` now keys a shared analysis by source SHA-256 and the complete analysis profile: backend/model/dimensions; chunk duration and overlap; preprocessing enablement, resolution, fps, codec settings and FFmpeg binary hash; still detection enablement, algorithm and threshold; backend video sampling parameters; and quantization setting. The versioned contract distinguishes future algorithm changes. Endpoint provenance excludes userinfo, query and fragment and does not contain API keys or local paths.

The cache lives at `<VIDEOAUTO_DATA_ROOT>/video/analysis-cache/v1/<key>/manifest.json` (or `~/.sentrysearch/analysis-cache/v1`). Each successful embedding or still decision is a separately checksummed receipt. Writes use a temporary file, flush/fsync and atomic replacement. A Windows/POSIX OS file lock serializes analysis of identical content, releases on process exit and has a bounded wait. Failed chunks do not mark the file complete; a later run retries missing chunks while retaining verified successes. Changed source/model/settings, invalid receipt values, incomplete exports and corrupted metadata cannot silently certify old analysis.

Searchable vectors remain separate aliases with the current absolute source path. Previous spans for a replaced/reconfigured path are removed before mounting verified receipts. `SentryStore.search` retains its `allowed_source_files` filter before ranking, so shared analysis does not broaden a shot's material scope.

## Original, normalized and cloud compatibility

Rust provides `<normalized-file>.source.json` with source/output hashes and sizes, normalization profile and `time_mapping: identity`. Python checks the actual original and normalized bytes. With the default preprocessing enabled, analysis reads the verified original bytes and performs the same chunk/preprocessing operations used by original-library analysis; the normalized file is only the searchable alias. This gives original analysis and all normalized shots the exact same analysis input, rather than assuming that lossy re-encoding has identical pixels.

When preprocessing is disabled, normalized analysis keeps its normalization profile in the content key. A missing original or rejected sidecar falls back to the actual input's hash with an explicit log, and does not claim compatibility with original analysis.

New `export-analysis` payloads carry optional `analysis_provenance` containing `schema_version`, `source_identity`, `analysis_profile`, actual duration, expected spans and skipped-still spans. Import checks actual source identity, backend/model/dimensions, complete expected ranges and finite vectors before seeding shared receipts. A later index must request the identical profile to reuse them. Old authenticated payloads without provenance still restore for original-path use, but explicitly lack proof for cross-path reuse; one verified analysis is required. HNSW float32 rounding is handled by preserving the checksummed analysis receipt separately from searchable vector storage.

## Progress and finite waits

Indexing emits readable per-file/per-chunk phase, hit, elapsed-time and failure messages plus `VACUT_INDEX_PROGRESS:` JSON. `file/files` describe the current command, `chunks` is that file's actual expected chunk count, and `completed_chunks/cached_chunks` are current-file cumulative totals. Still receipts count as completed/cache hits. Chunk ordinals are not reported as completed work.

FFmpeg split/still/preprocessing calls have explicit `VIDEOAUTO_INDEX_STEP_TIMEOUT_SECONDS` (default 300, range 1–1800); duration probing is at most 30 seconds. Strict indexing treats preprocessing/still failures as failures instead of silently changing the requested analysis input.

Qwen HTTP calls receive `DASHSCOPE_REQUEST_TIMEOUT_SECONDS` (default 120, range 1–900). The SDK has a separate upload timeout internally, so each video upload+inference attempt runs in `qwen_request_worker.py`, bounded by `VIDEOAUTO_QWEN_ATTEMPT_TIMEOUT_SECONDS` (default 180, range 1–1800). The backend owns at most three attempts with 2/4-second backoffs; the CLI no longer multiplies these with its old outer retry loop. Nonretryable provider errors fail immediately. Credentials are inherited by the worker environment and are absent from worker arguments and input JSON. Rust supplies the whole-command/descendant-process budget and log supervision.

## Validation at code freeze

- System Python: `python -m pytest VideoAutoCut/tests -q`: **211 passed, 2 skipped**. Both skips are the real Chroma/CLI integration cases unavailable in the system Python environment.
- Packaged Python 3.11: `python.exe -m unittest discover -s VideoAutoCut/tests -p test_analysis_cache.py -q`: **13 passed**, including both integration cases.
- Real FFmpeg motion media plus counted offline embeddings verifies original path → two differently encoded normalized shot paths calls the embedder once; each real Chroma scoped query returns only its own shot path. It also verifies concurrent requests, changed content/model/parameters, corrupt cache/store fallback, partial failure resume, still receipts, source changes during requests, and export/import reuse through real Click command branches.
- Qwen tests verify explicit HTTP timeout, at most three attempts, no retry on 401, no key in child payload, and an actually sleeping process terminated by a one-second attempt deadline.
- `git diff --check` for these changes passes.

The offline embedding tests are not real provider or business-video end-to-end results. The root task separately reported successful real-Qwen source-engine runs for three source assets over multiple shots and two consecutive tasks, including final 720p outputs; candidate-runtime repetition and publication remain root-owned release gates.
