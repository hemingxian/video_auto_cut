# VideoAutoCut 开发方案 + 验收单：标准模板导入器 · 分镜字段补齐与透传 · 分镜工作区对上模板

2026-09-23 · Mac Claude 起草（只读代码，未改仓库）· 基线 `origin/feature/material-agent-select` = `1bc0fdb`
分工：**Windows 端 Codex 实施**（改代码、跑测试、实跑、回帖），**Mac Claude 审核**（拉 diff 独立审，按本文验收）。
模板正本：`docs/script-template-v1/`（Mac 入库，见 §9；Codex 不写、不改模板文件）。列定义以其中 `模板设计说明.md` 为准。

---

## 0. 用户口径（本轮一切判断的依据）

1. **一切以作者脚本为准**：AI 不改写口播 / 字幕 / 上屏文字 / 分镜标题；拿不准的只告警、不改；没写的不上屏，写了的不删。
2. 模板 v1 的 6 条拍板（2026-09-23）：
   - 示例暂时单独存一个文件（有了专用解析器以后可以放回模板里，**本轮不放**）；
   - 不砍列，音效暂时写在「备注」里（专用解析器以后可以拆成单独一列，**本轮不拆**）；
   - 逐字出处校验：全角/半角标点差异不算错；「／」换成换行标黄待确认（这是**转换器**的规则，本轮不做转换器，只在导入闸门里认黄格）；
   - 部分摘取标黄；
   - 字幕留空 = 同口播；时长按整数秒；一个文件只放一种语言；
   - **导入闸门：红格禁止导入；口播/字幕/上屏文字里的黄格禁止导入；景别、运镜等制作字段的黄格可以导入，但要提醒。**
3. 架构方向（`Claude复盘_2026-09-23/架构评估_2026-09-23.md`）：模板脚本由程序确定性读取，**不经大模型**；非模板走老路（Qwen + 纠正器，本轮不动）；schema 不再三处手写，以后加字段不应再重编引擎。
4. 包装美化后置；软件现在已能出成片。

## 1. 目标与不做什么

**本轮目标（三件打包，一个里程碑）**

| # | 做什么 | 验收一句话 |
|---|---|---|
| A | **模板导入器**：认出标准模板后，只读「分镜脚本」sheet，逐列确定性生成 plan，执行导入闸门；**这条路一次模型/网络调用都没有** | 模板文件导入零 Qwen；非模板文件的输出与 `1bc0fdb` **逐字节一致** |
| B | **分镜数据补齐 + 通用透传**：模板新增列进 `shots.json`（`script_meta` 命名空间），Rust/Python 对不认识的键**原样保留** | 以后加字段只改 Python 导入器 + 桌面端，**不用重编引擎** |
| C | **分镜工作区对上模板**：口播/字幕/上屏/画面内容可看可改，景别/运镜/角度/转场下拉，告警与黄/红状态逐镜可见可确认，改过的字段标「人已改」 | 从导入 → 工作区改一处字幕 → 出片，改动体现在成片里 |

**本轮不做**

- 包装美化、品牌包、新卡片版式（「参数卡/决策树」专用版式也不做）。
- 非模板路径的任何改造：`normalize_script` 的 Qwen 路、`script_card_fields` 纠正器、`prompts/*.md`、`TABLE_ROLE_BY_KEY` 表头门槛（设计说明 §9 P0-2、P1-4、P1-7）一律不动。
- 选材改造：不把「推荐素材来源」解析成 `material_bindings`，不让选材用景别/运镜（见 §8 可选后续）；`optimize_queries` 照旧运行。
- 客户脚本 → 模板的转换器（设计说明 §8）；「示例 sheet 放回模板」；音效单独成列。
- 渲染层消费 `transition` / `camera_move`（只存不用）。
- 打包、上传、合 master（见 §7）。

---

## 2. 现状（带证据，基线 `1bc0fdb`）

### 2.1 导入入口与「哪里决定走 Qwen」

| 事实 | 证据 |
|---|---|
| 桌面端「预览分镜」→ 队列项 `mode:'plan'` → `task:start` → 引擎参数 `--script-file <path> --plan-only` | `src/pages/StartPage.tsx:53`；`useStartTaskController.ts:749-776`；`taskQueueModel.ts:103-124`；`electron/task-service.ts:199-212` |
| 引擎**先于执行循环**解析脚本：`--script-file` 走 `read_plan_from_script_ai`，`--shots-json` 走 `read_plan_from_file` | `VideoAutoCutApp/src/main.rs:402-409` |
| `read_plan_from_script_ai` 只做一件事：起内置 Python 跑 `tools/normalize_script.py --input --output <data_root>/temp/normalized_script_shots.json --topic <文件名>`，再读回 | `VideoAutoCutApp/src/script.rs:75-110` |
| **Rust 里没有任何 qwen-long / 脚本解析逻辑**，走不走模型完全在 `normalize_script.py` 里决定 | Rust 全仓无 `qwen-long`、`script_card_fields` |
| `normalize_script.main()`：**无条件**先把文件上传 DashScope（`upload_script_file`），再 `normalize_with_ai`（qwen-long），可能再 `review_voice_and_subtitles_with_ai`，然后 `verify_card_fields` 纠正、`ensure_progress_labels(reviewer=Qwen)` | `VideoAutoCut/tools/normalize_script.py:374-431`（上传 `:390`，解析 `:400`，复核 `:405-414`，纠正 `:425`，章节标签 `:427`，写盘 `:430`） |
| `ensure_progress_labels` 在 `reviewer` 非空时会调 Qwen 复核章节名；`reviewer=None` 时纯本地 | `VideoAutoCut/tools/progress_labels.py:65-91` |
| 表格读取层是纯标准库（嵌入式 Python 无 pip），读值、合并、隐藏行列、数值/公式/截断标记；**不读单元格底色** | `VideoAutoCut/tools/script_tabular.py:1-24`、`:126-146`（`CellText.kind`）、`:356-417`（`_sheet_grid` 忽略 `c@s`） |
| 标签剥离 / 占位 / 版式：`script_value`、`layout_from_labels`、`field_doubt`、`is_placeholder`、`authored_field_value` | `VideoAutoCut/tools/script_card_fields.py:563`、`:390`、`:519`、`:492`、`:325` |

### 2.2 shots 字段「三处手写」与丢字段点

| 层 | 定义 | 对不认识的键 |
|---|---|---|
| Rust `Shot` / `ShotPlan` | `VideoAutoCutApp/src/models.rs:7-85`、`:124-148`；无 `flatten`、无 `deny_unknown_fields`；`schema_version` 缺省 2（`:146-148`） | **读入即丢**。`main.rs:426-429` 用强类型 `initial_plan` 写 `run/shots.json`——Python 输出里 Rust 不认识的键在这里**永久丢失**。之后的 `main.rs:650-653`、`:668-671`、`incremental.rs:577/734/745` 都按 `serde_json::Value` 写，不再丢 |
| Rust 版本检查 | `material_clip.rs:76-80`：`schema_version != 2` 直接失败 | — |
| Python `normalize_shot_plan` | `VideoAutoCut/tools/shot_plan_schema.py:141-246`；可选字段白名单 `:198-217`；`schema_version` 写死 2（`:153`） | **全部丢弃**（按白名单重建 dict）。被 `optimize_queries.py:228,232`、`prepare_voice.py:642`、`prepare_cards.py:74` 在生成阶段反复调用 → 即使 Rust 透传了，Python 这三步也会把新字段洗掉 |
| TS `ShotDraft` | `VideoAutoCutDesktop/src/pages/start/types.ts:96-119`，有索引签名 `[key: string]: unknown`（`:118`）；`ShotPlanRoot = Record<string, unknown>`（`:121`） | **保留**：`normalizeShots` 展开原对象（`shotPlan.ts:50-55`），`saveShots` 展开 `planRoot`（`useStartTaskController.ts:985-992`）。例外：`material_bindings` 被收窄到最小键（`shotPlan.ts:7-35`）；值为 `undefined` 的键会被 `JSON.stringify` 去掉 |
| TS 写死版本号 | `schema_version: 2` 硬编码 6 处：`useStartTaskController.ts:539,646,987,1045,1061,1087`，`resumeGeneration.ts:61` | — |
| TS 读文件上限 | `electron/workspace-service.ts:732-742` `readTextFile(file, max = 200000)`：超过 200 KB **只返回尾部** → `JSON.parse` 失败 | 加了 `script_meta` 后 50 镜左右的 shots.json 会逼近这个上限（§4.4） |
| 下游只按白名单读，不受多余键影响 | `material_agent_select.py:567-603`（`SHOT_TEXT_FIELDS`）、`packaging_agent.py:50`（`CONTEXT_FIELDS`）、`template_packaging.py:45-97` | — |
| 增量缓存键 | `incremental.rs:123-146` `shot_input`：`query/voice/download/clip` 各取字段子集，**其它阶段（`_`）哈希整镜**；`incremental.rs:370-385` `aggregate_input` 哈希整份 plan（去 `task_revision`） | 新增的注释性字段会让「确认一条提醒」也触发整镜重渲（§4.3.4） |

### 2.3 字幕显示的现行规则（影响「字幕 ≠ 口播」与端到端验收）

