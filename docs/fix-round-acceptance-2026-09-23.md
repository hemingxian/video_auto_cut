# Mac → Media/Windows：剪辑软件修复轮最终验收单（2026-09-23 终版，含第三次复审修复，自包含）

> ⛔ **本单取代**：issue IKGH73 评论 51319179 系列（含 B5/B7 补充评论）、`docs/fix-round-acceptance-2026-09-22.md`、以及本文件在 `556210e` 的旧草稿和 `4775b9a` 的上一版（第三次复审前）。那些**全部不再执行**，本单不引用它们的任何步骤——需要的脚本、命令、对照表都已贴在下面或写明仓库内文件路径。
> ⛔ pkg4 作废，不上传。本轮只**本地**打 pkg5，也不上传。
> ⏸ 不运行任何 upload 命令，不改线上 `runtime/`、`runtime-trial/`，不合 master，不改生产 `app.env` / 用户 `.pi` / `release-upload.local.json`，不 reset Media 机两份 Desktop `package*.json` 的用户修改。
> `<FINAL_HEAD>` 在发布 issue 时填写（= 包含本文档的提交）。

## 0. 代码锚点

- 分支 `feature/material-agent-select`；上一次远端 HEAD `e5b5bec`；`master` 仍是 `60b3e3d`，**不合**。
- 本轮全部提交（按顺序，都在 `e5b5bec` 之后）：

| commit | 内容 |
|---|---|
| `727a032` | 读取层：解码 `_xHHHH_`；横向合并只沿本列下摊；数值/公式/布尔/错误格打标记 |
| `a0f23da` | 校验层：「确定」档判据；没有上屏列绝不清空；占位与版式标签不上屏；提示词第 15 条 |
| `772a7c5` | `compact_plan`：表格脚本的 `card_content` 保留单元格内换行 |
| `556210e` | 旧验收草稿（已被本文件取代） |
| `7fc4bf4` | 第二次对抗复审：阻断 B1/B2、应修 1/2、建议项 |
| `01785c3` | 新功能：按脚本版式标签选卡片版式（`card_layout`，含 Rust 透传） |
| `74d58fb` | `pack-runtime.ts`：排除规则前缀修正 |
| `4775b9a` | 上一版验收单 + `docs/acceptance-tools/check_v2a_shots.py`、`check_pkg_contents.py` |
| `3570703` | 第三次复审：阻断 B1（逐行占位）/ B2（首镜之前的内容行）、建议 2–6（截断格、占位收窄、无冒号标签、成对星号、整词提醒） |
| `590a323` | 测试：逐字节渲染回归缺 git 时**失败**，不再静默跳过 |
| `3fd1df6` | Rust 测试临时目录防撞名（仅测试代码，引擎行为不变） |
| `b9b5293` | `check_pkg_contents.py` 改用 `git cat-file --filters`（应修 Y1）；`.gitignore` 加 `.codex-tmp/` |
| `29bd93d` | Mac 修复轮终版验收单（本文件在 Media 补修前的终版） |
| `efb7350` | Media 第一阶段 R1/S1/S2/S3：占位说明改写只告警、「不填写」提醒、title/hint 粗体疑点、包内容 raw/filters 双口径；含回归测试 |
| `5da98cb` | Media 第一阶段证据文档与回帖锚点（51337255） |
| `db239cf` | Mac 审核 51338403 后补修 R1：说明子串在 missing / rewritten / copied 三路径统一只告警 |
| `<FINAL_HEAD>` | 本文档（本轮更新） |

- 相对 `e5b5bec` 改动的**运行包文件**（W2/W3 同步用；第三次复审只动了其中的 `script_card_fields.py`、`script_tabular.py`，清单不变）：`VideoAutoCut/tools/` 下 `script_card_fields.py`、`script_tabular.py`、`normalize_script.py`、`template_packaging.py`、`packaging_agent.py`、`shot_plan_schema.py`、`prompts/script_parse.md`；引擎 `VideoAutoCutApp/src/{models,domain,planner}.rs`（**必须重编 `VideoAutoCutEngine.exe`**，旧引擎会丢掉新字段 `card_layout`）；打包脚本 `VideoAutoCutDesktop/scripts/pack-runtime.ts`。桌面端只多一个类型声明（`src/pages/start/types.ts`），本轮不打桌面包。
- 包装提示词 `agent_packaging_plan.md` 未动，SHA-256 仍为 `0cb811b544a5f99ecd68385f72b18d18f52710a50fab09c044f28d499563f788`。

## 1. 用户口径（本轮一切判断的依据）

1. 一切以客户/作者脚本为准；上屏卡片只在作者写了 `card_content` 的镜出现；AI 不生成、不摘取、不改写上屏文字。
2. **只有百分之百认准才自动改 plan；拿不准一律只告警、一字不改。宁可漏改，绝不改错 / 删掉 / 把没写的上屏。**
3. 版式标签（「大字：」「副行：」「小字：」「参数卡：」「决策树：」）**不上屏，但用来选卡片版式**（9/23 用户看 `render_check` 图后拍板，见 §4）。

## 2. 三档与「确定」判据（代码 `script_card_fields.table_certainty_problems`）

| 档位 `tier` | 含义 | 对 plan |
|---|---|---|
| `certain` 确定 | 原文读得准，逐镜逐字段比对 | 过了逐镜闸门的差异自动纠正；带版式标签的镜写 `card_layout` |
| `warn_only` 只告警 | 读到原文但拿不准（`skipped:uncertain` / `skipped:sheets` / `skipped:shot_count`） | **一个字不改** |
| `skipped` 跳过 | 读不到可比对的原文（格式不支持、没有「分镜 N」、认不出表头） | 不改 |

表格脚本（xlsx/xlsm/csv）进「确定」档必须**同时**满足：

1. 关键列（分镜号 / 口播·字幕·分镜标题 / 上屏文字 / 卡片样式）都是白名单原名逐字命中（只去空白与 `*_-–—·`、转小写）；靠剥括注才认出来的不算。
2. 选中表至少有一列上屏文字 / 卡片样式 / 分镜标题。
3. 全工作簿除这一行表头本身外，没有任何别的「带上屏/标题列的表头行」。**9/23 起逐字重复的表头也算**（阻断 B1，见 §3）。真实生产表 v1/v2A/v2B/v2C/v2 系列/EN 系列 Mac 已逐份扫过：一份都没有重复表头。
4. 关键列在表头行及以下没有被横向合并覆盖；上屏/样式/标题列的纵向合并不跨镜。
5. 选中表所在 sheet 没有隐藏的列或行。真实生产表均无隐藏列/行。
6. **（第三次复审 B2）**表头与第一个写了镜号的分镜之间，没有「有实质内容或写了镜号」的行（片头行 `片头` / `1a` / 镜号空但有口播或上屏）。原来这种行被静默跳过，模型把片头并进第 1 镜给卡，确定档再把卡当臆造删掉。只有空行、只写时长/时间轴的行不算。真实生产表均不受影响。
7. 镜数与 plan 相等。

「确定」档里的**逐镜只告警**：数值/公式/布尔/错误格、**超过 2 万字被截断的格子**；**上屏列里某一行是占位而整格不是**（`大字：抓取卡↵副行：（不填）`、`副行：——`、`大字：——↵副行：X`、`抓取卡↵无`，第三次复审 B1）；**整格只是「像」占位**（见下）；**行首标签没写冒号**（`大字 A句`）；**剥完标签后正文中间还有 `**`**（含 title / card_hint）；这一镜的口播锚点对不上（**9/23 起口播对不上时同名标题不能替它认人**）；一镜多值；本表不认识的列里写着 plan 值；**上一镜之后隔着整行空白或重复表头又冒出来的同号行 / 无号行**（示例块、表尾说明，阻断 B2）；原文只要含「不上屏/不填/不填写/留空」任一子串，无论 plan 留空、改写还是照抄都只告警。card_content 不可靠时该镜不带 `card_layout`；title / card_hint 疑点只冻结对应字段，不影响独立可靠的 card_content 版式。plan 与原文一致时也另打一条「请人工确认」（照抄的说明文字会原样上屏）。整格确定占位仍表示作者没写，可清掉 plan 臆造卡。表里没有上屏文字列 / 卡片样式列时对应字段整表冻结，**绝不清空**。

**占位口径（第三次复审建议 3 收窄）**：
- **确定占位 = 没写**（可以清掉 plan 里凭空造的卡）：NFKC、去首尾空白、去成对括号/引号后**逐字**等于 `不填 不填写 无 没有 暂无 空 留空 空白 不上屏 n/a na none null nil tbd` 之一，或只由横线/斜线组成（`-` `—` `——` `／` `— —` `-↵-`）。例：`（不填）` `「无」` `Ｎ／Ａ` `（ 空白 ）`。
- **像占位**（只告警，不清也不补）：拆开括号和句末标点后每段都是占位词，但整体不在上面那张表里。例：`没有！` `None.` `空 空` `——（不填）` `无。`、以及 `大字：——↵副行：（不填）` 这种每行都是占位的两行格。
- **不是占位**：`—3%` `/分钟` `无人化` `无需人工` `不填充` `留空率` `不上屏幕`。其中前四项正常比对；后三项虽然不清除，但因含说明子串只告警、不自动补写或改写。
- 最终卡片的额外提醒仍按整词匹配（后面不能紧跟别的字）控制噪音：`此镜不填` `不上屏（本镜）` 会提醒，`不填充` `留空率` 不会。字段校验的 missing / rewritten / copied 疑点闸门统一按子串（宁可漏改）。
- 星号：只剥**成对包住整行**的 `**`/`__`，或落单在边上的一个（`- **上屏文字：** 安全第一` 留下的半个）；`**抓取**卡与**放置**` 不拆，且该镜只告警。

> ⚠ **章节横幅行会让表降级（醒目提示）**：表里插了「第一部分：xxx」这类章节横幅行时——
> - 横幅行横向合并跨过关键列 → **整份只告警**（判据 4）；
> - 横幅写在分镜号列、不写镜号 → 它前面那一镜**整镜只告警**；
> - 横幅写在标题/上屏等列、不写镜号 → 它前面那一镜的该字段变成一镜多值，**该字段只告警**；
> - **第一镜之前的横幅**（写在分镜号列，或口播/字幕/标题/上屏/样式/画面任一列）→ **整份只告警**（判据 6，第三次复审 B2 起；以前是被忽略）。
> 这是「宁可漏改」的有意结果，Mac 已用三种形状实测。需要自动纠正的脚本请不要在分镜表里插横幅行。

