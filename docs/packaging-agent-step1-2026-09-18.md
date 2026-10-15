# 模板包装 agent 第一步（选版式）· 交接说明 2026-09-18

分支 `feature/material-agent-select`，基于 `ba6553e`。**默认关闭**：不动 app.env 的话，agent 一行代码都不会跑。

⚠️ **「与接入前逐字节一致」这句现在要分两种说**（`ebeed78` 修了 §9.0 那个 0.5.9 的老 bug 之后）：

- **单页 composition**：与 `ba6553e` **逐字节相同**，成片 sha256 也相同（Mac 与 Windows 都实测过）。
- **分页 composition**：**不相同**，多出每页一行 `tl.set("#page-i",{opacity:0},end)` 的硬收尾。
  这是修老 bug 的**必要变更**——不加这几行，分页的上屏文字在 `hyperframes lint` 直接被拦，
  `render_segment` 退出 1，整条任务挂（0.5.9 起一直如此）。对照口径因此是
  「剥掉新增的 `tl.set` 行后与 `ba6553e` 逐字节相同」。

也就是说：**开关关闭 ≠ 这个分支对成片零影响**。关闭的只是 agent 决策；分页包装的渲染产物
必然与 `ba6553e` 不同（而 `ba6553e` 那份根本渲不出来）。

## 1. 这一步做了什么

模板包装（`VIDEOAUTO_TEMPLATE_PACKAGING=true`）原来用正则从 `card_hint` 猜版式
（`template_packaging.py::packaging_content`）。现在多一条可选路径：
`PACKAGING_AGENT_SELECT=1` 时，每个分镜调一次模型，从 **title / parameters / cta 三个固定版式**
里挑一个，并判断这一镜要不要上包装。

**模型不产出、也不改写任何文字。** 返回 schema 里根本没有文字字段；上屏文字永远是
`packaging_content()` 从 `card_content`（没有就退回 `title`）原样取的那份。

插入点是 `render_segment.py` 内部，**引擎（Rust）、桌面端、打包脚本一行没改**。
`final_video.rs:191` 那个唯一耦合点（脚本路径 + argparse 契约）保持原样。

## 2. 文件清单

新增：

| 路径 | 作用 |
|---|---|
| `VideoAutoCut/tools/packaging_agent.py` | 开关/配置、prompt 组装、返回校验、run 级缓存、决策日志 |
| `VideoAutoCut/tools/prompts/agent_packaging_plan.md` | 系统提示词 |
| `VideoAutoCut/tests/test_packaging_agent.py` | 24 项单测（含与 `ba6553e` 那版 `template_packaging.py` 的逐字节真对照），模型全用假 `ask`，不联网 |
| `VideoAutoCut/tests/test_render_segment_packaging.py` | 10 项接线测试：降级触发条件、不该触发时不触发、原始诊断不被顶掉、关闭态零副作用 |
| `VideoAutoCut/tools/material_gen/hyperframes/install_hyperframes.py` | 打包前现装 HyperFrames 渲染器 + 四件套自检 |
| `VideoAutoCut/tools/material_gen/hyperframes/.gitignore` | node_modules 不入库的说明（仓库根已排除，这里写清口径） |
| `docs/packaging-agent-step1-2026-09-18.md` | 本文 |

改动：

| 路径 | 改法 |
|---|---|
| `tools/template_packaging.py` | `packaging_content` / `build_composition` / `render_overlay` 三个签名尾部各加一个可选 `plan`；`plan=None` 时代码路径与原来完全一致。manifest 多一个 `template_source` 字段 |
| `tools/render_segment.py` | 包装分支接 agent + 两层降级；成片自校验补音轨与时长；两行 `VACUT_EVENT` 进度 |
| `VideoAutoCut/.env.example` | 5 个新键，全部注释掉 |
| `tools/material_gen/pi/.gitignore`、`pi/install_pi.py` | 把「node_modules 是否入库待定」改成定论（见 §6），只改注释 |

## 3. env 键

| 键 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `PACKAGING_AGENT_SELECT` | 0/1 | `0` | 总开关。只在 `VIDEOAUTO_TEMPLATE_PACKAGING=true` 时才有意义 |
| `PACKAGING_AGENT_BACKEND` | `pi` / `dashscope` | `dashscope` | 与 `MATERIAL_AGENT_BACKEND` 同款收紧逻辑：没显式配 pi 一律 dashscope |
| `PACKAGING_AGENT_TIMEOUT` | 秒 | `90`（收在 30–600） | **本镜决策的整体预算**，不是单次调用超时，见 §3.1 |
| `PACKAGING_AGENT_MODEL` | 模型名 | 空 | 只覆盖这一步的模型，两个后端各自读的模型键都会被临时盖上，用完还原 |
| `PACKAGING_AGENT_CACHE` | 0/1 | `1` | 决策缓存，同一份文案重渲不换版式 |

### 3.1 超时语义：整体预算，不是单次调用

`PACKAGING_AGENT_TIMEOUT` 是**这一镜 agent 决策的总耗时上限**。两个后端在一次 `ask` 里
各自还会内部重试（`ask_pi` 正常一次 + 顶层数组补一次 = 2；`ask_dashscope` 的
`for attempt in range(3)` = 3，本模块不改 `material_agent_select.py`），所以
`plan_for_shot` 把剩余预算按内部次数摊开再传下去：

- 单次调用超时 = **调用时刻 deadline 还剩多少就给多少**，下限 10s（低于 10s 直接判预算用尽、
  走确定性版式）。
  ~~早先按内部重试次数摊（90s → 单次 45s）~~ —— 2026-09-18 Windows #4b 实测推翻：超时这条路径
  根本不会重试（`ask_pi` 的第二次尝试只在返回**顶层数组**时才触发），30s 的预算实际只用掉 14s；
  反过来，正常但慢的调用（thinking 打开）会在预算没用完时被提前杀。内部那次重试只可能发生在
  第一次**成功且快速**返回之后，所以把整份剩余交给这一次调用，实际总耗时仍贴着预算。
  要给内部重试单独算一份更小的超时，得改 `material_agent_select.ask_pi` 的签名（禁区），
  所以只做记录：真出现「慢响应 + 顶层数组重试」时最坏会到预算两倍，日志 `budget.overran` 标出来。
- dashscope 链路另外用 contextmanager 把 `VIDEOAUTO_HTTP_RETRIES` 临时压到 `1`
  （默认 5 次且带指数退避，最长一次要等 30s，一次网络抖动就能拖爆预算），调用结束还原。
  没有改 `call_qwen` 或 `common.py` 的签名。
- 因此**单镜 agent 最坏耗时 ≈ TIMEOUT + 几秒**（进程启动与 JSON 解析的零头）。
  预算与实际份额都写进决策日志的 `budget` 字段。

**pi 的传输配置不另起一套**，继续读选材那批：`MATERIAL_AGENT_PI_PROVIDER` / `_PI_MODEL` /
`_PI_TEXT_MODEL` / `_PI_THINKING` / `_PI_EXE` / `_NODE_EXE` / `_PI_API_KEY*`。一台机器一套 pi 配置，
`.cmd` 参数截断那条修法也自动继承。

⚠️ **app.env 要就地改键，不能往文件末尾追加**：`common.load_dotenv` 是 `os.environ.setdefault`，
同名键第一次出现的那行生效（9/17 已经踩过一次）。

## 4. 降级路径（三层）

| 故障 | 处理 | 成片 |
|---|---|---|
| 开关没开 | 连 `packaging_agent` 模块都不 import | agent 相关行为与接入前一致；成片 sha256 相同（单页 composition 已实测。分页 composition 多了硬收尾行，见文首的两种说法） |
| 找不到 pi/node、超时、返回非 JSON、顶层数组、`template` 不在枚举、`show` 不是 bool | `plan_for_shot` 返回 `None`，日志记 `fallback_used:true` + 原因 | 确定性正则版式，正常出片 |
| agent 版式渲 overlay 失败（分页太密、超长词、组件缺失） | 用确定性版式重渲 overlay 一次，并把 plan 清成 `None`；日志记 `overlay_fallback` | 保住 |
| 成片**画面**校验不过（尺寸/SAR），且这一镜真用了 agent 版式（`plan` 非 None 且 `overlay` 非 None） | 用确定性版式重渲整镜一次；日志记 `final_check_retry`；仍不过才抛（与接入前同）。回退时 `render_overlay` 再失败，会把原始诊断和新错误拼在一起抛，不顶掉原因 | 尽力保住 |
| 成片**音轨**校验不过 | 只有 `plan` 非 None（agent 真参与本镜）才硬失败；已降级到确定性版式的镜子降为软告警记 `final_check_warning`，不改变接入前「只硬失败画面尺寸」的行为。换 overlay 修不了音轨，所以不重渲 | 不因 agent 变差 |
| agent 判 `show=false`（`overlay` 为 `None`） | 校验失败时**不触发**第二层降级——回退不许凭空给这一镜加包装 | 与判定一致 |

另外两条确定性护栏：

- **作者写了 `card_content` 的分镜不许关包装**：模型填 `show=false` 会被强制改回 `true`，
  日志记 `overridden:"author_card_content"`。
