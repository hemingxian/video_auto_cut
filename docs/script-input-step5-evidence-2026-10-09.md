# 脚本输入步骤 5 验收证据（2026-10-09）

## 范围与提交

本步完成 S2、S4、S7，以及 Rust 集中的口播正文转发、S5、S6。S3 已在步骤 3 完成；S1 中文卡片分词不在本轮。未调用真实模型，未生成成片，未打包、上传或替换安装目录引擎，未改生产配置，未进入步骤 6。

- `ef7a359`：Rust 转发 `--voice-script-body`，S5 使用中性的“脚本文档解析失败”，S6 打印解析后的实际分镜数。
- `6b4c85b`：S4 阻断和失败通知使用错误状态；模板导入被拦下显示专用文案，缺少 `shots.json` 也不吞提示。
- `5bcc21f`：S7 成功启动脚本按账号持久登记；旧 run 沿用共享本地历史语义并在 reveal 时严格校验。
- S2：本证据文档所在的第四个独立提交（字幕词边界与软换行空格恢复）。

## S2：中文词边界与 U+0020

字幕折行懒加载固定离线 jieba 0.42.1；卡片继续走原逐汉字路径，不加载 tokenizer。超长中文词只有在词自身宽于整行时才逐字降级，长 Latin 单词仍保持完整。软换行完整保留 U+0020；实际 ASS 维持 Mac 回帖 51487839 确认的旧规则，只删除每个软行末尾、空白后缀之前的标点，行中标点和空白保持。

N3 旧 ASS 全字节断言按 51487839 明确授权替换为三项例外的独立测试 oracle：仅换行位置、旧行尾标点删除、恢复 U+0020 可变。测试先证明食品码垛全部 9 镜的 pre-display 行重组后与规范化源文逐 codepoint 相同，再独立计算每行旧标点规则并核实际 ASS；同时核真实卡片 manifest 与 HTML 文本。legacy plan 的 a29 字节兼容测试仍保留。没有新增 skip，也未放宽宽度或内容约束；原空格测试由 `join(" ")` 改为 `join("")`，原因是换行边界的原 U+0020 已存在于行内，不再由测试人工补空格。

卡片的 `white-space:pre` 只在实际 wrapped line 含浏览器会折叠的行首、行尾或连续 U+0020 时加入。普通卡片 HTML 保持旧字节。首次全量发现全局 CSS 使 25 个既有卡片字节断言失败，随后将样式收窄为条件触发；25 个旧断言未修改，相关两文件分别 32 项与 193 项复跑通过。真实 Chrome DOM/静帧证据覆盖 normal 与 `headline_sub`，computed `white-space=pre` 且 DOM 文本逐字相等：[receipt](acceptance-evidence/step5-s2-wrap-20261009/card-space-browser-evidence.json)、[normal](acceptance-evidence/step5-s2-wrap-20261009/card-space-normal-browser.png)、[headline](acceptance-evidence/step5-s2-wrap-20261009/card-space-headline-browser.png)。

真实食品第 8 镜由“托盘规 / 格”改为“托盘 / 规格”：[before](acceptance-evidence/step5-s2-wrap-20261009/food08-before.png)、[after](acceptance-evidence/step5-s2-wrap-20261009/food08-after.png)。额外的无标点长句复现夹具沿用真实第 8 镜底图，用于证明结果不依赖标点：[before](acceptance-evidence/step5-s2-wrap-20261009/targeted-before.png)、[after](acceptance-evidence/step5-s2-wrap-20261009/targeted-after.png)；它不是另一条客户脚本镜头。字幕带之外按 3 像素步长抽查 155,520 个像素，前后差异为 0。ASS、哈希和 codepoint 记录见 [subtitle receipt](acceptance-evidence/step5-s2-wrap-20261009/subtitle-evidence.json)。

食品卡片镜 1、3、8、9 使用旧真实 HTML 与 WIP HTML、Chrome 1920×1080 固定 seek；四组 before/after PNG 字节完全相同，证明 S1 卡片换行未改变。它们是静态 overlay，不是新成片抽帧或合成背景：[卡片证据目录](acceptance-evidence/step5-s2-wrap-20261009/cards/)。

## 固定离线依赖与缓存

供应来源、MIT LICENSE、8 个交付文件的大小和 SHA-256 见 [vendor manifest](../VideoAutoCut/tools/_vendor/JIEBA-0.42.1.md) 与 [复核 receipt](acceptance-evidence/step5-s2-wrap-20261009/jieba-cache-and-vendor.json)。七个代码/数据文件保持上游字节；LICENSE 文本不变，仅规范化终止 LF，并以 `.gitattributes` 固定交付字节。

缓存只接受显式 `VIDEOAUTO_DATA_ROOT` 或 `VIDEOAUTO_WORKSPACE_DIR`，固定到 `<workspace>/.videoautocut/cache/jieba/`。系统 temp、`VIDEOAUTO_TEMP_DIR` 和安装/runtime 目录均不会成为缓存目标；无显式 workspace、目标不可写或目标落在 runtime 内时直接在内存构建词典，不静默退回逐字分割。测试覆盖无 env、workspace 外 TEMP、不可写/无效 workspace、workspace 等于 runtime、runtime 子目录、固定缓存名及卡片不加载 tokenizer。

