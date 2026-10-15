# 第二批 agent 选材 Windows 验收（2026-09-17）

对应 Gitee issue `IKGH73` 最新评论 `51242322`，被测代码 `d0bb033`，分支 `feature/material-agent-select`。

**总结果：不通过，不打包发布。** 7 镜完整任务成功出片，第 5 镜横倒问题在这次选中素材和成片中未复现；但 4 镜仍没有 agent 来源候选进入评审池，6 镜 agent 阶段耗时增幅超过 30%，检索词和视觉判断仍有问题。

## 执行方式与边界

- fast-forward 到 `d0bb033`；备份后仅覆盖已安装运行时的 `tools/material_agent_select.py`、`tools/prompts/agent_query_rewrite.md`、`tools/prompts/agent_candidate_judge.md`，逐文件 SHA-256 与仓库一致。
- 后台调用已安装 `VideoAutoCutEngine.exe`，使用原任务的 `shots.json` 和原素材清单；清单只修改运行编号，`--restart-all` 全部重跑，不复用旧分镜产物。原 7 镜脚本文件哈希未变。
- 运行账号网关配置通过现有桌面代码读取并仅注入进程内存，环境合并遵循 `createVideoAutoEnv` 的顺序。实际后台是 `dashscope`，模型 `qwen3.6-plus`，thinking=off；本轮没有使用 Pi。
- 本轮验证的是已安装引擎和 Python 选材管线，GUI 启动按钮交互未在本轮重测。用户已在 GUI 保存的最低分 0，经实际引擎日志确认读到。
- 生产 `app.env` 本轮逐字节不变（SHA-256 `b9d6ecaf70da6bc559429efccbcc616356f82878cd79e97428c9e1a19b875cab`）。`PROGRESS_BAR=false` 是本轮开始前已有的用户设置；未修改任何生产配置。
- 没有自行修改 agent 判断逻辑或提示词，也未修改 Rust、桌面端或素材服务端。仓库原有两个 package 版本修改保留。本轮只增加验收文档；现场运行时保留验收用的三个覆盖文件。未重新制作、上传或发布运行包。

## 清单逐项结果

| 项 | 结果 | 证据 |
|---|---|---|
| 1 配置与实际阈值 | 通过 | `app.env:89` 为 `MATERIAL_MATCH_MIN_SCORE=0`；`A/engine-full.log:12` 实际输出 `匹配接受阈值: 0.00`。 |
| 2 更新运行时、原任务全 7 镜重跑 | 通过 | 三个文件哈希一致；新运行 `run_406990d9eb8a48c0b7842fa056ba3e72`，7 份新 `material-agent-log.json` / `material-policy-report.json` 均 ok=true；引擎退出码 0。 |
| 3 每镜 agent 候选至少 1 个 | 不通过 | 按 01–07 镜分别为 `2,0,1,0,1,0,0`。02/04/06/07 为 `engine:8 / agent:0`，每镜 9 个重搜结果全被去重丢弃。 |
| 4 第 5 镜和成片方向 | 通过（本次样本） | 第 5 镜选 agent 候选 #8，orientation=upright；7 镜选中项全为 upright，无 rotated 被选中。人工检查全部选中 contact sheet 和成片 30/31/32 秒，未见横倒；三张成片抽帧均为第 5 镜正常方向。 |
| 5 分数分布、visible/missing 结构约束 | 通过（形式项） | 7 镜选中分数 `95,76,95,95,95,45,45`。56/56 条 ranking 都有 visible/missing 数组；52 条 missing 非空，其分数全部 <=89。视觉事实准确性另见下文：形式通过不代表判断内容正确。 |
| 6 四条检索词都具象、无抽象行业词 | 不通过（人工检查） | 第 6 镜第 4 条仍是 `box spillage slip simulation pallet stability test real world failure`，为概念/关键词串，未说明明确主体实施的具体动作；第 1 条也仍是动画与失败测试的抽象对比。第 5 镜第 4 条额外编造 `metal parts`，脚本未指定金属件。全部 28 条原文见附录。 |
| 7 每镜 agent 耗时增幅 <=30% | 不通过 | 仅第 2 镜通过，其他 6 镜增幅 36.63%–72.83%，逐镜数据如下。 |
| 8 Windows 三组单元测试 | 通过 | 已安装运行时自带 Python 3.11.9 执行三组测试：`Ran 51 tests in 10.482s / OK`，退出码 0；完整输出 `A/unittest.log`。系统 Python 亦通过 51 项。 |

