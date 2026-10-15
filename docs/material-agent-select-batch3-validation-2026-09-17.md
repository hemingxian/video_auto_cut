# 第三批 Windows 验收：6fb56f1（2026-09-17）

结论：**未全部通过，不打包发布。** `both` 合并、遮挡/最低分拦截及全拒停止已生效；第 5 镜仍把横倒 90° 画面当成正常俯视选中，第 4 镜指定候选仍未入池，改写词还有编造对象和剪辑叙述。模型还出现“关键内容缺失但 acceptable=true”的矛盾。

同一任务 `01_包装换型与码垛_CN` 执行 `--restart-all`，在第 6 镜全拒后正常触发阻断，退出码 1，未生成新成片。**第 6 镜停止本身是 issue 明确允许的预期行为，不计为验收失败。** 第 7 镜未执行，不补造该镜结论，也未降低门槛继续出片。

## 执行范围与环境

- 对应 issue IKGH73 的最新验收要求：评论 `51243448`（2026-09-17 15:46:36 +08:00）。分支 `feature/material-agent-select`，被测源码 `6fb56f1`。
- 时间：2026-09-17 15:56:50–16:03:09（北京时间），引擎总耗时 378.724 秒；01–06 的 agent 阶段合计 251.48 秒。此次未覆盖第 7 镜、合成与最终成片检查。
- 使用已安装的 Windows 引擎和嵌入式 Python 3.11.9，从后台调用正式引擎入口；不是 GUI 点击验收。原 shots 和素材 manifest 保持一致，仅 manifest.run_id 更换为本次新 run_id。
- 运行时只覆盖 `tools/material_agent_select.py` 和两个 prompt，安装文件 SHA256 与被测源码一致，原文件已备份。没有改模型判定、提示词、Rust、桌面端或素材服务程序。
- `MATERIAL_AGENT_SELECT=1`、backend=`dashscope`、视觉模型=`qwen3.6-plus`、thinking=`off`；本次不是 Pi 验收。agent 候选比例默认 0.4，最低接受分默认 60。
- 用户 GUI 保存的 `MATERIAL_MATCH_MIN_SCORE=0` 实际生效，日志为“匹配接受阈值: 0.00”；它与 agent 最低接受分 60 是两套不同门槛。
- 生产 app.env 未修改，前后 SHA256 均为 `b9d6ecaf70da6bc559429efccbcc616356f82878cd79e97428c9e1a19b875cab`。账号网关凭据仅在内存使用，日志已做密钥脱敏。
- 本轮只提交验收文档；保留桌面端 package.json/package-lock.json 原有版本改动，未纳入提交。没有新 runtime 包；已安装 0.5.14 目录当前是本次三文件覆盖的验收状态。

本机 run：
```text
D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_22caa72631214939903393fb824c4051
```

本机完整审计（未上传 Git）：
```text
D:\autocut\video-auto-cut\VideoAutoCutDesktop\node_modules\.tmp\agent-acceptance-batch3-20260917-6fb56f1
```

含 `engine-full.log`、`engine-result.json`、`unittest.log`、`selection-audit.json`、原始文件备份、短路径 sheet 副本及复现启动脚本。下文原始 agent log/report/sheet 均保留在 run 目录。

## 验收逐项结论

