# U6 revalidation STOP — runtime mismatch

- Source HEAD: `d34557036205c36e97e6e2f006d2cede329a7e2c`.
- App remains running; no badshot, Generate, U7, E2E, or W6 action followed.
- Preflight: Candidate `--help` only, exit 0, not an import/model call.
- Formal GUI imports: **1**. Input SHA-256 `64d23f4889081c0239f396db40a4ef18744779232376eeba90d96c5d1ff48b63`.
- At import time, `current.json` identified `0.5.14` under the isolated runtime directory; expected 3715aa4 Candidate was not used. The trigger that changed `current.json` is not proven by persisted evidence.
- The operator did not click any install/update/upgrade control and did not press a key to confirm an update. The complete relevant UI action order was: activate isolated window; click 脚本文件; click 选择脚本; double-click 转换演示_v1表格.xlsx; click 导入并整理分镜; observe/capture result.
- Import exited 0 and produced 8 shots/29% ready UI instead of the required exit 2/two-issue red card.
- Raw stdout: `raw-electron-stdout/observer-37812-seq-2-child-39716-stdout.bin`, 8708 bytes, SHA-256 `b350a0c83a4da48d195a5199424cefc360df52dd1b71916de1d671bfae07fd05`.
- Raw stderr: `raw-electron-stdout/observer-37812-seq-2-child-39716-stderr.bin`, 0 bytes, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- Raw VACUT_EVENT bytes: `raw-electron-stdout/observer-37812-seq-2-child-39716-vacut-events.bin`, 4 lines/589 bytes, SHA-256 `2580e148201b208ffa4e4b37bc2dc8d0cee811319abf23a5a91e57f2f5c81f82`.
- Qwen boundary: one call is proven (`normalize_with_ai`); file upload is excluded. The voice/subtitle review branch did not run. Persisted artifacts cannot distinguish 0–2 progress-label review calls, so the defensible total is **1–3**. Successful requests had no retry warning.
- Raw capture scan found no credential keywords, OpenAI-style keys, Aliyun-style keys, or JWT-like tokens.
- Screenshot: `screenshots/STOP-runtime-drift-formal-ready.jpg`.
- All six protected hashes still match. Git status contains only the two user package modifications.
