# 第四批 Windows 验收与试验运行包（2026-09-17）

**第四批功能清单通过，试验运行包已生成，本机保留经验证的 tools 部署。** 被测提交 `3d5f2e5`，对应 issue IKGH73 评论 `51244653`（16:36:57 +08:00）。按“全拒时占位继续”的新约定，7 镜全部出片；02/06/07 为明确记录的占位，不将它们当成内容完全匹配。

需要继续跟进的实际问题：02/06/07 独立方向调用返回顶层 list 而非对象，发生了 3 次显式降级；缓存与评审仍挡住横倒素材。第五镜固定池复测证明新增保护能挡住仍在发生的“横倒当俯视”模型错误。第五镜正式选择也仍未满足严格俯视需求，见下文画面质量限制。本轮没有为通过验收修改任何应用代码或 prompt。

## 执行环境和结果

- 分支 `feature/material-agent-select`；本轮只新增验收文档，保留原有两个 desktop package 文件的未提交版本改动。
- 使用 Windows 安装引擎与嵌入式 Python 3.11.9，后台走正式引擎入口 `--restart-all`，同一任务、同一原始 shots/素材绑定，仅更换 run_id。不是 GUI 按钮/任务历史事件验收。
- backend=`dashscope`，视觉和独立方向模型均 `qwen3.6-plus`，thinking=`off`；不是 Pi。匹配阈值实际 0.00，agent 普通接受分默认 60，fallback 默认 fill，候选上限 8、agent 比例 0.4。
- 主任务北京时间 16:42:27–16:50:12，耗时 465.001 秒，退出码 0；7 份 agent log 与 policy report 均 ok=true。
- Windows 指定三组测试：80 项，26.803 秒，OK；生产 app.env 前后哈希一致，原始 shots 与已部署四个源码文件的哈希检查通过。
- 成片 1920×1080、H.264/AAC、51.021333 秒、18,872,719 字节。完整 ffmpeg 解码退出 0、stderr 为空。

成片：
```text
D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\01_包装换型与码垛_CN最终视频\01_包装换型与码垛_CN_v004.mp4
```

本次 run：
```text
D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_3396f98fbffd4a188b81d6816470b11b
```

审计目录（本地文件，不随 Git 上传）：
```text
D:\autocut\video-auto-cut\VideoAutoCutDesktop\node_modules\.tmp\agent-acceptance-batch4-20260917-3d5f2e5
```

包含完整引擎输出、80 项测试结果、7 镜结构化证据、定向复测、抽帧、打包日志、包校验和部署记录。凭据只在内存使用，日志经过脱敏。

## 清单逐项

| 项目 | 结论 | 证据与覆盖范围 |
|---|---|---|
| 1. 7 镜完整出片 | 通过 | v004 出片并完整解码通过；02/06/07 占位继续。 |
| 2. 横倒拦截/缓存 | 通过，含补充复测 | 旧横倒 sheet 在主任务中出现 5 次，全为 rotated、0 分且未选；后 4 次命中缓存。正式 05 没有该候选，另用上轮 05 固定池实际调用模型，独立 rotated 覆盖评审 upright/overhead/85 分/pick=[5]，最终 0 分硬拒。 |
| 3. 第 6 镜占位 | 通过 | fallback_used=true；本轮候选 6 为 upright+none、50 分，reason 以【占位】开头，已进入成片；候选编号随池变化，不照搬上轮 4/7。 |
| 4. pick 空/缺失分数上限 | 通过，按 fill 例外核验 | 02/06/07 的 pick=[] 均触发全拒，再走显式占位；没有偷偷补为普通命中。21 个 missing≥3 候选全 ≤55，普通选择 0 个；其中 07 一个按明确占位使用，符合新“全拒继续”的约定。 |
| 5. 检索词 | 本轮清单通过 | 21 条改写，18 条实际搜索、3 条拒绝；05 的 connects 实际通过。没有编造数字尺寸；本轮未生成 top-down shot，已有精确反例测试验证其拒绝及 shot blasting 放行。 |
| 6. 分阶段计时 | 通过 | 7 镜含 orientation_seconds 六项齐全，report/log 一致；相同前 6 镜 judge 比上轮下降 13.92%，新增方向调用使 agent 总时长增长 13.63%。 |
| 7. Windows 测试 | 通过 | test_material_agent_select / test_material_selection_policy / test_python_boundaries 共 80 项 OK。 |