| 项 | 结论 | 证据/限制 |
|---|---|---|
| 1. both/agent 入池 | 部分通过 | 01–06 都有 both/agent，达到至少 6/7 的数量要求；02 原第 10 名成功入池；04 原第 9 名合并为 both 后仍被名额截掉，未满足该指定样本要求。07 未执行。 |
| 2. 遮挡 | 本次样本通过 | 48 个评审中 heavy 23 个，全部调整后 ≤50 且被拦；partial 10 个全部 ≤75。抽帧中密集前景网栏类均记录非 none，没有 heavy 入选。 |
| 3. 机位/方向 | 不通过 | 05 候选 5 明显横倒 90°，却 upright/overhead、85 分入选；同一张 sheet 在其他镜被判 rotated。非俯视候选的 missing 机位提示虽已出现，仍不足以兜住此例。 |
| 4. 最低分与全拒 | 通过 | 全部 35 个调整后 <60 的候选被拦；前 5 镜选中分为 95/85/85/65/85。06 全拒、paths=[]、fallback=null、ok=false，8 条 missing 及 fallback_suggestion 完整；任务停止符合预期。 |
| 5. 改写词 | 不通过且覆盖不全 | 实际生成 18 条，15 条被搜索，3 条 rejected；07 的 3 条未生成。仍有 paper boxes/吸盘等文案外对象，以及 top-down shot 和名词串漏过过滤。 |
| 6. 耗时 | 分阶段记录通过；提速未证实 | 六镜 timings 全部完整。judge 实测合计 171.646 秒，上轮相同六镜估算 171.622 秒，基本持平；28/48 条 reason 仍超过 40 字。 |
| 7. Windows 测试 | 通过 | 指定三组共 65 项，21.029 秒，OK，退出码 0。 |

## 1. 候选池与去重合并

| 镜 | engine | agent | both | merged 命中 | 最终选择 |
|---|---:|---:|---:|---:|---|
| 01 | 4 | 0 | 4 | 9 | 候选 1 / engine / 95 |
| 02 | 4 | 1 | 3 | 8 | 候选 7 / both / 85 |
| 03 | 4 | 1 | 3 | 8 | 候选 1 / engine / 85 |
| 04 | 4 | 0 | 4 | 9 | 候选 8 / both / 65 |
| 05 | 5 | 0 | 3 | 6 | 候选 5 / engine / 85 |
| 06 | 5 | 0 | 3 | 3 | 全拒 |
| 07 | — | — | — | — | 前镜停止，未执行 |

02：上轮引擎第 10 名 `match_006_bound_006_asset_cefb3f4b89804025af2fe79e37b784e9_v1_02m05s-02m18s.mp4` 本次成为候选 5、`origin=both`、`agent_hits=3`，进入评审池后被 heavy 拦截。合并命中没有丢失。

04：上轮引擎第 9 名 `match_005_bound_005_asset_9194697b483a419aac4438ec042c204f_v1_00m00s-00m30s.mp4` 本次在 `_agent_q03` 第 3 位命中一次；`merged_into.origin=both`，但 `merged_into.candidate=null`，不在最终 8 个候选中。其余 4 个 both 的 hits/rank 分别为 3/2、2/1、2/1、1/1；目标为 1/3，按当前排序排第 5，agent 侧只有 4 个名额。因此不是旧的“去重直接丢弃”问题，而是排序/配额下仍不能保证这个指定样本入池；本次改写词与上轮不同，不能假称它仍被命中两次。

## 2. 关键视觉反例与模型矛盾

**05 候选 5：横倒被当俯视。** 已直接查看 sheet：地面在画面左侧，设备、立柱与人物随整幅画面横倒，绝非正上方俯视。ffprobe 没有 rotation 元数据，像素本身横倒，当前确定性规则仍信任模型的 upright。

sheet：
```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_22caa72631214939903393fb824c4051\clips\01a85a09a2d3e0989f1102eca47b6d25af48804331b7990be9a9c2dc84584bad\a8ebc30e503b7eca2ca06a4105ff7158bf1e4493334d66978f2aa9e86ba35b84\05 · 工位衔接可视化\_agent_frames\c05\sheet.jpg
```

模型原文：
```json
{
  "candidate": 5,
  "score": 85,
  "acceptable": true,
  "orientation": "upright",
  "obstruction": "none",
  "camera_angle": "overhead",
  "visible": [
    "绿色地面俯视视角",
    "橙色机械臂与输送线",
    "粉色箱料与蓝色托盘",
    "工位布局清晰可见"
  ],
  "missing": [
    "不是白色桶装工件"
  ],
  "reason": "唯一符合口播要求的俯视（overhead）机位，清晰展示了取料、输送和码垛的衔接关系，无遮挡。虽工件颜色不同，但结构逻辑完全匹配。"
}
```