- **决策缓存**按 `sha256(六个文案字段 + TEMPLATE_VERSION)`，落
  `{run}/final_clips/packaging/_agent_cache/packaging.json`，跨分镜共享、上限 200 条。

## 5. 产物位置

- 决策日志：`{run}/final_clips/packaging/{NNNN}_final/packaging-agent-log.json`
  （和 `index.html` / `template.json` / `render.log` 放一起）。形状对齐 `material-agent-log.json`：
  `backend / model / deterministic / response_raw / decision / agreed_with_deterministic /
  cache / overlay_fallback / final_check / timings / errors / fallback_used / ok`。
- 人读日志：stdout 的 `[packaging] …` 行（全部 `flush=True`）。
- 进度：`VACUT_EVENT` 两行，`workflowStage:"compose"` + `workflowStatus:"running"` +
  `phase:"packaging"` + `current/total`。**不发 `completed`**（那是 Rust 收尾发的）。
  桌面端会把这两行从可见日志里摘掉，所以人读内容另走 `[packaging]` 明文行。

## 6. node_modules 的口径（2026-09-18 定论，不再是待定）

**pi 与 HyperFrames 的 `node_modules` 都不进代码仓库，随视频引擎运行包一起打包、一起下载分发。**

打包前依次跑，两个 `--check` 都过再打包：

```powershell
python VideoAutoCut\tools\material_gen\pi\install_pi.py
python VideoAutoCut\tools\material_gen\pi\install_pi.py --check
# 仓库工作区不是运行时目录（没有 node-runtime、没有 chrome），装完紧接着的自检要借一个底包来
# 找这两样——`--runtime-root` 在**安装模式下同样生效**，所以一条命令装完就验完：
python VideoAutoCut\tools\material_gen\hyperframes\install_hyperframes.py --runtime-root "<已安装的运行包目录>"
# 只想重验不想重装：
python VideoAutoCut\tools\material_gen\hyperframes\install_hyperframes.py --check --runtime-root "<已安装的运行包目录>"
```

不带 `--runtime-root` 在仓库里装：npm 那步是好的，紧接着的自检会**退出 1**（报缺内置 Node 和
Chrome）——这是预期，不是装失败。

`--runtime-root` 只借 node 与 chrome；cli 与 gsap **只认仓库本目录装的那份**（脚本会断言解析到的
`cli.js` 在本目录下，否则报错，免得拿底包那份冒充成绿的）。仓库工作区不是运行时目录（没有
`node-runtime`、没有 chrome），所以不带这个参数时 `--check` 必红。

⚠️ **不能加 `--omit=optional`**（`--omit=dev` 保留）：hyperframes 的原生依赖 sharp / esbuild /
onnxruntime-node 全是按平台拆的 optional 包，omit 之后 Windows 上少装 `@img/sharp-win32-x64`
等 718 个文件，`cli.js` 连 lint 都起不来（`Could not load the "sharp" module using the
win32-x64 runtime`），而且 esbuild 会 fallback 自己下一份 10.6MB 二进制塞进运行包
（2026-09-18 打包实测包体积 +4.5MB 几乎全是它）。npm 11 关于 install 脚本
「not yet covered by allowScripts」的提示**不用处理、也不用加 `--foreground-scripts`**
（那只改输出是否实时刷屏，不影响脚本跑不跑）：sharp 0.33+ 的运行库就是那个预编译 optional 包，
装上就能 require；到底行不行由下面的真跑来判，不靠猜。

**`--check` 会真跑两步**（只查文件在不在是假绿，2026-09-18 就是这么漏的）：① 按 cli.js 的解析
规则 `require('sharp')`；② 对脚本内置的最小分页 composition 真跑一次 `cli.js lint`（带
`HYPERFRAMES_NO_TELEMETRY` / `HYPERFRAMES_NO_UPDATE_CHECK`，否则遗留的后台子进程会占住临时
目录）。任一失败退出 1。

`install_hyperframes.py` 自检的就是 `template_packaging.renderer_dependencies()` 运行时要找的四件套：

1. 内置 node（运行根 `node-runtime/node.exe`）——缺 → 失败
2. HyperFrames CLI，版本按本目录 `package.json` 钉死（当前 0.7.3）——缺或版本不符 → 失败
3. GSAP（当前 3.14.2）——缺或版本不符 → 失败
4. `chrome-headless-shell` ——**不由 npm install 装**（跟 remotion 那份或手放本目录），
   缺了默认只告警；`--require-browser` 可以升成硬失败

自检**直接调用 `renderer_dependencies()` 本身**，不另写一套探测：运行时怎么找，自检就怎么找。
所以 `VIDEOAUTO_NODE_EXE` / `HYPERFRAMES_CLI` / `HYPERFRAMES_GSAP` / `HYPERFRAMES_BROWSER_PATH`
与运行时天然同步，也不会出现「打包机 PATH 上有 node 所以自检绿、运行包里没 node-runtime
所以合成红」这种假绿——`renderer_dependencies` 只认运行根下的 `node-runtime/node.exe`，**不看 PATH**。

`scripts/verify.ps1` 和打包脚本都没改。

## 7. `card_content` 覆盖率（只是信息，不阻断）

本机能找到的真任务分镜样本只有一份：
`~/Desktop/临时/功能设计/ai edit/已验证脚本与记录_第四批/input-shots.json`
—— **7 个分镜里只有 1 个写了 `card_content`（14%），`card_hint` 同样只有 1 个。**

含义：真任务里多数分镜会退化成拿 `title` 当上屏文字，所以 agent 的决策空间很大一部分是
「这条 title 是不是内部占位标签、该不该上屏」（`show` 那一维），而不是三个版式之间的取舍。
第一步的通路价值大于内容价值。要让版式选择真正吃上力，得先让脚本作者把 `card_content` 补起来。
样本只有一份，这个数字**不能当成全量分布**，Windows 整跑时请顺手统计一次真实覆盖率。

## 8. Windows 验收清单

> 全程 app.env **就地改键**；每轮跑完还原生产 app.env。

| # | 项 | 做法 | 通过标准 |
|---|---|---|---|
| **0** | **前置：确定性包装能不能跑** | 先跑 §6 的两个 `--check`；再 app.env `VIDEOAUTO_TEMPLATE_PACKAGING=true`、`PACKAGING_AGENT_SELECT=0`，跑一条验证过的旧任务（7 镜） | 出成片；`{run}/final_clips/packaging/*/overlay.webm` **7 镜一个不少**、`render.log` 全是 `0 errors`。**特别是会分页的那一镜**（`01_包装换型与码垛_CN` 的第 7 镜，竖屏素材把 `card_content` 切成 2 页）**必须过 lint**——这正是 2026-09-18 第一次验收挂掉的地方，见 §9.0。组件缺失多半是 chrome-headless-shell（§6 第 4 条）。**这一项不过后面全部暂停** |
| **1** | 冒烟：单分镜直调 | 运行包内 Python 直接跑 `tools/render_segment.py`，参数照 `final_video.rs:213-249` 抄，加 `--template-packaging`；`PACKAGING_AGENT_SELECT=1`、`PACKAGING_AGENT_BACKEND=pi` | 退出码 0；stdout 有 2 行 `VACUT_EVENT` + `[packaging]` 明文行；`packaging-agent-log.json` 的 `decision.source=="agent"`；成片 ffprobe = 目标画布 / SAR 1:1 / aac 48000 2ch |
| **2** | 开关关闭回归 | 同一分镜 `PACKAGING_AGENT_SELECT=0` 再渲到另一个输出 | 不产生 `packaging-agent-log.json`；成片 **sha256 与 #1 之前的基线一致**（Mac 上已实测：无包装时开关开/关/改动前三者 sha256 完全相同）。不同请附两份 ffprobe 差异，不阻断 |
| **3** | 整跑 | 桌面端跑完整 7 镜任务，agent 开 | 7 镜全部出片可播；`fallback_used:true` 的镜数 ≤1；任务没有卡在「合成成片」 |
| **4** | 超时/坏后端演练 | 两遍：(a) `MATERIAL_AGENT_PI_PROVIDER=nonexistent`（或断网）整跑一次；(b) `PACKAGING_AGENT_TIMEOUT=30` + 指向一个不响应的 baseUrl 整跑一次 | **两遍都 7 镜全部正常出片**，每镜日志 `fallback_used:true` + `errors` 有记录，退出码 0；(b) 里**每镜 agent 段耗时 ≤ 预算 + 几秒**（看日志 `timings.model_seconds` 与 `budget.call_timeout_seconds`），总耗时与 #0 的差不超过 7×预算 |
| **5** | 坏返回演练 | 已由单测覆盖（顶层数组 / `template:"banner"` / `show:"true"` / 空对象 / 超长 reason），Windows 侧只需确认 #7 全绿 | 每种都落回确定性版式，不抛到 `main()` 之外 |
| **6** | 指标 | 汇总 7 份 `packaging-agent-log.json` | ① `timings.model_seconds` 中位数与 P95；② 三个对照口径分别报：`agreed_with_deterministic`（**只比版式**）、`show_agreed_with_deterministic`（只比上不上包装；确定性恒为「上」）、`decision_changed`（版式或 show 任一不同 = agent 到底改了几镜）；③ `final_check.duration_delta` 的 7 个值（决定要不要把时长校验升成硬失败）；④ 整跑总耗时 vs #0 的差，另报合成段耗时（整跑含选材，选材每次结果都会变）；⑤ 顺手数一下这条任务的 `card_content` 覆盖率 |
| **7** | 单测 | `python -m unittest tests.test_packaging_agent tests.test_template_packaging tests.test_material_agent_select tests.test_material_selection_policy tests.test_python_boundaries`，agent 开/关两态各一遍 | **以 Windows 全绿为准**。已知例外：`tests.test_material_selection_policy` 的 `test_disabled_policy_does_not_call_model` 与 `test_rejects_logo_uncertainty_then_selects_next_actual_candidate` 在 **macOS 上恒红**（`/var` 与 `/private/var` 符号链接差异，基线 `ba6553e` 上同样红，与本分支无关），**Windows 上是绿的**——Windows 若这两项红，那才是真问题 |
| **8** | 打包 | `scripts/verify.ps1`（未改）+ 打运行包 | `--check` 退出 0；本步骤零新增运行期依赖，包体积不应变化（HyperFrames 那部分是 §6 的既有组件） |

