# W6 STOP 证据索引

- `REPORT.md`：唯一正式 pack 的结论、零计数与准备 helper 修正边界。
- `receipts/instruction-51407111.md`：有效工单原文。
- `receipts/SOURCE-LOCK.json`、`FROZEN-INPUTS.json`、`worktree-created.json`、`W6-ISOLATED-STATE.json`：源锁、冻结输入、隔离 worktree 与最终状态。
- `receipts/pack-runtime.log`、`STOP-FACTS.json`：唯一正式 pack exit 1 原始日志及结构化事实。
- `receipts/*install.log`、`*check.log`：Pi/HyperFrames 物理安装与检查日志。
- `receipts/probe-*.json`、`process-temp.json`：owned probe 与隔离 TEMP 收据。
- `receipts/protected-main-before.json`、`protected-main-after-stop.json`：主六项保护 SHA，未复制受保护配置内容。
- `receipts/v1-*`：第一次准备 helper 在 SOURCE-LOCK 前停止时已写的冻结收据。
- `helpers/`：本轮审查和执行的主要隔离 helper；30/40 被保留用于证明其存在，但本轮调用为 0。
- `artifact-manifest.json`、`SHA256SUMS.txt`：证据文件字节数与 SHA256。
