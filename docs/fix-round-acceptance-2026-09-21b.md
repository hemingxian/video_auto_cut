# 【已过时】修复轮 · Windows 验收清单（2026-09-21，B1–B8）

> ⛔ **本文件已由 `docs/fix-round-acceptance-2026-09-22.md` 取代，不再执行。**
> 线上 issue 评论 `51298013` 也已于 2026-09-22 标记作废。请等待 9/22 新单填完最终 commit、测试数与审查证据并发布后，只按新单执行；发布前 Media/Windows 暂不开工。

> ⛔ **本条取代 issue IKGH73 评论 `51298013`，那条不要执行。**
> `51298013` 发出后用户又拍了三条（见下「一」），B1 降级、B2 扩展、新增 B7/B8，
> 分支也从 `d55c857` 往前走了 23 个 commit。**Windows 只需读这一份，从头到尾照做。**
>
> ✅ **总开工单 `51293189` 的 ①–⑤ 已完成，不用重做**（Windows 回帖 `51296044`，Mac 已复核通过）。
> ⏸ **⑥ 上传 `runtime-trial/` 继续暂缓**，等用户通知，本轮不碰上传。

承接链条：总开工单 `51293189` → Windows 回帖 `51296044`（①–⑤ 完成，⑥ 按「不符就停」停下）
→ Mac 修复轮 `51298013`（**作废**）→ **本条**。

---

## 一、用户 2026-09-21 拍板的三条（本轮的由来）

1. **生产脚本主要是表格（xlsx）或 txt**，其它格式（docx / pdf / csv）也可能有
   → 上一轮的「上屏字段确定性校验」只对纯文本生效，等于**最主要的那类脚本根本没被兜住**，要覆盖表格。
2. **分镜标题 `title` 也纳入同一套逐字校验**（解析器上次把 03 第 4/6 镜的 title 改写了；
   title 会上进度条，老路径下还会当卡片文字）。
3. **A4 的「第二个可能原因」不修**。用户口径：「脚本没写上屏内容的就不上卡片，一切以脚本为准」。
   默认配置（`VIDEOAUTO_PACKAGING_SCRIPT_ONLY=1`）下没有 `card_content` 的镜**根本不进模型**，
   `show` 由脚本决定；只有把 `SCRIPT_ONLY` 关掉的老路径才会走到模型判 `show`，
   而**那条路径的判断质量不再是关注点**。`packaging_agent.context_text()` 一行不动。

---

## 二、分支与 commit

分支 `feature/material-agent-select`，在 `86a02e0` 之上共 **29 个 commit**，分两小轮。

**第一小轮**（`86a02e0..d55c857`，6 个，已在 `51298013` 里说明过）：

| commit | 修哪个问题 |
|---|---|
| `8551900` | 修 1：包装提示词回归（A4 的口径偏差真因） |
| `336a490` | 修 2：脚本解析丢字 / 臆造 / 翻译上屏字段（新 `tools/script_card_fields.py`） |
| `f679597` | 修 3：pi 后端未配 provider 静默全降级 |
| `60aa06a` | 小项：两个装组件脚本 stdout 重定向被 `✓` 打崩 |
| `6e1ce92` | 第一次对抗复审修订（动的是前四条的公共面，合成一条；**要回退前四条里的任何一条，这条也要一起回**） |
| `d55c857` | 文档：填上 hash |

**第二小轮**（`d55c857..HEAD`，23 个；改代码的是这 7 条，其余是测试、夹具和文档）：

| commit | 改了什么 |
|---|---|
| `059c508` | 表格 / docx 脚本的**标准库**取文本层（新文件 `tools/script_tabular.py`） |
| `46c5f23` | 校验覆盖表格路径 + `title` 纳入逐字校验（`script_card_fields.py`） |
| `2549934` | 自查：日志回显作者原文时先过一道编码安全（作者写 emoji 会把这一层打崩） |
| `a176a14` | **本小轮第 1 次对抗复审修订**：列名剥括注把「泛用词+括注」整类认错（1 阻断 + 3 应修 + 5 建议） |
| `abe6f0a` | 表头按候选列表逐个试（最像的那行底下未必有数据行） |
| `0c67001` | **本小轮第 2 次对抗复审修订**：「同分取靠后」自己造出新的改坏路径；括注与角色冲突的列整列不认；sheet 超限整份放弃；保险丝阈值下调 |
| `cb62ad4` | **本小轮第 3 次对抗复审修订**：密度当排序键仍会被「真表头带备注列」劫持 → 密度降级成**准入闸门**、排名退回行号升序；冲突词表收窄到口播/字幕两角色；sheet 超限给一条说得通的原因串 |