**预计每分镜增加耗时**：agent 决策本身约 3–8s（纯文本单次调用 2–6s；pi 后端另加 1–2s node 冷启动；
缓存命中≈0）。**真正的大头不是 agent**：一旦包装开启，`render_overlay` 的 lint + headless Chrome
逐帧渲染按 30fps 算，8s 分镜 = 240 帧，经验值几十秒到 2 分钟/镜——这是既有成本，#0 必须先量出来，
否则 #3 的总耗时会被误算到 agent 头上。

## 8.9 2026-09-21 第二轮：只按脚本上屏 + 卡片换行禁则

> 先在 `feature/packaging-script-only`（基于 `57ecd75`）上做，9/21 下午 Windows 侧还没开工，
> 已**快进并入 `feature/material-agent-select`**（远端 `feature/packaging-script-only` 保留不删但停在 `600180e`，是主分支的祖先）。
> 两个 commit：`8f24772`（改动 A）、`68405c6`（改动 B），可以各自单独回退。
> 验收清单另见 `docs/packaging-script-only-acceptance-2026-09-21.md`，与
> `docs/packaging-test-scripts-2026-09-21/` 的 5 条测试**合成一轮**跑。

### 8.9.1 口径变更（用户 9/21 拍板）

1. **「只按脚本上屏」要做**：模板包装开启时**逐镜**判断——脚本写了上屏内容（`card_content` 非空）的镜
   才上卡片；没写的镜不上，**不再拿 `title` 顶替**。
2. **「agent 从口播摘上屏要点」不做**（第二步就此定为「不开」）。上屏内容属于**包装内容**，一律以
   脚本为准，**AI 不替作者生成、也不摘取上屏文字**。agent 在包装环节的职责只剩一条：
   **在作者写了上屏内容的镜里选版式**。
3. 路线 = **代码编排 + 逐环节 agent 决策点**。

这推翻了 §7 那段「真任务里多数分镜会退化成拿 `title` 当上屏文字」的既有行为：
现在那些镜**根本不上卡片**，`title` 不再是上屏文字的兜底来源。

### 8.9.2 新 env：`VIDEOAUTO_PACKAGING_SCRIPT_ONLY`

| 键 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `VIDEOAUTO_PACKAGING_SCRIPT_ONLY` | 0/1（`0/false/no/off` 关，其余一律开） | **`true`（开）** | **没有这个键也按开启算**。只在 `VIDEOAUTO_TEMPLATE_PACKAGING=true` 时才有意义 |

三个入口的默认值都锁成「开」，缺一不可：

- `VideoAutoCut/.env.example` 写成**不注释**的 `VIDEOAUTO_PACKAGING_SCRIPT_ONLY=true`（新装机的 app.env 从它复制）。
- `template_packaging.script_only()` 用 `env_bool(..., True)`——**键不存在、值为空、值是垃圾串** 都算开。
- 桌面端 `workspace-service.ts` 的 `ensureEnvDefaults` 补 `'true'`（**老 app.env 没这个键时，开机会自动补上**）。

口径：**只认 `card_content`**。`card_hint` 是版式提示，不是上屏内容，写了它也不算作者写了上屏文字。
`card_content` 去掉首尾空白后为空 = 没写。

### 8.9.3 代码落点

| 路径 | 改法 |
|---|---|
| `tools/template_packaging.py` | 加 `script_only()` / `has_script_card_content()`；`build_composition` 在取 content **之前**判一次，与 agent 判 `show=false` 走**同一条**「无 overlay」出口（`return None`）。所以 `plan=None` / `show=false` / script_only 跳过 三条路最终都是同一条合成路径 |
| `tools/render_segment.py` | `prepare_packaging` 里 script_only 且本镜无 `card_content` 时**不 import `packaging_agent`、不调模型、不发决策进度事件**，只打一行 `[packaging] 分镜 N 本镜脚本未写上屏内容，按脚本模式跳过包装（不调用模型）` |
| `tools/prompts/agent_packaging_plan.md` | **一字不改**（2026-09-21 修回）。9/21 上午曾往 `show` 那段里加过「默认配置下 `show` 实际恒为 true，照填 true 即可」，Windows 回帖 51296044 的 A4 证明那句把模型带偏了：`VIDEOAUTO_PACKAGING_SCRIPT_ONLY=0` 老路径下第 4/6 镜（title 是内部标签／与口播逐字重复）不再判 `show=false`。**不要再往提示词里写「照填 X 即可」这类让模型放弃判断的话**，也不要给判 false 的规则加「只有…关掉时」这种前置条件——它同样会被理解成「当前用不上」。`show` 字段与 `overridden="author_card_content"` 护栏保留不删，`script_only=0` 时仍要用 |
| `VideoAutoCut/.env.example` | 新键 + 注释，挨着 `VIDEOAUTO_TEMPLATE_PACKAGING` |
| `VideoAutoCutDesktop/electron/workspace-service.ts` | `ensureEnvDefaults` 补默认 `'true'` |
| `VideoAutoCutDesktop/src/config/settings.ts` | 登记该键（`type: 'switch'`） |
| `VideoAutoCutDesktop/src/pages/config/VisualStylePanel.tsx` | 「模板包装（可选）」下加子开关「只按脚本上屏（推荐）」，**仅模板包装开启时显示**；`isEnabledValue(..., true)` 保证老 app.env 缺键时 UI 也显示「开启」。同时把「模板包装」原副文案改准（「分镜现有上屏文字」→「脚本写好的上屏文字」） |

**进度事件**：被跳过的镜**照样发** `VACUT_EVENT` 两行，只是第一行的 label 写「按脚本跳过 N/M」
而不是「包装决策 N/M」。不发的话桌面端包装阶段的 `current` 会跳号（1 → 4 → 6），末镜被跳过时
还会停在 N-1/N 像卡住。为此把读分镜总数的 `shot_total` 实现挪到了
`template_packaging.shot_count()`（`packaging_agent.shot_total` 保留旧名字转调它）——
这样发事件不必 import `packaging_agent`，「跳过的镜零模型开销」这条不受影响。

### 8.9.4 §8 #0 的通过标准随 script_only 变了

§8 #0 原文要求「`overlay.webm` **7 镜一个不少**」——**那是 `script_only=0` 才成立的标准**。
默认（script_only 开）下正确的标准是：

| 场景 | overlay.webm 应有几个 |
|---|---|
| `VIDEOAUTO_PACKAGING_SCRIPT_ONLY=0`（旧行为） | **每镜一个，一个不少**（§8 #0 原文） |
| 默认（script_only 开） | **只有写了 `card_content` 的镜有**；没写的镜**必须没有**，且那几镜不产生 `packaging-agent-log.json` |

§8 #0 里点名的「会分页的那一镜」（`01_包装换型与码垛_CN` 第 7 镜）本来就有 `card_content`，
所以它在两种模式下都要出 overlay、都要 `0 errors`——这条不变，仍是分页老 bug 的回归点。

§8 #3「7 镜全部出片可播」仍然成立（不上卡片 ≠ 不出片）；
「`fallback_used:true` 的镜数 ≤1」的分母变成**被问到的镜数**，不再是分镜总数。

### 8.9.5 改动 B：卡片换行禁则（§9.1 第 0 条的「路径确｜认」）

`text_layout.wrap_text_pixels` 同时被**字幕**（`common.py:390`）和**进度条标签**（`add_progress.py:293`、
`fit_label`）用着，所以**没动它的现有行为**：加了一个 keyword-only 参数 `kinsoku`，
**默认 `False` = 2026-09-21 之前的原代码路径**，只有 `template_packaging.build_composition` 传 `True`。
字幕与进度条的调用全是位置参数，一个都没碰到。

规则（确定性、无外部依赖，**不引入 jieba 等分词库**——运行包里没有）：

