# U7 main UI capture preparation (51391241)

This ignored preparation is for the one authorized GUI import of the frozen non-template workbook. Creating and reviewing these helpers does not start Electron, upload the workbook, import a task, or call a model.

## Fixed inputs and runtime

- Source HEAD after the U6 evidence commit: `1c307c384a2ffaeed02bf29d5da55b671d3b59ab`.
- Product fix/build HEAD: `5893f7dc76bc87faa7c7907327807fb8893acb3d` (the later commit is docs-only).
- Reused isolation: `VideoAutoCutDesktop/node_modules/.tmp/ui-u6-51388993-314c52f-20260928`.
- New phase: `phase-51391241-u7-1c307c3`; prior U6 raw streams, receipts, screenshots, and persisted state are not overwritten.
- Candidate engine SHA-256: `be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf`.
- Frozen input: `docs/packaging-test-scripts-2026-09-21/07_表格版_混合_show判定_食品码垛_CN.xlsx`.
- Frozen input SHA-256: `32928ce140c3d8b25ad0b5ac482896b3698417f7de8401920c9129c3b030697e`.

The process-only runtime manifest aliases remain `http://127.0.0.1:9/runtime/manifest.json`, with port 9 required to have no listener. No `app.env`, auth, model configuration, runtime manifest, or production root is written.

## Model and retry accounting

The isolated `app.env` currently contains no override for `DASHSCOPE_SCRIPT_MODEL`, `DASHSCOPE_SCRIPT_REVIEW_MODEL`, `VIDEOAUTO_SCRIPT_REVIEW`, or `VIDEOAUTO_HTTP_RETRIES`; the launch helper also rejects inherited overrides for those keys. Therefore the frozen source selects:

- parse model: `qwen-long` (`normalize_script.py` default);
- voice/subtitle review model: `qwen-long` when the source predicate runs it;
- script review: enabled by default;
- HTTP attempts: at most 5 per request by default.

The GUI import click is counted separately from model calls. File upload requests are counted separately from Qwen chat-completion attempts. The capture verifier keeps every original Electron-received byte, inventories automatic retry lines with raw line hashes, and reports both logical model stages and HTTP attempts. It does not disable review or retry behavior.

The progress-label review has no success log. Its zero-call conclusion is accepted only after the verifier reproduces the frozen `progress_labels.py` predicates for every actual shot: `context` comes from `subtitle` or `voice_text`, `language` comes from that context (or the overall context), the restored authored title is passed through `clean_label`, and `label_matches_language` must accept it. A shot also cannot enter `pending` when its context or language is empty. The per-shot predicate inputs and result are persisted. If those facts do not prove `pending=0`, the verifier does not assume zero; it stops the chain for root classification without changing the input, configuration, or model behavior.

Recognized automatic HTTP retry warnings remain allowed and counted. A chapter-label review failure, partial-review fallback, or any other non-retry line containing a model failure/error marker is a STOP even when the outer engine exits 0 and stderr is empty.

## Authorized later sequence

1. Root reviews these helpers and runs `prepare-u7-phase.ps1`.
2. Start `start-u7-phase.ps1` hidden. The observer performs one zero-import engine `--help` preflight.
3. Run `verify-u7-preimport.ps1`; it records the exact current runtime bytes/read time, Candidate engine hash, frozen input hash, safe default-model provenance, and activation/preflight state.
4. Use official Computer Use for one import click. Default internal review and automatic HTTP retries may run. There is no manual retry.
5. Run `verify-u7-capture.ps1 -Sequence 2`, capture the current UI drawer, and retain the task/run state for the separately prepared legacy viewer. Any mismatch is a STOP; do not click import again.

The legacy `1bc0fdb` view is handled by a separate reviewed helper. This phase does not copy or rewrite its configuration.