“missing≥3 未被选中”按**普通命中**解释；若也禁止显式占位，便与本轮“全拒时继续出片”的新要求冲突。07 的 45 分、4 条 missing 在日志和本文均清楚标为占位，没有宣称其满足内容要求。第 4 镜指定候选的名额边界按本轮 issue 明确要求不计入验收。

## 每镜选择与占位

| 镜 | engine/agent/both | 候选 | 调整分 | 方向/遮挡 | 选择性质 |
|---|---|---:|---:|---|---|
| 01 | 4/0/4 | 2 | 95 | upright/none | 普通选择 |
| 02 | 4/0/4 | 5 | 75 | upright/none | 【占位】 |
| 03 | 4/0/4 | 1 | 85 | upright/none | 普通选择 |
| 04 | 4/0/4 | 6 | 95 | upright/none | 普通选择 |
| 05 | 4/1/3 | 1 | 75 | upright/none | 普通选择 |
| 06 | 5/0/3 | 6 | 50 | upright/none | 【占位】 |
| 07 | 4/0/4 | 2 | 45 | upright/partial | 【占位】 |

**02 · 袋料与箱体处理差异**

```text
【占位】全部 8 个候选被拒，用候选 5 占位（调整后 75 分、方向 upright、遮挡 none），缺：没有箱体、无抓取动作对比
```

sheet：
```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_3396f98fbffd4a188b81d6816470b11b\clips\2531580122c261371ccc737cef943a107afdff9f4868cbaecbe875bb154b3c4c\59039c4fbd9009666a978c2e43d46be8ba430c5e6d156c2b09aa3543c7c1b1cb\02 · 袋料与箱体处理差异\_agent_frames\c05\sheet.jpg
```

**06 · 动态演示的局限性**

```text
【占位】全部 8 个候选被拒，用候选 6 占位（调整后 50 分、方向 upright、遮挡 none），缺：无动画演示画面、无破包滑移测试
```

sheet：
```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_3396f98fbffd4a188b81d6816470b11b\clips\8bad2b3dbce5bb9ef2f07c4144b23c99e48716b2c081cab55a0bc0ff487e7e05\71ea8d934c485bc7720f6a5aa2613db2bf5931911301a734018c1f79ea15a2ec\06 · 动态演示的局限性\_agent_frames\c06\sheet.jpg
```

**07 · 换型前准备工作**

```text
【占位】全部 8 个候选被拒，用候选 2 占位（调整后 45 分、方向 upright、遮挡 partial），缺：无工程师、无新包装样件、无目标垛型图纸、无现场布局图
```

sheet：
```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_3396f98fbffd4a188b81d6816470b11b\clips\9e63591d648bd84214e1f6163e6a23498457e86966d5463c4c27e81e1e76e58f\cb829e09b017d5ef53dc97985f38dfe2bc3c86b5d1efcc760a89dda229b17e03\07 · 换型前准备工作\_agent_frames\c02\sheet.jpg
```

06 候选 3 与 6 同为 upright/none/50 分；6 的 agent_hits=1、3 没有 agent 命中，因此按占位排序选 6。heavy 候选 1/2/4/7/8 为45分，横倒候选5为0分，均未被占位采用。07 没有 upright+none 候选，选择 upright+partial；这与06的 none 要求分开记录。

## 横倒固定池复测与降级记录

目标 sheet SHA256：`6dbc30c32fe8fc8af3d279748271a7020c06def3f3e80c416244d64d6d78a06f`；对应 clip SHA256：`9e103483feee18437435fc3a4f511acb6e5b99b31910747e1583e9be4bd9eba4`。缓存以 clip 哈希为键，不是 sheet 哈希。

| 主任务镜/候选 | 独立方向 | 评审方向 | 缓存命中 | 最终方向 |
|---|---|---|---|---|
| 01/5 | rotated | rotated | False | rotated |
| 02/7 | unsure | rotated | True | rotated |
| 04/1 | rotated | rotated | True | rotated |
| 06/5 | unsure | rotated | True | rotated |
| 07/1 | unsure | rotated | True | rotated |

正式第五镜因为改写/配额改变，没有旧横倒候选，不能以它没被选中直接证明新防线有效。因此另取 batch3 第五镜原来的8个候选 sheet 和原文案，调用**未经修改**的第四批 `check_orientation`、`judge_candidates`、`combine_orientation`、`deterministic_review`。没有改检索阈值、没有重写主任务结果、没有污染方向缓存；补充复测只读主任务缓存，未生成第二份成片。