文本脚本（md/txt/docx，以及表头认不出来的 csv）：「分镜 N」标记严格 1..N、`键：值` 行抽取，确定档即原有全部闸门；值按单行比对。

## 3. 逐条修复与测试

测试名均在 `VideoAutoCut/tests/test_script_card_fields.py`（另注明的除外）。

### 3.1 9/23 复盘（`727a032`–`772a7c5`，上一稿已做，本轮未改动其结论）

| # | 问题 | 做法 | 测试 |
|---|---|---|---|
| A | 图例/示例表头抢表（X1/X2/X4/X5） | 判据 3 | `CertaintyGateTests.test_block_a_legend_or_example_header_above_the_real_table`、`test_the_same_table_without_the_legend_is_certain` |
| B | 真实 v1 卡片被清空 | 判据 2+3；无上屏列冻结 | `test_block_b_real_v1_shape_never_clears_author_cards`、`TableReconcileTests.test_a_table_without_a_card_column_never_clears_even_one_card`、`test_a_card_column_that_exists_still_clears_an_invented_card` |
| 1 | 横向合并把口播摊进上屏列 | 读取层只沿本列下摊；判据 4 | `XstringAndMergeReaderTests.test_a_horizontal_merge_is_only_spread_down_its_own_column`、`CertaintyGateTests.test_a_horizontal_merge_over_a_key_column_is_warn_only` 等 |
| 2 | 版式标签上屏 | 行首白名单标签剥掉 | `LayoutLabelTests`（5 条） |
| 3 | 符号占位 | 纯横线/斜线、「空白」「不上屏」等当没写 | `ExtractionTests.test_bare_symbols_are_placeholders_for_every_field` |
| 4a | `_x000D_` 上屏 | 解码 `_xHHHH_` | `test_x000d_is_decoded_in_shared_and_inline_strings` 等 |
| 4b | 数值/公式格 | 只告警 | `CellKindTests`（5 条） |
| 4c | `compact_plan` 折叠换行 | 表格脚本保留换行 | `CompactPlanLayoutTests`（2 条） |

### 3.2 第二次对抗复审（`7fc4bf4` 为主）

| 发现 | 处理 | 测试 |
|---|---|---|
| **阻断 B1**：上方示例块表头与正表逐字相同、示例行号写 1 → 示例卡片进第 1 镜且判确定（夹具 C1/C1b） | 采纳，**比补丁草案更保守**：判据 3 取消「同 sheet 逐字重复表头」豁免，出现即整份只告警（真实生产表无一受影响）；分组时仍记录「重复表头」状态（补丁草案原样） | `SecondReviewTests.test_b1_an_example_block_with_the_same_header_above_is_warn_only`；旧用例 `test_a_trailing_copy_of_the_header_does_not_kill_the_real_table`、`TableGroupingTests.test_a_repeated_header_row_is_not_taken_for_a_shot` 改为期望只告警 |
| **阻断 B2**：表尾说明不写镜号、落在上屏列 → 并进最后一镜（夹具 C2/C2b/C2c） | 采纳补丁草案：记录「上一镜之后出现过整行空白 / 重复表头」，之后的同号行或无号行把该镜标存疑（只告警），遇到新镜号清状态 | `test_b2_a_trailing_note_in_the_card_column_is_not_merged_into_the_last_shot`、`test_b2_variants_trailing_example_blocks`（含 C2b、C2c、空行后同号行） |
| **应修 1**：同名标题盖过口播错位（夹具 C4） | 采纳补丁草案：`anchor_verdict` 口播对不上即 `mismatch` | `test_c4_a_shared_title_cannot_vouch_for_a_mismatched_voice` |
| **应修 2**：`不上屏（本镜）` `——（不填）` `— —` `-\n-` `Ｎ／Ａ` `无。` 被主动补上屏 | 采纳：判占位前 NFKC；纯符号允许夹空白 `^[-—–－/／\s]+$`；括号与句末标点拆开后每段都是占位才算；「丢失」且原文含「不上屏/不填/留空」只告警不补；plan 最终卡片里含这几个字另打一条提醒（不改） | `test_placeholder_variants_are_never_put_on_screen`（含「无人化产线」等反例）、`test_a_copied_placeholder_explanation_is_flagged_not_changed` |
| **应修 3**：旧稿 W6 与 `pack-runtime.ts` 实际行为不符 | 采纳：W6 重写（§7 W6）。另修 `pack-runtime.ts` 排除前缀（`74d58fb`）：`syncRepoScripts` 拷 tools/config/sentrysearch/prompts 时相对路径不带目录前缀，`tools/material_gen/records` 与两处 `node_modules/.cache` 在**拷进暂存目录**这一步不生效。说明：zip 收文件时 `collectRuntimeEntries` 按暂存根重新算路径，这几条在那一步仍会被挡掉，所以此前的包内容其实不含它们；修复让两步用同一规则。**底包残留（0.5.14 里有、仓库已删的 tools 文件）与 Windows 工作区未跟踪文件仍会进包**，由 W6 列出 | Mac 用独立 tsc 6 + @types/node 类型检查 `pack-runtime.ts` 0 错误；Windows 在 W6 用探针文件验证 |
| **应修 4**：旧稿自相矛盾 | 本文件自包含，不再引用旧单 | — |
| **应修 5**：测试改动描述不准 | 见 §5 | Y1/Y2 用例注释改正并加档位断言 |
| 建议：同一行多个标签连续剥、标签后残留星号 | 采纳：`大字：副行：抓取卡` → `抓取卡`；`**大字：**A` / `大字：**A**` → `A`；提示词同步 | `test_chained_labels_and_markdown_around_labels_are_stripped` |
| 建议：`_x0000_` 等控制字符 | 采纳：只放行 `\t\n\r`，其余控制字符（含 C1）解码后丢弃 | `test_x0000_and_other_controls_are_dropped_but_tab_newline_cr_are_kept` |
| 建议：隐藏列 | 采纳更简单的一种：选中 sheet 有隐藏列**或隐藏行**即整份只告警（判据 5） | `test_hidden_columns_or_rows_make_the_table_warn_only` |
| 建议：章节横幅行降级写醒目 | 见 §2 醒目框 | — |
| 建议：csv 退回文本路换行口径 | 采纳：`normalize_script` 改用 `script_card_fields.is_table_script`，表头认不出的 csv 按文本脚本折叠 | `test_a_csv_that_falls_back_to_the_text_route_folds_card_breaks` |

复审夹具 C5 说明：复审留存的 `C5_旧上屏列(隐藏)有值_新列不认.xlsx` 实际**没有**设隐藏属性（是可见的旧 `上屏文字` 列 + 不认识的 `屏幕字` 列），这种形状仍是确定档、会按白名单列补第 3 镜（与 `556210e` 相同，见 §9 限制）；真正隐藏的形状由上面的新测试覆盖。

### 3.3 第三次复审（`3570703`–`b9b5293`，本轮）

| 发现 | 处理 | 测试（`ThirdReviewTests`，另注明的除外） |
|---|---|---|
| **阻断 B1**：`大字：抓取卡↵副行：（不填）` → 确定档把 plan 改成 `抓取卡↵（不填）` 并带 `headline_sub`；`副行：——`、`大字：——↵副行：X`、`抓取卡↵无` 同类，且无告警 | 新增 `field_doubt`：剥掉每行行首标签后，只要有非空行是（像）占位而整格不是 → 该镜 `reliable=False`、写 `doubt`、`layout=None`；plan 与原文一致时另打「请人工确认」 | `test_b1_a_placeholder_line_inside_a_real_card_is_warn_only`（四种形状）、`test_b1_a_copied_placeholder_line_is_flagged_not_changed`、`test_b1_whole_placeholders_and_real_two_line_cards_are_unchanged`（对照：确定占位仍是没写；真两行卡仍确定并带版式；`副行：` 留空不算占位） |
| **阻断 B2**：第一个镜号前的内容行被静默跳过；片头并入第 1 镜的卡被当臆造删掉 | 采纳**整份只告警**（判据 6）。真实生产脚本 v1/v2A/v2B/v2C/v2 系列/EN 与 7 份标准脚本 `collect_blocks` 与 `4775b9a` 逐项相同，不受影响，所以没退到「只标第 1 镜存疑」 | `test_b2_rows_before_the_first_shot_number_make_the_table_warn_only`（片头行 / 镜号空 / `1a` 后接 `1`）、`test_b2_blank_rows_or_a_time_only_row_before_the_first_shot_are_fine`（对照） |
| **应修 Y1**：`check_pkg_contents.py` 用 `git show` 取期望字节，Windows `core.autocrlf=true` 下 `text=auto !eol` 的文件（约 105 个）误报 | 改为 `git cat-file --filters <head>:<path>`（与检出同一套 eol/autocrlf 转换） | Mac 模拟：`core.autocrlf=true` 克隆 + 按映射拼的假包，旧脚本 `RESULT=106`（tools 84 + sentrysearch 22），新脚本 `RESULT=0` |
| 建议 1：Rust 偶发失败（临时目录只用时间戳/进程号，并发撞名） | `clip_manifest`、`incremental`（含 `receipts_…` 那条）、`normalization_cache` 加进程内原子计数器 + pid；复核时又在并发下抓到 `material_download::archived_candidate_is_reused_in_a_later_shot`（无 pid）一次，连同同形的 `checkpoint` 一起加 pid | 见 §6：单跑 12 次 + 三进程并发 40 轮（120 次）0 失败 |
| 建议 2：`script_tabular._clip` 截断超长格子 | 截断的格子带 `truncated` 标记 → 该镜该字段只告警；docx 段落被截断 → 整份零动作 | `test_a_truncated_cell_is_warn_only`（xlsx 共享/内联字符串、csv）、`test_a_truncated_docx_paragraph_gives_up_on_the_whole_file` |
| 建议 3：整格判占位会删真内容（`没有！` `None.` `「无」` `空 空`） | 占位收窄为精确词表 + 纯符号（§2 占位口径）；「像占位」只告警、不清不补；`「无」` 仍是确定占位。此行的旧反例预期后由 51338403 覆盖：`不填充` / `留空率` / `不上屏幕` 仍非占位，但只告警不自动改 | `test_placeholder_is_only_the_exact_set_and_bare_symbols`、`test_a_placeholder_lookalike_is_never_cleared_nor_supplied` |
| 建议 4：不带冒号的标签 `大字 A句` | 只告警不改、不带版式（`大字报…` 这种不带空白的不算） | `test_a_label_without_a_colon_is_warn_only` |
| 建议 5：`_strip_edge_marks` 会拆中间粗体 | 只剥成对包住整行的一对，或落单在边上的一个；正文中间残留 `**` 的镜只告警 | `test_edge_marks_only_strip_a_pair_around_the_whole_line`；既有 `test_chained_labels_and_markdown_around_labels_are_stripped`、`test_bold_key_with_the_colon_inside_the_emphasis` 不变通过 |
| 建议 6：「不上屏/不填/留空」提醒对 `不填充` `留空率` 误报 | 提醒改整词匹配（后面不能紧跟别的字） | `test_the_explanation_reminder_matches_whole_words_only` |
| 建议 7：验收单 | W1 跳过清单写死、逐字节回归缺 git 改为失败（`590a323`）；`.codex-tmp/` 进 `.gitignore`；W2 改在运行包**隔离副本**上做；§4 写明竖屏配横版素材的退回；测试数与 commit 列表更新 | `test_script_card_fields.ScriptLayoutRenderTests.test_shots_without_labels_render_byte_identical_to_556210e`、`test_packaging_agent` 两条 ba6553e 对照：缺 git 时 `fail` |