另：`normalize_script.py` 只挪了一行——`verify_card_fields` 提到 `ensure_progress_labels`
**之前**（否则进度条拿到的是未纠正的标题）。

口径与代码落点的**正本**：`docs/packaging-agent-step1-2026-09-18.md`
§8.9（只按脚本上屏）、§8.10（上屏字段确定性校验）、
**§8.10.5（第二小轮：格式覆盖矩阵 + 表格路规则 + `title` 边界 + A4 不修的理由）**。

**全程纪律**：app.env **就地改键，不能往文件末尾追加**（`load_dotenv` 是 `setdefault`，
第一次出现的那行生效）；每轮跑完还原生产 app.env。

---

## 三、这一轮改了什么（一页看懂）

### 3.1 一条要先讲清楚的事实：**软件本地根本不读脚本**

开工单原话是「校验必须复用同一套读取结果或同一批库」，查下来**这条路不存在**：

- `normalize_script.py` 把整个脚本文件**原样 multipart 上传**到 DashScope 的 `/v1/files`
  （`purpose=file-extract`，`upload_script_file:108-139`），再只发一条 `fileid://…`
  让 **qwen-long 在服务端**抽文字并结构化（`normalize_with_ai:301-318`）。
  **服务端抽出来的文本不回本地**，所以拿不到「同一套读取结果」。
- 「同一批库」也无从谈起：清点过 `VideoAutoCut/tools/` 全部 44 个 py 文件的 import，
  **零第三方依赖**，全是标准库 + 自家模块。运行包里的 Python 是
  `python-3.11.9-embed-amd64`（`VideoAutoCutApp/src/paths.rs:133`），嵌入式发行版
  **没有 pip、没有 site-packages**，装不了也不该装 openpyxl / python-docx。

**所以只剩一条不引入新依赖的路：标准库自己读。** `.xlsx` / `.xlsm` / `.docx`
本身就是 zip + XML（`zipfile` + `xml.etree` 够用），`.csv` 有 `csv`。
`.xls` / `.doc`（旧二进制 BIFF / CFB）和 `.pdf` 标准库读不了 → **不读，零动作**。

### 3.2 格式覆盖矩阵

| 格式 | 本地怎么读 | 走哪条路 |
|---|---|---|
| `.md` `.txt` `.json` `.srt` | 直接按文本读 | **文本路**：「分镜 N」切块 + `键：值` 行（**一行没改**） |
| `.xlsx` `.xlsm` | `zipfile` + `xml.etree` 读 OOXML | **表格路**：识别表头列名，数据行 = 一镜 |
| `.csv` | `csv` + Sniffer | 先试表格路；表头认不出来**退回文本路** |
| `.docx` | `zipfile` + `xml.etree` 读 `word/document.xml` | 取出纯文本后走**文本路** |
| `.pdf` `.doc` `.xls` | **不读** | **零动作**，只打一行说明 |

「零动作」= plan 一个字节不改、只打一行 `跳过（不影响出片）`，**绝不中断出片**。

### 3.3 表格路的规则（照真实生产脚本做的）

调研了 `产线视频` 项目下 **22 份独立分镜 xlsx**（只读）：单 sheet「视频脚本」，
**表头在第 11 / 18 / 20 / 21 行不等**（上面压着一块纵向的「模块一：封面文案」key-value 区），
**起始列 A 或 B 都有**，列名六种变体（`中文文案` / `中文文案（直接复用）` /
`素材搜索策略（中文）` 全角 vs `素材搜索(中文)` 半角），**没有分镜号列**，时间轴格子里带换行。

- **表头不假定在第 1 行、不假定 A 列**；**角色密度 < 0.6 的行直接否决**
  （密度 = 认出的列 / 这一行有几个非空格；封面块那行 `标题\|x\|文案\|y\|素材\|z` 是 3/6=0.5），
  过闸的按「①角色数 ②**行号升序**」排，**第一个底下真能切出分镜的才算数**。
  **密度只否决、不排名**——排名靠位置或靠形状分都能被构造出「下面的块抢表头」，
  而「表头永远在它自己的数据区之上」是结构事实；