| # | 规则 | 例 |
|---|---|---|
| 1 | **数字与其单位不断行**。数字串 + 最多**一个**空格（空格后必须是汉字）+ 最多 1 个汉字，之后每遇到一个单位符号 `/／·%‰°℃` 再最多 2 个汉字；遇顿号/竖线/字母词/第二个空格即止，黏成一个不可断单元。单位符号**不要求前面先有汉字**，所以 `35%`、`180℃` 也黏住——这同时让 `%` `℃` 不会自己跑到行首去 | `700 包/小时`、`12件/分`、`35%`、`180℃` |
| 2 | **连续拉丁字母/数字串整词不拆** | 既有行为（`text_units` 的正则），未改 |
| 3 | **行首禁则**：原有的 `，,。！？!?；;：:、)]）】》”’` 扩充 `」』〉%‰℃°…` | 行首不出现 `%` |
| 4 | **行尾禁则**（新增）：`（(【《「『“‘〈[{` 不留在行尾，跟着下一行走 | `项确认（` → `项确认` / `（抓具与` |
| 5 | **行尾孤字回退**：某一行只剩 **1 个汉字**（可带尾随标点）时，从上一行末尾借 **1 个**汉字下来凑成 2 个 | `抓具调整｜路径确` / `认` → `抓具调整｜路径` / `确认` |

**贯穿全部五条的铁律（2026-09-21 复审抓出来的，写进代码注释了）**：
**kinsoku 不许比不加禁则时多造出任何一条超宽的行。** 上层的字号收缩循环会为超宽行一路压字号，
压到下限还超就抛「模板上屏文字包含无法完整显示的超长词」——排版规则把本来能出片的卡片弄挂，
本末倒置。所以每一条会往某一行塞字符的规则都先过 `fits`，过不了就退回普通换行：

- 规则 1：黏出来的整体放不进一行就原样退回，逐字换行。「数字后最多 1 个汉字，之后每遇到一个
  单位符号再最多 2 个汉字」——刻意不贪心，多收一个字就可能把下一个词的词头黏进来反而制造断点。
- 规则 3/4（行首、行尾禁则）：**best-effort**。先试「追い出し」（把本行最后一个单元连同禁则符
  一起挪到下一行）；挪不动（挪完那一行放不下、或本行只剩这一个单元）就退回普通换行，
  宁可让符号落在行首，也**绝不**把它硬拼在放不下的行尾。
  ~~早先版本是无条件硬拼~~ —— 那正是复审抓到的阻断级 bug：`产能提升 35%，人工下降 2 人`
  在窄画面上会直接抛「超长词」，而同一份文案在不加禁则时能正常出片。
- 规则 5 的护栏（都在 `_reflow_orphan_lines`）：只借 1 个字；上一行末尾必须是汉字；
  **借完上一行自己不能变成孤字行**（否则只是把问题往上推一行，而本函数从前往后走不回头）；
  不从规则 1 黏好的「数字+单位」里抠字；借完那一行仍要过 `fits`。

`tests/test_text_layout.py::PackagingKinsokuTests::test_kinsoku_never_widens_a_line_beyond_plain`
把这条铁律钉死了（顺带锁「一个字符都不许丢」「行数不会凭空变少」）。另外用 4000 条随机语料 ×
4 组真实卡片几何（16000 组）实测：**多出超宽行 0 组、丢字 0 组**；孤字行**减少 708 组、增加 62 组**；
行数变多 407 组，其中 232 组是 kinsoku 在修 plain 本来就有的超宽行，**净代价 175 组（1.1%）**，
全部落在「数字后面紧跟 `%‰°》」` 这类密集符号」的随机串上，真实中文工业文案基本不出现。

**做不到的（已知不修，不是 bug）**：`抓取位居中不压袋角并逐项核对来料朝向与输送节拍确认`
（04 第 5 镜，25 字、整句**没有任何标点**）在 `parameters` 42 号下仍被切成
`…与输送节` / `拍确认`，把「节拍」劈开。判这种词边界只能上词典分词，本轮不引入。
`tests/test_text_layout.py::PackagingKinsokuTests::test_pure_chinese_two_character_word_split_is_a_known_limitation`
把当前行为钉住，免得以后被误以为已修。

**超长词硬失败行为不变**：04 第 6 镜那个 98 字英文长词，三个版式仍全部抛
`模板上屏文字包含无法完整显示的超长词，请缩短上屏文字。`（报错原文逐字不变，新旧实测一致）。

> **口径澄清（复审提出）**：「与改动前逐字节一致」这条硬约束**只约束改动 A**。
> 改动 B 是**有意的排版变更**——它就是来改断点的，所以有 `card_content` 的镜的 html 会变
>（`<br>` 位置，极端情况下连 `font-size` 都会跟着变）。`tests/test_packaging_agent.py` 里
> 与 `ba6553e` 的逐字节对照因此改成「把换行换回旧实现再比」（`plain_wrap`），
> **html 的其余部分仍必须一字不差**，而且那个 seam 会断言调用点确实传了 `kinsoku=True`，
> 免得将来参数名写错把对照测试变成永远通过。已发布批次若要复现旧排版，须 `kinsoku=False`。

### 8.9.6 02/04/05 三份测试脚本的行数/页数对照（改动 B 前后）

口径与 `docs/packaging-test-scripts-2026-09-21/README_测试说明.md` 第三节同法：
本机（Mac/PIL 量宽）用运行包同一份 `build_composition` ＋仓库内置 `NotoSansCJKsc-Bold.otf`，
画布 1920×1080、`picture_bounds` 取满画幅、各镜用脚本里写的时长、版式取**确定性**结果。
Windows 用 GDI 量宽，临界值上可能差一行。

| 脚本-镜 | 确定性版式 | 字号 | 改动 B 前 | 改动 B 后 | 断点是否变 |
|---|---|---|---|---|---|
| 02-1 | title | 54 | 1 行 / 1 页 | 1 行 / 1 页 | 同 |
| 02-2 | title | 54 | 1 行 / 1 页 | 1 行 / 1 页 | 同 |
| **02-3** | parameters | 42 | 2 行 / 1 页 | 2 行 / 1 页 | **变**（见下） |
| 02-4 | title | 54 | 1 行 / 1 页 | 1 行 / 1 页 | 同 |
| 02-5 | parameters | 42 | 1 行 / 1 页 | 1 行 / 1 页 | 同 |
| 02-6 | title | 54 | 2 行 / 1 页 | 2 行 / 1 页 | 同 |
| 02-7 | cta | 42 | 1 行 / 1 页 | 1 行 / 1 页 | 同 |
| 04-1 | title | 54 | 1 行 / 1 页 | 1 行 / 1 页 | 同 |
| 04-2 | title | 54 | 1 行 / 1 页 | 1 行 / 1 页 | 同 |
| 04-3 | title | 54 | 2 行 / 1 页 | 2 行 / 1 页 | 同 |
| 04-4 | parameters | 42 | 5 行 / **2 页** | 5 行 / **2 页** | 同（分页回归点，仍 2 页） |
| 04-5 | title | 54 | 2 行 / 1 页 | 2 行 / 1 页 | 同（`title` 本来就没切词；`parameters` 下的「节｜拍」见 8.9.5） |
| 04-6 | — | — | `RuntimeError` 超长词 | `RuntimeError` 超长词 | 同（报错原文一致） |
| 05-1 | title | 54 | 1 行 / 1 页 | 1 行 / 1 页 | 同 |
| **05-5** | parameters | 42 | 2 行 / 1 页 | 2 行 / 1 页 | **变**（见下） |
| 05-6 | title | 54 | 2 行 / 1 页 | 2 行 / 1 页 | 同 |

（05-2/3/4、01 全部 6 镜没有 `card_content`，默认模式下不上卡片，无版面可算。）

**唯二变了的两处**，都是规则 5 的孤字回退，行数与页数都没变：

```
02-3 / 05-5   节拍 700 包/小时｜输送带连续来料｜托盘满垛下线
  前：['节拍 700 包/小时｜输送带连续来料｜托盘满垛下', '线']
  后：['节拍 700 包/小时｜输送带连续来料｜托盘满垛', '下线']
```

**docs §9.1 的原例**（`01` 第 7 镜那种竖屏窄卡片，`picture_bounds=(656,0,606,1080)`、54 号）：

```
  前：[['新包装样件｜目标', '垛型｜现场布局｜', '抓具调整｜路径确'], ['认']]
  后：[['新包装样件｜目标', '垛型｜现场布局｜', '抓具调整｜路径'], ['确认']]
```

### 8.9.7 Mac 侧已跑结果（2026-09-21）

- 全量 `python3 -m unittest discover -s tests -p "test_*.py"`：
  **基线 `57ecd75` = Ran 349, failures=2, errors=5, skipped=3**；
  **本分支 = Ran 370, failures=2, errors=5, skipped=3**，失败/错误**清单逐条相同，零新增**。
  （Windows 同一份代码数出来是 **369**：Mac 多的那 1 个是 `test_qwen_cloud_embedder` 的
  导入失败占位 `unittest.loader._FailedTest`，缺可选依赖时 unittest 会塞一个假用例并计入
  errors，Windows 上该模块导入得了就没有。两边口径都对，别按差 1 去找 bug。）
  （§8 #7 那套模块 + 本轮新增的 `test_render_segment_packaging` / `test_text_layout`：
  基线 195 → 本分支 **216**，failures 同为 2。）
