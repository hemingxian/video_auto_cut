# 「Pi 接剪辑包装」第一步 · 带 card_content 的测试脚本（2026-09-21）

配套分支：`feature/material-agent-select`（已把 `feature/packaging-script-only` 快进并入；远端那条保留不删但停在 `600180e`，别从它开工），运行包基准 `0.5.15-agent-trial-pkg2`。
交接正本：`docs/packaging-agent-step1-2026-09-18.md`（env 键、三层降级、产物位置、验收清单都在那份里，本文不重复）。

> ⚠️ **口径已变：本轮按「新分支行为」栏跑。**（2026-09-21 下午并分支后更新）
> 「只按脚本上屏」已并进 `feature/material-agent-select`：没写 `card_content` 的镜一律不上卡片、
> 也不问模型（env `VIDEOAUTO_PACKAGING_SCRIPT_ONLY`，**默认开**）。Windows 只需拉这一条分支。
> 受影响的是 **01（对照组）** 与 **03（混合组）**，下面用「**57ecd75 行为 / 新分支行为**」两栏并列标了出来：
> **右栏 = 本轮预期**；左栏（`57ecd75` 旧行为）**一行没删**，保留下来供 `VIDEOAUTO_PACKAGING_SCRIPT_ONLY=0`
> 时的对照用。代码验收清单另见 `docs/packaging-script-only-acceptance-2026-09-21.md`（A1–A13），
> 本轮与它合成一轮跑。

> **2026-09-21 第二小轮追加两份**（见文末「七」）：`07_表格版…xlsx` 与 `07_纯文本版…txt`，
> 内容与 `03_混合_show判定` **逐字等价**，用来验「生产脚本主要是表格」这条新覆盖
> （验收 B7 / B8，口径正本 `docs/packaging-agent-step1-2026-09-18.md` §8.10.5）。
> 下面一到六节讲的仍是原来那 5 份 `.md`，一个字没改。

本目录 5 份脚本是给 **模板包装 agent（选版式 + 判 show）** 用的输入，用来补上 9/18 收口时
记的「等用户加带 `card_content` 的脚本」这一步。素材范围 = **本地素材 / 食品码垛**（9/17 冻结的那 6 条，
用户 9/21 确认素材库未改动），选材 agent 能在绑定范围内匹配得到。

**这一轮是内容价值验证，不是代码验收，也不改代码。** 9/18 那轮的任务 `card_content` 覆盖率只有 1/7，
agent 的版式选择基本没吃上力；这 5 份把覆盖率拉到 0/6 → 6/7 → 混合 → 边界 → 3/6，
看的是**版式选择与 show 判定在真实文案上的表现**。功能性验收（#0–#8）9/18 已经全过，不用重做。

---

## 一、先弄清 `card_content` 是什么（这决定脚本怎么写）

**结论：`card_content` = 脚本作者手写的「这一镜要上屏给观众看的那句／那几项文字」。**
它只能从**脚本文档**里来（桌面端分镜编辑器没有这个字段），不是 agent 生成的，agent 也一个字都改不了。

用户的理解「带 card_content 的脚本 ≈ 需要包装的脚本」——**方向对，但有一处不准**：

| 说法 | 准不准 | 依据 |
|---|---|---|
| 有 `card_content` 的镜 = 作者已经决定要上屏 | ✅ 准 | `packaging_agent.py:226-229`：模型填 `show=false` 会被强制改回 `true`，日志记 `overridden="author_card_content"`；提示词 `prompts/agent_packaging_plan.md:21` 同一口径 |
| **没有** `card_content` 的镜 = 不包装 | ❌ **在 `57ecd75` 上不准**；✅ **并入 `8f24772` 之后（默认开）就是这样** | `57ecd75`：`template_packaging.py:31,41`：上屏文字 = `card_content` **没有就退回 `title`**，而 `title` 由 schema 保证非空（`shot_plan_schema.py:184`，空了写成「分镜N」），所以**确定性路径永远上包装**。<br>**新分支（默认开）**：`build_composition` 在取 content 之前先判 `card_content`，空就 `return None`——用户 9/21 拍板，用户这个理解**成了产品口径** |
| 「要不要包装」这个判断在哪 | 只有开了 agent 才有 | `PACKAGING_AGENT_SELECT=1` 时模型多返回一个 `show`；`show=false` → `build_composition` 直接返回 `None`（`template_packaging.py:54-56`），走「和没有上屏文字完全相同」的那条路，不渲 overlay。**关掉 agent 就没有这一维**，`packaging_agent.py:336-339` 里确定性的 `show` 恒记为 `True` |

**所以 `card_content` 与三版式 + show 的关系是：**

- `card_content` 有内容 → `show` 被钉死为 `true`，agent 只剩「三版式选哪个」一个自由度；
- `card_content` 为空 → 上屏文字退回 `title`，agent 的主要工作变成「这条 title 是不是内部占位标签 / 是不是跟口播重复，该不该上屏」（`show` 那一维）；
- 文字内容**永远**不由模型产出 —— 返回 schema 里根本没有文字字段（`packaging_agent.py:215-231` 只认 `template`/`show`/`reason`）。

**消费链路（文件:行号）**

```
shots.json.shots[i].card_content
  └─ template_packaging.packaging_content()            tools/template_packaging.py:25-41   ← 唯一取文字的地方
       └─ build_composition()                          tools/template_packaging.py:53-118  ← 排版/分页/生成 HyperFrames html
            └─ render_overlay()                        tools/template_packaging.py:143-180 ← lint + 渲 overlay.webm
                 └─ render_segment.prepare_packaging() tools/render_segment.py:409-442     ← 插入点，agent 在这里被调
                      └─ final_video.rs:191            （Rust 唯一耦合点，本轮没动）
```

**另一条已经死掉的旧卡片链路**（别被它误导）：`tools/prepare_cards.py:31-32` 也读 `card_content`
（ASS 卡片 / `card_plan` / `card_ass`），但 `prepare_cards.py` 在 Rust 侧**没有任何调用点**，而且
`final_video.rs:249` 给 `render_segment.py` **恒定传 `--no-cards`**。所以 0.5.13/0.5.15 上，
`card_content` 的**唯一**活消费者就是模板包装。