- **列名两遍查表、绝不子串匹配**：先拿不剥括注的原名查，没命中才剥括注再查，
  且第二遍不许落到泛用键（`标题` / `文案` / `素材` / `title` …）上；再加一层
  **括注与角色冲突就整列不认**（只给口播 / 字幕：`中文文案（上屏）` 说的不是口播）；
- **合并单元格**摊到整个区域；分镜号同号或号为空的行并进上一组（一镜多行）；
  分镜号必须严格 `1..N`，否则整份零动作；
- **多 sheet**：恰好一个 sheet 能认出分镜表才动手，两个都像 → 零动作 + 告警；
  超过 64 张整份放弃（日志会说「sheet 太多」，不会笼统报「读不出来」）；
- 文本路已有的闸门全部沿用：块数≠分镜数、内容锚点认人、占位词当空、深拷贝原子性；
- **保险丝**：整表一个上屏列都没认出来、而 plan 里 **≥1/3 且至少 2 镜**有上屏内容 →
  两个上屏字段全表**只告警不改**（这更像「列没认出来」而不是「作者没写」），
  告警带「共有 N 处对不上」。只有 1 镜有卡片时不点火。

完整规则表在 `docs/packaging-agent-step1-2026-09-18.md` §8.10.5.3。

### 3.4 `title` 的边界

- 脚本**写了**标题而 plan 不同 / 为空 → 按 `card_content` 同一套纠回来；
- 脚本**没写**标题 → plan 里那个值**不算臆造、不清空、连告警都不打**
  （它是解析器自拟的或 schema 兜底填的「分镜N」，`shot_plan_schema.py:184`，都是合法产物）；
- **`module_label`（进度条章节名）不纳入**——解析器按规则生成的，不是作者原文；
- `title` 同时是三个内容锚点之一，但不产生循环：认人只要任一锚点命中。
  **只有标题能认人、而标题恰恰被改写了** → 认不了人 → 该镜只告警，标题不会被改。

### 3.5 日志前缀改名（B2/B7 要 grep 的字串变了）

`[script] 上屏字段校验` → **`[script] 脚本字段校验`**（现在也管 title）。
`VACUT_EVENT` 的 `workflowStage` / `phase` / `cardFieldCorrections` **字段名没变，桌面端不用改**；
`label` 改成「脚本字段校正 N/M 处」。事件正文现在是**纯 ASCII**（中文走 `\uXXXX` 转义），
这样任何控制台编码下都不会崩、而且一个字不丢。

---

## 四、前置

```powershell
git checkout feature/material-agent-select
git pull                              # → TBD_HEAD（本轮最后一条 commit）
python VideoAutoCut\tools\material_gen\pi\install_pi.py --check
python VideoAutoCut\tools\material_gen\hyperframes\install_hyperframes.py --check --runtime-root "<已安装的运行包目录>"
```

app.env 这一轮要就地配齐**这些**键：

```
VIDEOAUTO_TEMPLATE_PACKAGING=true
PACKAGING_AGENT_SELECT=1
PACKAGING_AGENT_BACKEND=pi
PACKAGING_AGENT_CACHE=0
MATERIAL_AGENT_PI_PROVIDER=evst-gateway
MATERIAL_AGENT_PI_MODEL=qwen3.6-plus
MATERIAL_AGENT_PI_TEXT_MODEL=qwen-plus
MATERIAL_AGENT_PI_THINKING=off
```

**建议执行顺序**：B5（最快、先确认代码是好的）→ B2 → B7 → B8（这三条共用同一批导入结果）
→ B3 → B4 → B6 → B1。

---

## B1 ·（**已降级，不是通过门槛**）确认包装提示词回到了 `57ecd75` 版本

> **用户拍板 A4 那条不再追**（见「一」第 3 条），所以 B1 只剩一件事，**不阻断**：

```powershell
git show 57ecd75:VideoAutoCut/tools/prompts/agent_packaging_plan.md | Get-FileHash -Algorithm SHA256
Get-FileHash VideoAutoCut\tools\prompts\agent_packaging_plan.md -Algorithm SHA256
```

**通过标准**：两个 sha256 相同（`test_packaging_agent.PromptTests` 也钉着这条，B5 会跑到）。