- 桌面端：`tsc -p tsconfig.json` 与 `tsc -p tsconfig.electron.json` 均 **0 error**；
  `npm test` 与基线**同一份 21 项失败**（Mac 固有，逐条相同，零新增）；
  `eslint` 仍是 §9.2 第 3 条记的那 **10 处 `react-hooks/set-state-in-effect`**，
  **本分支改到的四个前端文件一处都没有**。
  这 7 项全是 macOS 固有（`/var` 与 `/private/var` 符号链接、Homebrew ffmpeg 的
  `ass=...:fontsdir=...` 解析、缺可选依赖），Windows 上不复现。
- 四态各跑一遍（`PACKAGING_AGENT_SELECT` 0/1 × `VIDEOAUTO_PACKAGING_SCRIPT_ONLY` 0/1）：
  四态结果完全一致，均为 Ran 367 / failures=2 / errors=5。
- 端到端仍跑不了（四件套是 Windows 路径），按 §8 与新验收清单在 Windows 机上验。

### 8.9.8 本轮遗留

1. **纯中文无标点长句的二字词切分**（8.9.5 末尾）——要修得引入词典分词，运行包里没有，未做。
2. **卡片换行的「纯代价」约 1.1%**（8.9.5 末尾）：极少数含密集符号的文案会比以前多占一行。
   已实测不会多出超宽行、不会丢字，也没有一例把原本能出片的卡片打成「超长词」。
3. **§7 的 `card_content` 覆盖率统计**口径变了：现在它直接等于「有几镜会上卡片」，
   Windows 整跑时请按新口径报。
4. **第二步「agent 从口播摘上屏要点」已定为不做**，`prompts/agent_packaging_plan.md` 里与之相关的
   「模型不产出文字」铁律不但保留，而且现在是**产品口径**，不再只是实现约束。
5. 桌面端 `npm run lint` 的 10 处既有问题（§9.2 第 3 条）本轮没碰，只保证**不新增**。
6. **设置页的布尔口径顺手修了一处既有 bug**：`useConfigPageState.envToConfigValues` 以前只认精确的
   `'true'`，手写成 `1` / `yes` / `TRUE` 的开关会在设置页显示成「关闭」，用户改别的设置触发整表回写时
   会把它**静默写成 `false`**。现在按 `common.parse_bool` 同一口径解析（大小写不敏感、同一批词），
   并给「默认开」的开关加了 per-key 默认表。这条影响所有 switch 型设置，不只本轮这个键。

## 8.10 2026-09-21 修复轮：脚本解析丢字/臆造/翻译上屏字段

### 8.10.1 现象（Windows 回帖 51296044 第三节）

5 份测试脚本经 `normalize_script.py`（qwen-long 文件理解）解析后，Windows 手改了 14 处才跑：

| 类别 | 处数 | 例 |
|---|---|---|
| `card_content` 整条丢失 | 1 | 03 第 1 镜「来料到位是码垛稳定的第一道关」没了 |
| 作者写「（不填）」处凭空造 `card_hint` | 6 | 02-1/2/4/6、04-1、05-1 被写上 `on-screen text display` 等 |
| 中文 `card_hint` 被翻成英文 | 3 | 04-4「参数卡，列表排版」→ `parameter card with vertical list layout` |
| `title` 被改写 / `duration` 被改 | 4 | 03-4、03-6 的 title；04-3 的 duration（**不属上屏字段，本轮不碰**） |

「只按脚本上屏」口径下（`VIDEOAUTO_PACKAGING_SCRIPT_ONLY` 默认开），`card_content`
写没写**直接决定这一镜上不上卡片**——解析器丢一条，作者写的上屏文字就整条不见，
而且没有任何人会发现。**这是单点失效**，只靠提示词约束不够。

### 8.10.2 改法（两层）

**(a) 提示词收紧**：`prompts/script_parse.md` 字段说明 + 新规则 15；
`prompts/script_parse_review.md` 新增 11.1（复核那一轮也别顺手改上屏字段）。
口径：`card_content` / `card_hint` **逐字照搬**，不翻译、不改写、不补全；作者没写或写的是
「（不填）」「无」「-」「N/A」这类占位 → 空字符串；不得从口播 / 字幕 / 画面描述里臆造。

**(b) 确定性兜底（重点，不依赖模型）**：新模块 `tools/script_card_fields.py`，
`normalize_script.main()` 在 `ensure_progress_labels` 之后、写盘之前调一次
`verify_and_fix(plan, script_file)`。

> 2026-09-21 第二小轮把它扩到了**表格脚本（xlsx/xlsm/csv）和 docx**，
> 并把 **`title`** 也纳入同一套校验（取文本层是新模块 `tools/script_tabular.py`）。
> 下面 §8.10.2 的图与表仍然成立，**格式覆盖矩阵、表格路的规则、`title` 的边界见 §8.10.5**。

```
脚本原文 ──正则──► 每镜 {card_content, card_hint}
                          │
                    与 plan 比对（两边都先过 normalize_script 的空白折叠）
                          │
        ┌─────────────────┼─────────────────┐
     丢失(补回)        臆造(清空)        改写(换回原文)
                          │
            告警行 + 一条 VACUT_EVENT(stage=script, phase=card_fields)
```

**设计原则：宁可漏报，绝不误改。** 自动纠正会真的改 plan，把对的改坏比不查还糟，
所以每一道判断拿不准就退回「只告警不改」，任何情况都不中断：

| 情形 | 行为 | 为什么 |
|---|---|---|
| 本地读不出原文（pdf / doc / xls，或文件坏了） | **零动作** | 读不到原文就不猜。xlsx / xlsm / csv / docx 2026-09-21 起**已覆盖**，见 §8.10.5 |
| 找不到「分镜 N」式标记，或编号不是严格 1..N | **零动作** | 正文里提到「分镜 3」会破坏序列，正好挡住误切 |
| 代码围栏（``` / ~~~）里的内容 | 整段不参与抽取 | 「写法参考」块会凭空造出作者没写的卡片 |
| 分镜块数 ≠ plan 分镜数 | **只告警不改** | 镜号会错位 |
| **这一镜的口播 / 字幕 / 分镜标题都和 plan 对不上** | 该镜**只告警不改** | qwen 允许合并/拆分分镜，**块数相等不代表镜号对得上**；光数数会把别镜的上屏文字静默写进来。所以纠正前先用内容锚点认人，任一锚点命中即通过（03 第 4/6 镜的 title 被改写过，靠口播认） |
| 脚本这一镜没有任何锚点字段可用 | 该镜**只告警不改** | 认不了人就不动手 |
| 同一镜同一字段写了多行 / 值疑似跨行续写 | 该镜该字段**只告警不改** | 中英双语脚本会写两遍；`上屏文字：来料确认：…` 这种值里带冒号的换行续写，只取第一行会把卡片截断 |
| **要清空（臆造）或换掉（改写）的那个值，在本镜块里某条「本表不认识的字段名」的行 / 列上出现过** | 该镜该字段**只告警不改** | 说明作者写了、只是用了本表不认识的字段名（比如「字幕文字」「花字样式」），解析器其实抽对了。**这是最危险的一条路径**：误判会让整片卡片消失，正是本轮要消灭的那个故障。（2026-09-21 收窄成「只看认不出来的键」，理由见 §8.10.5.4） |
| 脚本里压根没有上屏字段 | 零纠正，plan 逐字节不变 | |
| 差异只在 markdown 强调 / 成对引号括号上 | 不算不一致 | 照搬 `**安全第一**` 会把星号渲到卡片上 |
| 比对中途出任何岔子 | 原 plan 一个字节不动 | 比对跑在深拷贝上，全部通过才整体搬回 |

**日志只用 ASCII 符号 + 汉字**（`[!]`，不用 `⚠`/`✓`）：中文 Windows 把 stdout 重定向到文件时
按 gbk 编码，U+26A0 / U+2713 编不出来会抛 `UnicodeEncodeError`——兜底日志自己崩掉的话，
「绝不带倒脚本解析」就失效了（shots.json 写不出来）。`material_agent_select` 的 provider
告警同理。正式引擎路径本来就注了 `PYTHONUTF8=1`（`VideoAutoCutApp/src/paths.rs:179-180`），
踩雷的是**手工直调 + 重定向**，而验收正是那么跑的。

识别的字段写法（键名去空白/星号/下划线/连字符后比对，大小写不敏感）：
`上屏文字 / 上屏内容 / 上屏文案 / 上屏正文 / 卡片文字 / 卡片内容 / 卡片文案 / 卡片正文 /
card_content / on-screen text / on-screen copy` → `card_content`；
`卡片样式 / 卡片版式 / 卡片要求 / 卡片提示 / 卡片说明 / 卡片风格 / 上屏样式 / 上屏版式 /
图层说明 / card_hint / card style / card layout` → `card_hint`。
占位词 `不填 / 不填写 / 无 / 没有 / 暂无 / 空 / 留空 / - / — / – / / / n/a / na / none / null /
nil / tbd`（可带括号）**整段完全相等**才算占位——上屏文字写「无人化产线」不会被误杀。

**开关**：`VIDEOAUTO_SCRIPT_CARD_AUTOFIX`（默认开）。设 `0` 只告警不纠正。

**边界**：这一层改的是 plan（`shots.json`），**不涉及包装关闭态的渲染基线**——
`render_segment` 一行没动，A1/A12 的逐字节结论不受影响。它也只碰这两个字段，
`title` / `duration` / `voice_text` 一个字都不动（有单测钉住）。

### 8.10.3 已知不管的（记账，别当 bug 报）

- **`duration` / `voice_text` / `subtitle` 这一层一个字不动**（`title` 已于
  2026-09-21 纳入，见 §8.10.5）。回帖手改表里的 04-3 duration **仍不会被自动改回来**。
- **`module_label` 不纳入**：它是解析器按规则生成的进度条章节名，不是作者原文。
- **同义词表之外的字段名认不出来**（表见上）。认不出时这一层只会「漏报」，不会误删——
  上面那条「值在表外字段里出现过」的闸门就是为它兜底的。要新增写法直接加进
  `FIELD_BY_KEY`（纯文本路）或 `TABLE_ROLE_BY_KEY`（表格路的非校验列）。
- **分镜编号只认 3 位数**（`分镜 1000` 之后的标记抽不到）。真出现时块数必然对不上
  plan，会退成「只告警不改」。
- **零宽字符**（U+200B）不在 `\s` 里，两边有一边带它就会被判「改写」。无害，只是多一条告警。

### 8.10.4 Mac 侧干跑结果

5 份真脚本全部能切块，每镜 `card_content` / `card_hint` 与原文逐字一致
（`tests/test_script_card_fields.py::RealScriptRegressionTests`，同时钉住
`README_测试说明.md` 这种带表格的文档**不会**被误当成脚本切块）；
回帖里那 10 处上屏字段改动逐条被判成 missing / invented / rewritten 并纠正。

### 8.10.5 2026-09-21 第二小轮：覆盖表格脚本 + `title` 纳入校验

用户拍板三条：**①生产脚本主要是表格（xlsx）或 txt，其它格式也会有，校验要覆盖表格；
②分镜标题 `title` 也纳入同一套逐字校验；③A4 的「第二个可能原因」不修**（见 §8.10.8）。

#### 8.10.5.1 先查清：软件现在怎么读各格式的脚本

**结论：本地根本不读。** `normalize_script.py` 把整个文件原样 multipart 上传到
DashScope 的 `/v1/files`（`purpose=file-extract`，`upload_script_file:108-139`），
再只发一条 `fileid://…` 让 **qwen-long 在服务端**抽文字并结构化
（`normalize_with_ai:301-318`）。服务端抽出来的文本**不回本地**。

