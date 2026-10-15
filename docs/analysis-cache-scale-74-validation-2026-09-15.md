# 74 候选规模验证（2026-09-15）

本次是隔离环境下的缓存与检索范围回归。视频生成、拆分、预处理、生产 `sentrysearch index/search`、分析缓存和 Chroma 持久化均使用真实实现；视频和文本 embedding 明确使用计数替身，不调用真实模型。下列时间不代表云模型耗时或匹配质量。

## 输入与隔离

- FFmpeg 生成 3 份不同的 2.2 秒运动短视频，尺寸为 192×108、160×120、108×192；视频内容 SHA-256 各不相同。
- 每个镜头复制为 74 个不同路径候选，候选内容仅来自这 3 份视频，共 148 条路径。
- 镜头目录分别命名 `shot_01`、`shot_010`，用于检验路径前缀相似时仍不会越界。
- 独立临时目录包含全部媒体、Chroma 数据库、分析缓存和检索记录。Python socket 连接被禁止，Chroma 遥测关闭。工作进程结束后删除临时目录，报告确认 `temporary_media_database_removed: true`。
- 没有修改生产源码、用户媒体、用户索引或服务端数据。本测试不覆盖归一化来源 sidecar；该链路由独立转码缓存和真实模型验证覆盖。

## 实测结果

Chroma 版本：1.5.9。

| 阶段 | 候选路径 | 索引耗时 | 新视频 embedding（模拟） | 缓存命中 | 真实拆分 | 真实预处理 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 第一镜 | 74 | 5.777 秒 | 3 | 71 | 3 | 3 |
| 第二镜 | 74 | 4.455 秒 | 0 | 74 | 0 | 0 |

- 数据库保留 148 条可检索路径别名，仅有 3 个分析内容键与 3 份完整缓存记录。
- 第一镜、第二镜的 `--source-root` 查询各返回本范围内 74 条，越界结果均为 0；查询耗时分别为 0.020、0.018 秒。
- 空目录作为 `--source-root` 返回 0 条，没有回退到全库，耗时 0.013 秒。
- 每镜均收到 74 个 `complete` 文件事件，完成分块数均为 1。第二镜没有 `embedding` 阶段事件。
- 总共 3 次模拟视频 embedding、3 次模拟文本 embedding。真实视频准备耗时 2.087 秒，工作进程总耗时 13.942 秒。
- 缓存命中仍需内容校验和挂载镜头自己的数据库记录，因此第二镜耗时不是零；这里验证的是避免重复模型分析和重复拆分/预处理。

## 复现与证据

独立验证脚本：`VideoAutoCut/tests/verify_analysis_cache_scale.py`。

```powershell
& 'VideoAutoCut/python-3.11.9-embed-amd64/python.exe' `
  VideoAutoCut/tests/verify_analysis_cache_scale.py `
  --output-dir .codex-tmp/analysis-cache-scale-74-20260915
```

报告目录：`.codex-tmp/analysis-cache-scale-74-20260915/`。

- `report.json`：计数、耗时、范围校验、临时数据清理结果。
- `shot-1.index.log`：546 行，第 546 行汇总 3 新分析、71 命中、74 文件。
- `shot-2.index.log`：519 行，第 519 行汇总 0 新分析、74 命中、74 文件。
- `shot-1.search.log`、`shot-2.search.log`、`empty.search.log`：真实生产查询输出。
- `fixture-0.ffmpeg.log` 至 `fixture-2.ffmpeg.log`：真实短视频生成日志。
- `worker.stderr.log` 为空。

这项验证不能代替真实云模型、长视频、多分块、实际网络故障和完整成片验收。真实模型的跨镜头、跨任务结果应与本报告分开陈述。
