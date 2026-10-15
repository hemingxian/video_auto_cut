# U6 fix revalidation stop evidence — 2026-09-28 / 51388185

Source HEAD: `d34557036205c36e97e6e2f006d2cede329a7e2c`.

The Electron observer and Candidate `--help` preflight passed, but the single
authorized formal GUI import did not exercise the required 3715aa4 Candidate.
At import time the isolated `current.json` identified runtime `0.5.14`, and the
engine ran that runtime's `tools/normalize_script.py`. It exited 0 and produced
an eight-shot plan at 29% instead of the expected exit-2 queue card containing
the two frozen I9/K9 issues. This run therefore does not validate the fix.

The persisted evidence does not establish what changed `current.json`. The UI
operator did not click an install, update, or upgrade control and did not press
a key to confirm an update. The complete relevant input order was:

1. Activate the isolated VideoAutoCut window.
2. Click **脚本文件**.
3. Click **选择脚本**.
4. Double-click `转换演示_v1表格.xlsx` in the Windows file picker.
5. Click **导入并整理分镜**.
6. Observe and capture the result without further input.

There were no other key presses or clicks. Exact click timestamps were not
persisted; `operator-timeline.json` records the available process and receipt
time anchors. No badshot import, Generate, U7, E2E, or W6 action followed.
The isolated app remains running for review.

The formal input SHA-256 was
`64d23f4889081c0239f396db40a4ef18744779232376eeba90d96c5d1ff48b63`.
`raw/formal-stdout.bin`, `raw/formal-stderr.bin`, and
`raw/formal-vacut-events.bin` are byte-for-byte files observed inside the real
Electron browser process. Their metadata is in `raw/formal-metadata.json`.
The help preflight is separately labelled under `raw/help-*`; it is not an
import or a model call.

The formal stdout proves one `normalize_with_ai -> call_qwen` call. The
separate file upload is excluded from that count. The voice/subtitle review
branch did not run. The successful `call_qwen` path is silent, so the existing
artifacts cannot distinguish zero through two progress-label review calls.
The defensible Qwen total is therefore **1–3**. No HTTP retry warning appears.

`raw-secret-scan.json` records a credential-pattern scan of the ten original
observer files. No credential, key, or JWT-like pattern was detected, so the
raw files were copied without modification. The remote upload file identifier
is retained because the raw stdout must remain exact; it is not counted as a
credential or a Qwen call.

The original Sky JPEG is preserved under `screenshots/`. The adjacent PNG is a
lossless conversion of its decoded RGB pixels; the equality receipt records
the source/output hashes, dimensions, and decoded RGB hash.

`STOP-runtime-drift.json` is the detailed machine-readable receipt.
`STOP-runtime-drift.md` is the concise stop report. `current.sanitized.json`
records only relative paths, version/package metadata, public hosts, and the
unconfirmed trigger status; it contains no auth or config values. The
`tests/` directory is maintained separately by the root reviewer.