> ⛔ **不要再跑 `SCRIPT_ONLY=0` 的 03，也不要再贴 `packaging-agent-log.json` 的 `input` 原文。**
> `context_text()` 一行不动，理由记在 §8.10.5.8。
>
> 背景留档：上一轮 A4 的口径偏差（第 3 镜判对、第 4/6 镜没判成 `false`）真因是 9/21 上午
> 往提示词 `show` 那段加的三句话，其中「默认配置下 `show` 实际恒为 true，照填 true 即可」
> 让模型整段放弃了判断。`8551900` 已改回原文。
> **教训：提示词里永远不要写「照填 X 即可」，也不要给判定规则加「只有…时」前置条件。**

---

## B2 · **7 份**测试脚本重新从脚本文档导入，看自动纠正

**不要复用手改过的 shots.json。** 这一条验的就是「不用手改也能拿到与脚本原文逐字一致的 plan」。

**做法**：对 `docs/packaging-test-scripts-2026-09-21/` 下的 **7 份**脚本各跑一次
`--plan-only --script-file …`（README §4.2 第 1 步那条命令），得到新的 `shots.json`。
`normalize_script.py` 会在写盘前自动跑一次脚本字段校验。

| 文件 | 格式 | 验什么 |
|---|---|---|
| `01`–`05` | `.md` | 原来那 5 条，纯文本路 |
| `07_表格版_混合_show判定_食品码垛_CN.xlsx` | `.xlsx` | **表格路**（见 B7） |
| `07_纯文本版_混合_show判定_食品码垛_CN.txt` | `.txt` | 文本路不只认 `.md` |

**通过标准**

1. **自动纠正事件**：stdout 里应有 `[script] 脚本字段校验` 开头的行（告警行带 `[!]` 前缀）；
   有纠正时另有一条 `VACUT_EVENT`（`workflowStage=script`、`workflowProgress.phase=card_fields`），
   其 `cardFieldCorrections` 数组列出纠正了哪些镜哪些字段、哪一类
   （`missing`/`invented`/`rewritten`）。**把这个数组原样贴回来**（7 份各一份）。
2. **纠正后逐字一致**：新 `shots.json` 里每镜的 `card_content` / `card_hint`
   与脚本原文**逐字相同**（「（不填）」处应为**没有这个键**）。5 份 md 合计 **32 镜**，
   两份新脚本另算 14 镜（7+7）。对照表见下。
3. **解析器原始出错数**：跑之前先把 `VIDEOAUTO_SCRIPT_CARD_AUTOFIX=0` 各跑一遍（只提示不纠正），
   记下每份的 corrections 条数——这就是「改了提示词之后，解析器自己还错几处」。
   上一轮同样 5 份脚本是 **10 处上屏字段改动**（03-1 丢 1、臆造 hint 6、翻译/改写 hint 3）。
   **这个数下降了多少，是提示词收紧的效果指标**；没下降也不阻断——确定性兜底会兜住。
4. **不越界**：`duration` / `voice_text` / `subtitle` / `module_label` 这一层一个字都不该动。
   上一轮手改表里的 04-3 duration **仍会是解析器给的值**，这是对的。
   **`title` 本轮起归这一层管了**，单列一条 B8。

**逐镜对照（脚本原文，Mac 侧干跑已核）**

| 脚本 | 有 `card_content` 的镜 | 有 `card_hint` 的镜（原文） |
|---|---|---|
| 01 | 无（6 镜全空） | 无 |
| 02 | 1–7 全有 | 3=`参数卡，列表排版`；5=`要点卡`；7=`CTA 行动号召`；1/2/4/6 = **空**（脚本写「（不填）」） |
| 03 / 07 表格版 / 07 纯文本版 | 1=`来料到位是码垛稳定的第一道关`；5=`占位卡 05`；7=`带上你的包装形态和目标垛型，一起把这条线试一遍`；2/3/4/6 空 | 7=`CTA 行动号召`，其余 **空** |
| 04 | 1–6 全有 | 4=`参数卡，列表排版`；6=`英文长标题，逐字保留，不要拆词、不要加空格`；1/2/3/5 = **空** |
| 05 | 1=`一条线同时接住瓶装、箱装和袋装`；5=`节拍 700 包/小时｜输送带连续来料｜托盘满垛下线`；6=`把你的包装形态和目标垛型发过来，我们照着试一遍`；2/3/4 空 | 5=`参数卡`，其余 **空** |

