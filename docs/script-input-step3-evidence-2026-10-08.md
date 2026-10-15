# 0.5.16 步骤 3 验收证据（2026-10-08）

基线为 `09aa088344eb82fe5363fd3d99aded6d5c8d77dc`，分支
`feature/0.5.16-script-input`。本步骤只实现非标准脚本的 organized 后处理、S3
标题纠正和渲染字幕路由；未实施步骤 3b。

## 实现结果

- `script_organize.py` 在既有 `verify_card_fields` 后、`ensure_progress_labels` 前运行。
  文本、工作簿和 DOCX 可本地核对；PDF、DOC、XLS 按不可核对处理。
- 景别、运镜、拍摄角度、转场只有同时通过字典、连续原文 evidence、字典词命中才保留；
  单字运镜还要求 evidence 含“镜头”或“机位”。缺失或不可信时前三项为“不限”，转场为空。
- subtitle、material_source、project_info 只保留本地可核对的原文明写内容。口播保持既有
  `compact_plan` 合法性口径；本地连续原文为 `script`，其余合法口播为 `ai`。
- 每镜增加同形 `script_meta`，顶层增加 `script_source.route=organized`；16 个标准字段全部进入
  `ai_suggested`。`render_segment` 允许 template/organized 的 subtitle hint。
- `incremental.rs` 只同步注释，哈希生产逻辑未改。

## 提示词逐句差异

