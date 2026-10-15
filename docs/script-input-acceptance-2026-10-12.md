# 0.5.16 脚本输入：实现与验收汇总

- 日期：2026-10-12
- 功能分支：`feature/0.5.16-script-input`
- 产品验收源码：`a06a61c7c4fdf914025757a557cf5b3c7426a56e`（汇总开始时功能分支产品 HEAD；本 docs-only 提交会使分支 HEAD 前移）
基线：`release/0.5.15` / `a29d74f8216fa2960b5f4591b1c5b66d428df1f7`

## 结论与边界

步骤 1–6 已完成，四种输入（标准 XLSX、标准 Markdown、普通文章、口播稿）均完成真实安装包端到端验收；XLSX 另完成生成中暂停/继续、历史 plan-only 任务恢复与首次生成，旧 0.5.15 任务完成回归。最终收口见 [Mac 评论 51533101](https://gitee.com/chengdus-thoughts-on-things_1/video-auto-cut/issues/IKK0H4#note_51533101)，Windows 完整证据回帖见 [51532900](https://gitee.com/chengdus-thoughts-on-things_1/video-auto-cut/issues/IKK0H4#note_51532900)。

当前验收包仍带 `0.5.15` 版本标识，只能称为包含 0.5.16 功能的候选包，不能直接作为 0.5.16 正式发布物。本文不代表已经改版本、合并 `master`、打 tag、上传产物或切换线上清单。

## 步骤 1–6

| 步骤 | 交付内容 | 提交 | 收口回帖 |
|---|---|---|---|
| 1 | 字段规范集中化、基线守卫 | `363f5f1bc7f4fb9fd5d0eeadd17174d0372845f8` | Mac [51473526](https://gitee.com/chengdus-thoughts-on-things_1/video-auto-cut/issues/IKK0H4#note_51473526) |
| 2 | 标准 Markdown 零模型导入；粗体字段标签兼容修复 | `17859965906957d1f7d31e9ff02e5ada87176203`、`09aa088344eb82fe5363fd3d99aded6d5c8d77dc` | Mac [51474103](https://gitee.com/chengdus-thoughts-on-things_1/video-auto-cut/issues/IKK0H4#note_51474103) |
| 3 | 普通文章 AI 整理、元数据来源；分镜对齐与段落标签同步修复 | `fd3f1e2d61d569e6a21839967c9c2376b2d5bf68`、`dfe947ec9ca5d7e0df3eecf23c7812b3ca97c57a` | Mac [51474946](https://gitee.com/chengdus-thoughts-on-things_1/video-auto-cut/issues/IKK0H4#note_51474946)、[51475585](https://gitee.com/chengdus-thoughts-on-things_1/video-auto-cut/issues/IKK0H4#note_51475585) |
| 3b | 口播稿逐字导入；短口播分镜标记修复 | `848aee651b8ec6d46f3216112efa95d31f64eb45`、`b544f4a8aaa89ef2edb677ae26a36e8dde0b81df` | Mac [51485246](https://gitee.com/chengdus-thoughts-on-things_1/video-auto-cut/issues/IKK0H4#note_51485246) |
| 4 | Desktop 脚本复核与口播正文工作流 | `a3e64b48df9ad4caff0361850a6fc97f7f73a91a` | Mac [51486704](https://gitee.com/chengdus-thoughts-on-things_1/video-auto-cut/issues/IKK0H4#note_51486704) |
| 5 | Engine 口播参数转发、阻断通知、脚本定位登记、中文字幕分词换行及隔离修复 | `ef7a359720fbdfbefd7348b1fc398737bdc1334f`、`6b4c85b13e784be8397a74225be0e4cf3b976215`、`5bcc21f5a4b44a4db953b4fa0e047605f8b6c65d`、`38e041ecf4ecba7ef05831e9bdfc3ce5441d4f3a`、`35c9287881fa4ab528e7afa5a11598653d18467a` | Mac [51490140](https://gitee.com/chengdus-thoughts-on-things_1/video-auto-cut/issues/IKK0H4#note_51490140) |
| 6 | Windows 恢复路径、文章/口播字段修复、草稿身份恢复、plan-only 历史分类修复及完整 E2E | `0f9cc4020e5448cf3d15c0338c02f6a9b71bc75c`、`eecfd11531cfccfe758c0910c7e954dccd4ec5be`、`1fb82823729c8a9bc7744d1fa91cac4530ced1f9`、`d021b067544f9115bdca359d5e47efd6f6792451`、`a06a61c7c4fdf914025757a557cf5b3c7426a56e` | Windows [51532900](https://gitee.com/chengdus-thoughts-on-things_1/video-auto-cut/issues/IKK0H4#note_51532900)；Mac [51533101](https://gitee.com/chengdus-thoughts-on-things_1/video-auto-cut/issues/IKK0H4#note_51533101) |

步骤 0 的规格与示例文档提交为 `f2cd530b5a0629a3c71330d105b0050350242c81`、`0a5d8c99d4d5e6268a7ddcc7c5c4db03b5b6c433`，不计入上述步骤 1–6。

## 四种输入的 E2E 证据

| 输入 | 结果 | 证据根与关键收据 |
|---|---|---|
| 标准 XLSX | 9 镜，素材库模式 54 个候选；历史 plan-only 任务恢复为可首次生成；新 run `run_1a01cc0142bf4042b2bb494cb469e18f`；在 `ClipSegments` 阶段暂停一次、继续一次，同 run 完成；正式审计 8/8 PASS；最终 MP4 38,043,782 B、80.021029 s、SHA-256 `da62e0e0a4fa43ac1ef5db0d2c68d6e6d6db47a4bd876ef72d6d273ad27df25f` | `D:/vac/s516-history-restore-fix-51530332/xlsx-generation`；`pause-resume-audit-51530332.json`（SHA-256 `71c44c3497b0a1124b80114f3096a4e600f51b0757cb9a4bd70775c9cb9d77db`）；`final-freeze/final-output-audit.json`（SHA-256 `0164287082cb30dbfe768900e2d7f8da95589d4ed38198f424d74ce824be50ca`） |
| 标准 Markdown | 零模型导入；生成完成；核心字段与 XLSX 深度相等；9 条 ASS、7 个卡片文本一致；最终 v002 为 40,167,808 B、80.021029 s、SHA-256 `03187c239186debfa92f435365268744c836938d0c3bf577899f8e21acee03ff` | `D:/vac/s516-step6-resume-fix-evidence-51492839/standard-md`；`standard-md-audit-receipt.json` |
| 普通文章 | 真实 AI 整理后 9 镜生成完成；非复核文本、9/9 素材绑定、16/16 字段确认均通过；1920×1080 H.264 + AAC，80.021333 s；最终 SHA-256 `87b88bdebb42f0237e0a1d90760487a7ccb0e30e0115cf56e5c7d4d624ad1540` | `D:/vac/s516-step6-prose-fix-evidence-51502926/prose`；`generation-audit-receipt.json`、`final-output-audit.json` |
| 口播稿 | 11 镜正文按空白归一后逐字一致；cue 来源与口播一致；字幕仅含已接受的软换行差异；最终真实 run `run_d1944649311742799ed7c0ff8251c235` 全部检查 PASS；最终 MP4 37,219,207 B、81.021333 s、SHA-256 `c5afdbef347b1ecc0db26dde727c897427de07045bfa95af5c90b5cc939f86d2` | `D:/vac/s516-step6-resume-key-fix-51508432/voice-resume-audit`；`final-freeze/voice-run-audit.json`、`final-freeze/final-freeze-receipt.json`、`final-freeze/final-ffprobe.json`、`pause-resume-audit-51512403.receipt.json` |

补充验收包括生成阻断后跳到第一处未确认分镜并打开抽屉的截图、素材错误详情展开截图，以及 0.5.15 legacy 任务回归。legacy 使用既有任务 `run_28e2825d015a43ed85f4163ec7278416`，no-op Save 后仅出现两处 JSON 数字表示 `8.0 → 8`，按既定三项顶层排除规则语义 deep equal，未新增递归 metadata；独立生成 run `run_1587980235ec4244ad43e9a74a90f2ae` 完成，旧 v001/v002 保持不变，v003 为 28,080,762 B、80.021029 s、SHA-256 `8290a3899534940a43f0c6427676ed2ae75ce2e25edc724446e33472135a83c9`。关键收据位于 `D:/vac/s516-history-restore-fix-51530332/legacy/legacy-post-receipt.json` 和 `legacy-final-supplemental-receipt.json`。

## 已验候选包

本轮最后一次 Desktop-only 打包、三项检查和本地安装均通过：

| 产物 | SHA-256 |
|---|---|
| `VideoAutoCutStudio-x64-0.5.15.zip` | `bdbd14b8c04923af53793730bac613c3d41be619e5bd8ba526a775d36a14ccd7` |
| `VideoAutoCutStudioUserSetup-x64-0.5.15.exe` | `28f57437c79c7604f9b16a988213f1a7740b02a4705df9d5216533c4234d31d4` |
| `win-unpacked/resources/app.asar` | `818dc4228e2b818d6717a4dda47661548f1ddf55aff361b3cc40e13d0938d378` |

打包收据：`D:/vac/s516-history-restore-fix-51530332/desktop-pack-history-restore-fix-51530332-receipt.json`；安装收据：`desktop-install-receipt-51530332.json`。

候选 Desktop 打包沿用了已验 Engine，SHA-256 为 `41995f53fae3d89c9486e6980b33b98a3f2e434f73a0706ad71948af40e6c871`，没有在最后一次 Desktop-only 打包中重编 Engine 或重包 runtime。后续口播/XLSX/legacy 验收使用的 runtime ZIP SHA-256 为 `5dbe17741193e5bf7523512f8cd7f965ff2c45f3cc9c57d89d801f5be1b6e9d2`，source head 为 `1fb82823729c8a9bc7744d1fa91cac4530ced1f9`，已包含当时最新 Python/tools；其后只有 Desktop 改动。标准 Markdown 与普通文章在跨修复链的较早阶段完成，本文按 Mac 最终认可汇总，不表示四种输入都在 `a06a61c7...` 或同一最新 runtime 上重跑。

## 版本核查与正式发版草案

只读调查见 `D:/vac/s516-release-summary-51533101/version-release-investigation.md`（SHA-256 `021ba875fdf443838cdb7763cd1c9bff64cc14cfe170280c627f18cfe7fc9ef7`）。当前 `package.json.version`、`package-lock.json.version`、`package-lock.json` 的 `packages[""].version`，以及 ASAR package、EXE 元数据、`desktop-config.enc.json.appVersion`、`latest.yml` 和 installer 文件名全部仍为 `0.5.15`。本次汇总开始时远端 `feature/0.5.16-script-input` 为 `a06a61c7...`，验收产品 HEAD 也是 `a06a61c7...`；本 docs 后续提交只增加本文档。同期 `master` 为 `a29d74f8...`，尚无 `v0.5.16` tag。

正式发版应在用户批准后执行以下独立流程：

1. 用户批准后，在 feature 上用 `dist-scripts/release-version.js set-desktop 0.5.16` 统一修改上述三处版本源，检查完整祖先链、差异与 clean 状态，并形成独立版本准备提交；runtime 目标显式设为 `0.5.16`。ASAR/EXE/`latest.yml`/`desktop-config.enc.json.appVersion` 和产物文件名由正式重打派生，不手改；Cargo crate 版本 `0.2.1` 无需随 Desktop 版本修改。
2. 按批准方案将完整功能、汇总文档和版本准备提交合入 `master`，复核精确 master commit；tag 必须指向这个准备构建的 master commit。
3. 从该精确 tag/commit 重新打 Desktop 和 runtime。低层 runtime-only 组包可保留已验 `41995f53...`；仓库高层正式 runtime 命令会执行 `cargo build --release --locked`。无论采用哪条受控流程，都必须生成 0.5.16 ZIP/manifest 并记录 Engine SHA；若重编 SHA 不同，应先判明差异，不能盲目接受或替换回旧文件。新 Desktop 至少复核版本身份、真实登录、ASAR 依赖及 `@undefined=0`；新 runtime 核对 Engine 与当前 tools。既有四输入 E2E 是跨修复链累计认可的证据，复用它不自动要求四份全部重跑；是否追加代表性 smoke 由正式发版门槛另行批准。
4. 上传前复核版本、文件名、size/hash、runtime 内 Engine 和依赖；保存线上 `updates/latest.yml`、`runtime/manifest.json` 和共享 `desktop-config.enc.json` 的原字节、SHA/size/time，并确认当前 marker 引用的 payload 可读，形成回滚集合。
5. 上传 payload 后再切 marker：runtime ZIP；Desktop installer、blockmap、共享 `desktop-config.enc.json`；runtime manifest；最后 Desktop `latest.yml`。在线回读 marker/payload 并做更新 smoke。若写入共享配置后失败，即使 marker 尚未切换也要恢复该配置的原字节；marker 已切换时一并恢复对应旧 marker，保留新 payload 取证。

上述均为待批准发版草案，本轮没有执行版本修改、正式重打、发版相关远端写入、上传产物、替换线上清单、合并或 tag。

## 已登记事项

- legacy no-op Save 的两处 `8.0 → 8` 是 JSON 数字表示归一化，本轮不修；语义 deep equal 已通过。
- 0.5.15 已完成但未生成的 plan-only 历史任务被误判为失败/中断，已在 `a06a61c7...` 修复。仅在无成片、无 incremental 且 `job_plan`/checkpoint 严格证明两步 plan 完成时恢复为 `ready`；损坏、缺失、真正中断、已有成片和 restart-all 行为保持原状。
- S1 卡片标题拆词仍登记到 0.5.17，本轮未扩大范围处理。
- 竖源 16:9 左右黑边留到 0.5.18 前后继续讨论。
- 短冒号文章行默认选择、DOCX tab/`br` 空白与嵌套 `txbxContent`、临时 `voice_script_body` 文件清理等已登记小项继续留后续版本处理。
- `embeddedRecords` 当前仍扫描 `checkpoint.signature` 内 JSON；待 checkpoint 直接提供 `task_id` 后再简化。
- 用户主动“任务已停止”的红色错误样式、`--voice-script-body` 与 `--shots-json` 路径的静默忽略、jieba 冷启动收益较小，均为非阻塞建议。
- S2 字幕拆词及空白处理已经修复，并由 `35c9287...` 隔离到 `cjk_word_boundaries=True`；默认/kinsoku 52 万次差分为 0，不属于遗留项。
- lint 基线仍为 10 errors / 1 warning；各相关实现轮均核对无新增诊断，build 与相关测试通过。
