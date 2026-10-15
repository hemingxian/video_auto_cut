# 食品码垛 E2E STOP 证据（51400401）

本目录记录锁定 source `2cad82d773f8bbfc9e66013628322dd499a3d161`、Candidate engine `be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf` 的一次正式食品 E2E。官方原生 UI 控制不可用后，按合同 §6.4 明确允许的 Route A 备选执行。

plan-only 模板导入成功且 Qwen=0；唯一一次正式 `--restart-all` 在生成 9 套口播、ASR 与 cue 后，于本地素材索引阶段失败并退出 1。没有重试，没有进入 material agent、packaging agent 或 renderer，没有成片。因此字幕逐字、卡片软接缝与最终视频验收均未完成，食品 E2E 整体不通过。

正式运行的原始 stdout/stderr、ASR JSON、MP3 和 cue 文件保留在本地 ignored 审计目录；正式原始流含临时服务 URL，不进入仓库。本目录公开不含敏感内容的 plan-only 原始 stdout/stderr，并为正式运行保留字节数、SHA-256、时间与从原始流机械提取的安全摘录。

`artifact-manifest.json` 枚举公开文件；`SHA256SUMS.txt` 覆盖目录内全部文件（除其自身）。
