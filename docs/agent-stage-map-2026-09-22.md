# VideoAutoCut Agent 判断环节现状（2026-09-22）

> 范围：只读 `1a5f5d0` 的源码与既有验收记录；本次没有运行软件、模型、Media 机或新 benchmark。下文把“历史实测”“估算”“待测”分开。Jev 的能力边界见 [TypeSafe AI Jev 适配调研](jev-fit-2026-09-22.md)；这里不假定它能看图，也不先声称可以替换现有模型。

## 现状地图

| 环节 | 输入模态 | 现有判断方式 / 模型 | Pi 实际作用 | 已有耗时证据 | 适合接快判模块的位置、验收与不可替代职责 |
|---|---|---|---|---|---|
| 脚本文件解析、缺失口播/字幕复核 | 原始 xlsx/docx/pdf 等文件 + 第一次结构化 plan | DashScope `qwen-long` 读整份上传文件；当 plan 缺 voice/subtitle 时再复核一次。解析后另有**本地确定性**原文校验，防止 title/card 被漏掉、翻译或编造。见 `VideoAutoCut/tools/normalize_script.py:301-341,356-389`、`VideoAutoCut/tools/script_card_fields.py:3-39` | 无 Pi 接口 | **待测**：只配置 600s 超时，未找到同口径真实耗时记录 | 可先用文本/结构化快判决定“是否需要第二次复核”，输出 `review_required/reason/confidence`；验收看漏复核率、误触发率、p50/p95、最终字段逐字一致率。不能替代原文件理解，也不能越过本地逐字校验；上屏文字和 title 必须以脚本原文为准。
| 搜索词改写 | 分镜 title、当前 query、画面要求、口播/字幕等**纯文本** | 直接调用 DashScope JSON 接口，默认 `qwen-plus`；桌面流水线在 OptimizeQueries 阶段调用。见 `VideoAutoCut/tools/optimize_queries.py:31-67,141-161`、`VideoAutoCutApp/src/main.rs:645-654,1168-1189` | 无 Pi 接口 | **Windows 历史实测（2026-09-17 batch4）**：2.351–3.982s/镜，约 3s/镜；不是本轮重测 | 适合单独测 Jev 做固定类型的 `keep/rewrite` 路由；判为 `rewrite` 后仍由原模型生成检索词，Jev 不承担文本生成。I/O：分镜文本→`keep/rewrite`。验收：路由准确率、漏改/误改率、经原模型改写后的真实素材 search hit/Recall@K、端到端 p95。不能替代搜索词生成、素材范围约束和检索本身。
| 素材搜索与候选池合并 | query、限定目录、向量分、来源等**文本/数值/元数据**；搜索本身依赖既有向量索引 | SentrySearch 向量搜索；agent query 与引擎候选合并后再交视觉评审。阶段计时已单列。见 `VideoAutoCut/tools/material_agent_select.py:1680-1736,1860-1875` | Pi 不执行搜索；仅可生成 query/评审结果 | **Windows 历史实测 batch4**：2.732–9.750s/镜。另有真实 Qwen 3素材×3镜两任务总计 23.672s/13.875s（含索引/查询等，不可拆成单环节）；74候选的 0.020/0.018s 查询是模拟 embedding 规模回归，不能当真实模型速度 | 可做纯结构化路由：根据分数间隔、候选来源、缓存命中判断“直接交既有规则 / 升级视觉 judge / 用占位”。输出固定枚举+候选序号。验收：相对强 judge 的升级召回率、错误直通率必须接近 0、视觉调用减少率、端到端 p95。不能替代向量索引、目录边界或内容身份缓存。
| 素材方向判断 | 每个候选的**真实视频抽帧拼图**；刻意不提供脚本文本 | 独立视觉调用判 `upright/rotated/unsure`，并与 metadata、任务内 SHA 缓存、主 judge 结论共同防横倒。见 `VideoAutoCut/tools/material_agent_select.py:1260-1285,1877-1937` | material backend 显式设 `pi` 时由 Pi 调模型；默认仍是 DashScope | **Windows 历史实测 batch4**：9.234–11.950s/镜，7镜合计 72.875s。后续仅 2 个 90° 横倒样本上，方向模型换 flash 后耗时 -36%、拦截 100%；样本不足以外推小角度。 | 这是单一视觉问题，适合先独立 A/B，但候选若不能看真实帧就只能做“是否升级视觉”的路由，不能直接给方向结论。I/O：拼图/帧→逐候选方向、置信度、证据。验收优先 rotated 召回率与误杀率，再看 p50/p95、缓存命中率；需补小角度/镜面/俯视。不能替代 metadata 探测、SHA 缓存和失败时的保守降级。
| 素材语义 judge / 排名 | 分镜语义 + 每候选的**真实帧拼图** + 向量分/来源 | 视觉模型逐候选输出完整 ranking、acceptable、可见/缺失证据、方向与分数；漏评会补要求重试一次，仍缺则不参与 pick。见 `VideoAutoCut/tools/material_agent_select.py:1204-1257,1939-1957` | material backend 显式设 `pi` 时由 Pi 承载调用；不是默认 | **Windows 历史实测 batch4**：21.723–28.430s/镜，7镜合计 173.484s；整个 agent 7镜 334.82s。Pi+flash 曾把整跑 379s 降到 240s，但出现 3 次画面编造和两镜漏评，不能用于 judge；plus 可用。包内 Pi 另有约 +2s/调用冷启动。 | 最大潜在收益是“便宜粗筛→强视觉 judge”：快判只删明显无关项或决定升级，不直接产最终画面事实。I/O：结构化候选摘要（若支持视觉再加帧）→keep/drop/upgrade+理由。验收：相对 plus 的 Recall@K、全部候选覆盖率、画面编造=0、横倒漏放=0、占位率、fallback率、端到端 p95。不能替代看帧后的语义/水印/logo判断和独立方向闸门。
| 包装版式选择 | 已确认的脚本 card 内容/提示、时长、画布、picture bounds，**纯文本+结构化几何** | 默认关闭；script-only 默认下，`show` 由脚本是否提供 `card_content` 决定：没有内容就不 import agent、不调用模型；有内容时才从 `title/parameters/cta` 三个固定模板中选择，失败回确定性模板。见 `VideoAutoCut/tools/packaging_agent.py:58-72,275-394`、`VideoAutoCut/tools/render_segment.py:412-460` | 支持显式 `PACKAGING_AGENT_BACKEND=pi`；默认 DashScope。Pi 通路已打通/验收过，但不是全局编排 | **估算**：模型决策约 3–8s/镜（纯文本 2–6s + Pi 冷启 1–2s）；默认预算 90s，最坏约预算+数秒。记录要求定义了中位数/P95，但未找到可引用的完整真实 7镜数值 | 很适合最先做最小分类 A/B：有 `card_content` 时输入上述字段→只输出 `title/parameters/cta` 三选一，代码再包装成现有 schema。验收：分类有效率、重复输入稳定性、与确定性版式一致/改变率、overflow/lint/成片自校验、p50/p95。Jev 不决定 `show`，不生成自由文本 reason，也不能生成或改写 card/title、替代确定性渲染、分页与成片校验。
| 字幕安全区 | 视频 10%/50%/90% 的**真实帧** + 画布几何 | 可选且默认关闭；`qwen3-vl-plus` 检测主体/脸/原文字框，本地算法在下半部选固定位置，失败回默认。见 `VideoAutoCut/tools/subtitle_safe_area.py:28-60,90-114,125-177`、`VideoAutoCut/tools/render_segment.py:573-584` | 无 Pi 接口 | **待测**：模型调用 timeout 180s；未找到同口径真实 p50/p95 | 可将“黑边足够/缓存命中/画面简单”做文本元数据路由；真正区域框仍需视觉。I/O：3帧→完整逐帧框或 uncertain。验收：框完整率、字幕碰撞率、误避让率、失败回默认率、p95。不能把采样结论说成逐帧保证，也不能替代本地几何边界。
| AI 动画素材生成 | 自然语言 brief；生成后源码/预览 | 直接 Qwen 规划引擎，Manim/Remotion/HyperFrames coding agent 最多默认3次生成/修复；HyperFrames 另做源码与 brief 一致性审核。见 `VideoAutoCut/tools/material_gen/generate_material.py:111-150,395-408,453-493,501-535` | 当前调用 `call_qwen`，不是 Pi backend；Pi 安装不等于已接此链 | **待测**：只找到尝试上限，无可比真实耗时 | 可先让快判做“引擎分类/是否需要强模型修复/审核升级”的结构化路由。验收：首次生成通过率、修复次数、渲染成功率、brief 覆盖率、总时长。不能替代代码安全校验、真实预渲染和最终内容审核。