**不做（写进 §9 已知边界）**：两镜口播相同时按位置纠正（M5）；`width=0` / `ht=0` 这类「看起来隐藏」的列/行不检测。

**Media 第一阶段补修（基线 `29bd93d`，代码提交 `efb7350`）**：

| 发现 | 处理 | 回归测试 |
|---|---|---|
| R1 改写路径会把「不上屏（本镜）」写进 plan 并带版式 | `efb7350` 先按整词判断；**该结论已由 51338403 / `db239cf` 覆盖**，当前为任意说明子串只告警 | `test_b1_a_placeholder_explanation_is_warn_only_for_rewrites_too`、`test_b1_a_copied_placeholder_explanation_is_flagged_not_changed`、`test_b1_whole_explanation_placeholders_still_clear_invented_cards` |
| S1 「不填写」漏提醒 | 提醒词增加完整词「不填写」，保持正文反例 | `test_the_explanation_reminder_matches_whole_words_only` |
| S2 title / card_hint 中间成对 `**` 未判疑点 | 两字段与 card_content 一样只告警、不改 | `test_paired_markdown_in_title_and_hint_is_warn_only` |
| S3 工作区混合 LF/CRLF | 包核对同时接受 Git raw blob 与 `--filters`，逐文件记录命中口径 | `test_check_pkg_contents.CheckPkgContentsTests.test_mixed_raw_and_filtered_bytes_pass_and_neither_still_fails` |
| S4 类名写错 | §5 的两条 ba6553e 对照改为实际类 `CompositionTests` | 既有 `CompositionTests` 两条逐字节回归实际执行通过 |

## 4. 新功能：按脚本版式标签选卡片版式

**规则（用户 9/23 拍板）**

| 作者在上屏列写的 | `card_layout` | 画面 |
|---|---|---|
| `大字：` + `副行：`/`小字：`（第一行也可不写标签，后续每行都是副行/小字） | `headline_sub` | **新模板「大字+小字」**：第一行 54 号，后面各行 36 号、78% 白，间距 0.35 个小字高；深底卡、左侧青色条（与 title 卡同色 `#5DE0CF`）、同一字体、卡宽 1200（按画面缩放） |
| `大字：` + `大字：` | `equal_lines` | 保持现有「各行一样大」（即现在的 parameters 效果，html 与不带字段时逐字节相同） |
| 首行 `参数卡：` / `决策树：` | `equal_lines` | 暂按各行一样大出，**不新做模板，以后再做** |
| 单行（带不带标签都一样）、多行都没写标签、标签组合拿不准（如 `大字：`+无标签行、`副行：` 在前、`对接：` 这类非白名单） | 不带 | 按原规则，**输出与 `556210e` 逐字节相同** |

**谁来写、何时写**：只由 `script_card_fields.reconcile` 从脚本**原始单元格**（剥标签之前）确定性推出；只在这一镜的上屏字段能被自动纠正的全部前提下写——`certain` 档、该字段未冻结、这一格可靠（第三次复审起：含占位行 / 像占位 / 无冒号标签 / 残留 `**` / 被截断的格子都算不可靠）、内容锚点确认这一镜（口播对不上一律不算）、`VIDEOAUTO_SCRIPT_CARD_AUTOFIX` 未关。任何一条不满足就不带（不告警，回到默认规则）。模型不产出：`compact_plan` 不收这个键；Qwen 提示词只要求剥标签并明确「不要输出任何版式字段」。文本脚本的值是单行，所以只有表格脚本会带上它。

**透传链路**：`normalize_script.py`（`verify_card_fields` 写入）→ `temp/normalized_script_shots.json` → Rust `read_plan_from_file` 反序列化为 `Shot`（**新增 `card_layout: Option<String>`，缺省不序列化**；Rust 的 `Shot` 没有 `flatten`，未知字段会被丢，所以必须加字段、必须用新引擎）→ 运行目录 `shots.json` → `render_segment` → `template_packaging.load_packaging_shot`。`shot_plan_schema.normalize_shot_plan` 只保留两个合法值且要求这一镜有 `card_content`。桌面端不按字段名重建分镜，类型里加了可选声明。

**packaging agent 不得覆盖**：`packaging_agent.plan_for_shot` 见到 `card_layout` 直接返回脚本版式、**不调用模型**，决策日志记 `"script_layout": ...`、`overridden="script_layout"`、`source="script_label"`；`template_packaging.packaging_content` 里同一规则兜底（即使拿到一份 agent 版式也不看）。没有 `card_layout` 的镜照旧由 agent / 原规则决定。

**兜底**：大字+小字一页放不下（字太多、画面太窄）或有放不下的超长词时，退回原规则的多行版式（会分页），不硬塞、不报错。**竖屏成片配横版素材**（卡片可用宽度按素材区域收窄）时，v2A 第 1 镜这种「大字+一行小字」常常放不下，会退回原版式、分成两页出——`template.json` 里是 `template_source=deterministic`、没有 `sub_font_size`，属预期兜底，不是回归；W5 若遇到这种组合，按原版式两页验收并在回帖注明。用户事后在桌面端把内容改成单行时也回到原规则。`template.json` 多出 `template_source="script_label"`、`card_layout`，大字+小字另有 `sub_font_size`、`headline_lines`、`sub_lines`。

**Mac 出图**（`Claude复盘_2026-09-23/render_check/v2_labels/`，HyperFrames 0.8.46 `snapshot --at 2.5 --no-browser-gpu`，底色是预览用中灰渐变）：真实 v2A xlsx → 模拟模型输出 → `reconcile`（第 1 镜得 `headline_sub`，其余不带）→ `build_composition`：

| 文件 | 版式 | 字号 |
|---|---|---|
| `v2A_shot1_1920x1080_headline.png` | 大字+小字（新） | 54 / 36 |
| `v2A_shot1_1080x1920_headline.png` | 大字+小字（新） | 54 / 36 |
| `v2A_shot6_1920x1080_parameters.png` | 无标签两行（不变） | 42 |
| `v2A_shot6_1080x1920_parameters.png` | 无标签两行（不变） | 42 |

第 6 镜 1920×1080 的 html 与上一稿 `render_check/v2A_shot6_after_fix.html` **逐字节相同**；PNG 与上一稿仅有渲染器抗锯齿差（均值 0.3/255，30 个像素差 >8，出图方式 GPU→SwiftShader 不同所致）。四份 composition 的 `hyperframes lint` 均为 0 errors / 0 warnings。

## 5. 测试改动（准确版，应修 5）

**上一稿（`e5b5bec`→`556210e`，`test_script_card_fields.py`）：删 2、改 10、增 29。**
- 删：`ExtractionTests.test_bare_symbols_are_placeholders_for_hint_but_not_for_content`（口径改为所有字段同一占位规则，被 `test_bare_symbols_are_placeholders_for_every_field` 取代）、`TableReconcileTests.test_the_fuse_does_not_fire_when_only_a_minority_has_cards`（没有上屏列时一律不清，「少数镜才触发保险丝」的前提已不存在）。
- 改 10：括注列名、`文案（上屏）`、封面块、末尾逐字表头副本、半数格子是值的行、真实 tending 形状、中英双列、表外列保护、无上屏列的普通表、1/3 保险丝——除下面两条外都是往更严（改为只告警）。
  - `test_real_machine_tending_shape_prefers_the_field_sheet_over_narration_copy` 里 CRLF 那一段**其实是放松**：旧期望「plan 里的 CRLF 被纠正成 LF（算一条改写）」，新期望「CRLF 与 LF 视为同一换行、0 纠正」。原因：Excel 单元格换行解码后就是 CRLF，逐字比会把正确的 plan 报成改写；真实流程里 `compact_plan` 已先把 plan 侧 CRLF/CR 统一成 LF，渲染层按 `\n` 断行，**没有实际影响**。
  - `test_a_column_this_table_does_not_know_protects_a_correct_plan` 的**夹具多加了一列空的 `上屏文字`**：新规则下没有上屏列的表整表冻结，不加这列就测不到「表外列 `花字文案` 保护正确 plan」这条闸门本身。
  - Y1/Y2 用例（`test_the_y1_y2_fixes_of_the_fourth_review_are_not_undone`）旧注释写「两者都落到只告警/跳过」不准：**Y1 = 跳过（`skipped:table`）；Y2 = 确定档，只是 `分镜标题（全片通用）` 列因括注冲突没认出来、title 不参与校验**。本轮已改注释并加档位断言。