## 逐镜数据

这里的耗时是 `material-agent-log.json.elapsed_seconds`，含改写、重搜、抽帧和模型评审，不是单次模型请求延迟。上轮基线逐镜取自既有 `video-verification.json`。

| 镜 | engine/agent | 去重丢弃 | 选中来源/候选 | 模型分 | 上轮秒 | 本轮秒 | 增幅 | 耗时项 |
|---|---|---|---|---|---|---|---|---|
| 01 | 6/2 | 7 | engine #2 | 95 | 28.63 | 45.90 | +60.32% | 不通过 |
| 02 | 8/0 | 9 | engine #8 | 76 | 39.18 | 47.85 | +22.13% | 通过 |
| 03 | 7/1 | 8 | agent #8 | 95 | 29.27 | 43.88 | +49.91% | 不通过 |
| 04 | 8/0 | 9 | engine #2 | 95 | 32.19 | 43.98 | +36.63% | 不通过 |
| 05 | 7/1 | 8 | agent #8 | 95 | 27.72 | 40.45 | +45.92% | 不通过 |
| 06 | 8/0 | 9 | engine #1 | 45 | 26.90 | 46.49 | +72.83% | 不通过 |
| 07 | 8/0 | 9 | engine #1 | 45 | 27.81 | 41.12 | +47.86% | 不通过 |

7 镜 agent 阶段合计本轮 309.67 秒，上轮 211.70 秒。完整任务北京时间 15:06:21.884–15:13:59.848，457.964 秒。此次从头重跑，包含重新生成口播；完整任务耗时与上轮续跑的 268 秒不作为严格同条件性能对照。

实跑日志含 55 条 `[agent]` 行，无 HTTPError、HTTP 4xx/5xx、timed out 或 JSON 中断重试记录。单元测试日志里的两条 JSON 重试消息来自 mock 测试，不是这次真实任务发生的错误。

### ffprobe 补测

运行结束后，对实际 56 个候选逐个重复一次代码所用的旋转探测命令（每镜 8 次），按 01–07 镜合计耗时：

`0.2606s, 0.2565s, 0.2330s, 0.2269s, 0.2273s, 0.2281s, 0.2246s`。

这属于运行后暖缓存独立测量，不是实跑内部打点。该样本中每镜新增探测约 0.225–0.261 秒，不能据此把实跑增加的十几秒归因于 ffprobe。改写、重搜、图片处理和模型请求的单独耗时未核实；本轮没有为了测速修改程序。56 个候选的 metadata_rotation 均为 null。

## 不通过项的现象、复现与根因

### A. 去重先于名额分配，重搜命中仍可能被丢掉

复现：原任务、同一绑定素材清单、最低分 0、agent 开启、默认 reserve_ratio=0.4，`--restart-all`。检查 02/04/06/07 的 `candidate_pool` 和 `duplicates`：均 found engine=10 / agent=0、最终 8/0、duplicates_dropped=9。

将每条 duplicate 的 key 对回原始 `material-policy-request.json.paths`：这四镜的 9/9 条都命中了已加入的引擎候选。原因不是重搜未执行；每镜 3 条新检索均 hits=3。引擎先入 seen 集合，重搜遇到相同源/时间范围就直接 return，来源和重搜优先级丢失；merge_candidates 看到 agent 空集，再截引擎前 8 名。

更具体的丢失：第 2 镜重搜两次命中引擎第 10 名，第 4 镜一次命中引擎第 9 名；这两类候选既被当作重复丢弃，又因最终只留前 8 名而未进入评审池。`A/dedupe-audit.json` 保存逐镜对应位置。建议由 Claude 调整去重与合并顺序或保留重复命中的多来源/优先级；本轮未修改算法。

### B. 结构约束满足，视觉理由仍超出证据

已逐张查看 7 镜选中 sheet，并将下列模型原文与画面对照。以下 sheet 原路径和 JSON 可供继续修复。

#### 第 03 镜

画面前景为覆盖主体的大面积安全网栏。模型却写“无遮挡”、missing=[]、95 分，与实际帧以及提示词对 90 分档的要求不符；几帧也不足以证明全程无干涉。

选中 sheet：

