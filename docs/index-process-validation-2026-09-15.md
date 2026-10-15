# 索引进度、进程树与超时验证（2026-09-15）

本次仅为 Rust 的 `sentrysearch index` 增加流式输出和总预算；其他 `run_command`、捕获输出及已有超时调用保持原实现。Python 的逐文件/分块缓存、标准化缓存和模型单次请求限制由各自模块实现。

## 行为与边界

- `index_process.rs` 同时读取 stdout/stderr，遇到换行或回车立即转发到引擎输出并追加、刷新 `run.log`。每条读取缓冲最多 16 KiB，队列最多 64 条，超长无换行内容分段输出；不在 Rust 内收集整步输出。非法 UTF-8 使用替代字符，仍有固定上界。
- 每 10 秒输出已用时间、当前预算/硬上限、当前文件和分块、已完成分块及缓存数。完成数仅来自 Python 的 `completed_chunks` / `cached_chunks`，不把分块序号当作完成数。文件数和真实 `chunks` 可扩大工作量预算，不会缩小已分配预算。
- `material_clip.rs` 从实际索引输入统计 `.mp4` / `.mov`（与 Python 扫描扩展名一致），包含 `_indexed_h264` 下的文件。原始素材发现函数会排除该目录，不能用于预算计数；回归覆盖这一差别。
- Windows 在子进程执行前创建 Job、设置 `KILL_ON_JOB_CLOSE`，以 `CREATE_SUSPENDED | CREATE_NO_WINDOW` 启动、加入 Job 后恢复初始线程。超时结束整个 Job；父进程退出后也清理尚未退出的后代，避免后代继续占用管道。清理后最多等待管道 2 秒，必要时取消同步读取，不做无限期 join。
- 桌面当前“暂停”是终止进程树并保留检查点，继续会重新启动引擎，不是 OS suspend。每次索引调用使用新计时器，暂停时间不会累计到继续后的预算。引擎被终止时，Windows 关闭其 Job 句柄也会清理索引后代。未新增暂停语义或更改恢复路径。
- Unix 采用进程组终止，代码已保留对应实现；本次真实进程验证在 Windows 完成，未宣称已在 Unix 实机验证。

## 预算配置

默认总预算为 `180 + 文件数 × 60 + 估计块数 × 每块预算` 秒；未知文件先预留 4 块，观测到更多实际块时扩大，最后受总时长上限约束。

每块最低预算按 Python 子步骤硬界限计算：

`4 × VIDEOAUTO_INDEX_STEP_TIMEOUT_SECONDS + 3 × (VIDEOAUTO_QWEN_ATTEMPT_TIMEOUT_SECONDS + 60) + 6 + 30 + 30`

其中 4 次为 split/still/preprocess 上限，3 次模型 attempt 固定，60 秒为单次限流等待，6 秒为两次退避，另预留探测和处理开销。默认 `4×300 + 3×(180+60) + 6 + 30 + 30 = 1986` 秒/块。HTTP timeout 在 Python attempt 硬时限内部。工作量超出 12 小时仍会触发明确的总时长硬上限，不声称任何数量的素材都能无限等待。

| 环境项 | 默认 / 行为 |
| --- | --- |
| `SENTRY_INDEX_MAX_TIMEOUT_SECONDS` | 43200 秒；范围 60–86400，绝对最高 24 小时 |
| `SENTRY_INDEX_TIMEOUT_SECONDS` | 默认不设置，按工作量动态计算；设置正整数后为固定总预算，最低 60 秒且不能超过硬上限 |
| `SENTRY_INDEX_FILE_TIMEOUT_SECONDS` | 每文件额外 60 秒；范围 5–600 |
| `SENTRY_INDEX_CHUNK_TIMEOUT_SECONDS` | 默认由上述公式计算；可增加，不能低于当前子步骤时限推导值 |
| `SENTRY_INDEX_HEARTBEAT_SECONDS` | 10 秒；范围 1–60 |
| `VIDEOAUTO_INDEX_STEP_TIMEOUT_SECONDS` | Python 每个 ffmpeg 子步骤默认 300 秒；1–1800；Rust 读取同一配置 |
| `VIDEOAUTO_QWEN_ATTEMPT_TIMEOUT_SECONDS` | Python 单次模型尝试硬时限默认 180 秒；1–1800；Rust 读取同一配置 |

错误明确区分按工作量计算的预算、用户配置的总预算和总时长硬上限。超时后提示已经终止索引进程树，可继续任务复用已完成索引。

## 实测结果

Windows Rust 测试：`cargo test process:: -- --nocapture` **15/15 通过**；其中 10 项新增索引测试、5 项原进程回归。新增测试覆盖：

1. 真实子进程 stdout/stderr、回车进度、末尾无换行内容，在退出前已收到且带等待提示。
2. 约 2 MiB 无换行输出按固定缓冲分段，stdout/stderr 内容保留。
3. 超时结束仍在运行的孙进程；父进程已退出而孙进程仍持有管道时，也能在有界时间内清理。
4. 直接结束模拟引擎宿主，验证 Job 句柄关闭会结束真实索引后代并让读取线程退出（暂停场景）。
5. 停止/超时后重新启动得到新预算。
6. 真实子进程输出及等待提示进入独立临时 `run.log`。
7. 工作量预算按真实块数扩大、不缩小、受硬上限限制；公式覆盖子步骤时限和重试。
8. 完成/缓存统计仅采用上报值，汇总不同文件，拒绝无效计数。

`cargo test material_clip::tests::index_budget_counts -- --nocapture` **1/1 通过**：真实创建 `_indexed_h264` 和嵌套目录，确认计数包含 3 个受支持视频，单文件 1、缺失路径 0，并验证原素材发现函数确实排除该目录。

桌面日志解码与队列测试：`node --experimental-strip-types --test tests/task-event-reducer.test.mjs tests/task-events.test.mjs` **13/13 通过**。新测试确认 `Indexing file`、`VACUT_INDEX_PROGRESS`、cache hit 和中文等待提示保留在日志中，并保持原工作流计数，未把 74 份索引输入变成已选片段数。现有工作流支持 `indexing → 索引素材` 标签，日志订阅直接追加输出，因此无需新增前端协议或改变用户流程。

本文件记录进程/日志的真实本地子进程验证及桌面模型验证；真实云模型索引与跨任务缓存复用验收由整体验收记录单独报告。本任务未打包或发布。