| 文件/位置 | 改前原句 | 改后原句 | 依据 |
|---|---|---|---|
| `script_parse.md` 核心原则 | `“口播字幕”“全程叠加口播字幕”表示字幕跟随口播；除非文档明确说明只做无声文字叠加，否则需要生成 voice_text，并让 subtitle 承载口播字幕。` | `“口播字幕”“全程叠加口播字幕”表示需要口播；没有逐字字幕正文时只生成 voice_text，subtitle 留空（运行时空字幕跟随口播）。` | §6.2、§9 已定 2 |
| `script_parse.md` 核心原则 | `如果文档明确要求显示字幕、口播字幕、屏幕文字或画面字幕，但没有提供逐字正文，可以根据该分镜的真实内容生成 subtitle；subtitle 是画面字幕，不等于制作要求。` | `subtitle 只能逐字复制文档明确提供的字幕正文；没有逐字正文就留空，不得生成、压缩或改写。` | §6.2、§6.6、§9 已定 2 |
| JSON：景别 | 原 JSON 在 `"subtitle": "屏幕字幕，可选",` 后直接是 `"download_query": "素材平台搜索短语",`。 | `"shot_size": "景别字典值，只提取原文明写值，否则不限",` | §6.2–§6.3 |
| JSON：运镜 | 同上，无此键。 | `"camera_move": "运镜字典值，只提取原文明写值，否则不限",` | §6.2–§6.3 |
| JSON：角度 | 同上，无此键。 | `"camera_angle": "拍摄角度字典值，只提取原文明写值，否则不限",` | §6.2–§6.3 |
| JSON：转场 | 同上，无此键。 | `"transition": "转场字典值，只提取原文明写值，否则空",` | §6.2–§6.3 |
| JSON：证据 | 同上，无此键。 | `"evidence": {"shot_size": "原文连续摘录", "camera_move": "原文连续摘录", "camera_angle": "原文连续摘录", "transition": "原文连续摘录"},` | §6.3 |
| JSON：素材来源 | 同上，无此键。 | `"material_source": "推荐素材来源，只能逐字复制原文明写内容",` | §6.2、§6.6 |
| 规则 6 制作要求 | `不要把“男声、语速、音量、BGM、打码、转场、左上角小字”等制作要求本身当成口播正文；这些只能进入 voice_requirements、clip_requirements 或 subtitle。` | `不要把“男声、语速、音量、BGM、打码、转场、左上角小字”等制作要求本身当成口播正文；这些只能进入 voice_requirements 或 clip_requirements。` | §6.2、§9 已定 2 |
| 规则 8 标题 | `8. subtitle 是画面上显示的字幕：` | `8. subtitle 是画面上显示的字幕，只能逐字复制原文件明确提供的字幕正文；原文没有就留空，不得根据 voice_text 压缩、改写或生成字幕。不要把“全程叠加口播字幕”“添加字幕”等制作要求本身当成 subtitle 正文。` | §6.2、§6.6、§9 已定 2 |
| 规则 8 删除 1 | `如果文档已有明确字幕正文，直接提取。` | 合并进新规则 8 的“只能逐字复制”。 | §6.2 |
| 规则 8 删除 2 | `如果 voice_text 存在且文档要求口播字幕，subtitle 可以等于 voice_text 或压缩成更短的屏幕字幕。` | 合并进新规则 8 的“不得根据 voice_text 压缩、改写或生成”。 | §9 已定 2 |
| 规则 8 删除 3 | `如果文档只写了“全程叠加口播字幕”“添加字幕”等要求，但没有 voice_text，可以基于该分镜的章节、画面内容、卡片内容和素材描述生成一句简洁字幕。` | 合并进新规则 8 的“原文没有就留空”。 | §6.6 |
| 规则 8 删除 4 | `生成字幕只能使用文档中已经出现的信息，不要加入外部知识、评价、数字或新事实。` | 删除，因为新合同完全禁止生成字幕。 | §9 已定 2 |
| 规则 8 删除 5 | `不要把“男声、语速、音量、BGM、打码、转场、左上角小字”等制作要求当成 subtitle 正文。` | 合并进新规则 8 的“不要把……制作要求本身当成 subtitle 正文”。 | §6.2 |
| 新规则 8.1 | 无。 | `景别、运镜、拍摄角度、转场只提取原文明确写出的字典值，不得根据画面或语义推断。没有明写时前三项输出“不限”，转场输出空字符串。每个非空非“不限”值必须在 evidence 同名键返回包含该字典值的原文连续摘录；单字运镜“推、拉、跟、升、降、甩”的摘录还必须包含“镜头”或“机位”。` | §6.3 |
| 8.1 景别字典 | 无。 | `景别字典：大远景、远景、全景、中景、中近景、近景、特写、大特写、不限。` | §6.3 |
| 8.1 运镜字典 | 无。 | `运镜字典：固定、推、拉、左摇、右摇、上摇、下摇、左移、右移、跟、升、降、环绕、甩、手持、不限。` | §6.3 |
| 8.1 角度字典 | 无。 | `拍摄角度字典：平视、俯拍、仰拍、顶拍、侧拍、背拍、主观视角、倾斜、不限。` | §6.3 |
| 8.1 转场字典 | 无。 | `转场字典：硬切、叠化、淡入、淡出、闪白、闪黑、划像、甩切、匹配剪辑。` | §6.3 |
| 新规则 8.2 | 无。 | `material_source 只能逐字复制原文明写的推荐素材来源、指定路径或取段信息；原文没有就留空。project_info 只输出原文明写的项目信息，缺项不要补。` | §6.2、§6.6 |
| review 规则 4 | `重点检查每个分镜的 voice_text、voiceover、subtitle、voice_requirements 是否符合原文件语义。` | `重点检查每个分镜的 voice_text、voiceover、subtitle、voice_requirements 是否符合原文件语义；同时重新从原文件提取 shot_size、camera_move、camera_angle、transition 及其 evidence。镜头字段只能提取原文明写值，不得推断；没有明写时前三项为“不限”、转场为空。每个非空非“不限”值的 evidence 必须是含该值的原文连续摘录；单字运镜“推、拉、跟、升、降、甩”的摘录还必须含“镜头”或“机位”。` | §6.1–§6.3 |
| review 规则 4 字典句 | 无。 | `字典分别为：景别=大远景、远景、全景、中景、中近景、近景、特写、大特写、不限；运镜=固定、推、拉、左摇、右摇、上摇、下摇、左移、右移、跟、升、降、环绕、甩、手持、不限；拍摄角度=平视、俯拍、仰拍、顶拍、侧拍、背拍、主观视角、倾斜、不限；转场=硬切、叠化、淡入、淡出、闪白、闪黑、划像、甩切、匹配剪辑。` | §6.3 |
| review 新规则 4.1 | 无。 | `同时重新从原文件提取 material_source 和 project_info：推荐素材来源、指定路径、取段时间以及项目信息都只能逐字取原文明写内容；没有明写时 material_source 留空，project_info 不补缺项。` | §6.2、§6.6 |
| review 规则 8 | `如果原文件要求口播字幕，subtitle 应等于 voice_text 或是 voice_text 的短字幕版本；不要把“全程叠加口播字幕”这种制作要求本身当字幕正文。` | `subtitle 只能逐字复制原文件明确提供的字幕正文；原文没有就留空，不得把 voice_text 压缩、改写或生成为字幕，也不要把“全程叠加口播字幕”这种制作要求本身当字幕正文。` | §6.2、§6.6、§9 已定 2 |

