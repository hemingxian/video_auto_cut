# 证据索引

本包记录 311d5e5 新 Candidate 的只读构建/同步预检，以及官方原生 UI 不可用后的 STOP。关键文件：

- `REPORT.md`：结论与次数。
- `receipts/static-preflight-stop.json`：冻结身份、六保护和 N/A 实际 spawn 边界。
- `receipts/candidate-sync.json`：157 个 tracked tools 的 repo/Candidate 逐文件哈希。
- `receipts/candidate-bundle-identity.json`：engine + tools bundle 身份。
- `receipts/cargo-build-result.json`、`candidate-checks.json`：构建与只读 checks。
- `receipts/native-capability-block-51405727.{json,md}`：官方 native 三次失败事实。
- `helpers/electron-stdout-tap.cjs`：已准备但未启动的实际 spawn 身份观察 helper。

## 51406527 恢复阶段增补

- `receipts/instruction-51406527.md`、`comment-51406527-readback.json`：最新有效工单原文与 readback。
- `receipts/native-capability-check-51406141.json`：工单要求并入的旧自检收据。
- `receipts/native-capability-check-51406527-public.json`：本轮一次 native 自检成功；私人窗口标题已删去。
- `receipts/pre-import-u7-51406527.json`、`current-before-launch-51406527.json`、`launch-environment-51406527.json`：正式点击前隔离和身份检查。
- `receipts/u7-formal-*`：正式 child 的 spawn、metadata、原始 stdout/stderr/events。
- `receipts/u7-normalized-script-shots.json`、`u7-final-shots.json`、`u7-authored-fields-comparison.json`：normalize 中间结果、正式 run 最终工件，以及两者各自对作者字段 21/21 的逐字比较。
- `receipts/ui-result-shots-1-4.jpg`：导入完成后的 GUI 列表截图；只覆盖可见的第 1–4 镜。
- `receipts/u7-isolated-shutdown.json`：自然关闭后的进程与监听端口检查。
