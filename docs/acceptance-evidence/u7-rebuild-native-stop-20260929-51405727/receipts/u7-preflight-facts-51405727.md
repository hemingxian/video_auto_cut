# 51405727 U7 导入前只读事实与计数方案

本收据不启动 GUI、引擎、导入或模型，也不修改生产逻辑。冻结作者 oracle 见 `u7-author-oracle-51405727.json/.md`。

## 七镜作者 oracle

直接只读 `docs/packaging-test-scripts-2026-09-21/07_表格版_混合_show判定_食品码垛_CN.xlsx`，SHA-256 `32928ce140c3d8b25ad0b5ac482896b3698417f7de8401920c9129c3b030697e`。标题依次为：

1. 来料到位是第一道关
2. 袋料和箱体要分开核对
3. 镜头B
4. 包装落到托盘以后还要核对排列方向垛层边缘和抓具退出的路径
5. 换型准备
6. 开场
7. 欢迎带着包装形态来试

上屏文字和卡片样式保留 raw，并只按既有 `script_card_fields.script_value` 合同派生期望：剥离不上屏的版式标签，`（不填）` 等占位为空，其它文字与布局逐字保留；不做标点、大小写或其它归一化。

## stdout “分镜数: 6”来源

- `VideoAutoCutApp/src/cli.rs:47-48` 把未显式传入的 `--shots` CLI 参数默认设为6。
- `VideoAutoCutApp/src/main.rs:389-400` 在读取脚本文档之前打印启动表头；`:395` 打印的是 `cli.shots`，所以显示6。
- 随后 `main.rs:402-409` 才调用 `read_plan_from_script_ai`；实际计划不由该默认值截断。`normalize_script.py:465-468` 写出 plan 后打印 `len(plan['shots'])`，本输入应为7；`main.rs:426-429` 保存的是解析后的 `initial_plan`。
- 因而表头6是解析前遗留 CLI 默认显示，实际7必须由 normalize 的最终计数、最终 `shots.json` 长度和 UI 7镜共同证明，不能只用任一名义数字替代。

## 可复用的旧 U7 审计 helper

旧目录 `VideoAutoCutDesktop/node_modules/.tmp/ui-u7-51391241-prep-1c307c3` 的思路可复用，但其 HEAD、Candidate、engine SHA、路径和固定哈希全部过期，不能原样执行：

- `electron-stdout-tap.cjs`：只 tee Electron 收到的原 stdout/stderr/VACUT_EVENT 字节，不改变 ChildProcess stream。
- `verify-u7-preimport.ps1`：核 current runtime、Candidate engine/input/observer SHA、一次 `--help` 零导入 preflight、模型默认值和导入前计数0。
- `verify-u7-capture.ps1`：要求 help+唯一 import 两个 child，保存原字节/hash，核冻结输入/非模板路径、7镜作者字段、retry 原行与调用 ledger。
- `prepare-u7-phase.ps1` / `start-u7-phase.ps1`：隔离准备与隐藏启动骨架。

新 helper 必须重新锁定311d5e5构建物、实际 Candidate 和本轮 observer/helper SHA；不能把旧 `be8efb22...` 当本轮 engine。

## 每次上传、模型与重试的计数边界

源码链：`normalize_script.py:425-436` 依次上传并主解析；`:441-449` 只在 plan 完全缺 voice 或完全缺 subtitle 时口播字幕复核；`:461-463` 原文纠正后进入章节标签；`progress_labels.py:65-90` 对 pending 最多复核2轮。模型标签与默认分别见 `normalize_script.py:333-385`。上传和所有 chat completion 都经 `common.py:256-285`，默认最多5次，只有瞬态失败才输出带 label 的 retry 行。

导入后 ledger 应分开报告：

1. GUI import click：固定核1次；manual retry核0次。
2. 文件上传：逻辑操作1；HTTP attempts = 1 + `Qwen 文件上传` retry原行数（成功完成时）。不计作模型调用。
3. 主解析：逻辑 Qwen stage 1；HTTP attempts = 1 + `Qwen 脚本文件解析` retry原行数；默认模型 `qwen-long`，但仍须核实际隔离配置白名单。
4. 口播字幕复核：以 `AI 复核口播字幕` start/completion 实际marker为0或1；attempts = logical stage + 对应 retry原行数；模型继承 script model，除非隔离配置明确覆盖。
5. 章节标签复核：没有成功 start marker。只能由实际 plan 对 `progress_label_choices` 的 pending/语言谓词逐镜重放推导0；若 pending 非0，则源码最多2轮，但仅凭最终 stdout不能可靠区分1轮还是2轮成功调用。遇到该情况必须标为“源码推导范围/无法直接观测”，不能虚报精确HTTP；若 retry行存在可给出至少尝试数及各原行。
6. 所有自动重试：按四个精确 label 分组保存原行 ordinal、原字节/hash；不要把“一个GUI导入”写成“一次HTTP”，也不要把逻辑模型stage数写成底层HTTP尝试数。

旧 `verify-u7-capture.ps1:114-147,217-239` 已实现上述marker/retry拆分及证据限度，可移植到新本轮审计副本。若用户要求“每一次”超过stdout可证明范围，最安全做法是如实写 evidence class；不应为追求精确计数而插桩生产 `call_qwen`、代理请求或改变默认重试。