> **这一层宁可漏报也不误改**，下列任一情形都退成「只告警不改」、绝不中断任务：
> 本地读不出原文（pdf / doc / xls）→ 零动作；文本路找不到「分镜 N」标记或编号不是严格 1..N
> → 零动作；表格路认不出表头、分镜号不是 1..N、同一字段对应到两列 → 零动作或该字段只告警；
> 代码围栏里的示例整段不参与；块数与分镜数对不上；**这一镜的口播/字幕/分镜标题都和 plan
> 对不上（镜号可能错位）**，或这一镜压根没有锚点字段；同一镜同字段写了多行或值疑似跨行；
> **要清空/换掉的那个值在本镜某个「本表不认识的字段名」上出现过**。
> 完整表格见 `docs/packaging-agent-step1-2026-09-18.md` §8.10.2 与 §8.10.5.3。
> 想整体关掉自动纠正：`VIDEOAUTO_SCRIPT_CARD_AUTOFIX=0`（只提示）。
>
> **所以 B2 有两种合格结果**：要么全部纠正到位，要么某几镜被上述闸门挡成「只告警」
> 并在日志里说明原因。**被挡住也算过**——把告警原文贴回来即可，
> **不要手改 shots.json 去凑数**。

---

## B3 · 故意不配 `MATERIAL_AGENT_PI_PROVIDER`，看告警只出现一次且成片照出

> **若已按 `51298013` 跑过，不用重跑**——`material_agent_select.py` 第二小轮**一行没动**，
> 直接贴上一轮结论即可。

**背景**：上一轮第一批 5 条整跑 agent 全降级，就是因为漏配了这个键——provider 取默认
`dashscope`，而运行包只带 `models.evst-gateway.json` → pi 报 `Unknown provider` →
每镜 0.21s 静默降级，成片照出、`render.log` 全绿，看不出来。

**做法**（用配置副本，别动生产 app.env）：

1. **(a) 不配**：app.env 副本里把 `MATERIAL_AGENT_PI_PROVIDER` 整行删掉，
   保留 `PACKAGING_AGENT_BACKEND=pi`，直调 `render_segment.py --template-packaging` 跑**一镜**
   （用一个**有** `card_content` 的分镜，否则按脚本模式会跳过、根本不调模型）。
2. **(b) 配上**：把 `MATERIAL_AGENT_PI_PROVIDER=evst-gateway` 加回去，同一镜再跑一次。

**通过标准**

- (a) stdout 里**恰好一行** `[agent] [!] pi provider 'dashscope' 未配置或不存在：…`，
  内容点明「会静默降级为确定性结果」并给出修法（日志一律 ASCII 符号，不用 `⚠`——
  gbk 编不出来，重定向到文件会把调用方打断）；**成片照出**、退出码 0、
  `packaging-agent-log.json` 的 `fallback_used=true`。**不阻断**。
- (b) 这一行**不再出现**，`fallback_used=false`。
- 顺带确认「只打一次」：跑一条**多镜**的整跑（同样不配 provider），那行在整条 run.log 里
  仍只出现一次（每进程一次；`render_segment.py` 是每镜一个进程的话，就是每镜一次——
  按实际进程模型报即可，别当成 bug）。
- **没有改降级行为**：(a) 的降级路径、耗时、日志字段与上一轮第一批完全一致。

---

## B4 · 两个装组件脚本 `--check` 重定向到文件不崩

> **若已按 `51298013` 跑过，不用重跑**——两个 `install_*.py` 第二小轮**一行没动**。

```powershell
python VideoAutoCut\tools\material_gen\pi\install_pi.py --check > pi-check.txt 2>&1
echo $LASTEXITCODE
python VideoAutoCut\tools\material_gen\hyperframes\install_hyperframes.py --check --runtime-root "<已装运行包>" > hf-check.txt 2>&1
echo $LASTEXITCODE
```

**通过标准**：两条都**退出 0**（组件装好的前提下），`pi-check.txt` / `hf-check.txt` 里
`✓` 正常显示（文件按 UTF-8 打开），**不再有 `UnicodeEncodeError: 'gbk'`**。
**输出文案一个字没改**，逐行内容应与不重定向时相同。
顺带确认不加 `PYTHONUTF8=1` 也过。

---

