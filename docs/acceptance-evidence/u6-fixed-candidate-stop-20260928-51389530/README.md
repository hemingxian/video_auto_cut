# U6 fixed-candidate verification — STOP (51389530)

Candidate source: `314c52f0e77475d8d737e749936084e76ff0c520`. This package records one isolated native GUI U6 attempt and is a STOP record. It is not an overall PASS.

## Stop gate

The formal GUI import was invoked exactly once. The outer engine exited **1**, while the instruction required **2**, so the operator stopped without retry. Engine stderr separately records the inner Python child as `Some(2)`; this package discloses both process layers and does not approve them as equivalent. The UI stopped at 3% with “读取脚本失败”. Bad-shot, folder-open, Generate, U7, food E2E, W6, upload, publication, and merge were not performed.

## Partial observation

The queue card was visible with 2 blocked places. It showed I9/口播 and K9/上屏文字 for shot 8, and the folder button was visible but not clicked. The raw event records one `template` / `VAC-SB-1` report with 8 shots, 2 blocked items, and 53 warnings: 43 `ai_suggested`, 8 `status_pending`, and 2 `status_note`. This partial card observation does not satisfy the full U6 gate.

## Model classification

Model calls were **0**. The complete stdout inventory has 44 case-sensitive `AI` lines: 43 fixed local `[script] 标准模板导入 ai_suggested` reminders and the one complete event line. Qwen, DashScope/百炼, model-name, and model-API markers were 0. The stderr line’s existing generic Rust context “AI 解析脚本文档失败” wraps the local parser failure; it is not evidence of a model call. See [stdout AI lines](raw/AI-lines.stdout.txt), [stderr AI line](raw/AI-lines.stderr.txt), and the [inventory receipt](receipts/STOP-ai-line-inventory.json).

## Runtime and raw receipts

The sanitized `current.json` snapshots before and after the attempt are byte-identical (SHA-256 `4f4d6dbe81e1e852715f1cc6eead62ff02b81c2d094d5213a339f4f2b703af21`). The post-stop read time was `2026-09-28T07:20:12.1063229Z`. Candidate engine SHA-256 was `be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf`. Both process-only aliases, `VIDEOAUTO_RUNTIME_MANIFEST_URL` and `VIDEOAUTOCUT_RUNTIME_MANIFEST_URL`, were `http://127.0.0.1:9/runtime/manifest.json`; port 9 had no listener. No production config was copied.

Formal raw SHA-256: stdout `26db386946d5cfac794984dc6c4cdc5b5d85bd56a343afe4dd087313641e1e1a` (19,876 bytes), stderr `7a8219e2ecad4ab07728c772ce4aee7d718c24ae458b3a0301484f8843281948` (180 bytes), and event `91893d56879180a58dbd8ef72955979f080e0c05877be925f8974981330afae4` (14,380 bytes). After removing its trailing CRLF, the event is byte-identical to the frozen fixture, SHA-256 `52781ff6dbad77bd7238a86c3612add8863eec06956044c5a62a98526527cd92`.

## Screenshots and integrity

The main and queue PNGs are the reviewed primary UI evidence. The real-time log PNG is tagged transitional and is not claimed to clearly prove log text; raw stdout is the log evidence. Each PNG has a pixel-equivalence receipt tying it to the retained local JPEG and confirming identical decoded pixels at 1306×853. `artifact-manifest.json` and `SHA256SUMS.txt` cover all payload files except themselves as documented, and `.gitattributes` disables Git text conversion in this directory.

The app closed naturally through the native window. Electron PID 38016 and launcher PID 40088 were no longer running, with zero listeners on ports 4173 and 9. All six protected hashes remained unchanged.
