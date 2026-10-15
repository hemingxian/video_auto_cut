# 食品码垛 E2E Route A STOP（51400401）

## 结论

食品 E2E 本轮未通过。模板 plan-only 导入通过且导入 Qwen=0；唯一一次正式 Route A `--restart-all` 已消耗，在完成 9/9 TTS、9/9 ASR 和 9/9 cue 后，`sentrysearch index` 因 Chroma `InternalError (code: 14) unable to open database file` 退出 1。按工单立即停止，没有修复或重跑；未进入素材 agent、包装 agent、renderer，无最终成片。

## 路线与输入

- 官方 Sky 原生控制的 `list_windows` 首次、延迟重试、reset/reinitialize 后重试均返回 native pipe `os error 2`。UI 无点击，Generate=0，Electron 以 SIGINT 关闭；这不是产品验收失败，也没有消耗 UI Generate。
- 合同 `docs/template-import-workspace-2026-09-23.md` §6.4 明确允许 UI 跑不通时采用免 UI Route A，并要求回帖说明原因。本轮按该既有合同备选执行，没有扩张到 U7、W6、cleanup 或生产代码修改。
- source：`2cad82d773f8bbfc9e66013628322dd499a3d161`；engine：`be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf`。
- fixture SHA-256：`33a47aefc3d6e97d7cb556f827cfccbbac9dd2aba8e9cb35ae227b165869cc0a`。
- prepared plan SHA-256：`cfe073d8baf039e164f4497c4d4c9dd7a3ef556f9aaa16455417ca8cea5f551d`；manifest SHA-256：`d478427593440e01d437a9e5d0e2fcf10c4356416b85e441baf59e4fea9b5421`；run id：`run_175e3315e0624f028eba293d66a9dece`。
- 独立复核：Excel 45 个作者字段 0 差异；prepared JSON 恰有 20 处授权变化（9 个 download flag、9 个 folder binding、第2镜 U3字幕与 caption hint），unexpected=0；第8镜作者字幕未覆盖；9 个 shot id 与 manifest 完全一致，每镜6条素材记录逐 JSON 等于冻结 oracle，6个素材文件逐 SHA 相同。

## 实际运行

- plan-only：exit 0，template 9镜、9份 `script_meta`、9个非空唯一 shot id、0 cue/audio 字段。完整私有 stdout 中 Qwen/upload/AI parse 标记均为0。
- 正式 engine：PID 4028，`2026-09-29T03:30:09.519Z` 至 `03:32:02.875Z`，exit 1。spawn 收据记录完整 exe 路径与启动紧邻 SHA `be8efb22…`。本次 Food 新增了该观测，不能回填旧 U7 启动瞬间缺失的证据。
- 完成到停点：9份 fresh MP3、9份 run-root cue JSON、9份 incremental ASR JSON；日志观察到 TTS save 9、ASR submit/success 9/9、cue write 9。
- 字幕拆分：独立后验用锁定 Candidate 内嵌 Python 做纯 import 探针，确认 `align_subtitles.call_qwen` 可调用；按实际 production source path 推导为 11 个强标点句 × 两个分段入口 = 22 次 `qwen-plus` wrapper invocation；timing-map=0。模型名来自隔离 app.env 的 `DASHSCOPE_TEXT_MODEL=qwen-plus`，auth remoteConfigEnv 无同名覆盖，gatewayRemoteEnv 只提供 API key/base URL。该数字是源码/配置/成功工件推导，不是 direct HTTP 22；没有逐请求 telemetry，HTTP attempt 数无法精确。不会把“原始日志无 request marker”写成实际0。
- material agent=0、packaging agent=0、renderer=0；失败发生在这些阶段之前。无成片。
- 正式 stdout：65,989 bytes / `7de58f8a3294e1e8969a0ad75969d37f4daaac9903e1877cbacd1f202abab3a7`；stderr：47,550 bytes / `613d3a42128dce3e5691d4e1a5ba648352cd51c56eac9b8cee5d58c41a78697d`。原始流含临时 URL，仅本地保存。

## STOP 错误与证据限度

安全摘录见 `logs/safe-stop-excerpt.txt`：`clean-missing` 先产生可继续警告，随后 `sentrysearch index` 在 `chromadb.PersistentClient(path=db_path)` 初始化时抛 code 14，engine 最终报告索引命令失败。

冻结源码与本轮显式 `VIDEOAUTO_DATA_ROOT` 推导数据库路径为 `formal-workspace/video/vector-db/sentrysearch`；失败后该目录、父目录与 16,384-byte `chroma.sqlite3` 均存在。ACL 表面显示当前认证用户可修改，但这不能排除权限、路径、并发、SQLite/Chroma 或其它环境原因。日志没有直接打印 `db_path`，具体根因尚未证实。

本轮 launcher 把 `TEMP` / `TMP` 指向隔离的 `formal-temp`，但运行后该目录并不存在；`workspace/temp` 与尚未进入渲染阶段的 `formal-output` 也不存在。冻结源码的 `add_child_env` 只用 `VIDEOAUTO_TEMP_DIR` 覆盖 `workspace/temp`，没有代建 `TEMP` / `TMP`。这是一项需在 Mac 复核的本轮验收环境条件，可能影响 SQLite 临时文件，但没有复现实验，不能据此判定产品根因或产品缺陷。E2E 结论仅为索引初始化异常中断，环境与产品根因待审。

独立失败后复核收据 `receipts/independent-poststop-review.json`（SHA-256 `26493da49477628f5de7ffb8f53c71938735b7171d5174749457a136433150fa`）确认：9份 cue 拼接文本与各镜 `voice_text` 精确相等；post-plan 的 `script_source`、9个 shot id / `script_meta` / `render_hints` 深等；27个私有 voice/cue/ASR 文件逐一重哈一致；字幕模型与22次 wrapper 的 source/config 推导闭环。这些是失败前局部通过事实，不构成食品 E2E PASS。

## 未完成项与边界

- 没有 renderer 或成片，无法执行第2镜 U3 override、其它字幕按 Excel 原文的最终可见逐字核对，也无法执行卡片文字与软接缝验收。
- 旧 U7 标题4/6失败结论不变；本轮没有修改 `script_card_fields.py`，没有再跑 U7。
- W6、cleanup、upload、master merge、engine publish 继续禁止。
- 唯一正式食品运行没有重试；engine、sentrysearch、Python 子进程均已退出，端口9/4173无监听。六个保护对象不变，Git 仍仅两项用户 package 文件修改。

## §4 三点说明

1. 无障碍树的 `VideoAutoCut Studio v0.5.14` 来自 Electron Desktop package 的 `app.getVersion()`，不是 `be8efb22…` engine 自报版本。
2. 旧 U7 只在点击前收据证明 Candidate engine SHA，实际 child metadata 没有完整 exe 路径/启动瞬间 SHA；本次食品正式 spawn 收据已直接记录完整路径和 `be8efb22…`。
3. 日志开头“分镜数: 6”是脚本文档解析前的 `--shots` 默认目标值；normalize 后的7是实际解析镜数，二者口径不同，不是少解析一镜。
