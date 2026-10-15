# U6 folder-open verification — STOP (51390393)

Candidate source: `4d62e25965cbae0bd25f53ff2c45881082c87db6`. This package records one isolated native GUI U6 recovery attempt and is a STOP record, not an overall U6 pass.

## Result and stop gate

The prior isolated queue was absent after reopening the same user-data root, so the explicit missing-queue branch imported the frozen formal workbook exactly once. The captured Candidate process satisfied the corrected template gate: outer engine exit 1, inner `normalize_script` exit `Some(2)`, one nonempty stderr wrapper line, 8 shots, 2 blocked cells (shot 8 I9/口播 and K9/上屏文字), and 53 warnings split 43 `ai_suggested` + 8 `status_pending` + 2 `status_note`.

The native queue displayed that exact red card. The operator then clicked `打开所在文件夹` exactly once. Electron rejected the directory `D:\autocut\video-auto-cut\docs\script-template-v1` through `workspaceService.assertInsideWorkspace` with `目录不在工作区内，已拒绝删除`; no Explorer window opened or navigated to `script-template-v1`. U6 therefore stopped. The synthetic bad-shot import, U7, food E2E, Generate and W6 were not run.

## UI evidence

The five public PNGs are same-pixel conversions of original official-Sky JPEG captures:

- queue absent before the explicitly allowed formal recovery import;
- formal import main failure state;
- queue card before the single folder-button click;
- unchanged queue card after the rejected folder action;
- the pre-existing repository Explorer window, demonstrating that the click did not navigate it to `script-template-v1`.

Each PNG has a pixel-equivalence receipt containing the private source JPEG SHA-256, PNG SHA-256, dimensions and decoded RGB hashes. One unrelated pre-existing `review-page` Explorer screenshot remains only in the private audit and is intentionally excluded. The original full Sky window inventory also remains private; `receipts/window-inventory.derived.json` is explicitly derived, contains only the isolated Electron and Explorer entries, and records the original-inventory SHA. The derived file's own SHA is covered by `artifact-manifest.json` and `SHA256SUMS.txt`.

## Raw logs and line numbering

The complete launcher stdout/stderr and Electron observer bytes are copied without newline normalization. The folder error is at raw `rg` lines 22 and 28. A strict CRLF/LF/CR split reports logical lines 23 and 29, beginning at byte offsets 737 and 1316; standalone CR build-progress records explain the line-number difference. The difference is retained and explained rather than editing the raw log. The startup line showing Desktop package version `0.5.14` comes from the user's dirty Desktop package metadata. It does not identify or replace the frozen Candidate engine; `current.json` and engine SHA below are the runtime identity evidence.

## Runtime and model classification

Both pre-import and post-stop `current.json` snapshots are byte-identical, SHA-256 `4f4d6dbe81e1e852715f1cc6eead62ff02b81c2d094d5213a339f4f2b703af21`. Candidate engine SHA-256 is `be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf`.

Model calls were 0. Formal stdout has 43 exact local `[script] 标准模板导入 ai_suggested` reminder lines and one matching event line. Qwen, DashScope/百炼, model-name/API and AI upload/parse-path markers were 0. The one stderr string `AI 解析脚本文档失败` is the accepted generic outer wrapper around the local parser exit and is not a model call.

The help preflight ran once and is not an import or model call. Actual counts were: formal imports 1, bad-shot imports 0, U7 imports 0, Qwen/model 0, Generate 0, folder-button clicks 1. The separate U7 static question at issue comment `51390765` remains a pre-click HOLD; it is not a U7 failure.

## Shutdown and integrity

The isolated window closed naturally through official Sky `Alt+F4` after PID and command identity checks. Electron owner PID 5836 and launcher PID 22848 exited; ports 4173 and 9 had zero listeners; no force-kill was used. All six protected hashes remained unchanged and Git retained only the user's two dirty package files.

`.gitattributes` sets `* -text` so raw CR/LF/CR bytes, trailing whitespace and binary evidence remain unchanged in Git. `artifact-manifest.json` covers every payload except itself and `SHA256SUMS.txt`; `SHA256SUMS.txt` covers the payload plus the manifest and excludes itself.