同一全新隔离 workspace、两个全新指定嵌入式 Python 进程测得：cold（无旧 cache）364.077 ms，warm（第二进程复用磁盘 cache）331.593 ms。解释器、缓存路径和原始输出见 [cache receipt](acceptance-evidence/step5-s2-wrap-20261009/jieba-cache-and-vendor.json)。

## S4、S7 与 Desktop

Desktop 全量为 445 total / 443 passed / 2 existing skipped / 0 failed；build exit 0；lint 诊断的文件、规则和条数与冻结基线相同，仍为 10 errors + 1 warning。

S4 行为测试实际调用关闭通知逻辑：失败/blocked 先显示 error，随后 `shots.json` 加载拒绝也不吞提示；成功仍显示 success。React SSR 验证错误提示的警告图标与成功提示的对勾。

S7 覆盖 registry 重建、账号隔离、启动期间账号切换、坏 registry、非法/不存在路径、120 KB 日志上限、日志链接，以及真实 `run.log -> workspaceService -> IPC -> reveal -> shell` 链路。renderer queue 仍是内存状态，本步未新增队列持久化，也未宣称完整 Electron UI 重启。旧 run 无账号字段并沿用既有共享本地历史语义；只允许 Explorer 定位，经 absolute、exists、extension、realpath 和普通文件复核，不执行脚本或读取脚本正文。

相对证据：[Desktop full](acceptance-evidence/step5-s2-wrap-20261009/final-validation/desktop-full-final-step5.log)、[build](acceptance-evidence/step5-s2-wrap-20261009/final-validation/desktop-build-final-step5.log)、[lint](acceptance-evidence/step5-s2-wrap-20261009/final-validation/desktop-lint-step5-final.log)。

## Rust 与唯一 release 编译

- `cargo fmt --manifest-path VideoAutoCutApp/Cargo.toml -- --check`：exit 0；最终 receipt 见 [fmt receipt](acceptance-evidence/step5-s2-wrap-20261009/final-validation/rust-fmt-root-final-receipt.json)。
- `cargo test --manifest-path VideoAutoCutApp/Cargo.toml --all-targets --all-features`：122 passed / 4 existing ignored / 0 failed；见 [Rust full](acceptance-evidence/step5-s2-wrap-20261009/final-validation/rust-full-pre-release.log)。
- 本轮唯一 release 命令：`cargo build --manifest-path VideoAutoCutApp/Cargo.toml --release --locked`，exit 0。未重复编译。
- `VideoAutoCutEngine.exe`：8,311,296 bytes，SHA-256 `41995f53fae3d89c9486e6980b33b98a3f2e434f73a0706ad71948af40e6c871`；`--help` exit 0 且包含 `--voice-script-body`。产物未安装、复制或打包。见 [release receipt](acceptance-evidence/step5-s2-wrap-20261009/final-validation/rust-release-receipt.json)。

## Python 与 N1–N5

最终 Python 全量使用解释器 `D:/Video Edit/VideoAutoCut/workspace/runtime/0.5.15/VideoAutoCut/python-3.11.9-embed-amd64/python.exe`，参数 `-I -B -X utf8`。focused 使用审计环境中的另一份嵌入式 Python，精确路径见对应 receipt。

- S2 focused：41 + 18 + 40，全部通过；原卡片回归文件 32 + 193，全部通过，保留各 1 个既有 skip。
- Python 最终全量：692 total / 690 passed / 2 existing skipped / 0 failed，120.280 s；[命令](acceptance-evidence/step5-s2-wrap-20261009/final-validation/python-full-final-pass.command.txt)、[日志](acceptance-evidence/step5-s2-wrap-20261009/final-validation/python-full-final-pass.log)、[receipt](acceptance-evidence/step5-s2-wrap-20261009/final-validation/python-full-final-pass-receipt.json)。
- N1：完整全量中真实审计 a29d74f 的 5 份实际 xlsx 与 225 个生成 fixture states，结果通过。
- N2：Rust 全量通过；N3 按 51487839 的三项例外严格覆盖；N4 Desktop 全量通过；N5 Python/Rust/Desktop 的既有 skip 清单未增加。

历史失败日志如实保留在本地：一次全局 `white-space:pre` 导致 25 条旧 HTML 字节断言失败，修为条件 CSS 后清零；随后一次全量仅在既有 analysis-cache 临时 SQLite 清理遇 Windows `WinError 32`，该用例单跑 1/1 通过，最终完整全量再跑干净通过。

最后一次保护文件复核确认主目录两份 package 文件与 step1 七份历史候选哈希均未变化；receipt 见 [protected files](acceptance-evidence/step5-s2-wrap-20261009/final-validation/root-final-precommit-protected-receipt.json)。