- `final_video.rs:270-283` `segment_subtitle`：**有口播的镜，屏幕字幕一律取口播 `voice_text`**；`subtitle` 只在无口播镜使用。有单测锁定（`final_video.rs:512-531`）。
- `render_segment.py:574,584` 用 `args.subtitle or voice_text`；`:316-343` 有字幕时间轴（ASR 按口播打的）只在文本一致时使用，不一致就按句子均分时长（代码注释明说是给「用户改了显示文字」的情况）。
- 结论：模板示例第 7 镜「口播读 3 千瓦、字幕写 3 kW」在现有代码下**字幕不会出现在成片里**；工作区「改一处字幕」对有口播的镜也**不会体现在成片里**。本轮必须处理（§4.3.3）。

### 2.4 工作区显示 / 编辑哪些字段、怎么保存

| 事实 | 证据 |
|---|---|
| 可编辑字段联合类型只有 5 个：`'title' \| 'voice_text' \| 'download_query' \| 'visual_query' \| 'clip_requirements'` | `src/pages/start/types.ts:18` |
| 标签：分镜标题 / 口播文案 / 素材搜索词 / 想要的画面 / 剪辑要求 | `src/pages/start/constants.ts:3-9` |
| 抽屉逐镜渲染：序号、标题、时长只读；上面 5 个输入框；素材绑定区 | `ShotEditorDrawer.tsx:238-275`（输入框 `:256-262`，素材 `:264-273`、`:279-370`） |
| **不显示**：`subtitle`、`card_content`、`card_hint`、`card_layout`、`module_label` 等 | 同上 |
| `ShotMaterialBoard` 只读，brief 页显示口播/搜索词/画面/剪辑要求 | `ShotMaterialBoard.tsx:153`、`:218-221` |
| `StoryboardEditorReferencePage` 是**假页面**（fixture，保存只设 `savedAt`，不落盘） | `material-workflow-reference/StoryboardEditorReferencePage.tsx:20-97`（保存 `:56`） |
| 编辑：`updateShotField` → `updateShotContent`（改 `download_query/visual_query/visual_mode/clip_requirements` 时重置自动选材并置 `query_optimized:false`） | `useStartTaskController.ts:913-921`；`shotPlan.ts:100-104` |
| 保存链：`saveShots` → `api.saveTaskDraft`（SQLite 草稿）→ `api.writeFile(shotsPath, JSON.stringify(root,null,2))` → preload `file:write` → `workspace-service.writeTextFile`（非原子写） | `useStartTaskController.ts:971-1020`；`preload.ts:54`；`ipc-channels.ts:29`；`ipc-handlers.ts:257`；`workspace-service.ts:744-752` |
| 800 ms 防抖自动保存草稿（只进 SQLite） | `useStartTaskController.ts:637-677` |

### 2.5 告警在界面上看不到

- 纠正器发的事件带 `cardFieldCorrections`（`script_card_fields.py:1497-1524`），但桌面端 `parseWorkflowEventLine` 只取 stage/status/phase/progress/plan（`electron/task-events.ts:128-149`），**其余键全部丢弃**；`TaskEvent` 类型也没有位置放（`src/types/videoauto/task.ts:1-19`）。
- 告警只以纯文本行进日志抽屉（`LogDrawer`，`StartPage.tsx:170-174`），没有逐镜展示。

---

## 3. 设计 A：模板导入器（确定性，零模型）

### 3.1 新文件与入口

- 新模块 `VideoAutoCut/tools/script_template.py`（纯标准库）。对外三个函数：
  - `detect(path) -> TemplateMatch | None`：是不是标准模板（§3.2）；
  - `import_template(path, topic) -> (plan, report)`：读取 + 闸门 + 生成 plan（`plan` 已过 `normalize_shot_plan`）；
  - `main()`：命令行干跑 `python script_template.py --check <xlsx> [--json <报告路径>] [--plan <plan路径>]`，不写 shots.json、不联网，给 §6.2 干跑用。
- `script_tabular.py` **新增**（不改已有函数）`read_sheet_fills(path, sheet_name) -> dict[(row, col), str]`：单独解析 `xl/styles.xml` 的 `cellXfs → fillId → fills/patternFill(patternType="solid")/fgColor@rgb`，取后 6 位大写十六进制（openpyxl 写 `00FFF2CC`，Excel 写 `FFFFF2CC`，都归一成 `FFF2CC`）；`theme` / `indexed` 颜色返回 `theme:N` / `indexed:N`（不认识 → 只告警）。沿用该文件已有的防炸闸门（成员大小、DOCTYPE、行列上限）。已有的 `_sheet_grid` / `read_workbook_detail` 一个字节不改，保证非模板路径不变。
- `normalize_script.main()` 在 **上传之前**（`ensure_supported_script_file`（`:386`）之后、`upload_script_file`（`:390`）之前）插入分支：

```python
match = script_template.detect(script_file)          # 非 xlsx/xlsm、读不了、没有标记 -> None，且不打印任何东西
if match is not None:
    plan, report = script_template.import_template(script_file, topic, match)   # 闸门不过 -> SystemExit（非 0）
    plan = ensure_progress_labels(plan, reviewer=None)                          # 纯本地，不调 Qwen
    atomic_write_json(Path(args.output), plan)
    ...打印摘要 + VACUT_EVENT（§3.7）
    return
# 以下为原有代码，一个字符都不改
```

  - 模板路径**不调用** `upload_script_file`、`normalize_with_ai`、`review_voice_and_subtitles_with_ai`、`verify_card_fields`、`review_progress_labels_with_ai`；
  - `detect()` 对非模板文件**不打印、不抛异常**（任何异常都当「不是模板」，退回原路径——这就是现在的行为）。
- Rust 调用方式不变（`script.rs:75-110` 仍然起 `normalize_script.py`），所以 A 本身不需要改引擎；引擎只为 B 的透传重编（§4）。

### 3.2 识别规则（怎么认出标准模板）

**沿用模板里已经写好的标记 `VAC-SB-1`，不另起 `VAC-SCRIPT-v1`。** 理由：四份文件（空白模板、示例、两份转换演示）的「项目信息!B2」都已是 `模板版本 | VAC-SB-1`，设计说明全文也用这个名字，改名只会多一轮文件修改和不一致；现有文件**无需补标记**。以后出 v2 就写 `VAC-SB-2`，导入器按版本号查各自的列表。

认定为模板必须**同时**满足：

1. 扩展名 `.xlsx` / `.xlsm`；
2. 有名为 `项目信息` 的 sheet，其中某一行 A 列去首尾空白后等于 `模板版本`、B 列去首尾空白后**逐字**等于 `VAC-SB-1`（区分大小写）；
3. 有名为 `分镜脚本` 的 sheet，第 1 行 A–R 这 18 个格子去首尾空白后与 §3.3 的列名**逐字、逐位置**相同。

分支规则：

| 情况 | 处理 |
|---|---|
| 条件 2 不满足（没有标记） | **不是模板**，`detect` 返回 None，走原路径（行为与 `1bc0fdb` 完全一致） |
| 有标记但版本号不是 `VAC-SB-1` | **阻断**：`不支持的模板版本 X`（不退回 Qwen——作者明确说这是模板，退回去等于偷偷换了解析方式） |
| 有标记、版本对，但缺「分镜脚本」sheet 或 18 个表头有任何不同 | **阻断**，报告逐列差异（缺哪列、哪列改名、顺序错位）；提示「如确实不是标准模板，请删掉项目信息里的模板版本行」 |
| 第 19 列起还有非空表头（作者自己加的列，如「音效」） | 允许；这些列的值原样存进 `script_meta.extra_columns`，每份文件一条提醒 `extra_columns`。这样模板「禁止加列」的限制在新导入器下自然解除（旧启发式的 0.6 门槛与本路径无关） |

说明：同时校验「标记 + 18 个表头逐字相同」，就是设计说明 §5 解法 B 提到的「防止普通表格伪造标记」。「填写说明」「字典」两个 sheet 导入器不读；「项目信息」只按键值读（§3.4）。

### 3.3 列 → 字段映射（全 18 列）

读取口径：只读「分镜脚本」sheet；表头第 1 行，数据从第 2 行起；**整行 18 格全空的行跳过**（模板预置到第 200 行）；文本一律 `authored_field_value`（只去首尾空白、CRLF→LF，内部换行和空白保留）后再按下表处理。「黄/红」指底色 `FFF2CC` / `FFC7CE`（§3.5）。