```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_406990d9eb8a48c0b7842fa056ba3e72\clips\6f89c5004fed93dc4b7eeffc497af1004ce6c9b9dd7b43e4e9e4ed60a2c731cd\00c9dd4585f48a8532bf37e42315c6120d694c135be32ba66f12a448ff1c61dd\03 · 抓具运动安全检查\_agent_frames\c08\sheet.jpg
```

模型选中项原文：

```json
{
  "candidate": 8,
  "score": 95,
  "acceptable": true,
  "orientation": "upright",
  "visible": [
    "橙色六轴机械臂",
    "银色金属抓具（夹具）",
    "整层白色塑料瓶包装（带蓝色标签）",
    "抓具夹持包装处于悬空状态",
    "包装与抓具外廓清晰可见",
    "背景有红白警示带和围栏"
  ],
  "missing": [],
  "reason": "画面完美对应口播要求。清晰展示了抓具夹持整层包装（带料）抬起的动作，且处于悬空/转向过程中。视角良好，能清楚看到包装四角与抓具本体及周边的间隙，符合'检查完整外廓'和'无干涉'的视觉需求。无遮挡，无烧录字幕。"
}
```

#### 第 05 镜

本次画面方向已正常，但画面接近侧面/平视，可见人和机械臂的侧面、立柱与墙面。模型仍将其描述为所需的 overhead view，并给 missing=[]、95 分；不能仅因方向正常就视为俯视需求已满足。

选中 sheet：

```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_406990d9eb8a48c0b7842fa056ba3e72\clips\01a85a09a2d3e0989f1102eca47b6d25af48804331b7990be9a9c2dc84584bad\a8ebc30e503b7eca2ca06a4105ff7158bf1e4493334d66978f2aa9e86ba35b84\05 · 工位衔接可视化\_agent_frames\c08\sheet.jpg
```

模型选中项原文：

```json
{
  "candidate": 8,
  "score": 95,
  "acceptable": true,
  "orientation": "upright",
  "visible": [
    "俯视/高角度视角（overhead view）",
    "左侧可见输送线（conveyor）及上面的白色袋料",
    "右侧可见码垛工位，有蓝色托盘和堆叠的白色袋料",
    "中间有一台被灰色防尘罩包裹的机械臂（robotic arm/palletizer）",
    "画面清晰展示了取料端、输送线和托盘位置的空间衔接关系",
    "无烧录字幕或水印"
  ],
  "missing": [],
  "reason": "完全符合分镜要求。提供了口播所需的'overhead view'（俯视/高位视角），且在同一画面中清晰呈现了'pickup station'（输送线上的物料）、'conveyor'（输送线本身）和'palletizer'（码垛位及托盘）的位置关系，完美对应'工位衔接可视化'的主题。"
}
```

#### 第 07 镜

模型正确列出缺少样件、垛型图、布局图和对应动作，却以 45 分、acceptable=true 选中，并明确说“内容不对”“勉强可用”。与提示词“不符合时不要勉强选”存在直接矛盾。第 6 镜也以 45 分选中普通实拍码垛，缺少动画/实际失败测试对照；两镜仍属内容质量待修。

选中 sheet：

```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_406990d9eb8a48c0b7842fa056ba3e72\clips\9e63591d648bd84214e1f6163e6a23498457e86966d5463c4c27e81e1e76e58f\cb829e09b017d5ef53dc97985f38dfe2bc3c86b5d1efcc760a89dda229b17e03\07 · 换型前准备工作\_agent_frames\c01\sheet.jpg
```

模型选中项原文：

```json
{
  "candidate": 1,
  "score": 45,
  "acceptable": true,
  "orientation": "upright",
  "visible": [
    "橙色六轴机械臂在网栏内",
    "蓝色托盘上码放整齐的白色塑料瓶（工件）",
    "穿蓝色工服的人员在背景处站立或操作设备",
    "金属安全网栏"
  ],
  "missing": [
    "没有工程师手持新包装样件的特写",
    "没有目标垛型图纸或布局图（Factory floor plan）",
    "看不出人员正在确认抓具与路径调整项（动作不符，仅为常规生产场景）"
  ],
  "reason": "画面展示了正常的码垛生产场景，有工人和成品，但完全缺失分镜要求的‘换型前准备’关键视觉要素（样件、图纸、布局图）。属于同类工序但内容不对，仅作为勉强可用的环境空镜。"
}
```

### C. 检索词仍有抽象化/新增对象