## 接入顺序

1. **先测纯文本/结构化分类**：包装版式、搜索词是否需改写、候选是否需要升级视觉 judge。它们不要求候选具备视觉能力，失败可保守回现有路径。
2. **再测单一视觉任务**：这是面向一般未来视觉模型的方向判断 A/B，不代表 Jev 支持视觉。候选必须确认能读取真实帧；先覆盖 90°、小角度、俯视、镜面和正常画面，安全指标达标后才谈替换。
3. **最后测粗筛加速 judge**：先只做 `upgrade/keep` 路由并保留 plus 最终判定；稳定后再扩大职责。flash 的历史失败说明“更快”不能等同“可接管”。
4. **Pi 深入编排后置**：当前 Pi 只在选材和包装提供显式后端，安装包内可用但默认不启用；历史还有约 +2s/调用冷启动。应先证明每个独立决策点稳定、可回退，再让 Pi 组合这些步骤。

## 统一离线/在线验收口径

- 固定同一批真实脚本、真实视频候选和强模型日志作为 gold；每个模块先 shadow，只记录决策，不改变成片。
- 质量：覆盖率、误直通/误杀、视觉幻觉、漏评、fallback、输出 schema；安全类指标（横倒漏放、脚本文案改写）必须为 0。
- 性能：逐阶段 p50/p95、模型调用次数、冷启动、缓存命中、整镜和整任务 wall time；区分模型时间、抽帧、搜索、渲染。
- 稳定后按“只路由→粗筛→有限替换”放权，任何 uncertain/坏 JSON/超时都回现有确定性或强模型路径。

## 证据索引

- Windows batch4 分阶段实测：`docs/material-agent-select-batch4-validation-2026-09-17.md:202-214`
- Pi plus/flash 质量与速度、方向小样本：`docs/material-agent-select-trial-2026-09-17.md:724-743`
- Pi 默认关闭及包内冷启动：同文件 `:755-764,867-875`
- 包装能力、预算与估算：`docs/packaging-agent-step1-2026-09-18.md:20,56-80,188-201,243-254`
- 索引缓存真实/模拟证据：`docs/release-0.5.9.md:24-32`、`docs/analysis-cache-scale-74-validation-2026-09-15.md:17-27`