| # | 列名 | 类别 | 写到 plan 的哪里 | 处理规则 |
|---|---|---|---|---|
| 1 | 镜号 | 结构 | `shot`（`normalize_shot_plan` 重新编号前先校验）；`script_meta.source.row` 记 Excel 行号 | 必须是整数，且全表严格 1..N、不重复、不跳号、按行递增，否则**阻断** `shot_no_invalid`；有内容但镜号空 → **阻断** `row_without_shot_no` |
| 2 | 段落 | 制作 | `module_label`（非空时）；`script_meta.segment` | 原文照搬（折叠空白）。`ensure_progress_labels(reviewer=None)` 若因语言检查换掉了它 → 提醒 `module_label_replaced` |
| 3 | 分镜标题 | **正文** | `title` | `script_value(raw, "title")`；占位/留空 → 不写，由 schema 兜底「分镜N」（这是既有兜底，不上屏）|
| 4 | 时长(秒) | 制作 | `duration` = 向上取整的整数秒；非整数时原值存 `script_meta.duration_raw` | 空、非数字、≤0 → **阻断** `duration_invalid`（模板里是必填；见 §12 拍板 2）。有口播的镜最终以 TTS 实长为准（既有 `prepare_voice.py` 行为） |
| 5 | 景别 | 制作 | `script_meta.shot_size` | 原文照搬；不在字典 → 提醒 `not_in_dictionary`，值照存 |
| 6 | 运镜 | 制作 | `script_meta.camera_move` | 同上 |
| 7 | 拍摄角度 | 制作 | `script_meta.camera_angle` | 同上 |
| 8 | 画面内容 | 制作 | `visual_query`；`script_meta.visual_description`（作者原文，之后 `optimize_queries` 改写 `visual_query` 也不影响它） | 空 → `visual_query` 退回「搜索关键词 → 分镜标题」（与 `compact_plan` 同口径），提醒 `visual_missing` |
| 9 | 口播 | **正文** | `voice_text`（折叠空白，与现有 plan 口径一致）；`voiceover = 有口播` | 占位/留空 = 本镜无口播 |
| 10 | 字幕 | **正文** | `subtitle`；非空且与口播不同 → `render_hints.caption_source = "subtitle"`（§4.3.3） | 留空 = 同口播（不写 `subtitle`，下游本来就退回口播）。写了占位（`—` 等）→ 同口播 + 提醒 `subtitle_placeholder`（现版本不能单镜关字幕） |
| 11 | 上屏文字 | **正文** | `card_content` = `script_value(raw, "card_content", preserve_layout=True)`；`card_layout` = `layout_from_labels(raw)`（只在 `card_content` 非空且无疑点时写）；作者原文（带标签）存 `script_meta.authored.card_content` | `field_doubt()` 非空（像占位、标签没冒号、正文里有 `**`、某一行是占位）→ **不改写**：只剥确定的行首标签、不折占位、不写 `card_layout`，提醒 `doubtful_value`。确定占位 → 本镜不上卡片 |
| 12 | 卡片提示 | 制作 | `card_hint` = `script_value(raw, "card_hint")` | 自由文字，不查字典 |
| 13 | 推荐素材来源 | 制作 | `production_notes = ["推荐素材来源：<原文>"]`；`script_meta.material_source` | 只存不解析（不生成 `material_bindings`，本轮不做选材改造） |
| 14 | 素材要求 | 制作 | `clip_requirements`；`script_meta.material_requirements` | 原文 |
| 15 | 搜索关键词 | 制作 | `download_query`；`script_meta.search_keywords` | 空 → `download_query` 退回画面内容（`compact_plan` 同口径）。之后 `optimize_queries` 照旧改写（原值另存 `raw_download_query`） |
| 16 | 转场 | 制作 | `script_meta.transition` | 空 = 硬切（不写键）；不在字典 → 提醒 |
| 17 | 备注 | 制作 | `extra_requirements = [<原文>]`；`script_meta.notes` | 音效提示也在这里（用户拍板） |
| 18 | 来源/核对 | 状态 | `script_meta.review`（§3.5） | 不进其它 plan 字段 |
| 19+ | （作者自加列） | — | `script_meta.extra_columns = {表头: 值}` | 提醒 `extra_columns` |

「正文」四列 = 分镜标题、口播、字幕、上屏文字（作者原文，AI 不得改写；闸门对黄格最严）。其余为「制作」列。

**plan 顶层**：`topic` = 引擎传进来的 `--topic`（文件名，与现状一致）；`script_source`（§4.2）记项目信息全部键值、转换信息、字典、导入摘要。项目信息里的「画幅 / BGM 风格 / 配音音色」本轮**只记录不生效**（画幅仍由桌面端选择；BGM 仍按现有配置），UI 里只读展示。「语言」写成「中英双语」→ 提醒 `language_multi`（模板要求单文件单语言）。

### 3.4 项目信息读取

逐行读「项目信息」A/B 两列：A 非空且 B 非空 → `script_source.project_info[A] = B`（原样字符串，公式格取缓存值、无缓存则不记）。分组标题行（B 为空）跳过。「转换信息」段的 6 个键另存 `script_source.conversion`。本轮不做「原始脚本 SHA-256 与用户手里原文比对」（没有入口拿到原文），只记录。

### 3.5 导入闸门

**颜色是逐格的真源，「来源/核对」第一行是逐镜的真源。**「来源/核对」为空 = 作者手写，按「已确认」处理。

| 规则 | 级别 | 代码 |
|---|---|---|
| 任何一格底色 `FFC7CE`（红） | **阻断** | `red_cell` |
| 「来源/核对」第一行是 `校验失败` | **阻断** | `status_failed` |
| 分镜标题 / 口播 / 字幕 / 上屏文字 任一格底色 `FFF2CC`（黄；含「部分摘取」「／换行」等转换器标黄的情况） | **阻断** | `text_cell_pending` |
| 正文四列落在数值 / 公式 / 错误 / 截断格上（`CellText.kind`） | **阻断**（读到的不是作者看到的） | `text_cell_kind` |
| 镜号不合法、有内容无镜号、时长不合法、没有任何分镜、分镜脚本数据区有合并单元格、数据区有**含内容的**隐藏行/列 | **阻断** | `shot_no_invalid` / `row_without_shot_no` / `duration_invalid` / `no_shots` / `merged_cells` / `hidden_content` |
| 制作列（段落、时长、景别、运镜、拍摄角度、画面内容、卡片提示、推荐素材来源、素材要求、搜索关键词、转场、备注）黄格 | 提醒，可导入；字段名进 `script_meta.review.ai_suggested` | `ai_suggested` |
| 「来源/核对」第一行是 `待确认` | 提醒（即使黄格都清了） | `status_pending` |
| 「来源/核对」第 2 行起、除「原文：」「AI建议：」以外的说明行（如「原文含国内/海外两个版本…」） | 提醒，原文展示 | `status_note` |
| 第一行不是 已确认/待确认/校验失败/空 | 提醒，按待确认处理 | `unknown_status` |
| 正文列底色不是 无/白/`F7F9FB`（斑马纹）/黄/红（例如人手涂了 `FFFF00`） | 提醒「不认识的底色」 | `unknown_fill` |
| `doubtful_value` / `not_in_dictionary` / `visual_missing` / `subtitle_placeholder` / `module_label_replaced` / `language_multi` / `extra_columns` | 提醒 | 同名 |

- **阻断 = 整份不导入**：不写 `--output`，`SystemExit` 非 0，并先打印逐条清单 + 一条 `VACUT_EVENT`（§3.7）。不做「跳过坏镜、导入其余」——会改变分镜结构，违反「以脚本为准」。
- 解除阻断只能回 Excel：核对后**把黄/红底色清掉**、把状态改成「已确认」，再导入。工作区的「确认」只处理可导入的提醒（§5）。
- 阻断报告要列全所有问题（不是遇到第一条就停），每条带：镜号、Excel 单元格坐标（如 `K9`）、列名、原因、建议操作。
- 模板文件导入时，`script_card_fields.verify_and_fix` **不运行**（没有 Qwen 结果要纠正）。测试里要额外断言：拿模板导入出的 plan 跑一遍 `reconcile()`，示例和两份转换演示都是 0 处纠正（两套读取口径一致的交叉检查）。

### 3.6 阻断/提醒的输出位置

1. **stdout 人读行**：前缀 `[script] 标准模板导入`，只用 ASCII 符号 + 汉字（复用 `script_card_fields.say()`，gbk 控制台安全）。每条阻断/提醒一行。
2. **`VACUT_EVENT`**（§3.7），给桌面端结构化展示。
3. **持久化**：导入成功时，逐镜提醒写进 `script_meta.review.warnings`，汇总写进 `script_source.import_summary`——工作区以 shots.json 为准（事件会丢，文件不会）。

### 3.7 事件（让 UI 拿到告警）

沿用 `VACUT_EVENT` 的 workflow 事件外形（stage 必须是 `script`，不带 `current/total`，`ensure_ascii=True`），新增一个键 `scriptImport`：

```json
{"kind":"workflow","workflowStage":"script","workflowStatus":"running | failed",
 "workflowProgress":{"stage":"script","status":"running | failed","phase":"template_import",
                     "label":"标准模板导入：9 镜，3 条提醒 | 标准模板导入被拦下：2 处需在 Excel 里处理"},
 "scriptImport":{"route":"template","format":"VAC-SB-1","file":"示例_食品码垛_v1.xlsx",
                 "shots":9,"blocked":[{"shot":8,"cell":"I9","column":"口播","code":"text_cell_pending","message":"…"}],
                 "warnings":[{"shot":1,"column":"景别","code":"ai_suggested","message":"…"}]}}
```

桌面端改动：`electron/task-events.ts` 的 `parseWorkflowEventLine` 多取 `scriptImport`（做形状校验，数组各截断到 200 条），`task-service.ts:264-272` 透传，`TaskEvent` 类型加 `scriptImport?`。队列项失败时显示「导入被拦下」面板（§5.3）。

---

## 4. 设计 B：分镜数据补齐 + 通用透传

### 4.1 决定：新字段放命名空间 `script_meta`，版本号不升

- **每镜** `script_meta`（对象，自带 `v: 1`）：模板带来的、目前只供展示/核对的信息。
- **plan 顶层** `script_source`（对象，自带 `v: 1`）：来源文件、项目信息、字典、导入摘要。
- **每镜** `render_hints`（对象）：会影响渲染的提示，本轮只有 `caption_source`。单独放在顶层是因为它**参与**增量缓存键，而 `script_meta` **不参与**（§4.3.4）。
- **`schema_version` 保持 2，不升 3。** 理由：
  1. 改动全是新增、可选；旧读者忽略新键不影响出片；
  2. 升到 3 会同时碰到 Rust `material_clip.rs:76` 的硬检查和 TS 6 处硬编码的 2——新桌面端 + 旧运行包、旧桌面端 + 新运行包这两种混装都会炸；
  3. 非模板文件的输出必须逐字节不变，升版本号就做不到。