第 6 镜第 4 条原文及第 5 镜第 4 条原文见下附录。当前日志中的第一条是 engine 原 `visual_query`，另外三条才是 agent 改写；因此“四条都符合新改写要求”不能单凭修改 agent prompt 保证。第 2 镜改写还出现“画面切至”这类剪辑叙述。问题按原文反馈，未自行修改提示词。

## 成片与证据位置

- 成片：`\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\01_包装换型与码垛_CN最终视频\01_包装换型与码垛_CN_v003.mp4`
- 大小 28926821 bytes；时长 51.021333 秒；1920×1080 H.264 + AAC；全片 FFmpeg 解码退出 0，stderr 为空。
- 成片方向抽帧：`A/final-30s.jpg`、`A/final-31s.jpg`、`A/final-32s.jpg`，已逐张人工查看。
- 当前已安装运行时目录仍名为 `0.5.14`，其中三个选材文件是本次覆盖版本；旧的 `0.5.15-agent-trial` zip 没有被重新制作或发布，不能把旧包当作本轮代码。

`A`（本机完整证据目录）：

```text
D:\autocut\video-auto-cut\VideoAutoCutDesktop\node_modules\.tmp\agent-acceptance-batch2-20260917-d0bb033
```

`R`（本次完整运行目录）：

```text
D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_406990d9eb8a48c0b7842fa056ba3e72
```

A 内包含 `state.json`、`invocation.json`（命令与非敏感有效设置）、`engine-full.log`、`agent-lines.txt`（原始行号）、`engine-result.json`、`selection-audit.json`、`completion-verification.json`、`dedupe-audit.json`、`ffprobe-timing.json`、`unittest.log`、`original/` 三个旧运行时文件备份和选中 sheet 副本。账号密钥未写入这些验收脚本或报告。

各镜报告相对 R 的路径如下，旁边同目录为 `material-policy-report.json` 与 `material-policy-request.json`：

- 01 · 码垛流程观察起点: `clips\f46078f0efc246389caa6c81ea506ab3cd83e80182f48f2187017c9e7cc3019e\6cd44660ee7ac4a7a799d60b29e43f471c15662f8b95c5530e6e6ecdc078ca33\01 · 码垛流程观察起点\material-agent-log.json`
- 02 · 袋料与箱体处理差异: `clips\2531580122c261371ccc737cef943a107afdff9f4868cbaecbe875bb154b3c4c\59039c4fbd9009666a978c2e43d46be8ba430c5e6d156c2b09aa3543c7c1b1cb\02 · 袋料与箱体处理差异\material-agent-log.json`
- 03 · 抓具运动安全检查: `clips\6f89c5004fed93dc4b7eeffc497af1004ce6c9b9dd7b43e4e9e4ed60a2c731cd\00c9dd4585f48a8532bf37e42315c6120d694c135be32ba66f12a448ff1c61dd\03 · 抓具运动安全检查\material-agent-log.json`
- 04 · 落垛后质量确认: `clips\5ff58cca9e98d131e65b97cea9730c6bada01b359be5f38ae3b22b58b19d78d6\8427847768e534c39f401a7e925f29931e3b22fa800e70904446b3cd9aacf260\04 · 落垛后质量确认\material-agent-log.json`
- 05 · 工位衔接可视化: `clips\01a85a09a2d3e0989f1102eca47b6d25af48804331b7990be9a9c2dc84584bad\a8ebc30e503b7eca2ca06a4105ff7158bf1e4493334d66978f2aa9e86ba35b84\05 · 工位衔接可视化\material-agent-log.json`
- 06 · 动态演示的局限性: `clips\8bad2b3dbce5bb9ef2f07c4144b23c99e48716b2c081cab55a0bc0ff487e7e05\71ea8d934c485bc7720f6a5aa2613db2bf5931911301a734018c1f79ea15a2ec\06 · 动态演示的局限性\material-agent-log.json`
- 07 · 换型前准备工作: `clips\9e63591d648bd84214e1f6163e6a23498457e86966d5463c4c27e81e1e76e58f\cb829e09b017d5ef53dc97985f38dfe2bc3c86b5d1efcc760a89dda229b17e03\07 · 换型前准备工作\material-agent-log.json`

三个运行时文件与仓库一致的 SHA-256：

