# U6 dedicated script reveal revalidation (51391164)

Source commit `5893f7dc76bc87faa7c7907327807fb8893acb3d` revalidated the dedicated `script:reveal` path in the real isolated Electron UI. The frozen Candidate engine remained `be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf`; the isolated `current.json` stayed byte-identical before both imports and after completion.

## Result

- PASS: the preserved queue was visibly empty, so the one authorized formal import was used.
- PASS: the frozen formal workbook produced the exact template result: 8 shots, 2 blocked items, 53 warnings (`43 ai_suggested`, `8 status_pending`, `2 status_note`), outer engine exit 1 and inner `normalize_script` exit 2. The queue card shows shot 8 at `I9 / 口播` and `K9 / 上屏文字`.
- PASS: `打开所在文件夹` was clicked exactly once. A new Explorer window opened at `D:/autocut/video-auto-cut/docs/script-template-v1` with `转换演示_v1表格.xlsx` selected. Final launcher logs contain no `script:reveal`, `folder:open`, rejection, or error match.
- PASS: the original synthetic bad-shot fixture produced one blocked item and no warnings: `A2 / -1 / 镜号 / shot_no_invalid`.
- Model calls were zero. The formal stdout contains only the 43 allowed static `ai_suggested` lines plus the corresponding event line. The bad-shot stdout contains no literal `AI` line. No Qwen, DashScope, 百炼, model API, or model-name marker was observed.
- The script drawer did expose `统一设置素材范围` and per-script `绑定素材` controls. No material scope was selected for these U6 parser/reveal checks. The formal task stopped at 3% while reading the script, before material matching. This evidence does not claim that a range was selected.

## Fix validation

The behavioral baseline at parent `25fcd892e6ada40e2498e28e5aff9b7af26a0f71` records a successful `task:start`, the missing dedicated `script:reveal` handler, the old blocked-card wiring through workspace `folder:open`, and the workspace guard rejection for the external frozen script. The final fix at `5893f7dc76bc87faa7c7907327807fb8893acb3d` passed the focused suite (55/55, no skips), full suite (421 total, 419 passed, 0 failed, 2 pre-existing skips), build, and changed-file lint. The changed-file lint command output was not persisted; its exact exit receipt is included and this package does not claim a missing log exists. See `tests/fix-validation.json` and the copied original logs.

The UI label `v0.5.14` comes from the user's pre-existing dirty Desktop package files. It is distinct from the frozen Candidate engine identity above. Those two package files remained the only working-tree changes and were not staged or modified by this run.

## Evidence notes

Raw Electron-received stdout, stderr, VACUT events, metadata, and the zero-import help preflight are copied byte-for-byte under `raw/`. `.gitattributes` disables text conversion so their original line endings remain intact. Independent root receipts are under `receipts/`.

Each published native screenshot includes the original Sky JPEG and a PNG with identical decoded pixels. `receipts/screenshot-pixels.json` records the mapping. Two private images are intentionally excluded: the initial loading-only blank frame cannot prove an empty queue, and the first Explorer capture included unrelated desktop windows. The published Explorer image is the separate official Sky target-window screenshot, not a crop or reconstruction.

The isolated app was closed naturally through official Computer Use `Alt+F4`. Electron and its launcher exited, ports 4173 and 9 had no listener, and all six protected hashes remained unchanged. U7, Generate, food E2E, W6, cleanup, engine publication, and master merge were not run in this evidence phase.