- **以后什么时候升 `schema_version`**：只在「改名 / 删除 / 改变已有字段含义」时升，并且同一个提交里同时改 Rust 检查、Python 输出、TS 写入，Rust 继续接受旧版本。新增字段一律走命名空间对象，命名空间内部结构变了就升它自己的 `v`。
- **旧 shots.json 兼容规则**：没有 `script_meta` / `script_source` / `render_hints` = 旧行为，界面长得和现在一模一样；所有读 `script_meta` 的代码都要容忍缺键、类型不对（当作没有，不报错）。

### 4.2 数据形状（示例镜 1 / plan 顶层，`--check --plan` 输出应与此同构）

```jsonc
// 每镜新增（只列新增键；已有键照旧）
"render_hints": { "caption_source": "subtitle" },          // 仅当字幕非空且≠口播
"script_meta": {
  "v": 1,
  "source": { "format": "VAC-SB-1", "sheet": "分镜脚本", "row": 2 },
  "segment": "钩子",
  "visual_description": "机器人在机床前完成一次取件：……",
  "shot_size": "全景", "camera_move": "推", "camera_angle": "平视", "transition": "淡入",
  "material_source": "素材库：A_机床CNC上下料\n指定：……", "material_requirements": "横屏；……",
  "search_keywords": "机器人 机床 上下料 取件, CNC machine tending robot pick",
  "notes": "音效：气动夹爪咔嗒声压在抓取瞬间",
  "duration_raw": "9.5",                                    // 仅非整数时
  "authored": { "card_content": "大字：抓起来、放进去？\n副行：决定成败的其实是三件事" },
  "script_values": {                                        // 导入时写进 plan 的值；之后任何人都不改它
    "title": "开场钩子", "voice_text": "……", "subtitle": null,
    "card_content": "抓起来、放进去？\n决定成败的其实是三件事", "card_layout": "headline_sub", "card_hint": "标题卡",
    "visual_description": "……", "shot_size": "全景", "camera_move": "推", "camera_angle": "平视", "transition": "淡入"
  },
  "review": {
    "status": "作者手写 | 已确认 | 待确认 | 校验失败",
    "status_lines": ["原文：……", "AI建议：……"],
    "ai_suggested": ["shot_size", "camera_move"],          // 导入时的黄格（制作字段）
    "confirmed": [],                                        // 工作区点过「确认」的字段
    "warnings": [{ "code": "doubtful_value", "field": "card_content", "level": "warn", "message": "……" }],
    "acknowledged": []                                      // 工作区确认过的 warning，形如 "doubtful_value:card_content"
  },
  "extra_columns": { "音效": "……" }
}
// plan 顶层新增
"script_source": {
  "v": 1, "route": "template", "format": "VAC-SB-1",
  "file_name": "示例_食品码垛_v1.xlsx", "file_sha256": "……",
  "project_info": { "片名": "……", "画幅": "16:9", "BGM 风格": "……" },
  "conversion": { "原始脚本文件名": "……", "原始脚本 SHA-256": "……", "转换方式": "作者手写" },
  "dictionaries": { "shot_size": ["大远景", "…", "不限"], "camera_move": [...], "camera_angle": [...], "transition": [...] },
  "import_summary": { "shots": 9, "warnings": 0, "shots_with_ai_suggested": 0 }
}
```

- 字典由导入器写进 plan（常量在 `script_template.py` 一处定义，与模板「字典」sheet 有测试核对），**桌面端下拉直接读 `script_source.dictionaries`**，TS 不再手抄一份。
- 空值一律不写键（与现有 plan 口径一致）；`script_values` 里保留 `null` 以区分「作者没写」。
- 不写时间戳（导入结果要可重复，便于对比测试）。

### 4.3 各层改动

#### 4.3.1 Rust（`models.rs`，需重编引擎；这是最后一次为加字段重编）

```rust
pub(crate) struct Shot {
    ...现有字段不动...
    #[serde(flatten)]
    pub(crate) extra: serde_json::Map<String, serde_json::Value>,
}
pub(crate) struct ShotPlan {
    ...现有字段不动...
    #[serde(flatten)]
    pub(crate) extra: serde_json::Map<String, serde_json::Value>,
}
```

- 效果：任何 Rust 不认识的键（`script_meta`、`script_source`、`render_hints`，以及现在只活在原始 JSON 里的 `voice_audio`、`subtitle_cues`、`raw_*`、桌面端的 `material_resolution`、`material_source_mode`）经 `main.rs:428` 的强类型写盘也原样保留。
- 测试构造 `Shot` 的 4 处字面量（`domain.rs:118,149`、`planner.rs:219,250`）补 `extra: Default::default()`。
- **不开** `serde_json/preserve_order`：`main.rs:650` 等处本来就按 `Value`（BTreeMap，键按字母序）写 shots.json，开了会改变现有文件的键序。「原样保留」按 **JSON 值相等** 验收，不按字节。
- `material_clip.rs:76` 的版本检查不动（仍是 2）。
- 注意 `flatten` 的已知坑：`Shot.duration` 的 `deserialize_with`、`material_bindings` 内部 tagged enum（`deny_unknown_fields`）经 flatten 缓冲后仍要能正确反序列化——必须有测试覆盖（§6.1 R2、R3）。

#### 4.3.2 Python `shot_plan_schema.normalize_shot_plan`（通用透传）

- 定义显式常量 `KNOWN_PLAN_KEYS`、`KNOWN_SHOT_KEYS`（现有函数处理的所有键，**包括被它有意丢弃的**，如非法的 `card_layout`）。
- 按现逻辑处理完已知键后，把**不在已知集合里**的键按原顺序原样（深拷贝）追加到输出。已知键的处理一个字节都不变。
- 这样 `optimize_queries` / `prepare_voice` / `prepare_cards` 调用它时不再洗掉 `script_meta` 等键。
- 非模板导入路径：`compact_plan` 只产出已知键，所以透传对它是空操作 → 输出逐字节不变（§6.1 P1 锁住）。

#### 4.3.3 字幕显示（`render_hints.caption_source`）

- `render_segment.py`：从 `--shots-json` + `--shot-index` 读这一镜（与 `load_card_ass` 同样的读法）；若 `render_hints.caption_source == "subtitle"` 且 `subtitle` 非空 → 屏幕字幕用 `subtitle`，否则保持现状（`args.subtitle or voice_text`）。ASR 时间轴与字幕文本对不上时，现有代码已会退回按句均分（`render_segment.py:329-332`），不用另改。
- **Rust `final_video.rs:270-283` 不改**，其单测不改——非模板 plan 没有 `render_hints`，行为完全不变。
- 导入器：字幕非空且与口播（折叠空白后）不同 → 写这个提示；字幕留空或与口播相同 → 不写。
- 工作区：只有模板 plan 显示「字幕」编辑框；编辑后非空且≠口播 → 写 `render_hints.caption_source="subtitle"`；清空或改成与口播相同 → 删掉该键。

#### 4.3.4 增量缓存键（`incremental.rs`）

- 新增一个小函数，哈希前去掉每镜的 `script_meta` 和顶层的 `script_source`，用在 `shot_input` 的 `_` 分支（`incremental.rs:143`）和 `aggregate_input`（`:370-385`）。
- 目的：在工作区点「确认」、改景别这类**目前不影响画面**的操作，不触发整镜重渲/重合成。`render_hints`、`subtitle`、`card_content`、`card_layout` 仍在哈希里（它们影响画面）。
- 以后渲染层开始用 `transition` / `camera_move` 时，要把它们搬到 `render_hints` 或显式加进哈希——在函数注释里写明。
- 对没有这两个键的旧 plan，哈希值与现在**完全相同**（测试锁住）。

#### 4.3.5 TS（桌面端）

- `ShotDraft` 加可选类型 `script_meta?: ShotScriptMeta`、`render_hints?: { caption_source?: 'subtitle' }`；`ShotPlanRoot` 保持宽类型，另加 `readScriptSource(root)` 做形状校验读取。全部按「可能缺、可能是坏数据」写。
- `schema_version` 的 6 处硬编码：本轮**不动**（仍写 2，§4.1）。
- `workspace-service.readTextFile`：shots.json 的读取调用方显式传更大的上限（建议 8 MB），或新增一个整文件读取的 IPC；**不能再截尾部**。加测试：300 KB 的 shots.json 能完整读回。
- 编辑 `script_meta` 下的字段 / 确认提醒时，**不要**触发 `resetAutomaticMaterialResolution`（与改检索词区分开）。

### 4.4 全部读写 shots.json 的地方（逐一核对不丢字段）