上述 sheet 在 01/c08、02/c03、04/c01、05/c05、06/c06 的 SHA256 完全一致：`6dbc30c32fe8fc8af3d279748271a7020c06def3f3e80c416244d64d6d78a06f`。其中 01/02/04/06 判 rotated 并拦截，05 却判 upright 并入选。这支持“相同图片在不同文案上下文中判断不一致”，不能仅凭本轮其他镜能拒绝横倒就认定方向已修复。

**02 候选 7：关键主体/对照均缺失仍被选。** sheet 是红色机械臂与白色瓶组，确实没有袋料与箱体对比。

sheet：
```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_22caa72631214939903393fb824c4051\clips\2531580122c261371ccc737cef943a107afdff9f4868cbaecbe875bb154b3c4c\59039c4fbd9009666a978c2e43d46be8ba430c5e6d156c2b09aa3543c7c1b1cb\02 · 袋料与箱体处理差异\_agent_frames\c07\sheet.jpg
```

模型原文：
```json
{
  "candidate": 7,
  "score": 85,
  "acceptable": true,
  "orientation": "upright",
  "obstruction": "none",
  "camera_angle": "high",
  "visible": [
    "红色机械臂抓取白色瓶组",
    "前景红色托盘上的瓶组",
    "背景蓝色输送线上的瓶组",
    "无网栏遮挡主体"
  ],
  "missing": [
    "没有袋料（只有瓶装）",
    "没有箱体",
    "未展示不同工件对比"
  ],
  "reason": "画面清晰展示了机械臂对特定工件（瓶装）的抓取动作和支撑位置，虽缺失口播要求的'袋料与箱体'对比，但作为单一工件的处理演示，视觉要素完整且无遮挡。"
}
```

该镜 `judge.pick=[]`，但 ranking 中此候选仍 acceptable=true。程序在 pick 后补入按分数排序的 ranking，再按 acceptable 与 review 选择，因此实际 picked=[7]。这不是 <60 门槛失效，而是模型自相矛盾与 pick 空数组当前语义的组合；建议 Claude 明确“pick 为空”是否应硬拒绝，不在本轮擅改。

04 候选 8 也写 `missing=["未见明显抓具退出动作","非严格俯视视角"]`，却 acceptable=true、65 分选为“落垛后状态的空镜”。03 候选 5 的 reason 原文含“文案隐含的袋料（结合其他候选推断）”，其 missing 有“设备颜色不符”，但该镜文案没有指定袋料或设备颜色；05 又凭空列出“不是白色桶装工件”。说明模型仍会从其他候选引入要求。

遮挡检查中，明显密集网栏覆盖主体的素材已经被挡住；同一红色机械臂/背景网栏素材在不同镜仍出现 none/partial 差异，遮挡字段不是完全稳定。上面通过项仅说明本次规定的网栏样本及确定性分数限制通过，不外推为模型总能识别遮挡。

## 3. 第 6 镜全拒：预期停止与备用建议

log：
```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_22caa72631214939903393fb824c4051\clips\8bad2b3dbce5bb9ef2f07c4144b23c99e48716b2c081cab55a0bc0ff487e7e05\71ea8d934c485bc7720f6a5aa2613db2bf5931911301a734018c1f79ea15a2ec\06 · 动态演示的局限性\material-agent-log.json
```

模型缺失项与调整分（均未采用）：

| 候选 | 原分→调整分 | obstruction | errors 中的 missing |
|---|---:|---|---|
| 1 | 25→25 | heavy | 无动画演示画面、无破包/滑移测试、网栏严重遮挡主体、非俯视机位 |
| 2 | 25→25 | heavy | 无动画演示画面、无破包/滑移测试、网栏严重遮挡主体、非俯视机位 |
| 3 | 25→25 | heavy | 无动画演示画面、无破包/滑移测试、网栏严重遮挡主体、非俯视机位 |
| 4 | 25→25 | none | 无动画演示画面、无破包/滑移测试、非俯视机位、无稳定性对比 |
| 5 | 20→20 | partial | 无动画演示画面、无破包/滑移测试、警示带遮挡视线、非俯视机位 |
| 6 | 10→0 | none | 画面整体旋转90度、无动画演示画面、无破包/滑移测试、工件颜色不符 |
| 7 | 25→25 | none | 无动画演示画面、无破包/滑移测试、非俯视机位、无稳定性对比 |
| 8 | 20→20 | partial | 无动画演示画面、无破包/滑移测试、警示带遮挡视线、非俯视机位 |