## B5 · 全量单测（**要重跑**，预期数变了）

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

**通过标准**：**369 + 131 = 500 项，0 failures / 0 errors**（Windows 口径）。

- 上一轮 Windows 全量是 **369**（Mac 是 370，多的那 1 个是 `test_qwen_cloud_embedder`
  的导入失败占位 `unittest.loader._FailedTest`，Windows 上该模块导入得了就没有）。
- 第一小轮 **+56**：`test_script_card_fields` **+40**（新文件）、
  `test_material_agent_select` **+14**（provider 告警 10 + 装脚本编码 4）、
  `test_packaging_agent` **+2**（提示词冻结闸门）。
- 第二小轮再 **+75**，全在 `test_script_card_fields`（该文件 40 → 115）：
  表格读取层 13、表头识别 19、分组 12、表格比对 11、其它格式 5、title 8、
  新路径日志 2、B7 三格式等价 3、日志编码安全 2。
- Mac 侧全量 **Ran 501**（370 + 131），四组合
  （`VIDEOAUTO_PACKAGING_SCRIPT_ONLY` × `PACKAGING_AGENT_SELECT`）一致、
  与 `d55c857` 基线失败清单逐条相同、零新增。
- 重点看这几条「不误改」的闸门：
  - `RealScriptRegressionTests.test_a_clean_parse_of_each_script_needs_no_correction`
    —— 解析器全对时 5 份脚本零纠正零告警、plan 逐字节不变；
  - `…test_a_merged_shot_plan_is_not_silently_realigned` —— 块数相等但镜号错位要被锚点挡住；
  - `TableHeaderTests.test_lookalike_column_names_are_never_matched_by_substring`
    与 `…test_a_generic_key_with_a_bracketed_qualifier_is_not_matched_either`
    —— 「视频标题 / 附属文案」这种限定语在括号**外**的、和「标题（16字无标点）/ 文案（上屏）/
    Title (video)」这种在括号**里**的，一个都不许被当成分镜字段（后者是对抗复审的阻断项）；
  - `…test_a_platform_title_column_cannot_rewrite_every_shot_title`
    与 `…test_an_on_screen_column_named_wencan_cannot_wipe_every_card`
    —— 对抗复审那两个「把对的改坏」的复现，现在必须零纠正、plan 逐字节不变；
  - `…test_the_cover_copy_block_does_not_steal_the_header_row`
    —— 封面块与真表头角色数打平时，表头要取靠后那行；
  - `…test_a_plain_table_without_card_columns_leaves_a_correct_plan_byte_identical`
    —— 没有上屏列的普通表格脚本，plan 逐字节不变；
  - `TitleTests.test_a_schema_fallback_title_is_not_treated_as_invented`
    —— 脚本没写标题时「分镜N」不许被当臆造清掉；
  - `EquivalentScriptTests` —— md / xlsx / txt 三种格式抽出的东西逐字相同；
  - `OutputTests.test_every_log_line_survives_a_gbk_stdout` 与
    `…test_text_the_author_wrote_is_sanitised_for_the_console_encoding`
    —— 日志本身、以及作者写的 emoji / `⚠`，都不许在 gbk stdout 上把这一层打崩；
  - `test_packaging_agent.PromptTests` —— 提示词 golden sha256 冻结；
  - `test_material_agent_select.PiProviderMissingWarningTests` —— provider 告警不许误报。

---

## B6 · 包装关闭态逐字节基线不变

> **若已按 `51298013` 跑过，不用重跑**——`render_segment.py` / `template_packaging.py` /
> `text_layout.py` / 桌面端第二小轮仍是**一行没动**，已跑过的 sha256 结论继续有效。

**做法**：取 9/18 那条任务 7 镜的 `render_segment` 原参数，
`VIDEOAUTO_TEMPLATE_PACKAGING=false`，用本轮代码直调一遍。

**通过标准**：7 镜成片 sha256 与上一轮 A1 记的**完全相同**，两边都没有 `packaging/` 目录。

> 这一条**几乎不可能变**：`git diff d55c857..HEAD --stat` 只有
> `VideoAutoCut/tools/script_card_fields.py`、`VideoAutoCut/tools/script_tabular.py`（新）、
> `VideoAutoCut/tools/normalize_script.py`（只挪了一行调用顺序）、`VideoAutoCut/tests/*`、
> `VideoAutoCut/.env.example`、`docs/*` 被动过。跑它是为了把「零影响」这条钉死。