所以：
- **「复用同一套读取结果」这条路不存在**——本地拿不到服务端抽的文本；
- **「复用同一批库」也无从谈起**——本地一个解析库都没有。清点过
  `VideoAutoCut/tools/` 全部 44 个 py 文件的 import：**零第三方依赖**，全是标准库 + 自家模块。
  运行包里的 Python 是 `python-3.11.9-embed-amd64`（`VideoAutoCutApp/src/paths.rs:133`），
  嵌入式发行版**没有 pip、没有 site-packages**，装不了也不该装 openpyxl / python-docx。

剩下唯一一条不引入新依赖的路：**标准库自己读**。`.xlsx` / `.xlsm` / `.docx` 本身就是
zip + XML（`zipfile` + `xml.etree` 够用），`.csv` 有 `csv`。`.xls` / `.doc`
（旧二进制 BIFF / CFB）和 `.pdf` 标准库读不了 → 不读，零动作。
新模块 `tools/script_tabular.py` 只干这一件事，**只读、不判断语义、不抛异常**。

#### 8.10.5.2 格式覆盖矩阵

| 格式 | 本地怎么读 | 走哪条路 | 读不出来时 |
|---|---|---|---|
| `.md` `.txt` `.json` `.srt` | 直接按 utf-8-sig / gb18030 读文本 | **文本路**：「分镜 N」切块 + `键：值` 行（**一行没改**） | 零动作 |
| `.xlsx` `.xlsm` | `zipfile` + `xml.etree` 读 OOXML | **表格路**：识别表头列名，数据行 = 一镜 | 零动作 |
| `.csv` | `csv` + Sniffer 猜分隔符 | 先试表格路；表头认不出来**退回文本路** | 零动作 |
| `.docx` | `zipfile` + `xml.etree` 读 `word/document.xml` | 取出纯文本后走**文本路** | 零动作 |
| `.pdf` `.doc` `.xls` | **不读**（标准库读不了，不猜） | — | **零动作**，只打一行说明 |
| 其它后缀 | — | — | 零动作 |

「零动作」= plan 一个字节不改、只打一行 `[script] 脚本字段校验：…，跳过（不影响出片）`，
**绝不中断出片**。

#### 8.10.5.3 表格路怎么认（照真实生产脚本的形状做的）

调研了 `/Users/ethan/Movies/产线视频/claude/` 下 **22 份独立分镜 xlsx**（只读）：
单 sheet 名「视频脚本」，**表头在第 11 / 18 / 20 / 21 行不等**（上面压着一块纵向的
「模块一：封面文案」key-value 区），**起始列 A 或 B 都有**，列名有六种变体
（`中文文案` / `中文文案（直接复用）` / `中文文案（带标点断句）`，`素材搜索策略（中文）`
全角 vs `素材搜索(中文)` 半角），**没有分镜号列 / 没有时长列**，时间轴格子里带换行。

据此定的规则：

| 规则 | 怎么做 | 为什么 |
|---|---|---|
| 表头位置 | **不假定第 1 行、不假定 A 列**。角色密度仍只作准入闸门；过闸候选以**行号升序为主键**、角色数降序仅作同一行的次级裁决。只尝试最早仍可能成立的数据区：一个较早候选如果连分镜组都切不出来，就把它当成该数据区的上界，**不得继续向下搜索另一张角色更多的小表**。要求至少一个实质角色（口播/字幕/标题/上屏/画面），有分镜号列时 ≥2 个角色、没有分镜号列时 ≥3 个 | 第四次对抗复审证明，按角色数优先仍会让下方 `镜号\|分镜标题\|口播\|画面` 小表抢走上方 `分镜\|口播\|上屏文字` 真表头，进而整片改写 title。最终规则宁可让上方假表头造成零动作，也不越过失败候选向下猜另一块表。 |
| 列名匹配 | **两遍查表**：先拿不剥括注的原列名规范化后精确查；没命中才剥括注再查，第二遍不许落到 `GENERIC_KEYS`。`NOTE_CONFLICTS` 除口播/字幕的上屏类冲突词外，`title` 还必须把括注里的 **`全片` / `整片`** 视为冲突：`分镜标题（全片通用）` 这类纵向合并值不能被当作每镜 title。全程精确查表，绝不子串匹配 | 子串、泛用词和括注冲突都可能把平台/全片元数据误当成分镜字段。第四次复审复现了「分镜标题（全片通用）」配合纵向合并单元格，把整片 title 覆盖为同一个值；恢复这两个冲突词后应只告警/零动作。 |
| 分镜号列 | 有就按号分组，**同号或号为空的行并进上一组**；号必须是严格 `1..N`，否则**整份零动作** | 合并单元格摊开后就是 `1,1,1,2`；「一镜多行」也是这样写的 |
| 分镜号写法 | `1` / `第1镜` / `#1` / `1.` / Excel 的 `1.0` 都认；`1-2` 这种**认不出来** | 认不出来的并进上一组，并把那一组整个标成存疑（见下面那一行）→ 退成只告警 |
| 没有分镜号列 | 每个「有实质内容」的行算一镜 | 真实脚本就没有这列；全靠块数 + 锚点两道闸门兜 |
| 合并单元格 | `<mergeCells>` 的左上角值**摊到整个区域** | 摊开后各行值相同 → 唯一 → 照常纠正；不摊开会丢值 |
| 一镜多行给了两个不同值 | 该镜该字段**只告警不改** | 抽不出唯一对应关系 |
| 稀疏行 / 缺列 | 按**列索引**对齐（不按非空单元格顺序） | 真实脚本有整列空缺 |
| 说明行 / 小计行 / 示例行 | 只有时间轴或序号的行不算分镜；有内容的注脚会并进上一镜 → 该镜退成只告警 | 宁可少纠正一镜，不能错位 |
| 重复的表头行（合并表头摊开） | 跳过 | |
| 多 sheet | **恰好一个 sheet 能认出分镜表**才动手；两个都像（中英双版）→ **零动作 + 告警** | 没办法知道 qwen-long 在服务端读的是哪一张 |
| 同一个校验字段对应到两列 | 该字段**全表只告警不改** | `上屏文字（中文）`/`（英文）` 归一后同名，谁也不能当准 |
| 表里没有上屏列，plan 里也没有 | 照 §8.9 口径当「作者没写」处理，并**额外打一行说明** | 用户口径：脚本没写上屏内容的就不上卡片 |
| 表里没有上屏列，但 plan 里**≥1/3 且至少 2 镜**有上屏内容 | **保险丝**：两个上屏字段全表**只告警不改**，告警带「共有 N 处对不上」 | 这更像「上屏列没被认出来」而不是「作者全都没写」。真按「没写」处理一次就是**整片卡片消失**，爆炸半径太大。只有 1 镜有卡片时不点火——半径就是一镜，照口径清掉 |
| 号写了但认不出来（`1-2` / `小计` / `示例`）的行 | 并进上一组，并把**那一组整个标成存疑** | 只靠「值变得不唯一」不够——那一行在被校验的列上可能恰好是空的 |