| 位置 | 读/写 | 本轮后是否保留新键 | 要做什么 |
|---|---|---|---|
| `normalize_script.py:430` | 写 | 模板路径新写；非模板不变 | A |
| `script.rs:75-110` → `read_plan_from_file` | 读（强类型） | 是（flatten） | B |
| `main.rs:426-429` | 写（强类型） | 是（flatten） | B，**关键点** |
| `main.rs:616` | 读（强类型，只在内存） | 是 | — |
| `main.rs:645-672`（query/voice 非增量） | Python 写 + Rust 按 Value 写 | 是（Python 透传后） | B |
| `incremental.rs:510/577/595/608/628/667/734/745` | Value 读写 | 是 | 核对 |
| `optimize_queries.py:228,232`、`prepare_voice.py:642`、`prepare_cards.py:74` | 经 `normalize_shot_plan` 写 | 是（透传后） | B |
| `render_segment.py`、`template_packaging.py`、`packaging_agent.py`、`material_agent_select.py:582-603` | 读（白名单） | 不受影响 | `render_segment` 新读 `render_hints` |
| 桌面端 `shotPlanState.ts:35`、`resumeGeneration.ts:35` | 读 | 是（取决于读取上限） | 放宽上限 |
| 桌面端 `useStartTaskController.ts:551/1015/1052/1099`、`resumeGeneration.ts:64` | 写（展开 root/shots） | 是 | 测试锁住 |
| `material-auto-reuse.ts` 约 `:175-240` | 展开保留 | 是 | 核对 |
| `incremental-artifacts.ts:16`、`resume-material-manifest.ts:59` | 只读 | — | — |

Codex 开工时请再 `git grep -n "shots.json\|shots_json\|shotsPath"` 一遍，表里没有的新位置补进回帖。

---

## 5. 设计 C：分镜工作区对上模板

### 5.1 字段怎么显示、能不能改

仅当这一镜有 `script_meta`（模板导入）时显示模板区块；没有 `script_meta` 的旧 plan / 非模板 plan，抽屉**与现在完全一样**。

| 字段 | 显示 | 编辑 | 写回 |
|---|---|---|---|
| 分镜标题 | 输入框（现有） | 可改 | `title` |
| 口播 | 文本框（现有「口播文案」） | 可改 | `voice_text`（同时 `voiceover = 非空`） |
| 字幕 | 文本框，空时灰字「留空 = 同口播」 | 可改 | `subtitle` + `render_hints.caption_source`（§4.3.3） |
| 上屏文字 | 上：作者原文（`script_meta.authored.card_content`，带「大字：/副行：」标签）只读小字；下：上屏内容（`card_content`，按行显示）文本框 + 「版式」下拉（自动 / 大字+小字 / 各行一样大） | 内容与版式可改 | `card_content`、`card_layout`（选「自动」= 删键；内容少于 2 个非空行时自动删键并禁用下拉） |
| 卡片提示 | 只读 | — | — |
| 画面内容 | 文本框（模板 plan 下替换现有「想要的画面」框） | 可改 | `script_meta.visual_description` + `visual_query`（走现有 `updateShotContent` 的重置选材逻辑） |
| 景别 / 运镜 / 拍摄角度 / 转场 | 下拉，选项取 `script_source.dictionaries`；原值不在字典里时下拉里额外显示这个原值（标「非字典值」）；转场空显示「硬切（默认）」 | 可改 | `script_meta.shot_size / camera_move / camera_angle / transition` |
| 素材搜索词、剪辑要求 | 现有两个框保留（分别对应模板的「搜索关键词」「素材要求」） | 可改（现有行为） | `download_query`、`clip_requirements` |
| 段落、推荐素材来源、备注、来源/核对、项目信息、自加列 | 「更多（只读）」折叠区 | — | — |

**编辑不会改写脚本原文**：以上编辑都不碰 `script_meta.script_values` 和 `script_meta.authored`（测试锁住）。

### 5.2 「人已改」与「恢复原文」

- 规则（**派生，不另存标记**）：字段当前值 ≠ `script_meta.script_values` 里的值 → 显示「人已改」小标签，旁边一个「恢复原文」按钮（写回快照值）。改回和原文一样，标签自动消失。
- 参与比对的字段：`title`、`voice_text`、`subtitle`、`card_content`、`card_layout`、`visual_description`、`shot_size`、`camera_move`、`camera_angle`、`transition`。
- **不**参与：`download_query` / `visual_query`（会被 `optimize_queries` 自动改写，比对会误报），`clip_requirements`。
- 比对口径：两边都 CRLF→LF、去首尾空白后逐字相等；`null` 与空串视为相同。

### 5.3 提醒、黄/红状态与「确认」

- 抽屉顶部模板信息条：`标准模板 VAC-SB-1 · 片名 · 9 镜 · 待确认 3 条 [只看待确认]`。
- 每镜头部：`!N` 徽标（未确认提醒数）；「来源/核对」状态为「待确认」时显示黄色状态点。
- 黄格（`review.ai_suggested`）对应的字段：控件左侧黄色竖条 + 「AI 建议，待确认」。每项有「确认」，每镜有「本镜全部确认」。确认 = 把字段名加进 `review.confirmed`；**编辑一个黄格字段也视为已确认**。
- 其它提醒（`review.warnings`）逐条列在本镜底部，原文展示 message，每条可「知道了」（加进 `review.acknowledged`，形如 `code:field`）。
- 红格和正文黄格根本导不进来，工作区不会出现；导入被拦下时，任务队列里这一项显示「导入被拦下」面板（来自 `scriptImport.blocked`），逐条列出「第 8 镜 · I9 · 口播 · 黄格（待确认的正文不能导入）→ 请在 Excel 核对后清除底色」，带「打开脚本所在文件夹」按钮。
- 未确认提醒**不阻止**生成；点生成时如果还有未确认项，弹一次非阻断提示「还有 N 条提醒未确认，仍然生成？」。
- 确认操作只写 shots.json，**不回写 Excel**；重新导入同一份 Excel 会得到新的 plan（与现在重新预览一样），这点在提示里写明。

### 5.4 文字版界面草图

```
┌─ 分镜编辑 ─────────────────────────────────────────────── [保存] 已保存 14:32 ┐
│ 主题 [示例_食品码垛_v1                                          ]              │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ 标准模板 VAC-SB-1 · 食品饮料码垛讲解 · 6 镜 · 待确认 3 条  [只看待确认]    │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ 03 ─ 包装到位 ──────────────────────── 段落：抓取 · 8s · [!2] ● 待确认       │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ 分镜标题 [包装到位                                  ]                    │ │
│ │ 口播     [整箱饮品沿输送带到位，机械臂先识别再抓取。  ]                  │ │
│ │ 字幕     [整箱到位 → 识别 → 抓取                      ] (人已改) [恢复原文]│ │
│ │ 上屏文字  原文：大字：整箱到位↵小字：输送带 · 挡边 · 定位                 │ │
│ │          内容 [整箱到位                               ]  版式 [大字+小字 ▾]│ │
│ │               [输送带 · 挡边 · 定位                   ]                    │ │
│ │ 卡片提示  编号卡                                                          │ │
│ │ 画面内容 [整箱瓶装饮品在输送带上排队，机械臂下探抓取   ]                  │ │
│ │ ▌景别 [中景 ▾]  ▌运镜 [固定 ▾]  拍摄角度 [平视 ▾]  转场 [硬切（默认）▾]  │ │
│ │ ▌= AI 建议，待确认   [确认景别] [确认运镜]            [本镜全部确认]     │ │
│ │ 素材搜索词 [整箱瓶装饮品 输送带 码垛机                 ]                  │ │
│ │ 剪辑要求   [横屏；不出现品牌铭牌                       ]                  │ │
│ │ ▸ 更多（只读）：推荐素材来源 · 备注 · 来源/核对 · 自加列                 │ │
│ │ 提醒：[doubtful_value] 上屏文字第 2 行像占位……            [知道了]      │ │
│ │ 素材 ( 自动获取 | ●指定素材 )  [食品码垛 ×]  [+ 选择素材]                 │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ 04 ─ …                                                                        │
└──────────────────────────────────────────────────────────────────────────────┘

导入被拦下（任务队列 → 该项）：
┌─ 转换演示_v1表格.xlsx：导入被拦下，2 处需在 Excel 里处理 ─────────────────┐
│ 第 8 镜  I9  口播      黄格：待确认的正文不能导入 → 核对后清除底色         │
│ 第 8 镜  K9  上屏文字  黄格：待确认的正文不能导入 → 核对后清除底色         │
│ 改好后保存 Excel，再点「预览分镜」。                   [打开所在文件夹]     │
└──────────────────────────────────────────────────────────────────────────────┘
```

（素材绑定区与现有组件完全一致，不改。`ShotMaterialBoard` 与 `StoryboardEditorReferencePage` 本轮不改：前者只读，后者是不落盘的样例页。）

### 5.5 状态流

`updateShotField` 扩展 `EditableShotField`，增加 `'subtitle' | 'card_content' | 'card_layout'`；另加 `updateShotScriptMeta(index, key, value)`（`visual_description` 同时写 `visual_query`；四个下拉只写 `script_meta`）、`confirmShotReview(index, fields | 'all')`、`acknowledgeShotWarning(index, id)`、`restoreScriptValue(index, field)`。全部置 `dirty:true`，走现有 `saveShots` 保存链，不新增 IPC。

---

## 6. 验收单

### 6.0 放行门槛（总）

Python / Rust / 桌面端测试 0 失败 0 错误，跳过清单与 `1bc0fdb` 基线相同（新增用例不许 skip）；§6.2 干跑结果与预期表逐项一致；§6.3 界面手测截图齐全；§6.4 端到端成片通过。任何一项不符：停下回帖，不改测试、不放宽断言凑通过。

### 6.1 自动化测试（新增用例清单）