`fallback_suggestion` 原文（只建议，不自动放行）：
```json
{
  "candidate": 1,
  "path": "\\\\?\\D:\\Video Edit\\VideoAutoCut\\workspace\\video\\runs\\20260917\\01_包装换型与码垛_CN\\.videoautocut\\runs\\run_22caa72631214939903393fb824c4051\\clips\\8bad2b3dbce5bb9ef2f07c4144b23c99e48716b2c081cab55a0bc0ff487e7e05\\71ea8d934c485bc7720f6a5aa2613db2bf5931911301a734018c1f79ea15a2ec\\06 · 动态演示的局限性\\match_002_bound_002_asset_bf69621a458943a49bd1b72529d9b4e8_v1_00m50s-01m00s.mp4",
  "origin": "engine",
  "model_score": 25.0,
  "adjusted_score": 25.0,
  "orientation": "upright",
  "obstruction": "heavy",
  "camera_angle": "eye_level",
  "missing": [
    "无动画演示画面",
    "无破包/滑移测试",
    "网栏严重遮挡主体",
    "非俯视机位"
  ],
  "block_kind": "obstruction",
  "reason": "主体被大面积遮挡（obstruction=heavy），分数上限 50（25→25）且判为不可用",
  "note": "全部候选被否决，任务在这一镜停下；这是被拒候选里调整后分数最高的一条，供人工决定是否放行或换素材"
}
```

供 Claude 判断：候选 1、2、3、4、7 同为调整后 25 分，当前 `max(...adjusted_score)` 取首先出现的候选 1，因此建议的是 heavy，而同分候选 4、7 为 none。建议本身没有触发放行；不过若用于人工参考，平分时的遮挡优先级值得再评估。八张 sheet 已逐一对应到本次实际候选；均为普通车间码垛，未见动画/破包/滑移试验。

停止镜 8 个候选 sheet 完整路径（均为公司机本地文件）：

候选 1：`match_002_bound_002_asset_bf69621a458943a49bd1b72529d9b4e8_v1_00m50s-01m00s.mp4`
```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_22caa72631214939903393fb824c4051\clips\8bad2b3dbce5bb9ef2f07c4144b23c99e48716b2c081cab55a0bc0ff487e7e05\71ea8d934c485bc7720f6a5aa2613db2bf5931911301a734018c1f79ea15a2ec\06 · 动态演示的局限性\_agent_frames\c01\sheet.jpg
```

候选 2：`match_002_bound_002_asset_bf69621a458943a49bd1b72529d9b4e8_v1_00m00s-00m30s.mp4`
```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_22caa72631214939903393fb824c4051\clips\8bad2b3dbce5bb9ef2f07c4144b23c99e48716b2c081cab55a0bc0ff487e7e05\71ea8d934c485bc7720f6a5aa2613db2bf5931911301a734018c1f79ea15a2ec\06 · 动态演示的局限性\_agent_frames\c02\sheet.jpg
```

候选 3：`match_002_bound_002_asset_bf69621a458943a49bd1b72529d9b4e8_v1_00m25s-00m55s.mp4`
```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_22caa72631214939903393fb824c4051\clips\8bad2b3dbce5bb9ef2f07c4144b23c99e48716b2c081cab55a0bc0ff487e7e05\71ea8d934c485bc7720f6a5aa2613db2bf5931911301a734018c1f79ea15a2ec\06 · 动态演示的局限性\_agent_frames\c03\sheet.jpg
```

候选 4：`match_005_bound_005_asset_9194697b483a419aac4438ec042c204f_v1_00m00s-00m30s.mp4`
```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_22caa72631214939903393fb824c4051\clips\8bad2b3dbce5bb9ef2f07c4144b23c99e48716b2c081cab55a0bc0ff487e7e05\71ea8d934c485bc7720f6a5aa2613db2bf5931911301a734018c1f79ea15a2ec\06 · 动态演示的局限性\_agent_frames\c04\sheet.jpg
```