- 增 29：`CertaintyGateTests`、`CellKindTests`、`XstringAndMergeReaderTests`、`LayoutLabelTests`、`CompactPlanLayoutTests` 等。

**第二次复审轮（`556210e`→`4775b9a`）：删 0、改 4、增 21**（`7fc4bf4` 改 4 增 10，`01785c3` 增 11）。
- 改：末尾逐字表头副本、重复表头行两条改为期望只告警（更严）；tending 形状在「文字一个不改」之外多断言第 1 镜得到 `card_layout=headline_sub`；Y1/Y2 见上。
- 增：`SecondReviewTests`（10）、`ScriptLayoutTests`（4）、`ScriptLayoutRenderTests`（7，其中真 HyperFrames lint 1 条缺组件时 skip）。
- 夹具 `tests/xlsx_fixture.py` 新增隐藏列/行写法。Rust 新增 `domain::tests::card_layout_round_trips_and_stays_absent_when_missing`。

**第三次复审轮（`4775b9a`→`29bd93d`）：删 0、改 4、增 12。**
- 增：`ThirdReviewTests`（12，见 §3.3）。
- 改 1（`SecondReviewTests.test_placeholder_variants_are_never_put_on_screen`）：行为断言不变（7 种写法都 0 纠正、plan 逐字节不变），只是其中「`——（不填）`、`无。` 是占位」的断言改成「不是确定占位、是像占位」——占位收窄后它们从「当没写」变成「只告警」，**更严**。
- 改 3（缺 git 的逐字节回归）：`test_script_card_fields.ScriptLayoutRenderTests.test_shots_without_labels_render_byte_identical_to_556210e`、`test_packaging_agent.CompositionTests` 两条 ba6553e 对照（源码约 447 / 471 行），`skipTest` → `fail`（**更严**）。
- Rust 只改了测试夹具的临时目录名（5 个文件），测试数不变。

**Media 第一阶段（`29bd93d`→`efb7350`）：删 0、改 1、增 5。**
- `test_script_card_fields.py` 增 4 个测试方法（R1 三条、S2 一条），并在既有整词提醒用例增加「不填写」断言。
- 新增 `test_check_pkg_contents.py` 1 项，在临时 Git 仓库提交后启用 autocrlf，模拟 clone 后才切换配置形成的混合 LF/CRLF 状态，覆盖 raw-only、filters-only 与双方不匹配。
- 未删除测试、未增加 skip、未放松既有断言。

**Media R1 补修（`5da98cb`→`db239cf`）：删 0、改 2、增 2。**
- 新增 missing / rewritten / copied 三路径子串用例，以及 title / card_hint 子串用例；带标签的 `大字：抓取卡↵副行：留空即可` 明确不带 layout。
- 按 51338403 授权修改旧断言：`不填充` / `留空率` / `不上屏幕` 从“非占位且自动 rewritten”改为“仍非占位，但只告警、不清、不改、不带版式”。

## 6. 验证证据（Mac 历史证据与 Media 实跑分列）

> 本节先列**第三次复审轮**的新证据（§6.0），其后是上一版的证据（仍然有效，数字已按本轮更新）。第三次复审轮的原始数据在 `Claude复盘_2026-09-23/第四轮实施_2026-09-23/`。

### 6.0 第三次复审轮（Mac `29bd93d` 对 `4775b9a`）

- `test_script_card_fields`：**184 ran，OK（skipped=1：真 lint 缺组件）**；`test_packaging_agent` / `test_template_packaging` / `test_render_segment_packaging` 全过（四个模块合计 246 ran，skipped=2，均为真 lint）。
- 全量 `discover("tests")`（Python 3.14.5）：**Ran 582，failures=2，errors=4，skipped=4**（`4775b9a` 为 570；+12 即 `ThirdReviewTests`）。失败/错误与已知基线逐条相同（2F `/var` 符号链接 + 4E 缺 `fc-match`，见下），skipped 4 条 = 两条真 lint + 两条 chromadb 集成（`test_analysis_cache` 的 `test_real_chroma_alias_queries_remain_strictly_scoped`、`test_real_cli_index_export_import_and_cloud_reuse`）。**零新失败。**
- Rust（同一临时工具链）：`cargo test --locked` 单跑 **12 次全过**（每次 106 passed / 4 ignored + 集成 5 passed）；把测试二进制**三进程同时跑 40 轮（120 次）0 失败**。对照：`556210e` 的测试二进制两进程并发 24 次失败 1 次（`incremental::…silent_shot_can_reuse_an_empty_voice_receipt_but_not_stale_audio`）；修复中途（只修了前两个文件）三进程 90 次又抓到 `material_download::…archived_candidate_is_reused_in_a_later_shot` 1 次，一并修掉。
  **已知偶发、已修**（都是测试夹具临时目录撞名，不是产品逻辑）：`clip_manifest::tests::{imports_both_historical_formats_and_preserves_first_sorted_file, incomplete_retry_and_bad_manifests_never_fall_back_to_old_files, rejects_missing_empty_escape_and_duplicate_files, rejects_version_run_revision_and_identity_mismatches}`、`incremental::tests::{reordered_revision_rebuilds_clip_manifest_by_id_and_preserves_producer_ranking_without_executors, reordered_voice_maps_saved_audio_and_cues_to_the_new_timeline_without_tts, silent_shot_can_reuse_an_empty_voice_receipt_but_not_stale_audio, receipts_verify_each_shot_and_reject_missing_corrupt_or_foreign_outputs}`、`material_download::tests::archived_candidate_is_reused_in_a_later_shot`、`checkpoint::tests::changed_output_invalidates_its_step_and_downstream_but_keeps_valid_prefix`、`normalization_cache` 的 `TestRoot` 各用例。Windows 上若仍有 Rust 测试偶发失败，贴出测试名，不要重跑凑通过。
- 真实生产脚本（`05_视频脚本/` 11 xlsx + 9 md，只读副本）：`collect_blocks` 与 `4775b9a` **20/20 逐项相同**（含 v1 / v2 系列只告警的原因列表——两份都没有首镜之前的内容行）；干跑 28 个用例（含「只前 2 镜有卡」变体）档位/纠正/告警/最终字段/`card_layout`/二次校验**全部相同**，即 §6.1 表整张不变。v2A 仍确定档、第 1 镜 `headline_sub`、变体里 3–7 镜卡片照常恢复。
- 7 份标准脚本：`collect_blocks` 7/7 相同；干跑 8/8 完全相同（`card_layout` 均无）。
- 前三轮全部夹具（复盘 `fx/`、复审2 `fx/` 共 57 个用例；复审3 `run.py` P1/L/M/S + `m8.py` + `m10.py`）与 `4775b9a` 比，**只朝「少改/不改」变**：

| 夹具 | `4775b9a` | 本轮 |
|---|---|---|
| P1 `大字：抓取卡↵副行：（不填）`（模型丢掉占位行） | 确定，改成 `抓取卡↵（不填）` + `headline_sub` | 0 改，只告警（占位行） |
| P1b 同上（模型照抄） | 0 改但写 `headline_sub` | 0 改、不带版式，提醒人工确认 |
| P1c `副行：——` / P1d `大字：——↵副行：抓取三要素` / P1e `抓取卡↵无` | 确定，改成带占位行的两行卡（P1c/P1d 带 `headline_sub`） | 0 改，只告警 |
| L9 `大字 A句↵副行 B句`（模型照抄） | 0 改，无告警 | 0 改，多一条「没写冒号」提醒 |
| M8 首行镜号 `1a` 后接 `1` / M8b 片头行 / M8c 首行无号有卡 | 确定，第 1 镜的卡被当臆造**删掉** | 只告警（判据 6），0 改 |
| M10 2 万字以上的格子 | 确定，改写成截断后的半截 | 0 改（截断格只告警） |
| X4 / X5 / C1b（本来就只告警） | 只告警 | 只告警，原因多一条「首镜之前有内容行」 |
| P3 `——（不填）`、P6 `无。`（模型留空） | 0 改 | 0 改，多一条「像占位」告警 |

其余用例（复盘 `fx/` 37 份、复审2 其余、复审3 其余 L/M/S）档位/纠正/是否改 plan/最终卡片逐项相同。

### 6.3 Media 第一阶段实跑（基线 `29bd93d`，2026-09-23）

- 编辑前基线：四专项 246 tests、OK、skipped=2；全量 discover 582 tests、OK、skipped=2。
- 修复后：`test_script_card_fields` **188 tests、OK、skipped=1**；四专项 **250 tests、OK、skipped=2**；全量 discover **587 tests、OK、skipped=2**。两条 skip 均为既有真 HyperFrames lint；0 新失败、0 新 skip。
- 离线干跑 12 例：7 份标准脚本、07 xlsx 仅前 2 镜有卡变体、真实 v2A 原始单元格照抄及仅前 2 镜变体、真实 v1 原始单元格照抄及仅前 2 镜变体。对同一冻结输入分别加载 Git blob 中的 `29bd93d` 模块与修复后模块，完整 report、最终 plan、tier/corrections/warnings/layout 全部 **12/12 严格相同**；二次校验 12/12 为 0 纠正且 plan 不变。该项是离线模拟模型逐字照抄，不冒充真实 Qwen 导入。
- S3 混合换行专项 1/1 通过；双方不匹配时退出 1 的反例也在同一测试内通过。
- 审计目录：`VideoAutoCutDesktop/node_modules/.tmp/fix-round-phase1-29bd93d-20260923-115315/`。

### 6.4 Media R1 补修实跑（基线 `5da98cb`，2026-09-23）

- `test_script_card_fields` **190 tests、0 failures、0 errors、skipped=1**；四专项 **252 tests、0 failures、0 errors、skipped=2**；全量 discover **589 tests、0 failures、0 errors、skipped=2**。两条 skip 仍是既有真 HyperFrames lint，0 新失败、0 新 skip。
- 直接复用上一轮冻结输入（SHA-256 `30bcbb7938f5ff69d5e37bb46521675c261a28487847d1ced1e2dddc2f59a192`），加载 `5da98cb` Git blob 与 `db239cf` 模块比较：12/12 完整 report 与最终 plan 严格相同，二次校验 12/12 为 0 纠正且 plan 不变；v2A 两例仍为 certain，仅第 1 镜 `headline_sub`。
- 审计目录：`VideoAutoCutDesktop/node_modules/.tmp/r1-followup-5da98cb-20260923-135220/`。