主提示词规则 14、15 的完整文本与 `09aa088` 逐字相同；O6 测试固定该基线直接比较，
没有以当前 HEAD 自我比较。

## O1–O8

`test_script_organize.py` 共 8 个方法：

- O1：同一旧字段 plan 前后逐键比较；仅非原文 subtitle 可消失，新增范围严格为每镜
  `script_meta` 与顶层 `script_source`。
- O2：分别覆盖缺 evidence、evidence 不在原文、evidence 不含值、值不在字典、
  `近景特写` 不算 `特写`、单字“跟”无镜头/机位语境、拍摄角度/转场缺 evidence，
  并覆盖四字段阳性保留。
- O3：PDF 不可核对，前三项“不限”、转场空，并产生 `camera_unverifiable`。
- O4：AI 生成字幕被清空，产生 `subtitle_not_in_script`，且不残留 caption hint。
- O5：先由真实 `verify_card_fields` 清除两镜臆造 card，再由 organizer 保持为空。
- O6：硬编码核对 16 个 `ai_suggested`、完整 `field_origin`、明写 project_info、
  偶然命中文本的伪项目信息、伪 `document_quote`、import summary 和规则 14/15。
- O7：标准库 DOCX 读取中文普通段落及表格单元格段落。
- O8：a29 与候选分别运行完整 `normalize_script.main()`；无需口播复核时调用数为
  `upload/main parse/voice review/progress review = 1/1/0/0`，需要复核时为 `1/1/1/0`，
  两边完全相同，无新增模型调用。

O 测试最终日志：`D:\vac\s516-step3-evidence\organize-final.log`，8 passed。

## 旧合同有意变化

- T17 的基线由旧的 `1bc0fdb` 改为真实 a29 `a29d74f`。修改前断言
  `results[0][0] == results[1][0]`（完整 JSON 字节相等）以及 stdout 行列表相等。修改后先从候选
  剔除获准新增的每镜 `script_meta`、顶层 `script_source`，再从两边剔除唯一获准变化的
  `subtitle`，对剩余完整对象做 deep equality；另明确断言 a29 subtitle 为“口播”、候选无
  subtitle、候选 route 为 organized，并继续断言 stdout 行列表相等。
- `test_u7_exception_does_not_apply_to_plain_text_titles` 修改前精确结果为
  `corrections=[]`、`title='解析器抄来的章节标签'`，且 warnings 含“本表不认识的字段名”；
  修改后为 `corrections=[('title','rewritten')]`、`title='来料到位是第一道关'`、
  `warnings=[]`。原因是 §1.2 S3 明确移除只对 table 生效的可靠标题例外限制；card 字段与
  `NO_INVENT` 门槛未放宽。

## N1–N5 与全量结果

- N1：最终 Python 全量包含模板 39 项；a29 逐字节审计覆盖 225 个生成 fixture 最终态和
  5 份真实 xlsx，全部通过。
- N2：Rust `cargo test --all-targets --all-features` 通过既有增量缓存 golden；本步骤仅改
  `incremental.rs` 注释，无哈希逻辑变化。
- N3：生产 ASS 与旧 plan 合同未改；完整 a29 输入、ASS 哈希与逐字节证据见
  [步骤 1 证据](script-input-step1-evidence-2026-10-08.md)。本步骤 Python 全量中的既有 ASS
  回归测试继续通过。
- N4：Desktop 真实 `saveShots` 的 a29/候选保存产物 deep equality、旧业务字段不变且不添
  `script_meta/script_source` 的完整证据见[步骤 1 证据](script-input-step1-evidence-2026-10-08.md)；
  本步骤 Desktop 全量继续通过同一真实保存回归。
- N5：
  - Python：`D:\vac\s516-step3-evidence\python-final.log`，659 run，657 passed，2 skipped，
    0 failures/errors。新增后 skip 名称及原因与步骤 1 清单相同。
  - Rust：`D:\vac\s516-step3-evidence\rust-final.log`，114 + 5 passed，4 ignored，0 failed；
    ignored 名称及原因与步骤 1 清单相同。
  - Desktop：`D:\vac\s516-step3-evidence\desktop-final.log`，420 passed，2 skipped，0 failed；
    skip 名称及原因与步骤 1 清单相同。

本步骤未增加 skip；仅按授权修改 T17 与 S3 的预期，其他既有门槛未放宽；未调用真实模型、
未执行真实导入或出片。