表格路沿用文本路已有的全部闸门（块数≠分镜数、内容锚点认人、占位词当空、深拷贝原子性）。
「表外字段」在表格路上 = **表头认不出来的那些列，外加画面 / 素材 / 时长 / 时间轴这些
不参与校验也不当锚点的列**（只排除分镜号列）——纯文本路里 `画面：xxx` / `时长：7 秒`
的键同样认不出来、同样算数，两条路的闸门强度必须一致，否则同一份脚本的 txt 版和
xlsx 版会得出不同结论。

**读取层的两道防护**：`xml.etree` 会展开内部 DTD 实体（billion laughs），而字节上限管的是
解压后的成员大小、管不住展开后的内存 → `<!DOCTYPE` / `<!ENTITY` 出现即整份放弃；
sheet 数量上限 64，**超限整份放弃、不截断**（截断会把「恰好一个 sheet 像分镜表才动手」
那道闸门绕过去——被砍掉的那张也可能是分镜表）。

**已知的漏报（可接受，但要能对账）**：
① 「画面 / 素材」列的值也算表外值，所以「解析器把画面描述抄进 `card_content`」这种
**本该纠正**的改写会被挡成只告警——纯文本路里 `画面：xxx` 同样挡，行为是一致的
（不自洽的是「字幕被抄进 `title`」仍会纠正，因为锚点值刻意不进表外值）；
② 没有分镜号列、且只认出 2 个列角色的表（比如只有「口播 + 上屏文字」两列）整份零动作；
③ 括注与角色冲突的列（`中文文案（上屏）`）整列认不出来，那一列的上屏文字校验不到；
④ **角色密度 < 0.6 的超稀疏表头**（`分镜|口播|上屏文字|备注|填写人|审核人` = 3/6）整份零动作；
⑤ **2 镜的表里只有 1 镜有卡片**时保险丝不点火，那一镜照样清——绝对量是一镜，
真实脚本 6–8 镜，可接受。

#### 8.10.5.4 `title` 的规则与 schema 兜底的边界

`title` 与 `card_content` / `card_hint` 用**同一套**三类判定（丢失 / 臆造 / 改写），
但多一条例外：

- **脚本原文写了标题、plan 不同或为空** → `rewritten` / `missing`，**以脚本原文为准纠正**。
  回帖 51296044 手改表里的 03-4（与口播逐字重复的长句）、03-6（「开场」）正是这两类。
- **脚本原文没写标题** → plan 里那个值**不算臆造，不清空，连告警都不打**。
  因为它要么是解析器自拟的，要么是 schema 兜底填的「分镜N」
  （`normalize_script.compact_plan` 与 `shot_plan_schema.py:184` 两处都有这个兜底），
  **两者都是合法产物**。5 份测试脚本里 02 / 04 压根没写分镜标题，这是常态不是异常。
  代码落点：`script_card_fields.NO_INVENT_FIELDS`。
- **作者把标题写成「（不填）」** → 同上，当作没写。
- **`module_label` 不纳入**：进度条章节名是解析器按规则生成的，不是作者原文。

**调用顺序**：`verify_card_fields` 必须跑在 `ensure_progress_labels` **之前**
（`normalize_script.main()`）。`progress_labels.py:45` 在 AI 没给 `module_label` 时会拿
`title` 当章节名，跑在后面的话进度条拿到的是**未纠正**的标题——而「title 会上进度条」
正是把它纳入校验的动机。

**一条有意留下的边界**：`visual_query` / `download_query` 在脚本没给画面描述时会退回
`title`（`normalize_script.py:269`、`shot_plan_schema.py:191`），此时纠正 `title`
**不会**同步改它们。改它们会改变素材检索结果，超出「把作者原文还原回来」的范围，
所以宁可留一处不一致也不静默动检索词。要不要一并同步，等用户定。

`title` 同时是三个**内容锚点**之一，但不产生循环或自证：认人只要求
口播 / 字幕 / 标题**任一**命中。所以
- 口播对得上 → 认人成功 → 被改写的标题照常纠回来（03 第 4/6 镜就是这条）；
- **只有标题能认人、而标题恰恰被改写了** → 认不了人 → 该镜**只告警**，标题不会被改。

**一处闸门收窄**（`6e1ce92` 阻断 1 那条的精修）：判「这个值是不是作者用别名写的」时，
原来把本镜**所有**字段行的值都算进去，于是「解析器把字幕原样抄进 `title` / `card_content`」
这种**恰恰要纠正**的情况也被一起挡住了（03 第 6 镜的 title 就是它自己的字幕原文）。
改成只看**认不出来的**那些键 / 列的值。那条闸门当初要挡的场景（作者用了表外字段名，
比如「字幕文字」「花字样式」）一字不差地仍然挡得住，对应单测原样通过。

#### 8.10.5.5 日志前缀改名

`[script] 上屏字段校验` → **`[script] 脚本字段校验`**（现在也管 title），
`VACUT_EVENT` 的 `workflowProgress.label` 同步改成「脚本字段校正 N/M 处」。
**`stage` / `phase` / `cardFieldCorrections` 字段名都没变，桌面端不用改。**
日志仍然只用 ASCII 符号 + 汉字（`[!]`，不用 `⚠`），新增的五条路径各有一条 gbk 编码断言。

#### 8.10.5.6 Mac 侧已跑

全量 **Ran 501**（基线 `d55c857` 是 426，**+75**），四组合
（`VIDEOAUTO_PACKAGING_SCRIPT_ONLY` × `PACKAGING_AGENT_SELECT`）均为 501，
失败清单与基线**逐条相同、零新增**（Mac 侧固有 7 项）。
`render_segment.py` / `template_packaging.py` / `text_layout.py` / 桌面端**一行没动**。

新增用例覆盖（`test_script_card_fields` 40 → 109）：表格读取层 12（共享字符串 vs
行内字符串、稀疏行、合并单元格、格内换行、多 sheet、sheet 名不许错位、坏 zip、
DTD 预检、列字母换算、csv、docx）、表头识别 15（表头不在首行、起始列非 A、三套列名写法、
两类 lookalike 列名、封面块不许抢表头、末尾重复表头不许废掉真表、没有号列时门槛 3、
认不出表头、单列不算表头、两个 sheet 都像、空 sheet 不挡真表、双语同名列、
两个「把对的改坏」的复现）、分组 12（合并号、一镜多行、一行多镜、`1-2` 让整组存疑、
表外列保护、空行、小计行、说明行、非 1..N、带装饰的号、无号列、重复表头）、
表格比对 10、其它格式 5（docx 两条、pdf/doc/xls、未知后缀、坏 workbook）、
title 8、新路径日志 2、B7 三格式等价 3、日志编码安全 2
（日志会原样回显作者写的值，作者放了 emoji / `⚠` 时在 gbk stdout 上会把这一层打崩，
输出统一过一道 `printable()`——**只净化日志，`shots.json` 里仍是原文一个字节不差**；
`VACUT_EVENT` 走 `ensure_ascii=True`，纯 ASCII 在任何编码下都安全且一个字不丢）、
对抗复审修订 9（两个复现 + 封面块抢表头 + 保险丝 + sheet 名错位 + `1-2` 存疑 +
表外值口径对齐 + DTD 预检）。

另跑了 **550 个随机脚本 × gbk stdout** 的模糊测试（零异常逃逸、零编码崩溃），
以及 **8 份真实生产 xlsx** 的回归（表头仍在第 20/21 行正确认出、各 8 镜）。

#### 8.10.5.7 B7 / B8 用的两份新测试脚本

`docs/packaging-test-scripts-2026-09-21/` 下新增与 `03_混合_show判定` **逐字等价**的两份：

- `07_表格版_混合_show判定_食品码垛_CN.xlsx` —— 9 列
  （分镜 / 分镜标题 / 时长 / 章节标签 / 画面 / 口播 / 字幕 / 上屏文字 / 卡片样式），
  **表头刻意放在第 5 行**，上面压一块真实生产脚本那样的纵向「模块一」封面文案；
- `07_纯文本版_混合_show判定_食品码垛_CN.txt` —— 同内容的 `.txt`（验证文本路不只认 `.md`）。