### 上一版证据（`4775b9a` 及以前；下面 §6.1 / §6.2 也属于这一版，本轮复核结果不变）

- `test_script_card_fields`：**172 ran，OK（skipped=1：真 lint 缺组件）**；把四件套指向本机组件（node 22 + HyperFrames 0.8.46 CLI + GSAP 3.14.2 + playwright chrome-headless-shell）后 172/172 全过，`test_packaging_agent` 里原有的分页真 lint 也通过。包装相关 `test_packaging_agent` / `test_template_packaging` / `test_render_segment_packaging` 全过。
- 全量（新进程 `discover("tests")`，Python 3.14.5）：**Ran 570，failures=2，errors=4，skipped=4**（`556210e` 为 549）。failures/errors 与 `e5b5bec`/`556210e` 在同机的已知基线逐条相同（2F = `test_material_selection_policy` 两条，macOS `/var` 符号链接；4E = `test_output_format` 3 个 subTest + `test_subtitle_safe_area` 1 条，缺 `fc-match`）；skipped 3→4，多出的是本轮新增的真 lint 用例（缺组件 skip）。**零新失败。**
- Rust（Mac 临时工具链 cargo 1.98.1，只用于核对）：`cargo test --locked` **106 passed / 0 failed / 4 ignored**（`556210e` 为 105，+1 为新增透传测试）+ 集成测试 5 passed。12 次运行里有 1 次出现过 1 个失败、未能复现（其余 11 次全过）——第三次复审轮已定位为测试临时目录撞名并修复，见 §6.0。
- 7 份标准测试脚本：`collect_blocks` 与 `e5b5bec` **7/7 相同**（07 xlsx 仅多出新键 `layout: null`，文字与状态逐字相同）；按原文构造 plan 干跑，纠正条目、告警、最终字段、二次校验 0 纠正与 `556210e` **8/8 完全相同**（含 07 xlsx「只前 2 镜有卡」变体）；均无 `card_layout`（这些脚本没写版式标签）。
- 渲染回归：不带 `card_layout` 的镜，`build_composition` 输出（html + manifest）与 `556210e` 逐字节相同——126 组（7 种卡 × 3 种画幅 × 3 种 agent 版式 × 2 种时长）全同，并写成单测对 `git show 556210e` 比对。

### 6.1 真实生产脚本干跑（`05_视频脚本/` 11 个 xlsx + 9 个 md，只读副本，不调模型）

plan 构造同上一稿（直接读原始单元格模拟模型逐字照抄；另加「只前 2 镜有卡」变体）。

| 文件 | `556210e` 档位/纠正/告警 | 新 HEAD 档位/纠正/告警 | 二次校验 | `card_layout` | 其余字段 |
|---|---|---|---|---|---|
| v1.xlsx | 只告警/0/3 | 只告警/0/3 | 0 | — | 相同 |
| v1.xlsx［只前 2 镜有卡］ | 只告警/0/3 | 只告警/0/3 | 0 | — | 相同 |
| v2A.xlsx | 确定/1/0 | 确定/1/0 | 0 | 第 1 镜 `headline_sub` | 相同 |
| v2A.xlsx［只前 2 镜有卡］ | 确定/11/0 | 确定/11/0 | 0 | 第 1 镜 `headline_sub` | 相同（3–7 镜卡片照常恢复） |
| v2B.xlsx | 确定/3/0 | 确定/3/0 | 0 | 第 1 镜 `headline_sub`、第 7 镜 `equal_lines`（决策树） | 相同 |
| v2B.xlsx［只前 2 镜有卡］ | 确定/11/0 | 确定/11/0 | 0 | 同上 | 相同 |
| v2C.xlsx | 确定/1/0 | 确定/1/0 | 0 | —（第 1 镜 `大字：5 个误区` 是单行） | 相同 |
| v2C.xlsx［只前 2 镜有卡］ | 确定/11/0 | 确定/11/0 | 0 | — | 相同 |
| v2 系列.xlsx（含变体） | 只告警/0/1 | 只告警/0/1 | 0 | — | 相同 |
| EN-A/B/C/D、EN 系列（含变体） | 跳过 | 跳过 | 0 | — | 相同 |
| 9 个 md | 跳过（无「分镜 N」） | 跳过 | 0 | — | 相同 |

v2A 仍是确定档并能恢复卡片；v1 仍只告警、零改动。证据：`Claude复盘_2026-09-23/第三轮实施_2026-09-23/dry_556.json` / `dry_new.json`；第三次复审轮对 `4775b9a` 的复跑见 `第四轮实施_2026-09-23/dry_4775.json` / `dry_final.json`（逐项相同）。

### 6.2 全部夹具（复盘 `fx/` 37 份 + 复审2 `fx/` 18 份，57 个用例）

与 `556210e` 相比只有下列用例变化，其余 44 个档位/纠正/是否改 plan 逐项相同（明细 `fx_556.json` / `fx_new.json`）：

| 夹具 | `556210e` | 新 HEAD |
|---|---|---|
| C1 上方示例同表头号 1 | 确定，第 1 镜被写入「示例卡片」 | 只告警，0 改 |
| C1b 上方示例同表头号空 | 确定，0 改 | 只告警，0 改 |
| C2 表尾说明落在上屏列 | 确定，第 3 镜被写入说明 | 确定，第 3 镜只告警，0 改 |
| C2b 表尾同表头示例 | 确定，0 改 | 只告警，0 改 |
| C4 重复标题掩盖口播错位 | 确定，第 1 镜卡被清、第 2 镜被写入 | 确定，两镜只告警，0 改 |
| P0 `不上屏（本镜）` | 补上屏 | 只告警，不补 |
| P1 `— —`、P2 `-\n-`、P3 `——（不填）`、P4 `Ｎ／Ａ`、P6 `无。` | 补上屏 | 当占位，0 改 |
| P5 `大字：副行：抓取卡` | 改成 `副行：抓取卡` | 0 改（正确值 `抓取卡`） |

不变但值得知道的：C2c（表尾示例号「例」）本来就只告警；C5 见 §3.2 末；C7（上屏列整列空、plan 有卡）按「作者没写」清掉——这是既定口径；C8（`上屏-文字`）按白名单归一命中，确定档。

## 7. Windows 要执行的项

顺序：W0 → W1 → W2 → W3 → W4 → W5 → W6。任一不符立即停下回帖；不要改代码、扩词表、改提示词或手改 `shots.json` 凑通过。所有破坏性配置都用副本，跑完还原。

### W0 · 开工

```powershell
Set-Location 'D:\autocut\video-auto-cut'
git checkout feature/material-agent-select
git pull --ff-only
git rev-parse HEAD                                   # 必须等于 <FINAL_HEAD>
git merge-base --is-ancestor 74d58fb HEAD; $LASTEXITCODE   # 必须 0
git status --porcelain                               # 除已记录的两份 Desktop package 用户修改外必须为空
```

先保留 `0.5.14` 底包（安装新 runtime 会清理同级旧版本）。不给任何嵌入 Python 装 openpyxl / pytest / chromadb。

### W1 · 全量测试 + Rust 测试 + 真 lint

1）Python 全量，用 0.5.14 运行包自带嵌入 Python，**不加 `top_level_dir`、不新增 `tests/__init__.py`**：

```powershell
$Repo = 'D:\autocut\video-auto-cut'
$SourceRoot = Join-Path $Repo 'VideoAutoCut'
$EmbeddedPython = 'D:\Video Edit\VideoAutoCut\workspace\runtime\0.5.14\VideoAutoCut\python-3.11.9-embed-amd64\python.exe'
$Audit = Join-Path $Repo ('VideoAutoCutDesktop\node_modules\.tmp\w1-' + (git rev-parse --short HEAD).Trim() + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $Audit | Out-Null
$Runner = Join-Path $Audit 'run-w1-unittest.py'
$RunnerSource = @'
import os
import sys
import unittest
from pathlib import Path

source_root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(source_root))
sys.path.insert(0, str(source_root / "tests"))
os.chdir(source_root)
suite = unittest.TestLoader().discover("tests", pattern="test_*.py")
result = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
'@
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($Runner, $RunnerSource, $Utf8NoBom)
& $EmbeddedPython --version *> (Join-Path $Audit 'W1.environment.txt')
& $EmbeddedPython -X utf8 $Runner $SourceRoot *> (Join-Path $Audit 'W1.log')
$W1Exit = $LASTEXITCODE
Get-Content (Join-Path $Audit 'W1.log') -Tail 40
"exit=$W1Exit"
```

报告 Ran、failures、errors、skipped、退出码，以及 `test_script_card_fields` 单独数字（Mac 184，1 条缺组件 skip）。**放行门槛：0 failures / 0 errors，且跳过清单只能是下面 4 条**（贴出 `W1.log` 里全部 `skipped` 行）：

| 允许跳过的测试 | 原因 |
|---|---|
| `test_packaging_agent.PagedCompositionTests.test_real_hyperframes_lint_accepts_the_paged_composition` | 真 lint 默认没有组件；由本节 3）指向 Candidate 单独跑 |
| `test_script_card_fields.ScriptLayoutRenderTests.test_real_hyperframes_lint_accepts_the_headline_card` | 同上 |
| `test_analysis_cache.ContentAnalysisTests.test_real_chroma_alias_queries_remain_strictly_scoped` | 需要 chromadb，嵌入 Python 不装（W0 禁止） |
| `test_analysis_cache.ContentAnalysisTests.test_real_cli_index_export_import_and_cloud_reuse` | 同上 |

出现任何别的 skipped 就停下回帖。逐字节渲染回归（对 `556210e` / `ba6553e` 的 `git show`）**缺 git 时会直接失败而不是跳过**（`590a323`），所以 W1 必须在仓库工作区、`git` 在 PATH 上跑。