| 文件 | SHA-256 |
|---|---|
| `tools/material_agent_select.py` | `3a5185938a39df44c6993cc3fadec5e0257df48eed8c6df594dbc2d0f6f649fb` |
| `tools/prompts/agent_query_rewrite.md` | `7302909a03b5993bcefb9d15746a968f5e868abf71d459d6403f4b5c70d69402` |
| `tools/prompts/agent_candidate_judge.md` | `f4f1291469a41e5544d045361ec59c6954ddc2ccb09fc745de3b48090cbb2e1c` |

## 附录：28 条真实检索词

### 01 · 码垛流程观察起点

1. [engine; hits=10] packaging arriving on conveyor, robotic arm preparing to pick
2. [visible_scene; hits=3] 蓝色塑料托盘上堆叠的纸箱沿滚筒输送线移动，机械臂末端带吸盘缓慢下降对准最上层纸箱
3. [process_action; hits=3] 包装箱到达输送线末端停止，机械臂从待机位伸出，吸盘压向纸箱顶部，箱体轻微下陷
4. [english; hits=3] conveyor stops with cartons stacked on pallet, robot arm extends and suction cup contacts top carton

### 02 · 袋料与箱体处理差异

1. [engine; hits=10] comparison of bagged and boxed items on feed line with different gripper settings
2. [visible_scene; hits=3] 机械臂用不同夹具分别抓取长条形编织袋和硬纸箱，袋子悬垂晃动，纸箱四角被吸盘固定
3. [process_action; hits=3] 操作员调整机器人示教器上袋料/箱体两组参数，画面切至传送带上袋料歪斜、箱体端正的对比
4. [english; hits=3] bag gripper vs box gripper on same packaging line: one with soft jaw gripping flexible bag, one with vacuum pads on rigid cardboard box

### 03 · 抓具运动安全检查

1. [engine; hits=10] robotic gripper lifting and rotating a package while maintaining full clearance
2. [visible_scene; hits=3] robotic gripper lifts cardboard box while rotating 90 degrees, no contact between box edges and gripper fingers or nearby metal frame
3. [visible_scene; hits=3] 抓具夹持纸箱向上抬起并水平旋转，纸箱四角与抓具本体及周边支架全程保持可见间隙
4. [english; hits=3] gripper with cardboard package lifting and turning, clear air gap visible around entire package perimeter

### 04 · 落垛后质量确认

1. [engine; hits=10] package being placed on pallet with attention to orientation, layer edge, and gripper withdrawal trajectory
2. [visible_scene; hits=3] 纸箱被机械臂吸盘放置在托盘上，箱体长边与托盘边缘平行，顶部层边缘齐整，吸盘缓慢垂直上移脱离纸箱
3. [english; hits=3] robot places carton on pallet, aligns long edge to pallet edge, checks top layer alignment, then retracts gripper vertically
4. [process_action; hits=3] 机械臂吸盘抓取纸箱放到托盘上，调整位置使箱体方向一致，确认垛层外沿平直，随后吸盘向上撤出不碰箱角

### 05 · 工位衔接可视化

1. [engine; hits=10] overhead view showing coordinated positions of pickup station, conveyor, and palletizer
2. [visible_scene; hits=3] overhead view of robotic arm picking up material at pickup station, conveyor belt moving toward palletizer, empty pallet on palletizer base
3. [process_action; hits=3] robot picks part from pickup station, places on conveyor, conveyor carries part to palletizer where pallet is being built
4. [english; hits=3] aerial shot pickup station conveyor palletizer alignment metal parts moving between stations

### 06 · 动态演示的局限性

1. [engine; hits=10] animated simulation of palletizing process contrasted with real-world failure tests
2. [visible_scene; hits=3] slow motion video of cardboard box falling from pallet stack, corner crushed, contents spilling out
3. [process_action; hits=3] pallet loaded with boxes tilting on conveyor, top layer sliding sideways, one box slipping off edge
4. [english; hits=3] box spillage slip simulation pallet stability test real world failure

### 07 · 换型前准备工作

1. [engine; hits=10] engineer reviewing new package samples, desired stack pattern, and factory floor plan before adjusting gripper
2. [visible_scene; hits=3] engineer holding rectangular cardboard package sample, pointing at printed pallet stacking diagram on clipboard, next to factory floor layout poster with robot path arrows
3. [process_action; hits=3] engineer comparing physical packaging sample with paper diagram of stack pattern while standing beside wall-mounted plant layout showing robotic arm reach zones
4. [english; hits=3] engineer reviewing package sample pallet pattern layout setup