两份都保留 03 第 4 镜的长句标题和第 6 镜的「开场」——那是 B8 的两个 title 探针。
生成脚本 `VideoAutoCut/tests/make_table_test_scripts.py`（**在 tests/ 下，不进运行包**），
xlsx 由 `VideoAutoCut/tests/xlsx_fixture.py` 用标准库 zip + XML 拼出来——
与读取端同一套 OOXML，测试里同样不许装 openpyxl。
单测 `EquivalentScriptTests` 钉住三种格式抽出的东西**逐字相同**。

#### 8.10.5.8 A4 的「第二个可能原因」：**不修**（用户 9/21 拍板）

上一轮 B1 留了个并列嫌疑人：`packaging_agent.context_text()` 逐字段 `if value:` 过滤，
`card_content` 为空时**整个键不出现在 payload 里**，而提示词说的是「`card_content` 为空时」，
模型看到的是「没有这个键」。

**用户拍板不修**，理由是口径已经变了：「脚本没写上屏内容的就不上卡片，一切以脚本为准」。
默认配置（`VIDEOAUTO_PACKAGING_SCRIPT_ONLY=1`）下没有 `card_content` 的镜**根本不进模型**，
`show` 由脚本决定，模型判不判得准无关紧要。只有把 `SCRIPT_ONLY` 关掉的老路径才会走到
模型判 `show`，而**那条路径的判断质量不再是关注点**。

所以：
- **B1 降级**为「仅确认提示词已回到 `57ecd75` 版本」，**不作为通过门槛**；
- **不要再让 Windows 贴 `packaging-agent-log.json` 的 `input` 原文**去追这个；
- `context_text()` 一行不动。

## 9. 已修的老 bug 与下一轮清理

### 9.0 分页上屏文字渲不出来（0.5.9 起的老 bug，2026-09-18 修）

**症状**：任何需要分页的 `card_content`，`render_overlay` 在 `hyperframes lint` 阶段报
`gsap_exit_missing_hard_kill`，`render_segment` 退出 1，整条任务停在合成。

**根因**：`build_composition` 给每页生成一对淡入 / 淡出 tween，淡出正好收在 `end`，
也就是**下一页 clip 的起点**，而没有零时长的硬收尾。非线性 seek 可能落在淡出之后，
留下过期的可见状态，lint 判 error。单页不触发（淡出收在整段末尾，不是 clip 边界），
生产 app.env 里模板包装默认关闭，所以线上一直没暴露；`test_template_packaging` 里
那条分页测试只验分页结果、不经 lint，所以也没抓到。

**与 agent 无关**：Windows 侧用 `git show ba6553e` 的旧版逐字节复现了同样的错误。

**修法**：分页时在每页的淡出 tween 之后补 `tl.set("#page-{i}",{opacity:0},{end})`。
**单页的 html 一个字节不变**（单页不触发这条规则，保持对 `ba6553e` 的逐字节可对照性）。
本机用**钉死的 0.7.3**（`npm i hyperframes@0.7.3` 到临时目录）与系统上的 **0.8.5**
两个版本都验过：修之前两版都报同一条 error，修之后两版都是 `0 errors, 0 warnings`。
两版的 Fix 建议措辞不同（0.7.3 说直接 `tl.set` 到 `#page-N`；0.8.5 说 `#page-N` 是 clip
元素、建议包一层内部 div 再收尾），但**两版都接受 `tl.set` 这个写法**，所以取了改动更小的那个。

回归测试：`tests/test_packaging_agent.py::PagedCompositionTests`——逐页断言硬收尾的时间点、
单页不得出现 `tl.set`，外加一条**真 lint** 用例（四件套齐才跑，Mac 上 skip、Windows 上真跑）。

### 9.1 下一轮清理（不改代码，只记账）

0. **分页按像素换行会把词切开**：第 7 镜的「路径确认」被切成「路径确｜认」，第 2 页只剩一个
   「认」字。想让换行优先落在 `｜、/，,` 这类分隔符上，得改 `text_layout.wrap_text_pixels`
   ——但它同时被**字幕**（`common.py:390`）和**进度条标签**（`add_progress.py:293`）用着，
   改了会动到这两处的既有排版，超出本轮范围。要做就单独一轮，带上字幕与进度条的回归。
0.5. **真 lint 用例在仓库里恒 skip。** `tests/test_packaging_agent.py::PagedCompositionTests::test_real_hyperframes_lint_accepts_the_paged_composition`
   复用 `renderer_dependencies()` 探四件套，仓库工作区没有 `node-runtime`/chrome，所以只会 skip；
   解压后的运行包里会真跑。想在仓库里真跑，用覆盖键把四件套指过去（`VIDEOAUTO_NODE_EXE` /
   `HYPERFRAMES_CLI` / `HYPERFRAMES_GSAP` / `HYPERFRAMES_BROWSER_PATH`），命令见那条用例的 docstring。
   设了 `VIDEOAUTO_NODE_EXE` 之后不会再影响 `test_material_agent_select` 的 node 探测用例——
   `IsolatedRuntimeRootMixin.setUp` 已经把两个 node 覆盖键一起清掉了。
1. **`verify_segment_output` 的 `video` / `audio` 分类本身没有单测。**
   现在的接线测试把它整个 mock 掉了，验的是"分类出来之后怎么走"，没有验"ffprobe 的返回
   怎么变成分类"。补法：造几段 ffmpeg 合成的小片（尺寸对/不对、SAR 非 1:1、音轨改成
   44100 或单声道），直接调这个函数比返回的二元组。因为要真起 ffmpeg，放在下一轮跟
   `test_material_agent_select` 那种"用真 ffmpeg 造合成片"的测试放一起。

2. **`install_hyperframes.py --check` 在非 Windows 上恒红，不要进 CI。**
   自检复用 `renderer_dependencies()`，而它找的是 `node-runtime/node.exe`、
   `chrome-headless-shell.exe` 这些 Windows 路径，所以 macOS/Linux 上必然退出 1。
   它是**打包前的人工闸门**，不是跨平台测试：接 CI 时要么只在 Windows runner 上跑，
   要么干脆不接，别让它把别的平台的流水线拖红。

## 10. Mac 侧已跑结果（2026-09-18）

- `python3 -m unittest tests.test_packaging_agent tests.test_render_segment_packaging` → **Ran 34 tests, OK**。
- 五个模块两态各一遍 → **Ran 159 tests, FAILED (failures=2)**。这 2 项是
  `tests.test_material_selection_policy` 的 `/var` 与 `/private/var` 符号链接差异，
  **在未改动的 `ba6553e` 上 `git stash` 后复跑同样失败**，与本次改动无关（macOS 专有，Windows 不复现）。
  去掉该模块后两态均为 **Ran 147 tests, OK**。
- 成片字节一致性：同一条命令在「改动前 / 改动后开关关 / 改动后开关开（未开包装）」三种情况下
  sha256 完全相同（`bc992d57…`）。
- 端到端的 agent + overlay 冒烟**在 Mac 上跑不了**：四件套是 Windows 路径（`node-runtime/node.exe`、
  `chrome-headless-shell.exe`），`install_hyperframes.py --check` 在本机如实报缺件并退出 1。
  这部分只能在公司 Windows 机上按 §8 的 #0/#1/#3 验。
- 另发现一处 macOS 专有的既有问题（与本次改动无关，未修）：Homebrew 的 ffmpeg 解析
  `ass=...:fontsdir=...` 滤镜参数会报 `No option name near`，所以 Mac 上带字幕/进度条的分镜渲不了。

### 9.2 `verify.ps1` 的既有问题清单（**非本分支**，未处理，留给用户定）

2026-09-18 Windows 侧跑 `scripts/verify.ps1` 跑不完。以下四条**全部是既有问题**，与本分支无关
（本分支相对 `ba6553e` 只动了 `VideoAutoCut/` 下的文件，不涉及 Rust、桌面端和脚本），
且都落在「Rust / 桌面端 / 打包脚本零改动」的禁区里，所以本轮**刻意没碰**：

1. **`verify.ps1` 自身在 PowerShell 7.6 下报错**：「Python tests」那一步
   `无法处理参数，因为参数名称 'p' 存在歧义。可能的匹配项包括: -ProgressAction -PipelineVariable`。
   `Invoke-Python` 是 advanced function，传进去的 `-p "test_*.py"` 被当成了公共参数的缩写；
   改法应该是写全 `-Pattern`，或给参数换个不与公共参数前缀冲突的名字。
2. **`cargo clippy -D warnings` 失败**：`src/main.rs` 9 处 `needless_borrow` / `collapsible_if`，
   Rust 1.98 的新 lint；Rust 代码最后一次改动是 `75ec6d3`（0.5.12）。
3. **`npm run lint` 失败**：10 处 `react-hooks/set-state-in-effect`，在 `ScriptFilesDialog.tsx`、
   `ShotEditorDrawer.tsx` 等文件。
4. **`cargo test` 会在仓库根留下 `.codex-tmp/material-match-config-tests/`**（约 120 个 fixture）不清理。

其余步骤是过的：Python syntax、`cargo fmt --check`、`cargo test`（107+5）、`npm test`（397 pass）、
`npm run build` / `build:scripts`、Web 两项。
