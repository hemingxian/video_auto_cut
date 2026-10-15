# 食品 E2E Route A 唯一重跑 STOP（51402638）

唯一正式重跑未通过。冻结 plan/manifest 未重新导入；9/9 TTS、9/9 ASR、9/9 cue 完成，素材标准化完成 9 个周期并进入渲染。`python render_segment` 抛出 `NotADirectoryError: [WinError 267] 目录名称无效。`。生产代码先执行初次 packaging render 1 次，失败后执行内置确定性模板 fallback 1 次；同一个 engine 内共 2 次 render 调用均得到相同异常，最终 exit 1。这不是人工重跑；manual retry=0。

helper 于 `06:20:44.774Z` 记录首个明确 traceback 并请求停止 owned PID 15304 进程树；engine 已在 `06:20:44.949Z` 返回 exit 1，随后 taskkill 报 PID 不存在，不能声称 taskkill 杀死成功。无最终成片，未修复、未重试。

本轮预先创建了空 `formal-temp` 与 `workspace/temp`。实际 PEB 只读收据证明 engine 的 TEMP/TMP/VIDEOAUTO_TEMP_DIR 均指向存在的 formal-temp；所有已捕获 Python child 的 TEMP/TMP 均为 formal-temp。所有已捕获进程的 VIDEOAUTO_TEMP_DIR 共 12 种值，其中 Python child 共 11 种，随阶段出现 incremental-work、workspace/temp、run/temp 等值，全部 `exist=true`；接近失败时间的 PID 40820 在 `06:20:44.480888Z` 捕获为 run/temp，但收据没有 command line，不能断言它就是 render PID。此前 code 14 未再现。该事实不证明本次 WinError 267 根因。

失败时 packaging cwd 由正式 output 路径推导为 `\\?\...\final_clips\packaging\0001_final`：含前缀长度 266，去掉 `\\?\` 后长度 262；两种路径在停止后均存在，去前缀路径确为目录，`render.log` 为 0 bytes。这里只记录失败现场，不开展复现或修复，也不据此确定根因。

正式运行前有 3 次 loader/setup 失败，均发生在 helper/engine 加载前，marker 不存在，engine/model spawn 为 0；正式额度只消耗 PID 15304 这一条。完整 formal raw 因含临时 URL 仅本地保留，公开包仅含 SHA/bytes 与按 raw LF 机械提取的安全行。

没有成片，合同 §6.4 的最终可见字幕逐字、卡片软接缝、1920×1080/有声/时长验收无法完成，因此食品 E2E 为 STOP，不是 PASS。旧 U7 仍失败，W6 仍禁止。

observer 共记录 449 条 allowlisted 进程环境记录；另有 101 次观察器读取失败，仅记录为 `MethodInvocationException`，可能涉及短命进程竞态，但没有原生错误细节，不能据此推定原因，也不是产品日志错误。实际记录已覆盖 engine 与关键 Python 子进程。root 停止后按进程 CreationDate 排除 PID 复用，owned process 存活 0、未知 0；六保护不变，Git 仍仅两项用户 package 修改。

调用口径：模板导入 Qwen=0；字幕拆分为 source-derived 22 次 qwen-plus wrapper invocation，direct HTTP 精确数无 telemetry；素材 agent 有 9 份逐镜成功 session/log，模型标记 qwen3.6-plus，但 exact direct HTTP request 数不猜；query 9、embedding chunk 24/24。包装决策为 script-label 确定性路径，`response_raw=null`、`model_seconds=0.0`，包装模型调用 0；随后同一镜发生 2 次包装 render 调用（初次 1 + 内置 fallback 1）。`render_segment` 已进入第 1 镜；底层包装 renderer 子进程启动失败、完成 0，final video 0。

独立停止后复核确认：27 个 voice/cue/ASR 原件 SHA 全同，9 份 cue 拼接与 voice 目标精确相等；post-plan `script_source` 与 9×`shot_id`/`script_meta`/`render_hints` 共 28 项深比对 0 差异，post-plan SHA-256 `ef3acd5c5ecc7e3658e4843b111995bf04d3b9105dcb1e3d2b942ed8303ab763`。这些局部通过不构成 E2E PASS。