2）Rust：`Set-Location "$Repo\VideoAutoCutApp"; cargo test --locked` 与 `cargo build --release --locked`。报告测试数（Mac 106 passed / 4 ignored + 5 passed）、release 构建时间、`target\release\VideoAutoCutEngine.exe` 的 SHA-256。`cargo test` 会在仓库根建 `.codex-tmp/`（`tests/material_match_config.rs` 的临时目录），本轮已加进 `.gitignore`；跑完 `git status --porcelain` 除已记录的两份 Desktop package 用户修改外必须为空（`Cargo.lock` 不得变化）。§6.0 列出的「已知偶发、已修」Rust 测试若仍失败，贴测试名与输出，**不要重跑凑通过**。

3）真 HyperFrames lint（仓库里默认 skip，必须指向 Candidate 组件单独跑，**报告 pass 还是 skipped，不许写成「已覆盖」**）。`<Candidate>` 见 W3：

```powershell
$env:VIDEOAUTO_NODE_EXE = '<Candidate>\node-runtime\node.exe'
$env:HYPERFRAMES_CLI = '<Candidate>\tools\material_gen\hyperframes\node_modules\hyperframes\dist\cli.js'
$env:HYPERFRAMES_GSAP = '<Candidate>\tools\material_gen\hyperframes\node_modules\gsap\dist\gsap.min.js'
$env:HYPERFRAMES_BROWSER_PATH = '<Candidate>\tools\material_gen\hyperframes\chrome-headless-shell\chrome-headless-shell.exe'
$LintRunner = Join-Path $Audit 'run-w1-lint.py'
$LintSource = @'
import os
import sys
import unittest
from pathlib import Path

source_root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(source_root))
sys.path.insert(0, str(source_root / "tests"))
os.chdir(source_root)
suite = unittest.TestLoader().loadTestsFromNames([
    "test_packaging_agent.PagedCompositionTests.test_real_hyperframes_lint_accepts_the_paged_composition",
    "test_script_card_fields.ScriptLayoutRenderTests.test_real_hyperframes_lint_accepts_the_headline_card",
])
result = unittest.TextTestRunner(verbosity=2).run(suite)
print("skipped:", [test.id() for test, _ in result.skipped])
raise SystemExit(0 if result.wasSuccessful() else 1)
'@
[System.IO.File]::WriteAllText($LintRunner, $LintSource, $Utf8NoBom)
& $EmbeddedPython -X utf8 $LintRunner $SourceRoot *> (Join-Path $Audit 'W1-lint.log')
"exit=$LASTEXITCODE"; Get-Content (Join-Path $Audit 'W1-lint.log') -Tail 15
Remove-Item Env:VIDEOAUTO_NODE_EXE, Env:HYPERFRAMES_CLI, Env:HYPERFRAMES_GSAP, Env:HYPERFRAMES_BROWSER_PATH
```

两条都必须是 ok（不是 skipped）。本节里的 `$EmbeddedPython`、`$Utf8NoBom`、`$Audit` 沿用 1）里定义的值，后面各节也沿用 `$EmbeddedPython`。

### W2 · 7 份标准脚本导入（plan-only，0.5.14 运行包的**隔离副本**）

**2a. 在 0.5.14 运行包的隔离副本上同步 7 个文件**。**生产的 `D:\Video Edit\VideoAutoCut\workspace\runtime\0.5.14` 一个字节都不动**（它也是 W6 的底包）：先把整个 `VideoAutoCut` 目录复制到独立审计工作区，副本路径必须是 `<W2Workspace>\runtime\0.5.14\VideoAutoCut`（启动器把 `runtime` 往上三级当 workspace），然后只改副本：

```powershell
$Repo = 'D:\autocut\video-auto-cut'
$BaseRuntime = 'D:\Video Edit\VideoAutoCut\workspace\runtime\0.5.14\VideoAutoCut'   # 只读
$W2Workspace = 'D:\Video Edit\VideoAutoCut-w2-audit\' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$Runtime = Join-Path $W2Workspace 'runtime\0.5.14\VideoAutoCut'                      # 已以 VideoAutoCut 结尾，不要再拼一层
New-Item -ItemType Directory -Force (Split-Path -Parent $Runtime) | Out-Null
Copy-Item -LiteralPath $BaseRuntime -Destination $Runtime -Recurse
$Audit = Join-Path $Repo ('VideoAutoCutDesktop\node_modules\.tmp\w2-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$ToolBackup = Join-Path $Audit 'original-tools'
$Changed = @('script_card_fields.py','script_tabular.py','normalize_script.py','template_packaging.py',
             'packaging_agent.py','shot_plan_schema.py','prompts\script_parse.md')
foreach ($Rel in $Changed) {
  $Source = Join-Path "$Repo\VideoAutoCut\tools" $Rel
  $Target = Join-Path "$Runtime\tools" $Rel
  $Backup = Join-Path $ToolBackup $Rel
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "缺少仓库文件: $Source" }
  New-Item -ItemType Directory -Force (Split-Path -Parent $Backup) | Out-Null
  if (Test-Path -LiteralPath $Target) { Copy-Item -LiteralPath $Target -Destination $Backup -Force }
  Copy-Item -LiteralPath $Source -Destination $Target -Force
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Source).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $Target).Hash) { throw "同步后哈希不一致: $Rel" }
}
```

**保留还是还原**：本轮**不改**生产 0.5.14；副本用完即删——W2 全部结束、把每份的 `shots.json`、`engine-full.log` 复制进 `$Audit` 之后，删除整个 `$W2Workspace`。开工前、收尾后各对 `$BaseRuntime\tools` 下这 7 个文件记一次 `Get-FileHash`，两次必须相同（证明本轮没碰底包）；如果开工前就发现它们与 0.5.14 原包不同（以前的轮次在生产目录上同步过），**保持现状、在回帖里说明，不要自行还原**——W6 打包会用仓库 tools 覆盖这些 tracked 文件，不影响 pkg5。

这份 0.5.14 副本的引擎是旧的，会丢掉 `card_layout`——W2 的 7 份脚本都没写版式标签，本来就不该有这个字段，不受影响；`card_layout` 的端到端验证在 W3（新引擎）。

**2b. 导入**：用仓库内启动器 `docs\acceptance-tools\run-plan-only.mts`（不含凭据；从配置目录 `auth.json` 取账号网关、内存合并远端凭据、脱敏日志；引擎参数固定为 `--plan-only --script-file`）。每份脚本一个新审计目录、一个唯一 `project_name`：

```powershell
$Desktop = Join-Path $Repo 'VideoAutoCutDesktop'
$Script = '<脚本文件名>'
$Run = Join-Path $Desktop ('node_modules\.tmp\w2-' + [IO.Path]::GetFileNameWithoutExtension($Script).Substring(0,2) + '-' + (Get-Date -Format 'HHmmss'))
New-Item -ItemType Directory -Force $Run | Out-Null
Copy-Item (Join-Path $Repo 'docs\acceptance-tools\run-plan-only.mts') (Join-Path $Run 'run-plan-only.mts') -Force
$State = @{
  repo = $Repo
  runtime = $Runtime
  env = 'D:\Video Edit\VideoAutoCut\config\app.env'
  script = (Join-Path $Repo "docs\packaging-test-scripts-2026-09-21\$Script")
  project_name = ('w2-' + (Get-Date -Format 'yyyyMMddHHmmss'))
} | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $Run 'state.json'), $State, (New-Object System.Text.UTF8Encoding($false)))
$In = (Join-Path $Run 'run-plan-only.mts').Substring($Desktop.Length + 1).Replace('\', '/')
$Out = (Join-Path $Run 'run-plan-only.mjs').Substring($Desktop.Length + 1).Replace('\', '/')
Push-Location $Desktop
node --input-type=module -e "import { rolldown } from 'rolldown'; const b = await rolldown({input:process.argv[1],platform:'node'}); await b.write({file:process.argv[2],format:'esm'}); await b.close();" $In $Out
if ($LASTEXITCODE -ne 0) { throw '启动器编译失败' }
node $Out
$EngineExit = $LASTEXITCODE
Pop-Location
if ($EngineExit -ne 0) { throw "plan-only 失败，退出码: $EngineExit" }
```

`state.env` 指生产配置（只读使用，缺键默认开启），不能指到没有 `auth.json` 的孤立目录。从 `engine-full.log` 的 `运行目录:` 取 run 目录，结果在 `<run目录>\shots.json`。plan-only 不带 `--restart-all` / `--shots-json` / `--material-manifest`。

7 份脚本：`01_对照组_无上屏卡片_食品码垛_CN.md`、`02_全镜上屏_三版式_食品码垛_CN.md`、`03_混合_show判定_食品码垛_CN.md`、`04_边界_排版极限_含预期失败镜_食品码垛_CN.md`、`05_真实出片_食品码垛讲解_48s_CN.md`、`07_表格版_混合_show判定_食品码垛_CN.xlsx`、`07_纯文本版_混合_show判定_食品码垛_CN.txt`。每份一次**缺键默认开启**导入。

通过标准：

1. `card_content`、`card_hint`、脚本明确写出的 `title` 与作者原文逐字相同。原文对照：

| 脚本 | `card_content` | `card_hint` |
|---|---|---|
| 01 | 6 镜全空 | 全空 |
| 02 | 1–7 全有 | 3=`参数卡，列表排版`；5=`要点卡`；7=`CTA 行动号召`；其余空 |
| 03 / 07 xlsx / 07 txt | 1=`来料到位是码垛稳定的第一道关`；5=`占位卡 05`；7=`带上你的包装形态和目标垛型，一起把这条线试一遍`；其余空 | 7=`CTA 行动号召`；其余空 |
| 04 | 1–6 全有 | 4=`参数卡，列表排版`；6=`英文长标题，逐字保留，不要拆词、不要加空格`；其余空 |
| 05 | 1=`一条线同时接住瓶装、箱装和袋装`；5=`节拍 700 包/小时｜输送带连续来料｜托盘满垛下线`；6=`把你的包装形态和目标垛型发过来，我们照着试一遍`；其余空 | 5=`参数卡`；其余空 |