**Python**（新文件 `VideoAutoCut/tests/test_script_template.py`；`tests/xlsx_fixture.py` 的 `write_xlsx` 加可选参数 `fills={"分镜脚本": {"K9": "FFF2CC"}}`，缺省时输出与现在逐字节相同）

| 编号 | 用例 | 断言 |
|---|---|---|
| T1 | 识别正例：`docs/script-template-v1/` 下示例、两份转换演示、食品码垛示例、空白模板 | `detect` 均非 None |
| T2 | 识别反例：无标记的同表头表格；标记写在别的 sheet；`docs/packaging-test-scripts-2026-09-21/07_表格版_*.xlsx`；md/txt/csv/docx；坏 zip | 均返回 None，**stdout 为空** |
| T3 | 有标记但版本号 `VAC-SB-2` / 缺「分镜脚本」sheet / 表头改名一列 / 两列换位 | 阻断，报告逐列差异 |
| T4 | 第 19 列加「音效」 | 可导入；值进 `extra_columns`；1 条 `extra_columns` 提醒 |
| T5 | 全 18 列映射：夹具每列写不同的哨兵值 | §3.3 表每一行的目标字段逐一断言（含 `production_notes` / `extra_requirements` 的形状、`duration` 向上取整 + `duration_raw`） |
| T6 | 标签剥离 / 版式：示例 9 镜 | `card_content` 与设计说明 §5 表逐字一致；`card_layout` = 1 `headline_sub`、2 `headline_sub`、5 `equal_lines`、7 `equal_lines`、8 `headline_sub`、9 `headline_sub`，其余无；第 3 镜无 `card_content` 无 `card_hint` |
| T7 | 占位与疑点：`—`、`（不填）`、`没有！`、`大字 A句`、正文含 `**`、某一行是占位 | 确定占位 → 空；疑点 → 值不改写、无 `card_layout`、`doubtful_value` 提醒 |
| T8 | 闸门·红：任一列红格；状态「校验失败」 | 阻断；不写输出文件；报告含单元格坐标 |
| T9 | 闸门·正文黄：标题/口播/字幕/上屏各一例 | 各自阻断 `text_cell_pending` |
| T10 | 闸门·制作黄：景别/运镜/画面内容/时长/卡片提示黄 | 可导入；`ai_suggested` 列出这些字段；提醒条数正确 |
| T11 | 闸门·结构：镜号跳号/重复/非整数/有内容无镜号、时长空/0/文字、数据区合并、隐藏行含内容、正文落在数值/公式格 | 各自阻断，且**一次报全**（多问题夹具断言条数） |
| T12 | 状态列：空 / 已确认 / 待确认（无黄）/ 未知首行 / 带说明行 | 分别无提醒 / 无 / `status_pending` / `unknown_status` / `status_note` |
| T13 | 颜色解析：`00FFF2CC`、`FFFFF2CC`、`theme:4`、斑马 `F7F9FB` | 前两者=黄；theme 在正文列 → `unknown_fill`；斑马不提醒 |
| T14 | 字幕：留空 / 与口播相同 / 不同 / 写 `—` | 无 `subtitle` / 无 hint / `render_hints.caption_source="subtitle"` / 同口播 + `subtitle_placeholder` |
| T15 | **模板路径零模型**：`mock.patch` `upload_script_file`、`normalize_with_ai`、`review_voice_and_subtitles_with_ai`、`review_progress_labels_with_ai`、`optimize_queries.call_qwen`、`urllib.request.urlopen` 为抛异常；跑 `normalize_script.main()` 导入示例 | 成功写出 plan；上述函数调用次数 = 0 |
| T16 | 阻断时 `normalize_script.main()` | `SystemExit` 非 0；`--output` 文件不存在（预先放一个旧文件：未被覆盖）；stdout 有一条 `VACUT_EVENT` 且 `scriptImport.blocked` 非空 |
| T17 | **非模板逐字节不变**：固定一份 qwen 原始返回夹具（取 `docs/packaging-test-scripts-2026-09-21/03_*` 对应形状即可）+ 固定 uuid，mock 掉上传与 Qwen，跑 `normalize_script.main()` | 输出文件字节 = 在 `1bc0fdb` 上用同一夹具跑出的字节（按仓库既有做法 `git show 1bc0fdb:...` 起旧版对照，缺 git 时**失败**而不是跳过）；stdout 除 Qwen 相关行外逐行相同 |
| T18 | 交叉检查：示例、两份转换演示的模板 plan 跑 `script_card_fields.reconcile()` | 0 处纠正 |
| T19 | 字典常量 = 各文件「字典」sheet 的四列 | 逐值相等 |
| P1 | `normalize_shot_plan` 透传：未知键（嵌套对象、数组、中文键、`null`）在 shot 级和 plan 级原样保留、顺序在已知键之后 | 深相等 |
| P2 | `normalize_shot_plan` 对已知键行为不变：用仓库现有 plan 夹具，对比 `1bc0fdb` 版本输出 | 字节相同 |
| P3 | `optimize_queries` / `prepare_voice` / `prepare_cards` 各自对带 `script_meta` 的 plan 走一遍（mock 外部调用） | 回写后 `script_meta`、`script_source`、`render_hints` 深相等 |
| P4 | `render_segment`：有 `render_hints.caption_source="subtitle"` → 字幕用 `subtitle`；没有 → 用 `args.subtitle or voice_text`（与现状相同） | 生成的 ASS 字幕文本断言 |

**Rust**（`models.rs` / `incremental.rs` 的测试模块）

| 编号 | 用例 | 断言 |
|---|---|---|
| R1 | `ShotPlan` 带 `script_source`、每镜带 `script_meta` / `render_hints` / `voice_audio` / `material_resolution`，反序列化 → 序列化 | 与输入 **JSON 值深相等** |
| R2 | 同上且含 `duration: "9.5"`、`material_bindings`（folder + material 两种） | `duration=10`；bindings 正确；未知键不丢 |
| R3 | `material_bindings` 里带未知键 | 仍然报错（`deny_unknown_fields` 语义不变） |
| R4 | 不含任何未知键的 plan：序列化结果 | 与改动前的序列化**字节相同**（写死期望字符串） |
| R5 | `shot_input` 各阶段、`aggregate_input`：加/改 `script_meta`、`script_source` | 哈希不变；改 `render_hints` / `subtitle` / `card_content` → `_` 阶段哈希改变；无这两个键的 shot 哈希与改动前公式一致 |
| R6 | 端到端小链：`read_plan_from_file` → `write_json_pretty_atomic` | 文件里 `script_meta` 存在且深相等 |

**桌面端**（**不新增测试文件**：Media 机两份 `package*.json` 有用户未提交修改，新增文件就得改 `package.json` 的测试清单。新用例放进已在清单里的 `tests/task-models.test.mjs`、`tests/task-events.test.mjs`；若确需新文件，先回帖说明）

| 编号 | 用例 | 断言 |
|---|---|---|
| D1 | `parseShotsJson` → 编辑字幕 / 上屏 / 版式 / 画面内容 / 景别 / 确认 → `saveShots` 的 JSON | 往返后除被编辑字段外深相等；`script_values`、`authored` 不变；未知键（顶层、镜级、`script_meta` 内部未知键）不丢 |
| D2 | 「人已改」派生：改 → 标记出现；改回 → 消失；CRLF 与 LF、`null` 与空串视为相同 | 布尔断言 |
| D3 | 字幕编辑写/删 `render_hints.caption_source` | 三种情况 |
| D4 | 上屏内容改成单行 → `card_layout` 被删；选「自动」→ 删键 | 断言 |
| D5 | 编辑 `script_meta` 字段 / 确认 → 不重置 `material_resolution` / `query_optimized`；改画面内容 → 与现有「改想要的画面」相同的重置 | 断言 |
| D6 | 无 `script_meta` 的旧 plan：编辑/保存链与现有测试结果一致 | 现有 `task-models` 用例全过 + 1 条新增对照 |
| D7 | `task-events`：带 `scriptImport` 的事件被解析、透传、形状非法时忽略，协议行不出现在可见日志 | 断言 |
| D8 | 300 KB shots.json 完整读回（不截尾） | 断言 |
| D9 | 类型检查与构建：`npm run build`（含 `tsc -b`）、`npm run lint` | 0 错误 |

### 6.2 真实文件干跑（不起引擎、不联网）

在仓库工作区执行（嵌入式 Python 或系统 Python 均可，报告用的是哪个）：