**还有一条会影响脚本怎么写的硬事实：走脚本文档导入这条路，`card_content` 里不可能有换行。**
`normalize_script.compact_plan` 的 `text_field` 会把所有空白折成一个空格
（`tools/normalize_script.py:142-143`、`246-247`、`282`）。而确定性正则判 `parameters` 的条件之一
就是 `"\n" in content`（`template_packaging.py:39`）——这条分支从脚本文档进来时**走不到**。
结论：**确定性路径只能靠 `card_hint` 的关键词选版式**，`card_content` 的形态（列举、数字+单位）
只有 **agent** 会看。这正好让「agent 改了几镜」这个指标有东西可测。

确定性正则（`template_packaging.py:35-41`，读的是 `card_hint`，不是 `card_content`）：

- `cta`：命中 `cta | call.to.action | 行动 | 号召 | 关注 | 购买 | 订阅`
- `parameters`：命中 `param | spec | bullet | 参数 | 规格 | 要点 | 列表`（或 content 含换行）
- 其余一律 `title`

---

## 二、素材画面清单（公司 Windows 机素材库 · 食品码垛）

**这批素材到底有什么画面**，两个来源交叉核过：

- **实锤来源**：9/17 第四批验收冻结的 `material_manifest.json`（Windows 机审计目录里那份），
  其中 `local_path` 全部指向 `<素材库根>\食品码垛\食品\`，**唯一 6 个文件**。
- **画面标签来源**：这 6 条 mp4 在 Mac 侧另有一套逐秒时间轴标签 + 整段描述/logo 终判（不在本仓，
  文件名与 manifest 里的 6 个 mp4 一一对上）。下表的「画面事实」全部抄自那套标签，不是凭印象写的。

| 素材（按工艺归类，不写品牌/型号） | 时长 | 画面事实（标签原文） |
|---|---|---|
| 瓶装牛奶码垛（同一现场 2 个机位） | 138s / 68s | **纸箱装牛奶**为主，少量**塑料奶瓶**；红色机械臂 + **红色托盘**；输送带；托盘上已码**多层**；有**工人操作**出镜；1 帧标出「六轴」 |
| 乳品线码垛（固定机位） | 61s | **多台橙色码垛机器人**；工件是**白色塑料容器、带绿色标签**；托盘；镜头固定、视角不变；⚠️ 逐秒标签几乎全空（61 帧只有 2 帧有描述），整段描述来自 catalog |
| 瓶装饮用水 搬运+码垛 1 | 142s | **整箱矿泉水**；**多条输送带**（有线间转接）；**塑料托盘**；「码垛机」；catalog 写**视觉定位系统**抓取；有**工人**；跨多机位 |
| 瓶装饮用水 搬运+码垛 2 | 51s | **两条橙色机器人臂**；**整箱瓶装水**落到托盘；**绿色地面**；有工人；多机位；⚠️ 逐秒有效帧只有 4/51 |
| 袋装面粉码垛（节拍 700 包/小时） | 96s | **面粉袋／白色包装袋**；输送带→托盘；「码垛机」；catalog 另标**变位机**（用于调整托盘位置）；有**工人操作**；**描述覆盖率最高（96/96）**，且是这批里唯一 logo 像素粗筛与模型终判**双清**的一条 |

**这批里没有的东西（脚本里一律不许写）**：具体垛型层数/列数、交错垛、抓手形式（吸盘/夹抱/叉式——
标签里一条都没写）、AGV、地轨、机型与节拍以外的任何规格数字。
**唯一可用的数字**是「节拍 700 包/小时」，它来自素材文件名，不是我编的。

**可复用的检索画面词**（写 `画面` 字段时照这个池子挑，选材 agent 才匹配得到）：
`白色包装袋 / 面粉袋｜整箱瓶装饮品 / 整箱瓶装水｜纸箱装牛奶｜白色塑料容器 绿色标签｜输送带 挡边｜多条输送带｜塑料托盘 / 红色托盘｜码垛机｜变位机｜工人操作 控制面板｜多台码垛机器人同时作业｜成品托盘区｜绿色地面｜固定机位 / 全景 / 中景`

> 品牌铁律：5 份脚本里没有任何客户或供应商品牌名、机型号（素材文件名里带的型号一律不进脚本），全用通用工艺词。

---

## 三、5 份脚本各测什么 + 预期

**版面数字是实测的，不是估的**：在本机用运行包同一份 `template_packaging.build_composition`
＋仓库内置 `NotoSansCJKsc-Bold.otf` 跑出来的（画布 1920×1080、`picture_bounds` 取满画幅、分镜 8s）。
Windows 用 GDI 测宽、Mac 用 PIL 测宽，同字体下会有几像素差，**行数/页数在临界值上可能差一行**，以 Windows 实跑为准。

> 版面口径（16:9 / 1080p / 横屏素材铺满画幅）：`title` 字号 54、每行约 21 个汉字、每页 3 行；
> `parameters` 字号 42、每行约 22 个汉字、每页 4 行。**素材若是竖屏**，`picture_bounds` 变窄，
> 每行字数会大幅下降、页数变多（9/17 那轮第 7 镜分 2 页就是这个原因）。

### 01_对照组_无上屏卡片（6 镜）

**测什么**：全片**一个 `card_content` 都不写**，验证确定性路径不受 agent 接入影响 + agent 的 `show` 维度。

| 镜 | card_content | card_hint | 确定性版式 | agent 预期 |
|---|---|---|---|---|
| 1–6 | 无（上屏文字退回 `title`） | 无 | 全部 `title`，1 行 1 页 | 版式应全 `title`；`show` 因镜而异——6 个分镜标题都写成了「来料到位是第一道关」「落盘后核对三项」这类**能给观众看的短句**（脚本里用 `分镜标题：` 显式指定，不靠解析器自己起名），按提示词第 22 行应判 `true`。9/18 那条任务被判 `false` 的是「码垛流程观察起点」这类**内部标签式**标题（用户 9/21 已认可关掉是对的）；这 6 条不是标签而是成句短语，**如果连它们也被判 `false`，那就是口径过紧，要单独拎出来报** |

**预期产物**：agent 关 → `packaging/*/overlay.webm` **6 个一个不少**；agent 开 → `show=false` 的镜**不产生 overlay.webm**，且 `decision_changed=true`。

> **57ecd75 旧行为 / 本轮预期（并入后默认 `VIDEOAUTO_PACKAGING_SCRIPT_ONLY=1`）**
>
> | | 57ecd75 旧行为（= 现在显式 `VIDEOAUTO_PACKAGING_SCRIPT_ONLY=0`） | **本轮预期**（并入后默认） |
> |---|---|---|
> | agent 关、包装开 | 6 镜**全部**出 `overlay.webm`（上屏文字退回 `title`） | **一张卡片都不上**，0 个 `overlay.webm` |
> | agent 开 | 6 镜**全部**调模型，按 `show` 决定出不出 overlay | **一镜都不调模型**，0 份 `packaging-agent-log.json`；stdout 6 行「按脚本模式跳过包装」 |
> | 这条脚本还测不测得到东西 | 测得到（`show` 那一维） | **测不到**——`show` 维度在默认模式下不存在了。要测它必须显式 `VIDEOAUTO_PACKAGING_SCRIPT_ONLY=0`，那时行为回到左栏 |
>
> 也就是说：上面那张逐镜表（「这 6 条不是标签而是成句短语，如果连它们也被判 false 那就是口径过紧」）
> 在新分支默认模式下**不再适用**——用户 9/21 已拍板「上屏内容一律以脚本为准」，脚本没写就不上，
> 不再讨论 title 该不该上屏。

### 02_全镜上屏_三版式（7 镜）

**测什么**：三个版式的选择分布，并**故意让确定性正则和 agent 打架**（因为确定性只看 `card_hint`，agent 只看 `card_content`）。

| 镜 | card_content 形态 | card_hint | 确定性版式 | agent 预期 | 实测版面 |
|---|---|---|---|---|---|
| 1 | 一句话主张 | 空 | `title` | `title` | 54 / 1 行 / 1 页 |
| 2 | 顿号列举三项 | 空 | `title` | **`parameters`**（顿号列举） | 54 / 1 行（21 字刚好卡满） |
| 3 | `｜` 列举 + 数字单位 | **参数卡，列表排版** | `parameters` | `parameters` | 42 / 2 行 / 1 页 |
| 4 | 一句话 | 空 | `title` | `title` | 54 / 1 行 |
| 5 | 一句话（三样先备齐） | **要点卡** | `parameters` | 很可能 **`title`**（反向不一致） | 42 / 1 行 |
| 6 | 结尾是号召语 | 空 | `title` | **`cta`** | 54 / 2 行 |
| 7 | 号召语 | **CTA 行动号召** | `cta` | `cta` | 42 / 1 行 |

**判定**：`agreed_with_deterministic` 应该是 **4/7 左右**（1/3/4/7 一致，2/5/6 不一致）；
`show_agreed_with_deterministic` 应 **7/7 全 true**（有 `card_content` 就不许关）；
任何一镜出现 `overridden:"author_card_content"` 都说明模型试图关包装被程序挡回来了——**这条要单独报**。

### 03_混合_show判定（7 镜）

**测什么**：`show` 判定。三镜有 `card_content`，四镜只有 `title`，且 `title` 故意分三类。

| 镜 | 有无 card_content | title | 预期 `show` | 预期版式 |
|---|---|---|---|---|
| 1 | 有（一句话） | 正常句 | `true`（强制） | `title` |
| 2 | 无 | 「袋料和箱体要分开核对」= **能给观众看的话** | `true` | `title` |
| 3 | 无 | 「**镜头B**」= 内部占位标签 | **`false`** | — |
| 4 | 无 | title **与口播逐字重复** | **`false`** | — |
| 5 | 有，但内容是「**占位卡 05**」 | 正常 | **`true`（强制）** | `title` |
| 6 | 无 | 「**开场**」= 内部占位标签 | **`false`** | — |
| 7 | 有（号召语） | 正常 | `true` | `cta`（hint 也写了 CTA） |

**第 5 镜是 `overridden` 的专门探针**：模型多半会老实填 `true`；只要它填了 `false`，
日志就会出现 `decision.overridden == "author_card_content"`，说明那条护栏真的在工作。两种结果都要记。

**判定**：`show=false` 的镜应落在 3/4/6；1/5/7 绝不允许 `false`（落地值必须是 `true`）。
另外，`show=false` 的镜合成会**省掉一次 overlay 渲染（约 45s/镜）**，整跑合成段应明显快于 agent 关闭时。

> **57ecd75 行为 / 新分支行为（默认 `VIDEOAUTO_PACKAGING_SCRIPT_ONLY=1`）**
>
> | 镜 | 有无 card_content | 57ecd75 旧行为（`script_only=0`）：问不问模型 / 出不出卡片 | **本轮预期**（并入后默认）：问不问模型 / 出不出卡片 |
> |---|---|---|---|
> | 1 | 有 | 问 / 出（`title`） | 问 / 出（`title`）——**与左栏一致** |
> | 2 | 无 | 问 / 按 `show` 定（预期 `true` → 出，文字 = title） | **不问** / **不出** |
> | 3 | 无 | 问 / 预期 `show=false` → 不出 | **不问** / **不出**（结果同，但省了一次模型调用） |
> | 4 | 无 | 问 / 预期 `show=false` → 不出 | **不问** / **不出** |
> | 5 | 有（「占位卡 05」） | 问 / 强制 `show=true` → 出 | 问 / 出——**与左栏一致**，`overridden` 探针仍有效 |
> | 6 | 无 | 问 / 预期 `show=false` → 不出 | **不问** / **不出** |
> | 7 | 有 | 问 / 出（`cta`） | 问 / 出（`cta`）——**与左栏一致** |
>
> 新分支默认下这条脚本变成：**3 份 `packaging-agent-log.json`（1/5/7）、3 个 `overlay.webm`（1/5/7）**，
> 2/3/4/6 四镜各打一行 `[packaging] 分镜 N 本镜脚本未写上屏内容，按脚本模式跳过包装（不调用模型）`。
> 第 2 镜是唯一**结果不同**的一镜（旧：出卡片、文字是 title；新：不出卡片）——这正是本次口径变更的意图。
> 它也因此成了新分支验收里最值钱的一条对照，见 `docs/packaging-script-only-acceptance-2026-09-21.md` A2/A4。

### 04_边界_排版极限_含预期失败镜（6 镜）

⚠️ **这份的第 6 镜是「预期会把任务打挂」的**，请单独跑、放最后跑。

| 镜 | card_content | 确定性版式 | 实测版面（各版式） | 预期现象 |
|---|---|---|---|---|
| 1 | 「满垛」（2 字，极短） | `title` | 54 / 1 行 | 正常出片，验证极短不报错、不撑版 |
| 2 | 「节拍 700 包/小时」 | `title` | 54 / 1 行 | agent 可能判 `parameters`（数字+单位）→ `decision_changed` |
| 3 | 中英混排 + `｜`：`视觉定位 Vision-Guided 抓取｜托盘 Pallet 满垛下线` | `title` | 54 / 2 行 | 验证拉丁词整词不拆、中英混排换行正常 |
| 4 | **97 字长清单**（6 个 `｜` 段） | `parameters`（hint 写了参数卡） | `parameters` 42 / 4+1 行 / **2 页**；`title` 会自动降到 **51 号** / 3+2 行 / 2 页 | **这一镜是分页老 bug（`gsap_exit_missing_hard_kill`）的回归点**：`render.log` 必须 `0 errors`，`index.html` 里每页要有 `tl.set("#page-i",{opacity:0},…)` 硬收尾 |
| 5 | 25 字单行 | `title` | 54 / 2 行；`parameters` 42 / 2 行 | **复现 docs §9.1 的切词问题**：实测 `title` 切成「…与输送 / 节拍确认」，`parameters` 切成「…输送节 / 拍确认」（把「节拍」劈开）。只记录，本轮不修 |
| 6 | 98 字**不可断的英文长词** | `title` | **三个版式全部 `RuntimeError`** | **预期硬失败**：`模板上屏文字包含无法完整显示的超长词，请缩短上屏文字。`。agent 开着时先记一条 `overlay_fallback`，回退确定性版式再失败 → `render_segment` 退出 1，任务停在合成。**这正是要验的**：报错信息可读、且不是 agent 造成的 |

> 想跑完整 6 镜而不想让任务挂，就把第 6 镜整段删掉再导入。
> 第 1–5 镜的 `packaging-agent-log.json` 在第 6 镜挂掉之前已经写好了，照样能取。

### 05_真实出片_食品码垛讲解_48s（6 镜）

**测什么**：贴近真实出片的一条，6 镜 × 8 秒 = **48 秒**，口播按 **4.2 字/秒**估（每镜 29–32 字）。
`card_content` 覆盖 3/6（50%），比 9/17 那条真任务的 1/7（14%）高，正好看「覆盖率上来以后 agent 的版式选择是不是真的吃上力」。

| 镜 | card_content | card_hint | 确定性 | agent 预期 | 版面 |
|---|---|---|---|---|---|
| 1 | 「一条线同时接住瓶装、箱装和袋装」 | 空 | `title` | `title` 或 `parameters`（有顿号列举） | 54 / 1 行 |
| 2–4 | 无 | 空 | `title`（退回分镜标题） | `show` 判定。注意这三镜的分镜标题与字幕写得很接近口播，agent 有可能按「与 voice_text 重复」判 `false`——这正是要看的真实情况 | 1 行 |
| 5 | `节拍 700 包/小时｜输送带连续来料｜托盘满垛下线` | 参数卡 | `parameters` | `parameters` | 42 / 2 行 |
| 6 | 「把你的包装形态和目标垛型发过来，我们照着试一遍」 | 空 | `title` | **`cta`** | 54 / 2 行 |

> 口播语速口径：产线视频那边的经验值是 4.2 字/秒；9/17 那条真任务实测是 **4.8–5.0 字/秒**（含标点）。
> 按 4.2 写等于留了余量，TTS 出来应该短于分镜时长，`final_check.duration_delta` 不该变大。

### 02/04/05 的版面数字：57ecd75 行为 / 新分支行为

新分支的第二个 commit（`68405c6`）给**包装卡片**的换行加了禁则（数字+单位不拆、行首/行尾禁则、孤字回退）。
在这三份脚本的全部 `card_content` 上实算：**行数与页数一处没变**，只有两处断点位置变了，
上面各表里的「实测版面」列**不用改**：

| 脚本-镜 | 57ecd75 断行 | 新分支断行 |
|---|---|---|
| **02-3 / 05-5**（`节拍 700 包/小时｜输送带连续来料｜托盘满垛下线`） | `…托盘满垛下` / `线` | `…托盘满垛` / `下线` |
| **01 第 7 镜那类竖屏窄卡片**（docs §9.1 的「路径确认」） | `抓具调整｜路径确` / `认` | `抓具调整｜路径` / `确认` |

**04 第 5 镜的「节｜拍」新分支也没修好**：`title` 版式本来就没切词；`parameters` 42 号下仍是
`…与输送节` / `拍确认`。整句没有任何标点，判词边界只能上词典分词，本轮不引入，**已知不修**。
**04 第 6 镜的超长词硬失败行为与报错原文一字不变。**

---

## 四、在 Windows 上怎么导入、怎么跑

### 4.0 先说结论：哪几步 agent 能自己做，哪一步没有无 UI 入口

**结论：除了「把文件夹绑定解析成冻结素材清单」这一步，整条链都有命令行入口。**
而那一步本轮可以绕开——素材库没变，batch4 冻结的那份 `material_manifest.json` 里 6 条素材的
identity 字段可以原样复用，只要把 `shot_id` 换成新脚本的即可。**所以本轮可以全程不开桌面端。**

| 步骤 | 无 UI 入口 | 依据（file:line） |
|---|---|---|
| 脚本文档 → 分镜 | ✅ 引擎自带 | `cli.rs:79-81` `--script-file`、`cli.rs:95-96` `--plan-only`；引擎自己去调 `normalize_script.py`（`VideoAutoCutApp/src/script.rs:98-108`），plan 落在 `{run}\shots.json`（`main.rs:427-429`） |
| （同上，也可以绕过引擎直接调 Python） | ✅ | `tools/normalize_script.py:356-362`：`--input` / `--output`（必填）/ `--topic`；`load_dotenv()` 在 `:357`，要 `DASHSCOPE_API_KEY` + 网络 |
| 选素材范围（绑定「食品码垛」文件夹） | ⚠️ 没有 CLI，但它**只是往 shots.json 里写两个字段** | 桌面端那个「绑定素材范围」按钮干的事就是给每镜写 `material_bindings` + `download_material:false`（`src/pages/start/scriptMaterialScope.ts:20-37`）；字段规范在 `tools/shot_plan_schema.py:105-133`（binding 形状）与 `:163-188`（`download_material` 缺省 = `not bindings`） |
| 生成 `material_manifest.json` | ❌ **全仓唯一的生产者在 Electron 主进程里** | `VideoAutoCutDesktop/electron/material-local-store.ts:3455-3511`（`prepareGenerationManifest`，原子写到 `{dataRoot}\video\material-manifests\{run_id}.json`）。Rust 只是把它抄进 run 目录（`main.rs:423`），Python 侧没有任何写它的地方 |
| 起引擎出片 | ✅ | `cli.rs` 全表；9/17–9/18 那几轮验收本来就是这么跑的（不开 GUI，见 `51255957` §1） |

引擎对清单的硬校验（决定了「手搓 manifest」要满足什么）：

- 有绑定的分镜**必须**配 manifest，否则 `material_clip.rs:142-144` 直接 `bail!("bound shots require a frozen material manifest")`；只有 `--plan-only` 例外（`main.rs:418` 传 `require_manifest=!cli.plan_only`）。
- `manifest.task_revision` 必须等于 `shots.task_revision`（`material_clip.rs:161-167`）。
- manifest 的 `shot_id` 集合必须与 shots.json **完全相等**（不是子集，`material_clip.rs:203-205`）——
  所以**每一镜都要在 manifest 里有一条**，走自动下载的镜配空 `materials: []`。
- 每条素材要有非空 `material_id`/`asset_id`、`asset_version != 0`（`:182-201`）；
  staging 时还会校 64 位 hex `source_sha256`、`local_path` 必须在本机存在、并**真算一遍 SHA-256 比对**
  （`material_clip.rs:396-426`）。所以复用旧 identity 字段是安全的：素材被人换过，这里就会当场报错，不会悄悄跑歪。

**UI 自动化这条备选路（Playwright / Electron 远程调试端口）不建议走**：仓库里没有任何
Playwright/Spectron 依赖（`VideoAutoCutDesktop/package.json` 的 `scripts` 只有 `test` 和 `test:startup`），
要现搭一套比上面两条路都贵，而且 UI 一改就废。真要补，补下面 4.5 那个无 UI 入口更值。

### 4.1 前置（每轮开始前）

1. **app.env 要就地改键，不能往文件末尾追加**（`load_dotenv` 是 `setdefault`，第一次出现的那行生效）。
   文件：`D:\Video Edit\VideoAutoCut\config\app.env`
   ```
   VIDEOAUTO_TEMPLATE_PACKAGING=true      # 桌面端「画面样式 → 模板包装」那个开关也可以点
   PACKAGING_AGENT_SELECT=1               # 0 = 只跑确定性路径（对照）
   PACKAGING_AGENT_BACKEND=pi             # 不显式写 pi 一律走 dashscope
   PACKAGING_AGENT_CACHE=0                # 测试期建议关掉，否则同一份文案第二遍不会再问模型
   MATERIAL_AGENT_PI_PROVIDER=evst-gateway   # ⚠️ 这 4 个键必须一起配，见下
   MATERIAL_AGENT_PI_MODEL=qwen3.6-plus
   MATERIAL_AGENT_PI_TEXT_MODEL=qwen-plus
   MATERIAL_AGENT_PI_THINKING=off
   ```
   跑完记得还原生产 app.env。

   > ⚠️ **`PACKAGING_AGENT_BACKEND=pi` 不配 provider 会 100% 静默降级。**
   > 包装 agent 的 pi 参数沿用 `MATERIAL_AGENT_PI_*` 那一套，但**没有配就不是「用默认值」**：
   > provider 默认 `dashscope`，而运行包只带 `models.evst-gateway.json` → pi 报
   > `Unknown provider "dashscope"` → 每镜 0.21s 就降级走确定性版式，**成片照出、
   > `render.log` 全绿、看不出异常**。2026-09-21 第一批 5 条整跑就是这么全降级的
   > （回帖 51296044 第五节）。
   > 现在这种情况会在第一次调用前打一行 `[agent] ⚠ pi provider 'dashscope' 未配置或不存在：…`，
   > 但**不阻断**——跑完请顺手 grep 一下这行确认没出现，以及
   > `packaging-agent-log.json` 的 `fallback_used` 全是 `false`。

   > 并入后多了一个键 `VIDEOAUTO_PACKAGING_SCRIPT_ONLY`（**默认开**，桌面端「画面样式 → 模板包装 →
   > 只按脚本上屏」那个子开关）。**本轮就用默认（不设这个键，验「缺键=开」）**；想复现本文左栏那些
   > 旧预期，再就地加一行 `VIDEOAUTO_PACKAGING_SCRIPT_ONLY=0` 重跑。
2. 组件自检（缺 sharp / chrome 会在第一镜就挂）：
   ```powershell
   python VideoAutoCut\tools\material_gen\pi\install_pi.py --check
   python VideoAutoCut\tools\material_gen\hyperframes\install_hyperframes.py --check --runtime-root "<已安装的运行包目录>"
   ```

### 4.2 路线 A：全命令行（本轮推荐，不用开桌面端）

脚本已经在仓库里：`git pull` 之后就在 `docs/packaging-test-scripts-2026-09-21/`。
下面每一步都沿用你们 9/17 起那套后台验收骨架（新审计目录 + 编译 `run-acceptance.mts` + `node` 跑），
**只换 args 和 state**，env / 账号网关配置那一整套不要自己另搭（`交接必读_后台验收与打包.md` 里
踩过 HTTP 401 那个坑）。启动器仍然要求生产 `MATERIAL_MATCH_MIN_SCORE=0`。

**第 1 步 · 出分镜（plan-only）。** 把启动器的 args 换成：

```text
--plan-only --script-file <repo>\docs\packaging-test-scripts-2026-09-21\01_对照组_无上屏卡片_食品码垛_CN.md
--project-name pkg01_对照组_CN --aspect-ratio 16:9 --output-resolution 1080p --source pexels
```

- 这一步**不要带** `--restart-all`（它在目标 run 目录已有 `shots.json` 时会 bail，`main.rs:357-359`），
  也**不要带** `--material-manifest`（`--plan-only` 时 `require_manifest=false`，`main.rs:418`）。
- 引擎会自己去调 `normalize_script.py` 走 Qwen 文件理解（`script.rs:98-108`），
  然后把 plan 写到 `{run}\shots.json`（`main.rs:427-429`）。run 目录从 stdout 的「运行目录:」那行取。
- 成片比例固定 **16:9 / 1080p**（与 9/17 那轮一致，本文第三节的版面数字也是按这个算的）。

**第 2 步 · ★核对并改 `shots.json`（不能跳）。**

1. 照本文第三节的表**逐镜对 `card_content`**：是否逐字保留、`card_hint` 有没有进错字段、分镜数对不对。
   脚本里 `上屏文字 / 卡片样式` 是靠 `prompts/script_parse.md:55-56` 映射到 `card_content` / `card_hint` 的，
   qwen-long 不保证逐字（规则 14 在 `:95`）。
   - **04 第 6 镜**那个 98 字英文长词最可能被解析器拆开加空格——一旦被拆开就不会失败了，
     测试目的就没达到，**必须手工改回**。
   - 04 里写成 `卡片样式：（不填）` 的几镜，如果解析器真把「（不填）」塞进了 `card_hint`，把该字段删掉。
2. **补素材绑定**（这就是桌面端那个「绑定素材范围」按钮干的事，`scriptMaterialScope.ts:20-37`）：
   给**每一镜**加两个字段——

   ```json
   "download_material": false,
   "material_bindings": [
     { "binding_type": "folder", "folder_id": "<食品码垛/食品 那个文件夹的 fld_ id>", "include_subfolders": true }
   ]
   ```

   `folder_id` 直接从 **batch4 审计目录的 `input-shots.json`** 里抄（同一个文件夹，没换过）。
   两个字段必须一起给：`download_material:true` 又带 bindings 会被 `material_clip.rs:124-130` 拒掉。
3. 顶层 `task_revision` 保持 `normalize` 出来的 `0`（`shot_plan_schema.py:139-149`），
   后面手搓 manifest 时跟它对齐。
4. 改好的 shots.json **另存到本轮审计目录**，别写回第 1 步那个 run 目录。

**第 3 步 · 手搓 `material_manifest.json`。** 拿 batch4 审计目录那份当模板，只改 4 个地方：

| 字段 | 怎么填 | 校验在哪 |
|---|---|---|
| `run_id` | 新的 `run_<32 位 hex>`；引擎会**拿它当本次 run 目录名** | `main.rs:333` |
| `task_id` / `resolved_at` | 任意非空串 / 当前 ISO 时间 | `material_clip.rs:155-160` 只查非空 |
| `task_revision` | 改成 `0`，与 shots.json 一致 | `material_clip.rs:161-167` |
| `shots[]` | **每一镜一条**，`shot_id` 换成新 shots.json 里对应那镜的；`materials` 那 6 条原样照抄 | `material_clip.rs:203-205`：两边 shot_id 集合必须**完全相等**，不是子集 |

`material_id` / `asset_id` / `asset_version` / `source_sha256` / `local_path` 照抄是安全的：
staging 时引擎会**真算一遍 SHA-256** 并要求 `local_path` 存在（`material_clip.rs:396-426`），
素材要是被人换过，这里当场报错，不会悄悄跑歪。

做完可以先花几十秒**干跑一次校验**：`--plan-only --shots-json <改好的> --material-manifest <手搓的>`。
它会把两份文件的所有硬约束跑一遍。⚠️ 干跑用**另一个 run_id** 的 manifest 副本（干跑也会占掉那个 run 目录），
而且 `--plan-only` 这条路会执行 staging，把 6 条素材硬链接/复制进 run 目录（`main.rs:417-421`）。

**第 4 步 · 真跑。** 启动器 args 沿用已验证的那套，只换三处：

```text
--restart-all --shots-json <本轮 shots.json> --material-manifest <本轮 manifest>
--project-name <本条脚本的名字> --aspect-ratio 16:9 --output-resolution 1080p --source pexels
```

`--source pexels` 是沿用参数，实际选材受 manifest 绑定的本地范围约束——**别把 manifest 删了误跑成公共素材检索**。

**第 5 步 · 5 条脚本重复 1–4。** 每条一个独立 `--project-name` 和独立 run_id。

### 4.3 路线 B：桌面端导入（素材库变了、或懒得手搓 manifest 时走这条）

1. 脚本在 `docs/packaging-test-scripts-2026-09-21/`（`.md` 在脚本文件白名单里：
   `xlsx/xlsm/xls/docx/doc/pdf/txt/md/csv/json/srt`，见 `VideoAutoCutDesktop/electron/file-extensions.ts:6`）。
2. 工作台 →「脚本文件」→ 选脚本 → **点那个链接图标「绑定素材范围」，选中素材库里的「食品码垛」文件夹并勾选包含子文件夹**
   （不绑定就会按工作台的素材来源模式去找，可能跑到 Pexels 上去）。
3. 成片比例选 **16:9**、分辨率 **1080p**。
4. 点「**导入并整理分镜**」→ 同样是引擎调 `normalize_script.py`，写出 `{run}\shots.json`。
5. **★ 同 4.2 第 2 步：打开 `{run}\shots.json` 肉眼核对 `card_content`。**
   桌面端的分镜编辑抽屉**没有** `card_content` 输入框（可编辑字段只有 标题/口播/素材搜索词/想要的画面/剪辑要求，
   见 `src/pages/start/constants.ts:3-9`），解析错了只能在 shots.json 里手改。
   走这条路时手改**只动 `card_content`/`card_hint`**，`shot_id`、`material_bindings`、`task_revision`
   一个都别碰——桌面端已经按它们生成了冻结清单（`material-local-store.ts:3455-3511`）。
6. 回桌面端点生成。

### 4.4 复跑同一条任务（对照组用）

改 app.env 的 `PACKAGING_AGENT_SELECT=0`，**用同一份 shots.json + 同一份 manifest**（换个新 `run_id`）再跑一遍，
就是 4.2 第 4 步那条命令。9/17 那个 `准备新一轮.py` 干的就是这件事：复制同一输入、只把 manifest 的
`run_id` 换成新的，不重新解析绑定。

### 4.5 如果想彻底不用手搓（方案，本轮不实现）

唯一缺的入口是「把 `material_bindings` 解析成冻结清单」。最小补法：在
`VideoAutoCutDesktop/scripts/` 新增一个 `emit-material-manifest.mjs`，照现成的
`scripts/real-material-reuse-test.mjs` 的写法——它已经在做同一件事：从 `dist-electron/` import
`createMaterialLocalStore` / `createMaterialCloudService`，然后调
`prepareGenerationManifest({ taskId, taskRevision, shots })` 拿 `manifestPath`。
新脚本只要读 `--shots <shots.json>`、调同一个函数、把 manifest 路径打到 stdout 即可，**约 40–60 行**，
现有模块零改动（纯新增文件 + `package.json` 加一条 script）。

- 前置：`npm run build:electron`（它 import 的是编译产物）。
- 风险：这类脚本要自己重建 `main.ts:106-152` 那一套路径常量，指错了会连到空素材库 →
  清单为空。不过那也不会静默：引擎随后按「bound shot 必须至少选一个素材」报错（`material_clip.rs:133-138`）。
- 这一步做完，路线 A 的第 3 步就从「手搓 + 干跑校验」变成一条命令。

---

## 五、判定通过看什么

**每镜一份决策日志**：`{run}\final_clips\packaging\{NNNN}_final\packaging-agent-log.json`

| 字段 | 看什么 |
|---|---|
| `decision.template` / `decision.show` | 与本文第三节的预期表逐镜对 |
| `decision.overridden` | 出现 `"author_card_content"` = 模型想关包装被护栏挡回来了，单独报 |
| `deterministic.template` | 确定性正则选的版式（对照基线） |
| `agreed_with_deterministic` | **只比版式** |
| `show_agreed_with_deterministic` | 只比上不上包装（确定性恒为「上」，所以它 = `show` 是不是 true） |
| `decision_changed` | agent 到底改了几镜 |
| `cache.hit` | 测试期应全 `false`（`PACKAGING_AGENT_CACHE=0`） |
| `timings.model_seconds` | 9/18 基线：中位 2.22s / P95 2.79s |
| `budget.overran` | 应为 `false` |
| `fallback_used` + `errors` | 降级了几镜、为什么 |
| `overlay_fallback` | agent 版式渲不出来、回退确定性（04 的第 6 镜预期会有） |
| `final_check.duration_delta` | 9/18 基线 21 个值全 0.0 |

**产物**：

- `{run}\final_clips\packaging\{NNNN}_final\overlay.webm` —— `show=true` 的镜必须有，`show=false` 的镜必须**没有**
- 同目录 `render.log` —— 必须 `0 errors`（**04 第 4 镜的分页是重点**）
- 同目录 `index.html` —— 分页的那镜每页应有 `tl.set("#page-i",{opacity:0},…)`
- 同目录 `template.json` —— `template_source` 是 `agent` 还是 `deterministic`；`pages` 能直接看分页结果
- 成片：每镜 ffprobe = 目标画布 / SAR 1:1 / aac 48000 2ch

**stdout**：`[packaging] 分镜 N 版式 xxx（agent，理由）…` 或 `[packaging] 分镜 N 不上包装（…）`，
外加两行 `VACUT_EVENT`（桌面端会把它从可见日志里摘掉，人读看 `[packaging]` 行）。

**建议顺序**（每条任务的大头是 overlay 渲染，约 45s/镜，一条 6–7 镜的任务整跑十几到二十几分钟）：
`01（先 agent 关，再 agent 开）` → `03` → `02` → `05` → `04`（最后，且知道第 6 镜会挂）。

### 5.1 回帖要报的字段（每条脚本一张表）

1. **逐镜一行**：`decision.template` / `decision.show` / `agreed_with_deterministic` /
   `decision.overridden` / `fallback_used` + `overlay_fallback`，外加 `reason` 原文。
2. **每镜 `timings.model_seconds`**，并给这条脚本的中位数与 P95（9/18 基线：中位 2.22s / P95 2.79s）。
3. **合成耗时**：从第 1 镜写入包装到最后一镜成片落盘（整跑总耗时含选材，每次都会变，只能粗看）。
   01 那条要报 agent 关 / 开两轮的合成段差值。
4. **`final_check.duration_delta` 的每镜值**（9/18 基线 21 个值全 0.0）；`budget.overran` 应全 `false`；
   `cache.hit` 应全 `false`。
5. **成片路径** + **第 1 帧 / 中间帧 / 最后一帧**的截图或文字描述（看上屏文字有没有渲出来、有没有被切词切坏、分页节奏对不对）。
6. **`card_content` 覆盖率**（按实际解析出来的算，不是按脚本写的算）。
7. **04 第 6 镜**单独报：报错原文是不是
   `模板上屏文字包含无法完整显示的超长词，请缩短上屏文字。`，以及它之前是不是先记了一条 `overlay_fallback`。
8. **手改了 shots.json 的哪几处**（哪一镜、哪个字段、改前改后），这决定别人能不能复现。

---

## 六、拿不准 / 需要你确认的点

1. **素材范围 = 本地素材 / 食品码垛，按 9/17 那 6 条算**（用户 9/21 确认素材库还没被改动）。
   开跑前还是顺手核一眼那 6 个文件都在、sha256 对得上（4.2 第 3 步的干跑会替你查）。
   万一真换了内容，脚本里的 `画面` 字段要跟着改，否则选材 agent 匹配不到、大量走占位。
2. **脚本文档→分镜是 LLM 解析，不保证逐字。** `card_content` 会不会被改写、分镜会不会被合并/拆分，
   都是 qwen-long 说了算（`normalize_script.py` + `prompts/script_parse.md` 规则 14 在 `:95`）。
   所以 4.2 的第 2 步（核对 shots.json）**不能跳**。04 第 6 镜那个 98 字英文长词尤其可能被解析器拆开加空格——
   一旦被拆开，那一镜就不会失败了，测试目的就没达到，需要手工改回 shots.json。
3. **版面行数/页数是 Mac 侧用 PIL 测的宽度。** Windows 用 GDI 测，同字体下差几个像素；
   卡在临界值上的几镜（02 第 2 镜 21 字正好吃满一行、04 第 4 镜 4+1 行）可能差一行。不影响通过判定，只影响预期描述。
4. **素材朝向会直接改变版面。** 上面所有数字都按「横屏素材铺满 1920×1080」算。
   选材 agent 如果挑到竖屏/被裁窄的片段，`picture_bounds` 变窄 → 每行字数骤降 → 页数变多，
   04 第 4 镜可能从 2 页变 3–4 页（仍应 `0 errors`，只是节奏变快）。9/17 那轮第 7 镜就是这么分的页。
5. **`show=false` 的口径 9/21 已拍板成立**（9/18 那两镜「码垛流程观察起点」「工位衔接可视化」判不上包装，
   用户认可）。所以本轮**不必再为 show=false 停下来问**，照实记录即可；
   只有出现与这个口径明显矛盾的判定（比如把 01 那种能给观众看的短句也关掉）才单独拎出来报，
   真要收紧改的是提示词 `prompts/agent_packaging_plan.md` 第 22 行的 false 条件。
6. ~~**第二步「agent 从口播原文摘上屏要点」仍未开、仍未定。**~~
   **2026-09-21 用户拍板：第二步「agent 从口播摘上屏要点」= 不做。** 上屏内容属于包装内容，一律以脚本为准，
   AI 不替作者生成、也不摘取上屏文字；agent 在包装环节的职责只剩「在作者写了上屏内容的镜里选版式」。
   这 5 份脚本仍只服务第一步（选版式 + 判 show），别顺手把第二步一起验了。
7. **节拍 700 包/小时** 这个数字来自面粉码垛那条素材的文件名（文件名里还带机型号，机型号没进脚本）。
   如果你觉得测试脚本里也不该出现具体节拍，把 02-3、04-2、05-5 三处改成定性说法即可，不影响测试目的。

---

## 七、2026-09-21 第二小轮追加的两份（表格版 / 纯文本版）

用户拍板「生产脚本主要是表格（xlsx）或 txt」，上一轮的脚本字段确定性校验只对纯文本生效，
表格一律零动作。本轮把校验扩到表格 / docx（只用标准库读，运行包是嵌入式 Python，
**装不了也不许装 openpyxl**），于是配两份**内容与 `03_混合_show判定` 逐字等价**的脚本来验它：

| 文件 | 验什么 |
|---|---|
| `07_表格版_混合_show判定_食品码垛_CN.xlsx` | 表格路：表头识别 + 数据行 = 一镜 |
| `07_纯文本版_混合_show判定_食品码垛_CN.txt` | 文本路不只认 `.md` |

xlsx 那份**刻意做成真实生产脚本的形状**（调研了 `产线视频` 项目下 22 份独立分镜 xlsx）：

- **表头在第 5 行，不是第 1 行**——上面压着一块纵向的「模块一：封面文案」key-value 区；
- 9 列：`分镜 / 分镜标题 / 时长 / 章节标签 / 画面 / 口播 / 字幕 / 上屏文字 / 卡片样式`；
- 7 个数据行 = 7 镜，上屏文字 / 卡片样式的写法（含「（不填）」占位）与 03 一字不差。

**三份（md / xlsx / txt）导入后应当得到相同的 `card_content` / `card_hint` / `title`**，
逐镜对照见 `docs/fix-round-acceptance-2026-09-21b.md` 的 B2 表格 `03` 那一行。
Mac 侧单测 `test_script_card_fields.py::EquivalentScriptTests` 钉住了这一点。

两份都保留 03 第 4 镜的长句标题、第 6 镜的「开场」——那是 **B8（`title` 纳入逐字校验）**
的两个探针：这一轮起 `title` 也按脚本原文纠回来，但**脚本没写标题时**（02 / 04 那样）
plan 里那个 schema 兜底的「分镜N」**不算臆造、不清空**。

**怎么重新生成**（改了内容要重新出文件时）：

```powershell
cd VideoAutoCut
python tests\make_table_test_scripts.py
```

生成脚本与它用的最小 xlsx 写出器都在 `VideoAutoCut/tests/` 下，**不进运行包**。