2. 占位（「（不填）」「无」「-」「—」「／」「N/A」「空白」「不上屏」等）对应的 `card_content` 键**不存在**（不能是空字符串）。
3. 03 三种格式的 title 逐字保留（尤其 03-4 长句、03-6「开场」）；02/04 没写 title 时的 `分镜N` / 自拟标题保留、不告警；`module_label` 不纳入。
4. 7 份都应是 `certain`；`duration`、`voice_text`、`subtitle`、`module_label` 不被这层修改；所有镜都没有 `card_layout`。
5. 贴出每份的 `[script] 脚本字段校验` 日志、`cardFieldCorrections`（`VACUT_EVENT` 里 `workflowStage=script`、`phase=card_fields`）、只告警原文。**两次导入的纠正数不要求相同**，只要求最终作者字段逐字一致。

### W3 · 真实 v2A 与 v1（新引擎 Candidate；只读原件，不上传、不贴敏感正文）

**3a. 准备 Candidate**：沿用 9/22 已建的隔离 Candidate（`Base` 不动）：

```text
AuditWorkspace=D:\Video Edit\VideoAutoCut-b3b6-audit\2976c0a-20260922-142715
Candidate=D:\Video Edit\VideoAutoCut-b3b6-audit\2976c0a-20260922-142715\runtime\2976c0a851170f292725668826bbcad16bc266cf\VideoAutoCut
```

在 AuditWorkspace 下新建本轮子目录，另存 `git rev-parse HEAD`（必须 = `<FINAL_HEAD>`）。然后：
- 用 `git -C <repo> -c core.quotePath=false ls-files -- VideoAutoCut/tools` 取**全部 tracked tools**，对每个文件比 repo 与 Candidate 的 SHA-256，不同的先备份再覆盖；最后另存清单与逐文件 SHA，**mismatch 必须为 0**。只复制 tracked 文件，不从 repo 复制 `node_modules`、嵌入 Python、ffmpeg 或 config。
- 备份 Candidate 的 `VideoAutoCutEngine.exe`，换成 W1 刚编出的 `target\release\VideoAutoCutEngine.exe`，核 SHA-256 相同，并跑一次 `VideoAutoCutEngine.exe --help` 确认含 `--material-manifest` 与 `--project-name`。
- 用 Candidate 嵌入 Python 跑 `tools\material_gen\pi\install_pi.py --check` 与 `tools\material_gen\hyperframes\install_hyperframes.py --check --runtime-root <Candidate>`，任一非 0 立即停。
- 配置副本放在原配置目录（旁边要有 `auth.json`）：`Copy-Item 'D:\Video Edit\VideoAutoCut\config\app.env' 'D:\Video Edit\VideoAutoCut\config\app.env.w3-20260923'`。

**3b. 导入**：同 W2 的 2b 启动器，但 `state.runtime=<Candidate>`、`state.env=...\app.env.w3-20260923`（启动器会把 workspace 设为 AuditWorkspace）。只跑两份，各一次缺键默认开启：

- `上下料科普脚本_v2A_机器人给机床上下料_一个循环里到底发生了什么.xlsx`（SHA-256 `9f804531f7aafeb7fda7157170d684a7e928ebd0546ab9eaf5e8a97e567a0048`）。通过标准：
  1. 日志档位 **`certain`**。
  2. 仓库根执行 `& $EmbeddedPython -X utf8 docs\acceptance-tools\check_v2a_shots.py "<v2A 原件>" "<run目录>\shots.json"`，必须 `RESULT mismatches=0`：7 镜 `card_content` 与原始 `屏字/大字` 单元格**剥掉行首白名单标签后**逐字相同（含换行），`card_hint` 与 `原创图层` 逐字相同，**第 1 镜 `card_layout=headline_sub`、其余 6 镜没有该键**。该脚本的 expected 一侧独立实现（只用读取层取原始单元格，不经 `collect_blocks`、不折叠空白）。同一脚本也对 `<AuditWorkspace>\temp\normalized_script_shots.json`（Python 层输出，下一次导入会覆盖，跑完立即复制）跑一次，两者都 0 mismatch 才证明 Rust 透传无损。
  3. 用同一份 `shots.json` 离线再校验一次必须 0 纠正（仓库根）：
     ```powershell
     & $EmbeddedPython -X utf8 -c "import sys,json,copy; sys.path.insert(0,'VideoAutoCut/tools'); import script_card_fields as s; p=json.load(open(sys.argv[1],encoding='utf-8-sig')); b=copy.deepcopy(p); r=s.reconcile(p,sys.argv[2]); print(r['tier'],len(r['corrections']),p==b)" "<run目录>\shots.json" "<v2A 原件>"
     ```
     期望输出 `certain 0 True`。
- `上下料B端视频脚本_v1.xlsx`（SHA-256 `26774902cad264da98f76aa47b6f804b512762f7f267c03c009feebc512eaaf8`）：必须 **`warn_only`（`skipped:uncertain`）**、0 纠正、没有 `card_layout`；最终 `card_content` / `card_hint` 就是模型输出（不被清空）。回报 sheet 数、识别 sheet / 表头行 / 角色、镜数、告警原文。

不批量调用其它生产 xlsx 的 qwen。

### W4 · 关闭包装旧渲染回归

用 W3 的 Candidate，取 `51296044` A1 用过的同一批 9 月 18 日 7 镜输入与原参数，`VIDEOAUTO_TEMPLATE_PACKAGING=false`，所有输出写入 AuditWorkspace，最终代码直调 `render_segment`。7 镜成片 SHA-256 与 `51296044` A1 留存值**逐镜相同**，两边都不产生 `packaging/` 目录。贴「镜号、旧 SHA、新 SHA」七行。

直调参数不要手拼：从那次 run 的 `run.log` 里 `>>> python render_segment` 的下一行复制完整命令，只把 `--output` 与临时输出路径改到本轮审计目录：

```powershell
Select-String -Path '<已有run目录>\run.log' -Pattern '^>>> python render_segment$' -Context 0,1
```

最终 env：`VIDEOAUTO_ROOT` / `VIDEOAUTO_RUNTIME_ROOT=<Candidate>`，`VIDEOAUTO_DATA_ROOT` / `VIDEOAUTO_WORKSPACE_DIR=<AuditWorkspace>`，`VIDEOAUTO_CONFIG_ROOT` 为配置目录、`VIDEOAUTO_ENV_PATH` 为 W3 的配置副本，PATH 前置 `<Candidate>\ffmpeg\bin` 与 `<Candidate>\node-runtime`。

### W5 · 开包装实跑 v2A 第 1、6 镜并截图（新版式验收）

用 W3 v2A 的 `<run目录>\shots.json`（不手改）。直调参数同 W4 的取法（复制一镜完整命令），只改：`--shots-json <v2A shots.json>`、`--shot-index 1` / `6`、`--output` 到本轮审计目录；`--duration` 用 v2A 该镜时长（第 1 镜 11 秒、第 6 镜 12 秒，即原件 `时长s` 列）。env 同 W4，另设 `VIDEOAUTO_TEMPLATE_PACKAGING=true`、`VIDEOAUTO_PACKAGING_SCRIPT_ONLY=1`、`PACKAGING_AGENT_CACHE=false`。跑两轮：

- **5a（agent 开）**：`PACKAGING_AGENT_SELECT=1`、`PACKAGING_AGENT_BACKEND=pi`、`MATERIAL_AGENT_PI_PROVIDER=evst-gateway`、`PI_CODING_AGENT_DIR` 指向审计目录下新建空目录。通过标准：第 1 镜 `packaging\<输出名>\packaging-agent-log.json` 里 `script_layout=headline_sub`、`decision.overridden=script_layout`、`decision.source=script_label`、`timings.model_seconds=0`（**没问模型**），stdout 有 `[packaging] 分镜 1 版式 headline（脚本版式标签，…）`；第 6 镜照常调用模型（记录它选的版式即可，不设门槛）。
- **5b（agent 关）**：`PACKAGING_AGENT_SELECT=0`。通过标准（`packaging\<输出名>\template.json`）：

| 镜 | `template` | `font_size` | `sub_font_size` | `template_source` | `card_layout` | `pages` |
|---|---|---|---|---|---|---|
| 1 | `headline` | 54 × 画面缩放 | 36 × 画面缩放 | `script_label` | `headline_sub` | 1 页：`抓起来、放进去？` / `决定成败的其实是三件事` |
| 6 | `parameters` | 42 × 画面缩放 | （无） | `deterministic` | （无） | 1 页两行，无「大字：」等标签 |

（1920×1080 与 1080×1920 的缩放都是 1；若 A1 那条命令是其它分辨率，按 `min(宽,高)/1080` 换算。）两镜 `render.log` 里 HyperFrames lint 通过、成片自校验通过。

截图：`ffmpeg -ss 2.5 -i <成片> -frames:v 1 shot1.png`（第 6 镜同理），与 Mac 图 `Claude复盘_2026-09-23/render_check/v2_labels/v2A_shot1_1920x1080_headline.png`、`v2A_shot6_1920x1080_parameters.png` 对比（竖版素材对 `_1080x1920_`）：卡片位置、第一行大/第二行小一号且偏灰白、左侧青色条（第 1 镜）/浅蓝条（第 6 镜）、画面上没有任何版式标签。Mac 图底色是预览用中灰渐变，实拍画面不同属正常。截图随回帖附上。

### W6 · 打包 pkg5 与全目录核对（只本地，不上传）

1）打包前在仓库根贴出：

```powershell
git status --porcelain VideoAutoCut
git -c core.quotePath=false ls-files --others --exclude-standard VideoAutoCut                 # 未跟踪、未被忽略
git -c core.quotePath=false ls-files --others --ignored --exclude-standard VideoAutoCut/tools | Select-String -NotMatch 'node_modules|__pycache__|\.pyc$|chrome-headless-shell'   # 被忽略、又不是安装产物
```

`git status --porcelain VideoAutoCut` 必须为空；后两条清单原样贴出（打包会把 `tools/` 下这些文件一并拷进包，除非命中排除规则）。

2）排除规则探针：在仓库工作区临时创建两个文件，打完包立即删除。说明：`74d58fb` 修的是「拷进暂存目录」那一步；zip 收文件时还有第二道同名规则，所以探针验证的是**两道过滤的最终结果——包里确实没有这两类路径**，暂存目录那一步只能看代码（暂存目录打包完即删）：