补充复测关键原文：
```json
{
  "independent": {
    "orientation": "rotated",
    "evidence": "整幅画面旋转90度，地面位于画面左侧。"
  },
  "judge_target": {
    "candidate": 5,
    "score": 85,
    "acceptable": true,
    "orientation": "upright",
    "obstruction": "none",
    "camera_angle": "overhead",
    "visible": [
      "俯视视角",
      "绿色地面",
      "输送线与托盘",
      "码垛机器人"
    ],
    "missing": [
      "不是俯视，是平视侧面"
    ],
    "reason": "唯一符合口播要求的俯视（overhead）机位，清晰展示了输送线、托盘与机器人的空间衔接关系。"
  },
  "judge_pick": [
    5
  ],
  "final_orientation": "rotated",
  "adjusted_score": 0.0,
  "blocked": true,
  "reason": "画面整体旋转（orientation=rotated）（独立方向判断/缓存判 rotated，本次评审写 upright），确定性兜底判为不可用；模型分 85 不采信"
}
```

该次独立方向 11.187 秒、judge 27.203 秒；不计入主任务7镜耗时。即使不借助缓存，本次 independent=rotated 也足以覆盖 judge=upright。

**运行降级，未修复：** 02、06、07 各有一次同样的日志：
```text
独立方向判断失败，本镜只用评审与缓存的方向结论: Qwen 模型输出 顶层必须是 JSON 对象，实际为 list
```

这3镜没有独立方向结果，日志以 unsure 记录；方向缓存和该镜评审继续发挥作用。04/05 等成功调用与固定池复测不能抹掉此项。建议下一轮处理方向响应 schema 的稳定性；本轮保留原请求、原判断，未加重试或改变解析规则。主任务没有模型调用导致的中断。

成片已人工查看各镜中点（3.5/11/18/24.5/31.5/39/47秒），并增加第五镜28.5/34.5秒，共9张：抽查未见横倒；没有声称逐帧视觉验收。部分竖拍素材按16:9画布保留黑边，方向正常。

## 检索词与拒绝原文

下列只统计 agent 改写的21条，不包含7条引擎原词。

**01 · 码垛流程观察起点**

- 已搜索：`conveyor carries packaging toward robotic arm`
- 已搜索：`robotic arm extends toward packaging on conveyor`
- 已搜索：`overhead view of packaging moving on conveyor to robotic arm pickup position`

**02 · 袋料与箱体处理差异**

- 已搜索：`bagged items and boxed items moving side by side on feed line`
- 已搜索：`feed line carries bagged items and boxed items toward gripper station`
- 已搜索：`overhead view of feed line with bagged items next to boxed items`

**03 · 抓具运动安全检查**

- 已搜索：`robotic gripper lifts package and rotates while maintaining visible gap between package and surrounding tools`
- 已搜索：`package suspended by robotic gripper during rotation with clear space around all sides`
- 已搜索：`robotic gripper lifts and turns package without touching any nearby equipment or structure`

**04 · 落垛后质量确认**

- 已搜索：`package placed on pallet showing orientation alignment and edge of layer`
- 已搜索：`gripper withdrawing from package after placement on pallet`
- 已搜索：`package placement on pallet with aligned layer edges and consistent orientation`

**05 · 工位衔接可视化**

- 已搜索：`pickup station feeds material onto conveyor moving toward palletizer`
- 已搜索：`conveyor connects pickup station to palletizer in same overhead frame`
- 已拒绝：`overhead view of pickup station next to conveyor and palletizer`；没有任何动作词，是名词堆叠而不是「主体+动作+对象」的画面

**06 · 动态演示的局限性**

- 已搜索：`real pallet with packages sliding sideways on incline`
- 已拒绝：`packages spill from pallet during stability test`；含抽象概念或剪辑叙述词「test」，向量库里没有对应画面
- 已拒绝：`pallet stability test showing package slip and collapse`；含抽象概念或剪辑叙述词「test」，向量库里没有对应画面

**07 · 换型前准备工作**

- 已搜索：`engineer holding new packaging sample next to printed pallet pattern layout on table`
- 已搜索：`engineer points at factory floor plan while standing beside gripper adjustment station`
- 已搜索：`engineer reviews package samples and stack pattern before gripper adjustment`