---

## B7 · 表格脚本导入（**本轮新增，最关心的一条**）

**背景**：用户拍板「生产脚本主要是表格（xlsx）或 txt」。上一轮的校验只对纯文本生效，
表格一律零动作——等于最主要的那类脚本根本没被兜住。本轮用**标准库**
（`zipfile` + `xml.etree`，运行包是嵌入式 Python，**装不了也不许装 openpyxl**）加了表格路。

**做法**：把这两份**内容逐字等价**的脚本各导一次（`--plan-only --script-file …`）：

```
docs\packaging-test-scripts-2026-09-21\07_表格版_混合_show判定_食品码垛_CN.xlsx
docs\packaging-test-scripts-2026-09-21\07_纯文本版_混合_show判定_食品码垛_CN.txt
```

xlsx 那份刻意做成真实生产脚本的形状：**表头在第 5 行**（上面压着一块纵向的
「模块一：封面文案」），9 列 = 分镜 / 分镜标题 / 时长 / 章节标签 / 画面 / 口播 / 字幕 /
上屏文字 / 卡片样式。

**通过标准**

1. stdout 里有 `[script] 脚本字段校验` 开头的行，**不是**「跳过（不影响出片）」那种
   （那说明表头没认出来，要回报）。
2. 两份导出的 `shots.json`，**7 镜的 `card_content` / `card_hint` 与
   `03_混合_show判定_食品码垛_CN.md` 那份逐字相同**：
   - 1 = `来料到位是码垛稳定的第一道关`；5 = `占位卡 05`；
     7 = `带上你的包装形态和目标垛型，一起把这条线试一遍` + hint `CTA 行动号召`；
   - 2 / 3 / 4 / 6 的 `card_content` **应为没有这个键**（脚本写的是「（不填）」）。
3. **两份的 `cardFieldCorrections` 数组原样贴回来**，并说明与 `03` 那份的差异
   （理想是三份完全一致——Mac 侧单测 `EquivalentScriptTests` 就是钉这个的）。
4. **不越界**：`duration` / `voice_text` / `subtitle` / `module_label` 一个字没动。
5. 顺带回报 qwen-long **把表格读成什么样**：`shots.json` 的镜数是不是 7、
   `time_range` / `module_label` 有没有从「时长 / 章节标签」两列拿到值。
   这一条只是信息，不阻断——它决定下一步要不要在提示词里补表格的说明。

> **被闸门挡住也算过**：表头认不出来、镜数对不上、某一镜认不了人（口播/字幕/标题都对不上）
> 时这一层只告警不改，把告警原文贴回来即可，**不要手改 shots.json 去凑数**。

**日志长什么样**（Mac 侧拿「假装 qwen 犯了回帖 51296044 那几处错」的 plan 干跑出来的，
**xlsx 版与 txt 版逐字节相同**；真跑时 qwen 犯的错不一定是这几处，这里只是给个参照）：

```
[script] 脚本字段校验 [!] AI 解析结果与脚本原文有 4 处不一致（上屏内容与分镜标题一律以脚本为准），已按原文纠正 4 处：
[script] 脚本字段校验 [!] 分镜 1 card_content 丢失：解析得到 （空） -> 脚本原文 来料到位是码垛稳定的第一道关
[script] 脚本字段校验 [!] 分镜 4 title 改写：解析得到 落盘后核对方向与路径 -> 脚本原文 包装落到托盘以后还要核对排列方向垛层边缘和抓具退出的路径
[script] 脚本字段校验 [!] 分镜 5 card_hint 臆造：解析得到 placeholder card -> 脚本原文 （空）
[script] 脚本字段校验 [!] 分镜 6 title 改写：解析得到 整合视图看工位衔接 -> 脚本原文 开场
VACUT_EVENT:{"kind": "workflow", "workflowStage": "script", ..., "cardFieldCorrections": [...]}
```

`VACUT_EVENT` 的正文是**纯 ASCII**（中文走 `\uXXXX` 转义）——这样在任何控制台编码下
都不会崩，而且一个字都不丢。要看内容
`python -c "import json,sys;print(json.load(sys.stdin))"` 一下即可。

---

## B8 · `title` 校验（**本轮新增**）