```powershell
New-Item -ItemType Directory -Force 'VideoAutoCut\tools\material_gen\records' | Out-Null
Set-Content 'VideoAutoCut\tools\material_gen\records\_probe_w6.txt' 'probe'
New-Item -ItemType Directory -Force 'VideoAutoCut\tools\material_gen\hyperframes\node_modules\.cache' | Out-Null
Set-Content 'VideoAutoCut\tools\material_gen\hyperframes\node_modules\.cache\_probe_w6.txt' 'probe'
```

3）安装与打包（先装进**仓库**的 `tools/material_gen/pi/` 与 `.../hyperframes/`，打包脚本先复制底包、再用仓库 tools 覆盖）：

```powershell
Set-Location 'D:\autocut\video-auto-cut'
python VideoAutoCut\tools\material_gen\pi\install_pi.py
python VideoAutoCut\tools\material_gen\pi\install_pi.py --check
python VideoAutoCut\tools\material_gen\hyperframes\install_hyperframes.py --runtime-root "<保留的0.5.14底包目录>"
python VideoAutoCut\tools\material_gen\hyperframes\install_hyperframes.py --check --runtime-root "<保留的0.5.14底包目录>"
Set-Location VideoAutoCutDesktop
$env:VIDEOAUTO_RUNTIME_VERSION = "0.5.15-agent-trial-pkg5"
$env:VIDEOAUTO_RUNTIME_BASE_ROOT = "<保留的0.5.14底包目录>"
npm run release:pack:runtime
```

不要给 HyperFrames 安装加 `--omit=optional`。两个 `--check` 必须在打包前退出 0。`release:pack:runtime` 会跑 `cargo build --release --locked`，引擎 SHA-256 应与 W1 相同（不同就说明两次构建输入不同，停下回帖）。打完删掉两个探针文件与空目录。

4）解压到独立临时目录后核对：

```powershell
& $EmbeddedPython -X utf8 docs\acceptance-tools\check_pkg_contents.py --repo . --head <FINAL_HEAD> --pkg "<解压目录>\VideoAutoCut" --json "<审计目录>\pkg5-contents.json"
```

该脚本按 `pack-runtime.ts` 的 `syncRepoScripts()` 映射，逐文件同时取得 `<FINAL_HEAD>` 的 Git raw blob 与 `git cat-file --filters <FINAL_HEAD>:<路径>` 字节，包内文件匹配任一口径即通过，并在 JSON/控制台注明 `raw`、`filters` 或 `raw+filters`。这样既覆盖正常 autocrlf 检出，也覆盖 clone 后才开启 autocrlf 造成的工作区 LF/CRLF 混合；`--repo` 必须是打包用的那个工作区：

| 包内路径 | 仓库来源 | 要求 |
|---|---|---|
| `tools/` | `VideoAutoCut/tools/`（叠加在 0.5.14 底包上，只先清空 `tools/prompts`） | **全部 tracked tools mismatch=0、missing=0**（排除规则命中的除外，脚本会单列） |
| `config/` | `VideoAutoCut/config/` | mismatch=0；**不得**出现 `app.env`、`auth.json`、`device.json` |
| `sentrysearch/sentrysearch/`、`sentrysearch/sentrysearch_entry.py` | 同名 | mismatch=0 |
| `fonts/noto-sans-cjk-sc/` | 同名（按 manifest 只拷 manifest + 字体） | mismatch=0 |
| `prompts/rust/` | `VideoAutoCutApp/prompts/` | mismatch=0 |
| `VideoAutoCutEngine.exe` | 本轮 release 构建 | SHA-256 = W1 构建 |

脚本另外输出「包内 `tools/` 有、`<FINAL_HEAD>` 没有」的**全部**文件：安装产物（`node_modules`、`chrome-headless-shell`）按目录计数，其余（**0.5.14 底包残留**，以及工作区未跟踪文件）逐个列出——把这份清单原样贴回，由 Mac 判断是否需要处理；它不单独判失败。**`RESULT mismatch+missing+forbidden` 必须为 0。**

同时确认 zip 里**没有**任何 `tools/material_gen/records/`、`node_modules/.cache/` 路径（两个探针都不在包里）：

```powershell
& $EmbeddedPython -c "import zipfile,sys; n=[x for x in zipfile.ZipFile(sys.argv[1]).namelist() if '/material_gen/records/' in x or '/node_modules/.cache/' in x or '_probe_w6' in x]; print(len(n)); print('\n'.join(n[:20]))" "<zip路径>"
```

期望 `0`。再用**包内**嵌入 Python 各跑一次 `install_pi.py --check` 与 `install_hyperframes.py --check --runtime-root <解压目录>\VideoAutoCut`，确认没被底包旧 tools 覆盖回去。

记录 zip 文件名、字节数、SHA-256；`runtime-release\manifest.json` 的 `latest == 0.5.15-agent-trial-pkg5`，三处一致。**到此停止，不执行 `release:upload:runtime`。**

## 8. 禁止项

- 不上传任何包，不执行 `release:upload:runtime`；线上 `runtime/manifest.json` 保持 0.5.14，`runtime-trial/` 不动。
- 不合 master，不发正式版。
- 不改生产 `app.env`（用副本，跑完删除副本）、不改用户 `.pi`（Pi 用 `PI_CODING_AGENT_DIR` 指空目录）、不改 `release-upload.local.json`。
- 不 reset / 不覆盖 Media 机两份 Desktop `package.json` / `package-lock.json` 上的用户修改；所有“全局 status 为空”门槛均明确排除这两项已记录例外，其余输出仍须为空。
- 不给生产嵌入 Python 装 pytest / chromadb / openpyxl；不改测试刷绿；不扩词表、不改提示词、不手改 `shots.json`。
- 不批量调用其它生产 xlsx 的 qwen（W3 只有 v2A、v1 两份）。

## 9. 已知限制 / 待拍板

- **`参数卡` / `决策树` 模板**：暂按各行一样大出，以后再做专门模板。
- **`[无标签, 副行/小字]` 也判「大字+小字」**：v1 表里有「机床在等人？\n副行：…」「上下料 → …\n小字：…」这种首行不写「大字：」的写法，本轮按大字+小字处理（第二行明确标了副行/小字）。v1 目前整份只告警，不会带版式；若用户认为首行必须写「大字：」才算，改一行判断即可。
- **`card_layout` 只来自确定档表格脚本**：只告警 / 跳过的脚本（v1、v2 系列、EN 表、全部 md）不带版式，多行卡片仍是各行一样大，agent 可改版式。
- **桌面端改了卡片文字**：`card_layout` 不会跟着变；内容改成单行时自动回到原规则，改成别的两行时仍按大字+小字出。
- **md 单行写法**：真实 md 把卡片写成一行「大字：A ／ 副行：B」，按「只剥行首」只会剥掉「大字：」；这类 md 没有「分镜 N」标记，不进校验，也没有原文兜底。是否把「／」之后也当行首，待用户定。
- **EN 表格**（`Beat` / `英文旁白 VO`）整份跳过；是否加进白名单待用户定。
- **可见的旧上屏列**（复审 C5 夹具形状：白名单 `上屏文字` 列留着旧值，作者在不认识的新列里写新值）：仍按白名单列补「丢失」，无法与正常表区分；真正隐藏的旧列已降级。
- **章节横幅行**：见 §2 醒目框。
- 「确定」判据整体是**宁可漏改**：图例/示例/重复表头、括注才认出的关键列、关键列横向合并、隐藏列/行、首镜之前有内容行的表都只告警，需要人工核对。
- **两镜口播逐字相同**（复审3 M5）：锚点认不出谁是谁，按位置纠正。镜号本身严格 1..N、块数与 plan 相等时位置就是对的，可接受；不另做检测。
- **「看起来隐藏」的列/行**（`width=0` / `ht=0`、字体颜色与底色相同等）不检测，只认 Excel 的 `hidden` 属性。
- **像占位的整格只告警**：`没有！` `None.` `——（不填）` `无。` 以及每行都是占位的两行格，不再当没写——模型照抄了会原样上屏（有提醒），模型造了别的卡也不会被清掉，需要人工看。
- **说明疑点闸门统一按子串**：原文含「不上屏 / 不填 / 不填写 / 留空」字样的（包括 `不填充的区域` 这种正文），missing / rewritten / copied 都只告警；整格确定占位仍按“作者没写”处理。
- **正文中间有 `**` 的 card_content / title / card_hint**只告警：渲染层不解析 markdown，照原文会显示星号，去掉又不是原文，交给人定。

## 10. 回帖模板

````markdown
# Windows 回帖：2026-09-23 修复轮终版（<FINAL_HEAD>）
- W0：HEAD=…；ancestry 74d58fb=0；status 除两份已记录 Desktop package 用户修改外为空=是/否
- W1：Python Ran …，failures=…，errors=…，skipped=…（清单=仅 §7 W1 表中 4 条？），exit=…；test_script_card_fields=…；Rust passed=…/ignored=…、有无偶发失败（测试名）=…；cargo 后 status 除两份已记录 Desktop package 用户修改外为空=…；引擎 SHA-256=…；真 lint 两条=pass/skipped
- W2：隔离副本路径=…、已删除=…、底包 7 文件哈希前后一致=…；7 份 tier=…；card/hint/title 逐字一致=…；占位键不存在=…；card_layout 均无=…；corrections / 告警原文见下
- W3：Candidate tracked tools mismatch=…；引擎已替换且 SHA 一致=…；两个 --check rc=…
       v2A tier=…、check_v2a_shots（shots.json）mismatches=…、（normalized_script_shots.json）mismatches=…、二次校验=…
       v1 tier=…、纠正=…、card_layout 无=…、卡片保留=…
- W4：7 镜 SHA 全同=是/否（七行表）
- W5：5a 第 1 镜 script_layout/overridden/model_seconds=…；第 6 镜 agent 选=…
       5b 第 1 镜 template/font/sub_font/source=…；第 6 镜 template/font=…；截图见附件，与 Mac 图对比结论=…
- W6：打包前 git status 空=…、未跟踪清单=…；pkg5 zip/size/SHA-256=…；check_pkg_contents RESULT=…；tools 多出文件清单见下；zip 探针=0?；包内两个 --check rc=…；manifest.latest=…
- 状态：未上传=是；master 未合=是；app.env/.pi/release-upload.local.json 未改=是；Desktop package*.json 未 reset=是
````