候选 5：`match_006_bound_006_asset_cefb3f4b89804025af2fe79e37b784e9_v1_01m15s-01m45s.mp4`
```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_22caa72631214939903393fb824c4051\clips\8bad2b3dbce5bb9ef2f07c4144b23c99e48716b2c081cab55a0bc0ff487e7e05\71ea8d934c485bc7720f6a5aa2613db2bf5931911301a734018c1f79ea15a2ec\06 · 动态演示的局限性\_agent_frames\c05\sheet.jpg
```

候选 6：`match_003_bound_003_asset_118d0186208247498acc520eafcdb532_v1_00m25s-00m51s.mp4`
```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_22caa72631214939903393fb824c4051\clips\8bad2b3dbce5bb9ef2f07c4144b23c99e48716b2c081cab55a0bc0ff487e7e05\71ea8d934c485bc7720f6a5aa2613db2bf5931911301a734018c1f79ea15a2ec\06 · 动态演示的局限性\_agent_frames\c06\sheet.jpg
```

候选 7：`match_005_bound_005_asset_9194697b483a419aac4438ec042c204f_v1_00m50s-01m07s.mp4`
```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_22caa72631214939903393fb824c4051\clips\8bad2b3dbce5bb9ef2f07c4144b23c99e48716b2c081cab55a0bc0ff487e7e05\71ea8d934c485bc7720f6a5aa2613db2bf5931911301a734018c1f79ea15a2ec\06 · 动态演示的局限性\_agent_frames\c07\sheet.jpg
```

候选 8：`match_006_bound_006_asset_cefb3f4b89804025af2fe79e37b784e9_v1_02m05s-02m18s.mp4`
```text
\\?\D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_22caa72631214939903393fb824c4051\clips\8bad2b3dbce5bb9ef2f07c4144b23c99e48716b2c081cab55a0bc0ff487e7e05\71ea8d934c485bc7720f6a5aa2613db2bf5931911301a734018c1f79ea15a2ec\06 · 动态演示的局限性\_agent_frames\c08\sheet.jpg
```

前 5 镜的选取/渲染中间结果不应当作正式可用成片。最终目录仍只有历史 v001/v002/v003，本次没有 v004；没有为了覆盖第 7 镜绕过第 6 镜。

## 4. 改写词全量与过滤情况

仅统计 agent 改写；6 条引擎原词不计入以下 18 条。07 未执行，不能报告“21 条全部通过”。

**01 · 码垛流程观察起点**

- 已搜索：`包装箱沿传送带移动至机械臂下方，箱体前端对齐抓取位`
- 已搜索：`机械臂末端吸盘下降靠近包装箱顶面，箱面轻微变形`
- 已搜索：`conveyor moves packaging box to robot arm pickup position`

**02 · 袋料与箱体处理差异**

- 已搜索：`机械臂用宽软吸盘吸附袋料顶部，袋体随移动轻微晃动`
- 已搜索：`机械臂用四角夹爪夹住纸箱上沿，箱体平稳无变形`
- 已搜索：`bag top suction with soft wide pad causing gentle sway during transport`

**03 · 抓具运动安全检查**

- 已搜索：`robotic gripper lifts package upward while rotating 90 degrees, no contact between package edges and gripper frame`
- 已搜索：`package suspended by gripper, visible gap all around between package outline and gripper structure during rotation`
- 已搜索：`gripper frame clearance package outline rotating lift`

**04 · 落垛后质量确认**

- 已搜索：`机械臂吸盘松开纸箱顶面，纸箱静止落在托盘上，箱体长边与托盘长边平行`
- 已搜索：`纸箱四角对齐托盘边缘，最上层箱体顶部齐平，吸盘已离开箱面5厘米`
- 已搜索：`paper box placed on pallet with long edge parallel to pallet edge, suction cup retracting vertically upward`

**05 · 工位衔接可视化**