**背景**：用户拍板把分镜标题也纳入同一套逐字校验。回帖 `51296044` 记过
03 第 4/6 镜的 title 被解析器改写：第 4 镜原文是与口播逐字重复的长句、第 6 镜原文是「开场」
（解析器给的是它自己的字幕「整合视图看工位衔接」）。

**做法**：就看 B2 / B7 导出的那几份 `shots.json`，不用额外跑。

**通过标准**

| 镜 | 脚本原文 title | 期望 `shots.json` 里的 title |
|---|---|---|
| 03-4 | `包装落到托盘以后还要核对排列方向垛层边缘和抓具退出的路径` | **逐字相同** |
| 03-6 | `开场` | **逐字相同** |
| 03-1/2/3/5/7 | 见脚本 | 逐字相同 |
| **02 / 04 的每一镜** | **脚本压根没写分镜标题** | 解析器自拟的或 schema 兜底的 `分镜N` —— **原样保留，不许被清空，也不该有告警** |

**要报**：
1. 三份 03（md / xlsx / txt）的 7 个 title，逐字贴回来；
2. `cardFieldCorrections` 里 `field=="title"` 的条目（应该有 03-4 / 03-6 两条 `rewritten`，
   若解析器这次自己就抽对了则一条都没有，也算过——把实际情况贴回来）；
3. 02 / 04 的 title 有没有被动过（**一个字都不该动**），以及有没有多余告警。

> **边界**（§8.10.5.4 的正本）：脚本原文**没写**标题时，plan 里那个自拟 / 兜底的标题
> **不算臆造、不清空、连告警都不打**。`module_label` **不纳入校验**。
> 只有标题能认人、而标题恰恰被改写时，认不了人 → 该镜只告警，标题不会被改。

---

## 五、回帖要报的东西

1. **B7（最关心）**：表格版 / 纯文本版两份的 `cardFieldCorrections` 原文 + 7 镜
   `card_content`/`card_hint` 是否与 03 的 md 版逐字相同 + qwen-long 把表格读成了几镜。
2. **B8**：三份 03 的 7 个 title 逐字贴回；`field=="title"` 的纠正条目；
   02/04 的 title 有没有被动过。
3. **B2 的三个数**：自动纠正事件列了哪些（原样贴 `cardFieldCorrections`）、
   纠正后逐字一致的镜数、`AUTOFIX=0` 时解析器原始出错数（与上一轮 10 处对比）。
4. **B5**：tests / failures / errors 三个数（四组合），预期 **500**。
5. **B1**：两个 sha256 一样没有（一行即可，不阻断）。
6. **B3 / B4 / B6**：已跑过就**不用重跑**，贴上一轮的结论即可；没跑过就按上面跑。

---

## 六、不在本轮范围

- **⑥ 上传 `runtime-trial/` 暂缓**，等用户通知。上一轮查到线上 `runtime/manifest.json` 的
  `latest` 是 **0.5.14** 不是 0.5.12——**是总开工单写错了**（0.5.14 是 9/17 上午同事教用户
  打包时发的，内容≈当时的 agent 改动前后），Windows「不符就停」的处理是对的。
  开工单第 4/6 步里凡是写 0.5.12 的地方都按 0.5.14 读。
- **pkg3 已过期，不要传**：`0.5.15-agent-trial-pkg3`（669,921,095 B / SHA256 `a8aa8fc0…`）
  是上一轮打的，之后 `tools/` 又改了。**B1–B8 全过之后再用新代码重打 pkg4**（命名顺延），
  **现在先不打**。
- **A4 的「第二个可能原因」（`context_text()` 过滤空字段）不修**，理由见 §8.10.5.8。
- **`.pdf` / `.doc` / `.xls` 仍是零动作**：标准库读不了，运行包里又装不了第三方解析库，
  不猜内容。真要覆盖得先定「运行包里加一个纯 Python 的 pdf 解析器」这件事，等用户定。
- **`visual_query` 不同步**：脚本没给画面描述时 `visual_query` 会退回 `title`
  （`normalize_script.py:269`、`shot_plan_schema.py:191`），此时纠正 `title` **不会**
  同步改它——改它会改变素材检索结果，超出「把作者原文还原回来」的范围。要不要同步，等用户定。
- 04 第 5 镜「节｜拍」的纯中文二字词切分、`verify.ps1` 的既有问题，仍是既有遗留，未碰。
