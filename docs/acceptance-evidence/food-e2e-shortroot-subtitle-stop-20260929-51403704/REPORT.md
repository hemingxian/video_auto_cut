# 食品短根 E2E STOP 报告（51403704）

## 结论

本轮唯一正式 Route A 在短根 `D:\vac\f3` 自然退出 0，并生成 9 个最终片段、9 个 ASS 和本地最终成片；但第 2 镜最终显示字幕缺少冻结文本末尾的中文句号，因此食品 E2E 必须 STOP，不能报 PASS。

冻结期望为 `U3字幕验收：整箱来料排队。`，实际 ASS 唯一 Subtitle 事件及最终成片 10.000s、14.000s 两帧均显示 `U3字幕验收：整箱来料排队`。差异是缺少末尾 U+3002，不是时间映射或软换行接缝。原 ASS SHA256 为 `2fe3cd616da6801f81f154960cbd2c8903ac83b5bdf6b990d3f4e7e5837a6fc6`；两张最终成片帧 SHA256 分别为 `7564974f6f7cb64abc0caa4b74eba6e4590128c41da058c4bde5b53f0158ec85`、`3403faae2a808229496e3eb4fb3fa089e7de327ce5ecc5e0e686c314c7feb4b7`。没有修改字幕、放宽门槛、重渲染或手动重试。

## 正式运行

输入 plan `cfe073d8…`、manifest `d4784275…`、fixture `33a47aef…`、run id `run_175e3315e0624f028eba293d66a9dece` 原样复用；没有重新导入，导入模型调用 0。Candidate engine SHA256 为 `be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf`。

唯一正式进程于 `2026-09-29T06:57:15.819Z` 启动，`07:17:07.986Z` 自然退出 0，manual retry 0。stdout 584965 bytes/SHA256 `dac51d8b5be5f0508c58aee2c21c64a36172a469308cebbf683645834d2684aa`；stderr 51038 bytes/SHA256 `652d0cc1fad3676507f2835e3df06ee61e1c96dfc6aee86a02bed6b24058e95e`。原始流含临时 URL，只保留私有原件与公开哈希。

短根长度 9。spawn 前按第 9 镜估算包装 cwd：去 `\\?\` 前缀 123 字符、传入形式 127 字符，均低于授权上限 200。实际 9 个包装目录均存在，路径长度与对应结构收录于 postrun receipt。TEMP/TMP 预建为 `D:\vac\f3\t`，Rust child workspace temp 为 `D:\vac\f3\w\temp`。observer 完成并记录 535 条 allowlisted 环境记录、88 次读取失败；其进程库存包含早于本轮启动的无关长期进程（例如 `codex.exe`），因此不能把535条或聚合环境值都断言为 formal 子进程。正式 engine PID6464 的 TEMP/TMP/VIDEOAUTO_TEMP_DIR 均为 `D:\vac\f3\t` 且存在；首个由 engine 直接启动的 Python PID2464 的 TEMP/TMP 为同一路径，VIDEOAUTO_TEMP_DIR 为本轮 incremental-work 且存在。读取失败不是产品错误，也不据此推断原因；无关进程不会被终止。

最终成片只保留本地：28,185,133 bytes，SHA256 `a465f2d3da209939a5bbb2eaae6cd7074ce1b4197b1a3ba4a95a989abb822bce`，未上传。BGM 选择 `Soundscape - Last 31 - Cinematic Piano`，来源 `openverse-audio`，许可 `CC BY 4.0`；观察到三次搜索、一次候选下载并完成混音，均非模型调用，未公开临时 URL。

## 调用与局部完成事实

- TTS `cosyvoice-v3-flash`：9/9；ASR `qwen3-asr-flash-filetrans`：9/9；fresh voice/cue/ASR 工件各 9。
- post-plan 的 script_source 与 9 镜 shot_id/script_meta/ender_hints 共 28/28 深比较一致；这是局部元数据 PASS，不抵消最终字幕失败。
- 字幕拆分：源码/config 推导 `qwen-plus` wrapper 22 次；无逐请求 telemetry，不能声称底层 HTTP 精确数。
- 索引：observed embedding chunks 24、queries 9。
- 素材 agent：`qwen3.6-plus` 9 个逐镜 session 均 ok；同一 formal 内出现 1 次内置漏评补评/重试，manual retry 0；底层 HTTP 数未知。
- 包装：有卡片的 7 镜留下确定性 script-label decision log，均 `response_raw=null`，观察到模型调用 0；9 个片段均渲染完成。
- BGM 外部检索/下载如上，模型调用 0。

engine exit 0 与上述局部事实不改变最终文字验收失败。发现第 2 镜硬失败后，按合同停止扩大最终验收；其它字幕、卡片和抽帧内容，以及成片 1920×1080、声音轨、总时长等剩余规格项均未继续形成合同验收结论，不能宣称通过。旧 U7 仍失败，W6 仍禁止。

## 保护与默认工作区答复

运行后六项保护 SHA 全同，Git 仍仅两个用户 package 文件修改；没有修改产品、引擎、Excel、冻结输入或配置。

普通 Windows 用户首次启动、未设置工作区时，默认路径为 `%LOCALAPPDATA%\VideoAutoCut\workspace`。以本机用户名代入为 `C:\Users\evstm\AppData\Local\VideoAutoCut\workspace`（51字符）；36字符 manifest run id 和 `未命名任务` 下，第9镜包装 cwd 典型长度166。源码允许更长项目名/run id/自定义 root，不存在源码全局最大值；详细取值链和边界见随包默认工作区报告。

请 Mac 审核该末尾句号丢失的正式现场并明确后续范围。在新授权前不修复、不重跑、不继续后续验收。