- 已搜索：`overhead view pickup station conveyor palletizer aligned in single frame`
- 已搜索：`top-down shot showing pickup station next to conveyor belt and palletizer in same field of view`
- 已拒绝：`conveyor belt connects pickup station to palletizer with all three visible from above`；原因：没有任何动作词，是名词堆叠而不是「主体+动作+对象」的画面

**06 · 动态演示的局限性**

- 已搜索：`palletizer places paper boxes on pallet, then pallet tilts and top boxes slip sideways`
- 已拒绝：`paper box slides off pallet during vibration test, contents spill onto floor`；原因：含抽象概念或剪辑叙述词「test」，向量库里没有对应画面
- 已拒绝：`box spillage slip simulation pallet stability test`；原因：含抽象概念或剪辑叙述词「simulation」，向量库里没有对应画面

不通过的具体点：

- 05 的 `top-down shot showing ...` 含剪辑叙述，未被过滤；`overhead view ... aligned in single frame` 也描述机位/构图而不是主体操作对象。03 的 `gripper frame clearance package outline rotating lift` 仍是关键词堆叠；带 rotating/lift 即过动作词检测，并不保证完整短句。
- 02 文案有袋料/箱体，但未指定“宽软吸盘”“四角夹爪”“纸箱”；04 只写包装、托盘、抓具，却生成纸箱/吸盘及“5厘米”；06 也未指定 paper boxes。这些仍是文案外的具体物体、材质或尺寸设定。
- 过滤正确拦了 06 的 test/simulation 两条，但 05 的 `conveyor belt connects pickup station to palletizer ...` 明明有 connects，仍被判“没有任何动作词”。当前词表过滤同时存在漏判和误拒，不能将 rejected 非空直接等同于检索质量通过。

## 5. 分阶段耗时（秒）

| 镜 | rewrite | search | frames | probe | judge | elapsed | batch2 judge 估算 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 01 | 2.598 | 8.111 | 2.256 | 0.227 | 24.573 | 37.77 | 30.294 |
| 02 | 3.704 | 7.814 | 2.085 | 0.217 | 29.534 | 43.36 | 29.588 |
| 03 | 4.910 | 7.665 | 2.295 | 0.228 | 28.321 | 43.42 | 28.247 |
| 04 | 5.128 | 8.422 | 2.277 | 0.225 | 27.800 | 43.86 | 28.075 |
| 05 | 3.621 | 5.558 | 2.196 | 0.227 | 31.248 | 42.85 | 25.811 |
| 06 | 3.615 | 3.996 | 2.206 | 0.228 | 30.170 | 40.22 | 29.607 |
| 07 | — | — | — | — | — | — | 未纳入比较 |

batch2 没有分阶段计时。上表估算方法：该镜原始 `material-agent-log.json` 修改时间减去最后一张候选 sheet 修改时间，包含后续少量整理/写日志开销；不是精确 API 延迟，也不是可证明因果的同请求基准。

相同 01–06 六镜 judge：本次 171.646 秒（平均 28.608），上轮估算 171.622 秒（平均 28.604），基本持平；01 下降、05 上升，不能声称整体提速。agent elapsed 合计由 268.55 降至 251.48 秒（约 -6.36%），其中本轮 05/06 少搜索了 3 条被过滤的词，候选组成也变了，不能全部归功于输出限长。

48 个模型评审的 visible/missing 均符合数组≤4条、每条≤15字；但 28 个 reason 超过40字，最长72字，提示词的限长并未完全执行。日志 timings 五项与 report.agent.timings 一致；不再使用旧的总耗时 +30% 硬门槛。

## 6. Windows 测试与交付状态

```text
tests.test_material_agent_select
tests.test_material_selection_policy
tests.test_python_boundaries

Ran 65 tests in 21.029s
OK
exit_code=0
```

调用安装包内嵌入式 Python 3.11.9，按既有入口补充源码 sys.path 后运行。原始 stdout/stderr 在审计目录 unittest.log；本次验收没有修改任何测试或应用代码。

未重新打包、未上传 runtime、未覆盖线上清单、未合并 master。保留全部现场日志与 sheet。下一步应由 Claude 依据 05 的同图异判、02 的 acceptable/pick 矛盾、04 的配额边界和检索词反例修复后再验收。