已有单测 `test_any_shot_word_is_refused_but_shot_blasting_is_not` 包含精确的 top-down shot 反例；`test_plain_verbs_are_not_mistaken_for_noun_piles` 包含 connects；`test_sizes_the_script_never_states_are_refused` 包含5厘米/30cm/90度的未声明数值。三者均在此次80项内通过；未把单测伪装成现场模型实际生成过这些词。

## 分阶段耗时（秒）

| 镜 | rewrite | search | frames | probe | orientation | judge | elapsed | batch3 judge |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 01 | 2.351 | 7.854 | 2.160 | 0.217 | 11.448 | 21.723 | 45.79 | 24.573 |
| 02 | 2.781 | 7.652 | 2.169 | 0.219 | 9.234 | 25.534 | 47.63 | 29.534 |
| 03 | 3.982 | 7.625 | 2.068 | 0.220 | 9.657 | 28.430 | 52.02 | 28.321 |
| 04 | 2.734 | 9.750 | 2.201 | 0.226 | 11.950 | 23.563 | 50.46 | 27.800 |
| 05 | 2.695 | 6.381 | 2.187 | 0.222 | 9.836 | 23.868 | 45.23 | 31.248 |
| 06 | 3.387 | 2.732 | 2.224 | 0.226 | 11.383 | 24.640 | 44.63 | 30.170 |
| 07 | 3.307 | 8.050 | 2.333 | 0.226 | 9.367 | 25.726 | 49.06 | 未执行 |

01–06 同口径比较：judge 171.646→147.758 秒，下降13.92%；agent elapsed 251.48→285.76 秒，增长13.63%。新增方向步骤是额外工作，不能把 judge 下降说成总流程提速。7镜合计 orientation=72.875、judge=173.484、agent elapsed=334.82秒。前轮第7镜未执行，不对7镜总耗时作不等口径比较；此次补充复测不计入此表。

56个解析后 verdict 全部符合代码限制（reason≤60字，visible/missing各≤4条、每条≤20字）；本次 reason 最长40字，truncated=0，截断分支由已有超长响应单测覆盖。

## 画面质量限制与下一步

- 02缺箱体对照，06缺动画/稳定性试验，07缺工程师/新包装样件/垛型图/布局图，均为占位。report/日志可区分，占位字样没有烧录进成片。
- 05本次选了正常方向的侧面/斜拍画面；模型自己写“非要求的俯视”仍给75分、普通接受。这轮重点的横倒防线通过，但“关键机位不满足时能否普通接受”仍值得后续完善。
- 同一段红色机械臂白色瓶组片段重复用于01/04/05/06，说明目前出片连贯性/素材多样性还有限。未擅改选择算法以规避。
- 方向独立调用3/7降级需跟进；新防线有效不等于视觉模型本身已停止误判。

## 试验运行包与本机部署

沿用现有 TypeScript 发布构建、`cargo build --release --locked`、引擎 --help 参数检查和 `dist-scripts/pack-runtime.js`。首轮 shell 未包含 cargo 路径，改用已安装的 `C:\Users\evstm\.cargo\bin\cargo.exe` 后完成，没有重新安装或改全局环境。仅打运行包，未重打桌面端。

```text
D:\autocut\video-auto-cut\VideoAutoCutDesktop\runtime-release\VideoAutoCut-runtime-0.5.15-agent-trial-batch4.zip
```

- 版本：`0.5.15-agent-trial-batch4`
- 大小：633,365,651 字节
- SHA256：`0a768dfb6878e995bb9e2819ac84c364c3298b6e90b0beff8d292b22e7acc0e9`
- ZIP CRC：全部 18721 个条目通过；四个受测文件与源码逐字节一致；没有生产 .env/app.env/auth.json/device.json。
- 部署方式：使用已安装0.5.14运行目录中的四个第四批工具/提示词文件，已完成实际7镜引擎验证；包内这四个文件与本机文件一致。本机运行包标称目录仍0.5.14，属于试验覆盖部署，不伪称已切换正式版本号。
- 包内引擎与本机受测引擎哈希一致：True。生产配置未改，源文件备份在审计目录original中。
- 未上传线上运行包、未覆盖线上manifest、未合并master；生成的本地runtime-release/manifest.json仅用于本次试验包，上一版本地manifest已备份。