```powershell
$Out = '<审计目录>\dryrun'; New-Item -ItemType Directory -Force $Out | Out-Null
Get-ChildItem docs\script-template-v1\*.xlsx | ForEach-Object {
  & $Python -X utf8 VideoAutoCut\tools\script_template.py --check $_.FullName `
      --json (Join-Path $Out ($_.BaseName + '.report.json')) --plan (Join-Path $Out ($_.BaseName + '.plan.json'))
  "$($_.Name) exit=$LASTEXITCODE"
}
```

预期（以入库版本为准；Mac 入库时会在 `docs/script-template-v1/README.md` 附每份文件的 SHA-256，干跑前先核对）：

| 文件 | 预期 |
|---|---|
| `分镜脚本模板_v1.xlsx`（空白） | 认出模板；**阻断** `no_shots`；exit≠0 |
| `分镜脚本示例_上下料_v1.xlsx` | 9 镜，0 阻断，提醒 0 条（出现任何提醒逐条贴出）；`card_layout` 分布同 T6；第 7 镜 `render_hints.caption_source="subtitle"`；第 3 镜无卡片无提示；`module_label` 依次 = 段落列 |
| `转换演示_md文本.xlsx` | 7 镜，0 阻断；每镜 `ai_suggested` = 段落/景别/运镜/拍摄角度/画面内容/搜索关键词（第 1、7 镜另有转场）；每镜 `status_pending`；无 `card_layout`（第 1 镜单行「5 个误区」） |
| `转换演示_v1表格.xlsx` | **若入库版第 8 镜口播/上屏已补黄（§12 拍板 3 默认）**：阻断，恰好 2 条（`I9` 口播、`K9` 上屏文字）；**若未补黄**：8 镜可导入，`card_layout` 在第 1、4 镜，第 8 镜 `status_note`「原文含国内/海外两个版本…」 |
| `示例_食品码垛_v1.xlsx`（Mac 提供） | 0 阻断；镜数、提醒以 Mac 入库说明为准 |
| 反例：`docs/packaging-test-scripts-2026-09-21/07_表格版_混合_show判定_食品码垛_CN.xlsx`，以及 Media 机真实生产 `05_视频脚本\*.xlsx`（只读副本） | 全部「不是模板」，`--check` 输出 `not_template`、exit=0，不打印别的 |

另做两个负例副本（只在审计目录里改，不动入库文件）：把示例第 2 镜「口播」涂黄 → 阻断 1 条；把示例第 4 镜「景别」涂黄 → 可导入、1 条 `ai_suggested`。贴出两份报告。

### 6.3 Windows 界面手测（新引擎 + 新 tools + `npm run dev`）

运行时：`npm run dev` 会先 `cargo build` 并把调试引擎拷到 `VideoAutoCut\VideoAutoCutEngine.exe`（`VideoAutoCutDesktop/scripts/prepare-dev-engine.mjs`）；若开发运行时缺内置 Python/ffmpeg，改用上轮 W3 的 Candidate 做法（隔离副本 + 替换引擎 + 同步 tools），**不碰生产 0.5.14 目录**。每步截图（整窗 + 关键区域放大），文件名 `U<步号>_<说明>.png`。

| 步 | 操作 | 预期 / 截图 |
|---|---|---|
| U1 | 工作台 →「脚本文件」→ 选 `docs\script-template-v1\示例_食品码垛_v1.xlsx` → 绑定素材范围「食品码垛」（§6.4）→ 16:9 / 1080p →「预览分镜」 | 日志抽屉有 `[script] 标准模板导入`，**没有** `AI 上传脚本文件` / `AI 解析脚本文件` / `Qwen` 字样（贴日志） |
| U2 | 打开分镜抽屉 | 顶部模板信息条；每镜显示字幕、上屏原文 + 内容 + 版式、画面内容、四个下拉；截图 2 镜 |
| U3 | 选一镜改字幕、另一镜改景别、再一镜把上屏内容改成单行 → 保存 | 「人已改」出现；单行镜版式下拉变灰；保存成功。关闭再打开抽屉：改动仍在。用文本编辑器打开 run 目录 `shots.json`：`script_values` 未变，`render_hints` 按 §4.3.3 |
| U4 | 点其中一处「恢复原文」→ 保存 | 标记消失，值回到快照 |
| U5 | 导入 `转换演示_md文本.xlsx` | 7 镜都有黄竖条和 `!N`；「只看待确认」过滤生效；逐项确认 + 本镜全部确认后徽标归零；保存后重开仍为 0 |
| U6 | 导入 `转换演示_v1表格.xlsx`（若按默认补了黄） | 队列项显示「导入被拦下」面板，2 条，坐标正确；「打开所在文件夹」可用 |
| U7 | 对照：导入非模板 `07_表格版_混合_show判定_食品码垛_CN.xlsx`（会调 Qwen，仅此一份） | 抽屉与 `1bc0fdb` 版本外观一致（没有模板区块、没有字幕框），截图并列对比 |

### 6.4 端到端出一条成片（食品码垛模板示例）

素材：Windows 素材库只有本地「食品码垛」（+ 网站下载）。机床上下料示例（`分镜脚本示例_上下料_v1.xlsx`）和两份转换演示**只做导入/解析层验收**（§6.2、§6.3），**不出片**。端到端用 Mac 提供的 `docs/script-template-v1/示例_食品码垛_v1.xlsx`（由 `docs/packaging-test-scripts-2026-09-21/` 那批已验证素材覆盖的码垛脚本改写成模板 v1 格式；Codex 不写、不改脚本）。

**路线 B（UI，为准）**

1. app.env 用副本、就地改键（`load_dotenv` 是 setdefault，不能往末尾追加）：包装开关沿用 9/21 验收口径（`VIDEOAUTO_TEMPLATE_PACKAGING=true`，`VIDEOAUTO_PACKAGING_SCRIPT_ONLY` 不设 = 默认开；`PACKAGING_AGENT_*` / `MATERIAL_AGENT_PI_*` 四个键按 `docs/packaging-test-scripts-2026-09-21/README_测试说明.md` §4.1 配齐）。跑完还原。
2. 工作台 →「脚本文件」→ 选 `示例_食品码垛_v1.xlsx` → **点链接图标「绑定素材范围」，选素材库里的「食品码垛」文件夹并勾选包含子文件夹**（不绑定会按素材来源模式跑到 Pexels）。
3. 成片比例 **16:9**、分辨率 **1080p** →「预览分镜」（即 U1）。
4. 抽屉里挑**一个有口播的镜**，把字幕改成一句与口播不同的短句（例如只保留口播里的关键词并加「→」），保存。记下镜号、改前/改后文本。
5. 点「生成」→ 等成片。

**路线 A（免 UI，备选；UI 路线跑不通时才用，回帖说明原因）**

按 `docs/packaging-test-scripts-2026-09-21/README_测试说明.md` §4.2：
① `run-plan-only.mts` 以 `--plan-only --script-file <示例_食品码垛_v1.xlsx>` 出 `shots.json`（此步应零 Qwen，日志为证）；
② 给每镜补 `"download_material": false` 与 `"material_bindings": [{"binding_type":"folder","folder_id":"<食品码垛/食品 的 fld_ id，抄自 batch4 审计目录 input-shots.json>","include_subfolders":true}]`，**不许动 `script_meta` / `script_source`**；手改一镜 `subtitle` 并按 §4.3.3 加 `render_hints.caption_source="subtitle"`（等价于工作区编辑）；
③ 用 batch4 那份 `material_manifest.json` 当模板手搓本轮 manifest（改 `run_id`、`task_id`、`resolved_at`、`task_revision=0`、`shots[]` 的 `shot_id` 换成新 shots.json 的，6 条 materials 原样照抄）；
④ `--restart-all --shots-json <本轮> --material-manifest <本轮> --aspect-ratio 16:9 --output-resolution 1080p --source pexels` 真跑。

**验收（两条路线相同）**

| 项 | 预期 |
|---|---|
| 导入 | 零 Qwen（日志）；`shots.json` 有 `script_source` 与逐镜 `script_meta` |
| 生成后 run 目录 `shots.json` | `script_meta` / `script_source` / `render_hints` **仍在**且与生成前深相等（证明经过 query/voice/card 各阶段没被洗掉）；贴一段 diff 或 `python -c` 深比对输出 |
| 成片 | 规格 1920×1080、有声、时长合理；**被改那一镜**的字幕显示改后文本（在该镜中段 `ffmpeg -ss <t> -frames:v 1` 抽 2 帧截图）；另抽 1 个未改镜的帧，字幕仍是口播 |
| 上屏卡片 | 写了上屏文字的镜才有卡片，文字不含「大字：/副行：」等标签；没写的镜没有卡片（抽帧各 1） |
| 缓存行为（可选加分） | 在工作区只点「确认」某条提醒后「继续生成」：该镜不重渲（`incremental.json` 该镜 receipt 复用）；改字幕后：该镜重渲 |

贴：成片路径、SHA-256、`ffprobe` 摘要、上述抽帧截图、run 目录 `shots.json`（可脱敏素材路径）。

### 6.5 回帖模板

```
# Windows 回帖：模板导入 + 字段透传 + 工作区（<FINAL_HEAD>）
- 提交：<列出每个 commit 与一句话>
- Python：Ran …，failures=…，errors=…，skipped=…（清单与基线相同？），test_script_template=…
- Rust：cargo test passed=…/ignored=…；release 构建 SHA-256=…；cargo 后 git status 除两份已记录 Desktop package 修改外为空=…
- 桌面：npm test …；npm run build / lint …
- 干跑：6 份入库文件 + 反例 + 2 份负例副本，逐份 exit / 镜数 / 阻断 / 提醒（贴 report.json 关键段）
- 界面：U1–U7 截图 + 结论
- 端到端：路线 A/B；成片 SHA-256；抽帧截图；生成前后 script_meta 深比对结果
- 与本方案不同的地方（逐条 + 原因）
```

---

## 7. 分步实施顺序（建议 4 个提交，每步可独立验证）

| # | 提交 | 内容 | 独立验证 |
|---|---|---|---|
| 1 | `feat(schema): pass through unknown plan/shot keys` | Rust `flatten`（`models.rs`，4 处测试字面量）；`incremental.rs` 哈希去 `script_meta`/`script_source`；Python `normalize_shot_plan` 透传 + `KNOWN_*` 常量；测试 R1–R6、P1–P3 | 全量 Python + `cargo test`；此时还没有任何产出新键的代码，非模板行为不变 |
| 2 | `feat(script): deterministic VAC-SB-1 template import` | `script_tabular.read_sheet_fills`；`script_template.py`（识别/映射/闸门/`--check`）；`normalize_script.py` 上传前分支；事件；`xlsx_fixture` 加 `fills`；测试 T1–T19 | §6.2 干跑可以在这一步完成 |
| 3 | `feat(render): honor render_hints.caption_source` | `render_segment.py` 读 `render_hints`；导入器写该提示；测试 P4、T14 | 单镜直调 `render_segment` 对比 ASS |
| 4 | `feat(desktop): template fields in storyboard workspace` | 类型、编辑/确认/恢复、「人已改」、下拉、导入被拦面板、`task-events` 透传 `scriptImport`、放宽 shots.json 读取上限；测试 D1–D9 | `npm test`、`npm run build`、§6.3 |

之后再在最终 HEAD 上跑一遍全量测试 + §6.2 + §6.3 + §6.4，写 `docs/template-import-acceptance-2026-09-2x.md`（验收证据，可作为第 5 个提交），推分支、回帖。**每个提交都要能单独编译并通过当时已有的测试。**

---

## 8. 可选后续（本轮不做）

- **选材用画面描述 / 景别 / 运镜**：`material_agent_select` 的检索用 `script_meta.visual_description`（未被改写的作者原文）而不是改写后的 `visual_query`；VLM 评审把景别/运镜/角度当软约束（需要素材标签库先补这三个维度；EVST 逐秒标签库可导入）；「搜索关键词」非空时跳过 `optimize_queries`；「推荐素材来源」里的「指定：路径 取段 tA–tB」解析成 `material_bindings` + 时间窗。
- 渲染用 `transition`（镜间叠化/闪白）与 `camera_move`（静态/偏短素材做推拉摇移关键帧）——届时把用到的键搬进 `render_hints`。
- 「示例」sheet 放回模板、音效单独成列（导入器已不受列数门槛限制，改模板即可）。
- 客户脚本 → 模板转换器（列映射档案 / 文本抽取 + 逐字出处校验，用户已定的全半角/「／」规则在那里实现）。
- 项目信息里的品牌色 / 字体 / 字幕样式喂包装（品牌包阶段）。

---

## 9. 随方案入库的模板文件（Mac 负责提交，Codex 不提交）

仓库路径 `docs/script-template-v1/`（2026-09-23 已由 Mac 本地提交入库；SHA-256 为入库版本，干跑前先核对；逐文件预期干跑结果见该目录 `README.md`）：

| 入库路径 | 来源（Mac）与 SHA-256 | 说明 |
|---|---|---|
| `docs/script-template-v1/分镜脚本模板_v1.xlsx` | `~/Desktop/临时/剪辑软件_脚本模板_2026-09-23/分镜脚本模板_v1.xlsx`<br>`f42b223122a5649aaf12fc85862185b60da20530d39a4ab58d4710ab9375cf12` | 空白模板 |
| `docs/script-template-v1/分镜脚本示例_上下料_v1.xlsx` | 同目录<br>`a8dcefeac18dfb68957189e80719a06e83af7dfc0507577d2385932e70b444a5` | 格式演示，不出片 |
| `docs/script-template-v1/转换演示_v1表格.xlsx` | 同目录；已按 §12 拍板 3 用 `_生成脚本/convert_demo.py` 重新生成（第 8 镜 `I9` 口播、`K9` 上屏文字补黄，「来源/核对」写明待确认原因；首版 `3807114b…de515` 作废）<br>`64d23f4889081c0239f396db40a4ef18744779232376eeba90d96c5d1ff48b63` | 导入层验收（被拦下的负例） |
| `docs/script-template-v1/转换演示_md文本.xlsx` | 同目录<br>`a85420b8bae0f5c0fb8e48d7eaea0b89bc1ccb62c46de615199d0a8ec3784154` | 导入层验收 |
| `docs/script-template-v1/示例_食品码垛_v1.xlsx` | 同目录（Mac 原创，9 镜，基于 `docs/packaging-test-scripts-2026-09-21/` 素材覆盖已验证的码垛脚本改写）<br>`33a47aefc3d6e97d7cb556f827cfccbbac9dd2aba8e9cb35ae227b165869cc0a` | 端到端出片用 |
| `docs/script-template-v1/模板设计说明.md` | 同目录<br>`979389ff4e65877fbcd916128b9001e503c574fb170c2c87617deb543f2f6b51` | 列定义正本 |
| `docs/script-template-v1/README.md` | 新写：文件清单 + SHA-256 + 各文件预期干跑结果（§6.2）+ 重跑方法 | — |
| `docs/script-template-v1/_生成脚本/` | 同目录 `_生成脚本/`，逐文件 SHA-256 见 README：`vac_template.py`、`example_data.py`、`example_data_food.py`、`build_food.py`、`provenance.py`、`convert_demo.py`、`dryrun.py`、`dryrun_all.py`、`map_上下料B端_v1格式.json`、`干跑结果.json`、`干跑结果_食品码垛.json` | 生成器、干跑与演示；`convert_demo.py` 的原文目录已改成命令行参数 `--orig-dir`（不再写死 Mac 本机路径）；客户原始脚本本身**不入库** |

**未入库**：`~$*.xlsx`（Excel 锁文件）、`__pycache__/`、`*.bak_*` 备份。入库前 Mac 已在干净副本上用 `_生成脚本/dryrun_all.py`（调用 `dryrun.py`，`VAC_TOOLS` 指向 `1bc0fdb` 的 `VideoAutoCut/tools`）重跑，结果写入 `干跑结果.json`。

---

## 10. 禁止项

- 不上传任何运行包 / 桌面包，不跑 `release:upload*`，不打包（本轮不需要 pkg）。
- 不合 master，不改 master，不 force push；只在 `feature/material-agent-select` 上追加提交（或另开 `feature/template-import` 基于 `1bc0fdb`，二选一，回帖说明）。
- 不改生产 `D:\Video Edit\VideoAutoCut\config\app.env`（用副本；就地改键；跑完还原并贴哈希）、不改用户 `.pi` 目录、不动 `release-upload.local.json`。
- 不 reset / checkout / stash Media 机上两份 `VideoAutoCutDesktop/package*.json` 的用户修改；不新增需要改 `package.json` 测试清单的测试文件（§6.1 桌面端说明）。
- 不删测试、不放宽已有断言、不加 skip；不改 `script_card_fields.py`、`prompts/*.md`、非模板路径的任何行为。
- 不改 `docs/script-template-v1/` 下的模板文件（有问题回帖，由 Mac 改）。
- 不批量对生产 xlsx 跑 Qwen（§6.3 U7 只一份）；不手改 `shots.json` 凑通过（§6.4 路线 A 明确允许的字段除外）。
- 生产 0.5.14 运行包目录一个字节都不动。

## 11. 风险

| 风险 | 说明 / 缓解 |
|---|---|
| Rust `flatten` 改变 `--shots-json` 路径的落盘内容 | 以前被丢掉的 `material_resolution`、`material_source_mode` 等键会保留进 run 目录 `shots.json`；下游读取都是白名单（§2.2），不影响出片；新 run 的缓存键会因此与旧 run 不同（续跑旧 run 不写这个文件，不受影响）。R1–R6 + §6.4 生成前后深比对兜底 |
| `flatten` 与 `deserialize_with` / tagged enum 的组合 | R2、R3 专测 |
| 字幕显示规则新增一条分支 | 只对带 `render_hints` 的镜生效；非模板 plan 不会有它；Rust `segment_subtitle` 与其单测不动 |
| 桌面端读 shots.json 的 200 KB 截尾 | 必改（§4.3.5），D8 锁住 |
| Excel 另存后底色变成主题色 | 解析成 `theme:N` → 正文列 `unknown_fill` 提醒，不静默放行；手测时用 Excel 打开示例另存一次再导入，确认颜色仍被识别 |
| 新桌面 + 旧运行包 | 旧引擎在 `main.rs:428` 丢 `script_meta` → 工作区只是看不到模板区块，出片不受影响；验收一律用新引擎 |
| `optimize_queries` 仍会改写模板的检索词（查询阶段调 Qwen） | 属于选材阶段，本轮按「不做选材改造」保留；作者原文在 `script_meta` 里不丢 |
| 食品码垛模板示例由 Mac 提供 | 未入库前 §6.4 无法开始；Codex 可以先做 1–4 提交与 §6.1–6.3 |

## 12. 用户拍板（3 条，2026-09-23 已拍板，全部按默认）

1. **分镜标题的黄格也禁止导入**（已拍板：是）。用户原话列的是口播/字幕/上屏；设计说明 §8.4 把分镜标题同样列为「只能逐字取自原文」，而且它会上进度条。
2. **时长为空禁止导入**（已拍板：是，模板里时长是必填）。未采用的备选：有口播的镜允许空（以 TTS 实长为准），只提醒。
3. **`转换演示_v1表格.xlsx` 第 8 镜（原文含国内/海外两版）入库前把口播/上屏格补黄**（已拍板：是；已执行，入库版即补黄版，见 §9）。按用户规则，只有「待确认」状态不拦截；不补黄的话，两个版本的 CTA 会一起导进去上屏。补黄后这份文件就是一个真实的「被拦下」负例；要让它能导入，得有人在 Excel 里删掉不用的版本并清掉黄色。
