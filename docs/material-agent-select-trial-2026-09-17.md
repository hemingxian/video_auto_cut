# 指定范围内的 agent 选材（试验，默认关闭）

状态：备用线路，默认关闭，未接入任何默认流程。基于 0.5.13（master `24d5588`）。引擎（Rust）零改动，桌面端零改动，只新增 / 修改 `VideoAutoCut/tools` 与 `VideoAutoCut/tests` 下的 Python 文件。关闭时 `material_selection_policy.py` 的行为与原版逐字相同。

目标：把「指定素材范围里选哪一段」交给 agent（Pi + 视觉模型）判断。任务照常在软件里跑、可查、可恢复；agent 的每次决定写在分镜目录的 `material-agent-log.json`，可逐条审计。

## 原理：为什么不改引擎也能插进去

引擎在剪辑阶段的既有顺序是：向量搜索 → 按最低分过滤 → 若开了「避开原字幕、logo 和水印」就把候选交给 `material_selection_policy.py` 子进程 → 读回 `material-policy-report.json` 里的片段路径继续合成。

本试验完全走这条已有通道，请求 / 报告的 JSON 契约不变：

- 素材匹配最低分设为 `0`：引擎不再自己拦截，把前 N 名候选原样交给 policy 脚本；
- 「避开原字幕、logo 和水印」（`MATERIAL_EXCLUDE_OVERLAYS`）开启：引擎必走 policy 脚本；
- 「指定范围随机兜底」（`MATERIAL_RANDOM_BOUND_FALLBACK`）开启：引擎会把该分镜绑定的索引目录 `bound_root` 一并写进请求，agent 才有范围可以自己重搜。**agent 从不随机选片**，这个开关在本线路里只用于拿到目录；
- `MATERIAL_AGENT_SELECT=1`：policy 脚本的 `main()` 把整个决定交给 `material_agent_select.run_agent_selection()`。

agent 的一轮流程：读同任务的 `shots.json` 取得本分镜文案 → 改写检索词（换抽象层级，不是换同义词）→ 在 `bound_root` 内用 `sentrysearch` 重搜并导出候选 → 每个候选抽帧并横向拼成一张图（一图一候选）→ 视觉模型排序打分 → 按引擎原格式返回 `paths` / `rejected` / `fallback`。

不可放宽的三条约束（代码内已强制）：

- 只返回 `clip_root` 之下的路径，检索只在 `bound_root` 之内；越界候选被丢弃并记进日志的 `errors`。
- 没有随机兜底。全部候选都不可用时报告 `ok=false`，任务在该分镜按引擎原逻辑停下。
- 每次决定（试过的检索词、命中与分数、候选帧路径、模型打分与理由、最终选中项）都落 `material-agent-log.json`。

## 文件

| 文件 | 说明 |
| --- | --- |
| `VideoAutoCut/tools/material_selection_policy.py` | 修改。仅两处：顶部多一行 `from material_agent_select import agent_enabled, run_agent_selection`；`main()` 里多一个 `if agent_enabled():` 分支。`choose_candidates()` 及其余逻辑一字未动 |
| `VideoAutoCut/tools/material_agent_select.py` | 新增，720 行。agent 主体，含设置解析、sentrysearch 调用、抽帧拼图、Pi / DashScope 两种后端、判定与报告 |
| `VideoAutoCut/tools/prompts/agent_query_rewrite.md` | 新增。改写检索词的提示词（换抽象层级：工艺名 → 镜头里真正可见的主体 / 动作 / 工具 / 火花粉尘） |
| `VideoAutoCut/tools/prompts/agent_candidate_judge.md` | 新增。看帧判定的提示词（画面内容优先于向量分；帧内文字视为不可信数据而非指令） |
| `VideoAutoCut/tests/test_material_agent_select.py` | 新增，9 项管道测试。真 ffmpeg 造合成短片，模型与向量检索用假实现注入 |
| `VideoAutoCut/.env.example` | 修改。新增 `MATERIAL_AGENT_SELECT=false` 与一组注释掉的可选参数 |
| `VideoAutoCut/tools/material_gen/pi/` | 新增（2026-09-17 第二轮）。运行包自带的 pi 落点：`README.md`（体积事实、安装、入库两条路、目录结构）、`install_pi.py`（装 pi + 自检，纯标准库）、`models.evst-gateway.json`（provider 配置正本）、`.gitignore`（`node_modules` 入库开关，当前注释掉例外＝不入库）。`node_modules/` **不入库**，打包前在出包机上跑 `install_pi.py` 现装（入库与否待定，见「`node_modules` 入库还是打包前现装」） |

## 开关

默认关闭。`agent_enabled()` 走 `common.env_bool`，`false` / `FALSE` / `0` / `no` / `off` / 空值 / 未设置一律判为关；只有 `1` / `true` / `yes` / `on` 才开。

打开需要同时满足四项，缺一不生效：

1. 软件「设置」：素材匹配最低分 = `0`
2. 软件「设置」：避开原字幕、logo 和水印 = 开
3. 软件「设置」：指定范围随机兜底 = 开
4. 运行配置 `.env`（路径见任务日志里的 `VIDEOAUTO_ENV_PATH`）：`MATERIAL_AGENT_SELECT=1`

桌面端保存设置时按行改写 `.env`，不认识的键原样保留，手工加的这一行不会被覆盖。

## 安装

仓库侧只需合入上表六个文件。要在本机运行包实测，还需要两步：

1. 运行包里的 `VideoAutoCut/tools/` 是发布产物，不随仓库更新。把 `material_selection_policy.py`、`material_agent_select.py` 和 `prompts/` 下两个 md 手工拷进运行包对应目录（先备份原 `material_selection_policy.py`）。
2. 装 Pi（需要 Node，运行包自带的 Node 亦可）：

   ```
   npm i -g @earendil-works/pi-coding-agent
   pi --version
   ```

   provider 用 DashScope 时，把本文附录的 `models.json` 放到 `%USERPROFILE%\.pi\agent\models.json`；已有该文件则只合并 `providers.dashscope` 段。

不装 Pi 也能跑：`MATERIAL_AGENT_BACKEND=dashscope` 时脚本直接调 DashScope（复用 `optimize_queries.call_qwen`），用于排查 Pi 本身的问题。

## API key 的来源

DashScope 的 key 不需要在本线路里另配。桌面端按账号下发密钥，在 `VideoAutoCutDesktop/electron/workspace-service.ts` 的 `createVideoAutoEnv()` 里写进引擎进程环境，并设 `VIDEOAUTO_REQUIRE_REMOTE_CONFIG=true` 与 `VIDEOAUTO_REMOTE_CONFIG_KEYS`；引擎再经 `VideoAutoCutApp/src/paths.rs` 的 `add_child_env()` 传给 Python 子进程，其中 `DASHSCOPE_API_KEY` 在白名单内（未下发时才 `env_remove`）。所以 `MATERIAL_AGENT_PI_PROVIDER=dashscope`（默认）时，`pi_api_key()` 直接读到 `DASHSCOPE_API_KEY`。

换别的 provider（DeepSeek、Anthropic 等）则 DashScope 的 key 用不上，两选一：在 `.env` 里设 `MATERIAL_AGENT_PI_API_KEY=...`，或在该机 `pi` 里 `/login <provider>` 登录一次（登录过的 provider 不必再传 key）。`MATERIAL_AGENT_*` 不属于 `common.REMOTE_SECRET_ENV_KEYS`，不会被 `load_dotenv` 的远端配置过滤掉，写在 `.env` 里即生效。

Pi 走 Anthropic 需要该机网络能出去；DashScope 不需要。

## 参数

都在 `.env`，都有默认值，不填即可。

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `MATERIAL_AGENT_SELECT` | `false` | 总开关。关闭时 policy 脚本行为与原版相同 |
| `MATERIAL_AGENT_BACKEND` | `dashscope` | **只有显式填 `pi` 才走 Pi**。运行包自带 pi，但不会因为「找得到 pi」就自动切过去（2026-09-17 收紧，旧版默认是「有 pi 就 pi」） |
| `MATERIAL_AGENT_PI_PROVIDER` | `dashscope` | Pi 的 provider |
| `MATERIAL_AGENT_PI_MODEL` | `qwen3-vl-plus` | 看图判定用的视觉模型 |
| `MATERIAL_AGENT_PI_TEXT_MODEL` | 同看图模型 | 文字改写检索词用的模型，可与看图模型不同 |
| `MATERIAL_AGENT_PI_API_KEY` | 空 | 非 dashscope provider 的 key；该机 `pi /login` 过则不必填 |
| `MATERIAL_AGENT_PI_EXE` | 空（用运行包自带的 pi） | **留空即可**。顺序：本变量 → 运行包内 `tools/material_gen/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` → `PATH` 上的 `pi`。想换别处的 pi 才填，可直接指向 `cli.js`（脚本自动加 `node`）；`cli.js` **不自包含**，同目录的 `node_modules` 必须在。**Windows 上不要指向 `pi.cmd` / `pi.bat`**：cmd 转发会截断多行参数（见文末实测），脚本检测到 `.cmd`/`.bat` 会自己找同目录的 `cli.js`，找不到直接报错 |
| `MATERIAL_AGENT_NODE_EXE` | 空（用运行包自带的 `node-runtime`） | **留空即可**。顺序：本变量 → `VIDEOAUTO_NODE_EXE` → 运行包 `node-runtime/node.exe` → `node/node.exe` → pi 同目录的 node → `PATH` |
| `MATERIAL_AGENT_PI_SKIP_PROVIDER_MERGE` | 空（= 合并） | 填 `1` 跳过「首启把包内 `models.{provider}.json` 合并进 `%USERPROFILE%\.pi\agent\models.json`」。自己维护 pi `models.json` 的机器用；关掉后 provider 没配好 pi 会直接报错 |
| `MATERIAL_AGENT_PI_THINKING` | `off` | Pi 思考档位（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`）。看图判定不需要长推理，开了明显变慢 |
| `MATERIAL_AGENT_MAX_QUERIES` | `3`（0–8） | 最多改写几条检索词重搜。`0` = 只判断引擎给的候选，不重搜 |
| `MATERIAL_AGENT_SAVE_PER_QUERY` | `3`（1–10） | 每条检索词导出几段候选 |
| `MATERIAL_AGENT_MAX_CANDIDATES` | `8`（1–20） | 送模型判定的候选上限。引擎候选优先，其余按向量分排序 |
| `MATERIAL_AGENT_FRAMES` | `3`（1–6） | 每个候选抽几帧拼成一张图 |
| `MATERIAL_AGENT_ORIENTATION_MODEL` | 空 | 只给「画面方向单独判一次」那一步换模型，留空则用同一个看图模型。**对 pi 后端同样生效**：这一步会临时覆盖 `MATERIAL_AGENT_PI_MODEL`（dashscope 侧覆盖 `DASHSCOPE_VISUAL_REVIEW_MODEL`），调用结束即还原，评审那一步仍用原模型 |
| `MATERIAL_AGENT_TIMEOUT` | `240`（30–1800） | 单次模型调用超时（秒） |
| `MATERIAL_AGENT_SHOTS_JSON` | 空 | 指定 `shots.json`，留空时从 `clip_root` 向上找 10 层 |
| `MATERIAL_AGENT_SENTRY_ENTRY` | 空 | 指定 `sentrysearch_entry.py`，留空时按 `VIDEOAUTO_ROOT` / `VIDEOAUTO_RUNTIME_ROOT` / 脚本上级目录依次查找 |

重搜沿用 `SENTRY_SEARCH_TIMEOUT_SECONDS`（默认 120 秒）。重搜子进程里 `VIDEOAUTO_MIN_MATCH_SCORE` 被主动移除：agent 自己看得到全部分数，不需要引擎阈值先筛一遍。

## 看结果

- 引擎日志出现 `[agent] 使用 agent 选取候选` / `[agent] 检索词: …` / `[agent] 选中: …` / `[agent] 记录: …`。
- 分镜 clips 目录下：
  - `material-agent-log.json`：试过的检索词、每条的命中数与分数、每个候选的帧路径、模型打分与理由、最终选中项、`errors`、耗时。
  - `_agent_q01/` …：agent 重搜导出的候选片段；`_agent_frames/cNN/`：抽帧与 `sheet.jpg` 拼图，供人工复核。
  - `material-policy-report.json`：引擎读的正式结果，格式与原来一致。
- 选不到时任务在该分镜停下，报错文案来自引擎原逻辑，原因看日志的 `errors`。

## 回滚

任一即可，无需重装或改引擎：

- `.env` 删掉 `MATERIAL_AGENT_SELECT=1`（或改 `0`），立刻回到原版行为；
- 或把 `material_selection_policy.py` 换回 master 版本并删掉 `material_agent_select.py`；
- 分支整体不合入 master 即视为未启用。

设置里的三个开关按需恢复（最低分 `0.25`，两个开关关）。

## 已知边界

- `MATERIAL_EXCLUDE_OVERLAYS` 开着时，Pexels 下载分镜也会走 agent（这类请求没有 `bound_root`，只判断引擎给的候选，不重搜）。试验期可接受。
- 引擎对 policy 子进程有每分镜超时保护。agent 三轮重搜加看帧通常 1–3 分钟；若撞上引擎超时，先把 `MATERIAL_AGENT_MAX_QUERIES` 调小。
- 判定时一个候选 = 一张横向拼图。单帧仍保留在 `_agent_frames/cNN/` 供人工复核。
- Pi 从子进程调用时必须关闭 stdin（代码里已 `stdin=subprocess.DEVNULL`），否则 Pi 在 print 模式下会等管道结束直到超时。
- Pi 在 provider 报错时退出码仍为 0，错误藏在 `message_end` 事件的 `stopReason=error`。`assistant_text_from_pi_events()` 已把它抛成 `RuntimeError`，不会变成空答案。
- sentrysearch 真重搜依赖 `chromadb`，Mac 侧未验证，公司 Windows 机上是第一次真跑。
- 本线路未接入自动化 CI，仅有上述 9 项管道测试。

## Mac 验证结果（2026-09-16 / 09-17）

| 验证 | 结果 |
| --- | --- |
| `tests/test_material_agent_select.py`（仓库布局，`python3 -m unittest`） | 9 项全部通过 |
| `tests/test_material_selection_policy.py` 合入前 / 合入后对照 | 12 项结果逐项一致，patch 未改变任何一项结论 |
| `tests/test_python_boundaries.py` | 15 项通过 |
| 真 Pi + 真模型（DeepSeek：改写 `deepseek-v4-pro`，看图 `deepseek-v4-flash-vision-exp`） | 3 条真实素材跑通，单分镜 7–9 秒 |
| 开「避开台标字幕」时的拒绝行为 | 正确拒掉带台标的候选；关掉后正确选中内容最贴切的一条 |

`test_material_selection_policy.py` 在 macOS 上有 2 项固有失败（`test_disabled_policy_does_not_call_model`、`test_rejects_logo_uncertainty_then_selects_next_actual_candidate`），原因是 `tempfile` 给出 `/var/...` 而 `Path.resolve()` 得到 `/private/var/...`，与本改动无关：把 policy 换回 master 原版后同样失败，逐项对照结果完全一致。Windows 上不存在该符号链接，应全部通过。

## 附录：`%USERPROFILE%\.pi\agent\models.json`

provider 用 DashScope 时使用。`apiKey` 字段只是占位，实际 key 由脚本用 `--api-key` 传入。

```json
{
  "providers": {
    "dashscope": {
      "name": "DashScope (Qwen, OpenAI-compatible)",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "api": "openai-completions",
      "apiKey": "set-by---api-key-flag",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "qwen3-vl-plus",
          "name": "Qwen3 VL Plus",
          "reasoning": false,
          "input": ["text", "image"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 131072,
          "maxTokens": 8192
        },
        {
          "id": "qwen-plus",
          "name": "Qwen Plus",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 131072,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

## Windows 实测记录（2026-09-17）

本次在 `feature/material-agent-select` 分支接续 `fa8383e`，使用 Windows 本机安装的 0.5.14 运行环境及其嵌入式 Python 3.11.9。没有修改 Rust、桌面端或素材服务端源码，没有修改默认参数或模型判定提示词。桌面端两个版本文件在开始前已有本地改动，未纳入修复提交。

### 修复及配置核对

1. 将分支中的 policy、agent 和两份提示词同步到安装运行包，备份被覆盖文件。`fa8383e` 的 `sys.path` 修复已通过真实嵌入式 Python 启动验证。
2. 手工只设置 `VIDEOAUTO_ENV_PATH` 会读到旧的本地 API 配置并收到 HTTP 401。复现时改为使用桌面端现有 `getGatewayKey` 逻辑读取当前账号已分配的网关密钥，同时注入 `DASHSCOPE_BASE_URL`、运行目录和远程配置键名单；密钥只在进程内存中传递，不写入复现脚本、提交或本文。
3. **代码修复 `2054c6e`**：共享 `call_qwen()` 遇到缺失密钥或 HTTP 错误会抛 `SystemExit`，agent 原来的 `except Exception` 无法捕获，导致没有审计日志和正式失败报告。现在只在 agent 的 DashScope 适配层将该异常转为 `RuntimeError`，保持既有 CLI 和关闭 agent 时的行为。新增两项回归覆盖判断失败落日志、改写失败后继续判断引擎候选。
4. 当前账号网关不提供默认 `qwen3-vl-plus`，真实请求返回 HTTP 404 `model_not_found`。核对账号可用模型及[阿里云模型说明](https://help.aliyun.com/zh/model-studio/qwen3-6-plus)后，仅在生产 `config/app.env` 末尾追加 `DASHSCOPE_VISUAL_REVIEW_MODEL=qwen3.6-plus`。原文件完整字节前缀保留；没有设置 `MATERIAL_AGENT_MAX_QUERIES=0`，没有降低阈值、关闭字幕/logo 排除或改变判定逻辑。
5. 软件现有内存队列中的运行目录含 `\\?\` 前缀，而恢复入口使用 `/material_manifest.json` 拼接，首次点击“从失败步骤继续”在 agent 启动前即报 Windows `os error 123`。这是桌面端现有路径问题，未在本分支修改。实测操作为退出软件、重新打开，在“历史任务”选择原记录并“恢复到工作台”，再点“从失败步骤继续”；这样队列使用历史枚举得到的普通 Windows 路径，原检查点与产物保留。
6. **代码修复 `eb62052`**：真实第二分镜收到 HTTP 400，服务明确报告 `Model output became abnormal while generating a JSON response for response_format`，没有返回判断结果。DashScope 适配层现在仅对这一类错误原样重试一次；普通 400、401、404 不重试，连续同类失败仍写正式失败报告。新增回归验证原请求不变、重试最多一次及其他 HTTP 错误不重试，没有修改评分提示词或判断逻辑。
7. **代码修复 `6b5b28b`**：第六分镜出现持续 HTTP 502 和 JSON 生成中断，单次原样重试已经实际触发。核对[结构化输出说明](https://help.aliyun.com/zh/model-studio/qwen-structured-output)和[思考模式说明](https://help.aliyun.com/zh/model-studio/deep-thinking)，`qwen3.6-plus` 默认开启思考，而稳定 JSON 输出需非思考模式。增加仅对 agent 生效的可选 `MATERIAL_AGENT_DASHSCOPE_THINKING=on/off`，经共享请求函数的可选参数透传，未配置时请求体保持原样。仅在生产 env 末尾追加 `MATERIAL_AGENT_DASHSCOPE_THINKING=off`；未改提示词、选材条件或任何既有默认值。暂停等待中的第六分镜，再恢复原检查点实测。

### 手工 policy 与回归验证

- 使用原失败任务 `run_370e6565a3814839a76f2b5567a1f60a` 的原始 `material-policy-request.json`，没有重写请求或注入假模型结果。
- 真重搜完成三轮，每轮返回三段；八个候选抽帧、拼图成功。`chromadb`、sentrysearch、ffmpeg/ffprobe 和长路径在本机这条真实路径中均可用。
- policy 退出码为 **0**，正式报告 **`ok: true`**，`material-agent-log.json` 中 **`errors: []`**，有一个 `picked` 及完整理由。模型选择候选 8：传送带输送包装、机械臂准备抓取的起始画面。
- 本次手工请求耗时 **225.29 秒**，过程中网关 HTTP 502 经既有重试机制恢复；不能以这一次结果保证后续模型请求无延迟。
- `python -m unittest tests.test_material_agent_select tests.test_material_selection_policy tests.test_python_boundaries`：首次修复后 38 项通过，补充 JSON 生成异常重试后 41 项通过，加入可选思考参数和请求体兼容验证后 **44 项全部通过**。

### 原任务完整出片验证

- 12:10:33 从软件历史恢复同一个 `run_370e6565a3814839a76f2b5567a1f60a` 并点击“从失败步骤继续”，12:15:01 引擎正常结束；软件显示“视频已生成”、进度 100%。由于工具文件变化，运行时重新计算了全部七个分镜的剪辑，而非直接复用前五段旧剪辑。
- 七份最终 `material-policy-report.json` 均为 `ok: true`；对应 `material-agent-log.json` 均有选中项和具体理由，`errors` 全为空。保留真重搜，未设置查询数为零；实际任务匹配阈值为 0.25，未降低。
- 分镜 policy 耗时分别为 **28.63、39.18、29.27、32.19、27.72、26.90、27.81 秒**。此前第六分镜的长时间 502 / JSON 中断在追加非思考配置后未再出现；这只代表本次实测结果，不保证网关今后无瞬时故障。
- 成片：`D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\01_包装换型与码垛_CN最终视频\01_包装换型与码垛_CN_v002.mp4`。
- 成片大小 **23,492,251 字节**，时长 **51.021333 秒**，**1920×1080**，包含音轨；ffprobe 检查和 FFmpeg 完整解码均通过，产物时间晚于本轮全部选材报告。
- 最后再次验证生产 `app.env` 保留原始文件的完整字节前缀；关闭 agent 时的 `choose_candidates()` 与 `60b3e3d` 基线源码完全相同。

### 仍保留的限制

- 桌面端带 `\\?\` 前缀的内存队列路径与 `/material_manifest.json` 拼接问题尚未修改，依照本任务禁止修改桌面端的范围约束保留；恢复操作采用“退出软件 → 重新打开 → 历史任务恢复到工作台 → 从失败步骤继续”。
- 账号网关没有默认 `qwen3-vl-plus`。本机试验使用追加的 `qwen3.6-plus` 与 `MATERIAL_AGENT_DASHSCOPE_THINKING=off`；其他机器开启试验时须自行核对账号可用的视觉模型。运行包不含账号密钥和生产 env，也不默认开启 agent。

### 引擎运行包与校验

- 使用现有 `VideoAutoCutDesktop` 发布脚本，设置 `VIDEOAUTO_RUNTIME_VERSION=0.5.15-agent-trial`、`VIDEOAUTO_RUNTIME_BASE_ROOT=D:\Video Edit\VideoAutoCut\workspace\runtime\0.5.14\VideoAutoCut` 后执行 `npm run release:pack:runtime`。现有 Rust 源码经 `cargo build --release --locked` 编译并通过引擎参数检查，桌面端未重新打包；未上传或覆盖线上版本清单。
- 基底的 `.env.example` 已先备份再同步为分支模板，包内 `MATERIAL_AGENT_SELECT=false`；本次涉及的三个 Python 工具和两份 agent 提示词与分支完全一致，`VideoAutoCutEngine.exe` 与本次编译产物完全一致。
- 运行包：`D:\autocut\video-auto-cut\VideoAutoCutDesktop\runtime-release\VideoAutoCut-runtime-0.5.15-agent-trial.zip`。
- 大小：**633,346,192 字节**。
- SHA-256：**`c602a28d5a81ac79980fb2c266757993d16f3ad64b0a28c82fdb330df118ea32`**。
- 同目录生成 `manifest.json` 和 `.zip.sha256`。完整解压 **18,720 个条目**且 CRC 无误；从解压后的实际包验证嵌入式 Python 的 `chromadb`、Pillow、agent 与 policy 导入，以及引擎参数、ffprobe 启动，全部通过。包内未包含 `.env`、`app.env`、`auth.json`、`device.json` 或用户缓存目录。
- 本机详细校验文件位于忽略目录 `VideoAutoCutDesktop/node_modules/.tmp/agent-repair-20260917/`：`video-verification.json`、`runtime-verification.json`，以及原配置/工具备份。该目录不纳入 Git。
- 按用户另行要求，最终核对仓库开发用 `VideoAutoCut/.env` 并追加模板中仍缺失的 15 个有效配置项，原内容和已有值完整保留；该开发 env 不纳入提交，且不进入运行包。

## 实测记录 2026-09-17（Windows 公司机）

本节供另一台电脑上的 Fable 接续阅读。取证日期为 2026-09-17；写入前本地 HEAD 与远端 `origin/feature/material-agent-select` 均为 `0c47ea12705f0e5534ef93f60cbb29969efb0604`。本轮只补文档、读取证据、重跑指定测试，没有改应用代码或配置，也没有重新生成视频、重新打包。

以下 D 盘产物和完整审计文件是公司机本地文件，未上传到 Git；本节的摘录随文档提交同步。报告不含密钥。

### 一、配置实际生效情况

**1. env 路径**

本机定位的生产配置为 `D:\Video Edit\VideoAutoCut\config\app.env`，复现状态文件 `VideoAutoCutDesktop/node_modules/.tmp/agent-repair-20260917/state.json` 的 `env` 字段也是该路径。

但“任务日志里 `VIDEOAUTO_ENV_PATH` 的原文”：**未核实**。磁盘 run.log 和本次取得的软件实时日志均未打印此变量。不能把定位路径冒充日志原文。启动源码 `VideoAutoCutDesktop/electron/workspace-service.ts:462` 设置 `VIDEOAUTO_ENV_PATH: envPath`。

**2. 生产文件当前值和位置**

| 键 | 当前文件值 | 行号与位置 |
| --- | --- | --- |
| `MATERIAL_MATCH_MIN_SCORE` | 空字符串：`MATERIAL_MATCH_MIN_SCORE=` | 第 89 行；接手前已有的 agent 追加段 |
| `SENTRY_MATCH_THRESHOLD` | `0.25` | 第 45 行；原有段 |
| `MATERIAL_EXCLUDE_OVERLAYS` | `true` | 第 91 行；接手前已有的 agent 追加段 |
| `MATERIAL_RANDOM_BOUND_FALLBACK` | `true` | 第 93 行；接手前已有的 agent 追加段 |
| `MATERIAL_AGENT_SELECT` | `1` | 第 95 行；接手前已有的 agent 追加段 |
| `MATERIAL_AGENT_BACKEND` | `dashscope` | 第 97 行；接手前已有的 agent 追加段 |
| `MATERIAL_AGENT_MAX_QUERIES` | 未设置有效赋值；仅第 99 行注释 `# MATERIAL_AGENT_MAX_QUERIES=3` | 使用代码默认 3，且实测三轮重搜 |
| `DASHSCOPE_VISUAL_REVIEW_MODEL` | `qwen3.6-plus` | 第 120 行；本次修复末尾追加段 |
| `DASHSCOPE_TEXT_MODEL` | `qwen-plus` | 第 8 行；原有段 |
| `MATERIAL_AGENT_DASHSCOPE_THINKING` | `off` | 第 123 行；本次修复末尾追加段 |

第 87 行原文：`# ===== 2026-09-17 agent 选材试验（追加，未改动上方任何原有配置）=====`。第 89–97 行是接手时已有的追加段；第 118–123 行是本次修复追加段。

**3. 备份差异、GUI 写入键、最低分来源**

备份为 `D:\autocut\video-auto-cut\VideoAutoCutDesktop\node_modules\.tmp\agent-repair-20260917\original\app.env`，117 行，SHA-256：`b68d6ad4804c726d5bf24e39a1e26e4dbadfc22fc6f309d897f09d1aff6f0dc0`。

12:15 成片校验记录 `video-verification.json` 的 `production_env_prefix_preserved` 为 `true`。本次写报告开始时也核对为 true。**取证期间文件发生变化**：当前文件修改时间为 `2026-09-17 14:14:15`，第 26 行 `PROGRESS_BAR=true` 变为 `PROGRESS_BAR=false`。因此当前文件已不再逐字节保留备份前缀。本轮没有写配置，不能凭差异确认是哪次 GUI 操作或哪个进程保存的。

备份到当前文件：改动 1 行、删除 0 个配置项、追加 6 行，完整差异如下：

```diff
-26:PROGRESS_BAR=true
+26:PROGRESS_BAR=false
+118:
+119:# Agent trial 2026-09-17: available vision model on the account gateway
+120:DASHSCOPE_VISUAL_REVIEW_MODEL=qwen3.6-plus
+121:
+122:# Agent trial: opt out of provider thinking for reliable JSON output
+123:MATERIAL_AGENT_DASHSCOPE_THINKING=off
```

没有更早的“GUI 保存前”快照或保存事件日志，**接手前最低分是否由 GUI 从 0 改为空值：未核实**。备份中的 `MATERIAL_MATCH_MIN_SCORE` 已为空，不能归因于本轮修复。

源码事实：GUI “素材匹配最低分”写 `MATERIAL_MATCH_MIN_SCORE`（`VideoAutoCutDesktop/src/config/settings.ts:21`），`0.25` 是占位提示。设置页变化后延迟 650 ms 调用 `writeEnv(configValuesToEnv(values))`；`workspace-service.ts:360` 按键替换、追加，保留未涉及的键。

引擎读取优先级（`VideoAutoCutApp/src/config.rs:125`）为 `MATERIAL_MATCH_MIN_SCORE` → `SENTRY_MATCH_THRESHOLD` → `MATCH_ACCEPT_THRESHOLD` → 默认 `0.25`。`env_f32()` 对空字符串返回 None。**按当前文件和该读取规则，最低分来自 `SENTRY_MATCH_THRESHOLD=0.25`**；已结束引擎进程的完整环境快照未保存，日志不能单独证明变量来源。

另有仓库开发文件 `D:\autocut\video-auto-cut\VideoAutoCut\.env`，此前按用户要求追加了 15 个缺失模板项；它与上述生产 app.env 是两个文件。

**4. 任务开头实际打印值**

软件实时日志原文：

```text
匹配接受阈值: 0.25
```

同一运行 `checkpoint.json.signature` 含 `match_accept_threshold: 0.25`。这行没有保存到磁盘 run.log。

### 二、代码改动

**5. 新增提交及范围**

接续基线是 `fa8383e`，其已有嵌入式 Python 的 sys.path 修复。公司机新增提交：

| 提交 | 根因/用途 | 文件 |
| --- | --- | --- |
| `2054c6e` | 共享调用抛 SystemExit，原 Exception 捕获不到，失败缺审计；在 agent 适配层转为 RuntimeError | `VideoAutoCut/tools/material_agent_select.py`、`VideoAutoCut/tests/test_material_agent_select.py` |
| `eb62052` | 真实 HTTP 400 报 JSON 生成中断；仅对该明确错误原请求重试一次 | 同上两个文件 |
| `6b5b28b` | 增加可选思考参数以验证 Qwen3.6 的 JSON 兼容问题；未配置时请求体不变 | `VideoAutoCut/tools/material_agent_select.py`、`VideoAutoCut/tools/optimize_queries.py`、`VideoAutoCut/tests/test_material_agent_select.py`、`VideoAutoCut/.env.example` |
| `0c47ea1` | 记录 Windows 实测与运行包 | `docs/material-agent-select-trial-2026-09-17.md` |

确实改了 tools 之外的**测试、示例配置、文档**；没有提交 Rust、桌面端、素材服务端源码变更。本节将另作一次文档提交。当前两个原有未提交修改是桌面端 `package.json`、`package-lock.json` 的版本 `0.5.13` → `0.5.14`，未纳入修复提交。

对基线与当前文件进行 AST 定位后源码片段逐字比较：`judge_candidates()` 相同，`run_agent_selection()` 相同，两份 agent 提示词未变。因此候选合并/截断、acceptable、pick、评分补充排序逻辑未改。改了异常处理、重试和可选模型调用参数；生产文件显式追加关闭思考，不能说模型调用条件完全未变。

调用层完整 diff 可直接查看：

```powershell
git diff fa8383e..6b5b28b -- VideoAutoCut/tools/material_agent_select.py VideoAutoCut/tools/optimize_queries.py
```

**6. 安装运行包文件与 HEAD 一致性**

运行根为 `D:\Video Edit\VideoAutoCut\workspace\runtime\0.5.14\VideoAutoCut`。安装文件、工作区文件与 Git HEAD 内容三方 SHA-256 一致：

| 相对运行根路径 | 三方共同 SHA-256 |
| --- | --- |
| `tools/material_selection_policy.py` | `930743d1e7daca73f674b8782667e4a03012d2a1f47b13df7d58cd797f6802d5` |
| `tools/material_agent_select.py` | `33030d22299313c1a08a5edbecd4016e00adb8569401b388a695b5d95e2e1975` |
| `tools/prompts/agent_query_rewrite.md` | `8e09f3a6f354f0bb2d1fe2bf1fe3ac7e7271f307136988636176fdfc95007938` |
| `tools/prompts/agent_candidate_judge.md` | `92a819cb3169bbf0c9f7ec613e80a3a7d81a65d674f0a1e5f687fa6bdf4e894f` |
| `tools/optimize_queries.py` | `b4afff88b2333b00b56618584f78818c8215a32ff65abb97033659ca3d57bae6` |

原交接列出的四文件之外，额外修改的 `optimize_queries.py` 也已同步。

### 三、跑的结果

**7. 最近一次完整任务**

- 名称：`01_包装换型与码垛_CN`；run id：`run_370e6565a3814839a76f2b5567a1f60a`；`shots.json` 中 7 镜。
- 日志开始 `2026-09-17 12:10:33`，完成 `12:15:01`，本轮耗时 **268 秒（4 分 28 秒）**，不含之前失败和暂停时间。
- 从同一历史任务“恢复到工作台”后点“从失败步骤继续”。工具文件改变，全部七镜重新选材，前五段没有直接复用旧剪辑。
- 软件显示“视频已生成”“100%”“任务已完成”；实时日志尾部原文：`任务 shots.json结束，退出码：0`。
- 成片：`D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\01_包装换型与码垛_CN最终视频\01_包装换型与码垛_CN_v002.mp4`。
- 23,492,251 字节，51.021333 秒，1920×1080，含音轨，完整解码通过；这不代表每个画面方向或模型理由正确，见第 16 项。

运行目录记作 R：

```text
D:\Video Edit\VideoAutoCut\workspace\video\runs\20260917\01_包装换型与码垛_CN\.videoautocut\runs\run_370e6565a3814839a76f2b5567a1f60a
```

**8. 本轮全部 `[agent]` 行**

磁盘 `R/run.log` 中该前缀为 0 行。软件实时日志仍有 42 行，已通过 Windows UI 读取，保存到本机审计目录 `report-ui-log.txt`。UI 自动化读取时换行被折叠，以下按前缀恢复分行；各行均与界面文本逐字核对，42 行数量一致，没有凭空补写。

```text
[agent] 使用 agent 选取候选（MATERIAL_AGENT_SELECT=1）
[agent] 检索词: packaging arriving on conveyor, robotic arm preparing to pick
[agent] 检索词: 包装箱沿传送带匀速移动，前端接近机械臂工作区，箱体表面印有饮料logo，无遮挡
[agent] 检索词: robotic arm extends toward incoming carton on conveyor, end-effector aligns horizontally with box top
[agent] 检索词: CNC产线末端自动上下料通用场景
[agent] 选中: match_004_bound_004_asset_c2ee7c22ef8b4814abdc564d042962c5_v1_00m50s-01m20s.mp4 —— 画面清晰展示了橙色机械臂和输送带上排列整齐的粉色包装箱，构图完整，无遮挡，完美契合'包装到位与机械臂动作'的观察视角。
[agent] 使用 agent 选取候选（MATERIAL_AGENT_SELECT=1）
[agent] 检索词: comparison of bagged and boxed items on feed line with different gripper settings
[agent] 检索词: 机械臂切换两种夹具：真空吸盘吸附纸箱顶部，夹爪夹持编织袋中部，两组物料并排在输送线上缓慢移动
[agent] 检索词: bag handling vs box handling on conveyor: gripper arms adjusting position, one with suction cups pressing flat surface, another with pincer gripping flexible bag edge
[agent] 检索词: 包装线机器人上下料
[agent] 选中: match_001_bound_001_asset_15957870fe894ee5887b3a0a5ac33ff7_v1_01m15s-01m35s.mp4 —— 画面清晰展示了白色袋料（Bagged items）在输送线上的状态，以及工人在旁整理/核对的动作，完美契合口播中关于'袋料...来料朝向、抓取位置...核对'的描述，且无烧录字幕干扰。
[agent] 使用 agent 选取候选（MATERIAL_AGENT_SELECT=1）
[agent] 检索词: robotic gripper lifting and rotating a package while maintaining full clearance
[agent] 检索词: 机械臂 gripper 夹持纸箱缓慢抬升15cm后顺时针旋转90度，周围无遮挡物，箱体边缘与机架间隙清晰可见
[agent] 检索词: gripper lifting box 15cm then rotating 90 degrees clearance visible around all sides
[agent] 检索词: 工业机器人上下料过程中的运动包络线验证场景
[agent] 选中: match_005_bound_005_asset_9194697b483a419aac4438ec042c204f_v1_00m00s-00m30s.mp4 —— 画面清晰展示了红色机械臂抓取整托白色瓶装货物进行抬升和旋转的动作，完美对应'抓具带料抬起、转向'及'检查外廓'的视觉需求，且无遮挡或水印。
[agent] 使用 agent 选取候选（MATERIAL_AGENT_SELECT=1）
[agent] 检索词: package being placed on pallet with attention to orientation, layer edge, and gripper withdrawal trajectory
[agent] 检索词: 纸箱被机械臂吸盘放置到托盘上，箱体长边与托盘边缘平行，顶层纸箱排列整齐无错位，吸盘缓慢垂直抬起离开箱面
[agent] 检索词: palletizing quality check: robot gripper retracting vertically after placing carton, carton orientation aligned with pallet edge
[agent] 检索词: 托盘码垛完成后的静态检查场景：操作员或摄像头俯视视角，聚焦纸箱层边缘齐整度、单箱朝向一致性、抓具已完全撤离垛面
[agent] 选中: match_005_bound_005_asset_9194697b483a419aac4438ec042c204f_v1_00m50s-01m07s.mp4 —— 画面清晰展示了码垛机器人将整层白色桶装产品放置在托盘上的动作，且抓具正在向上抬起（退出路径），能直观体现‘排列方向’和‘垛层边缘’的整齐度，完美契合分镜需求。
[agent] 使用 agent 选取候选（MATERIAL_AGENT_SELECT=1）
[agent] 检索词: overhead view showing coordinated positions of pickup station, conveyor, and palletizer
[agent] 检索词: overhead shot of three industrial stations aligned: robotic arm at pickup station, motorized conveyor belt running straight, palletizer robot placing boxes on wooden pallet
[agent] 检索词: industrial layout integration visualization showing spatial relationship between material pickup point conveyor path and palletizing zone
[agent] 检索词: top-down view CNC cell layout integration
[agent] 选中: match_003_bound_003_asset_118d0186208247498acc520eafcdb532_v1_00m25s-00m51s.mp4 —— 画面为标准的俯视视角（Overhead view），清晰展示了输送线、取料工位与码垛机器人的空间布局，完美契合'工位衔接可视化'和'整合视图'的需求，且无烧录字幕干扰。
[agent] 使用 agent 选取候选（MATERIAL_AGENT_SELECT=1）
[agent] 检索词: animated simulation of palletizing process contrasted with real-world failure tests
[agent] 检索词: pallet of stacked boxes tipping over with contents spilling out on floor
[agent] 检索词: real pallet stability test: boxes sliding off during vibration or tilt, not animation
[agent] 检索词: pallet spillage test failure physical demonstration
[agent] 选中: match_005_bound_005_asset_9194697b483a419aac4438ec042c204f_v1_00m50s-01m07s.mp4 —— 画面清晰展示了红色码垛机器人正在抓取白色桶装物料进行堆叠的动作，属于典型的‘动态演示’（工位配置/运动画面），且无烧录字幕或水印，符合口播前半句‘这些运动画面可以帮助理解工位配置’的视觉需求。
[agent] 使用 agent 选取候选（MATERIAL_AGENT_SELECT=1）
[agent] 检索词: engineer reviewing new package samples, desired stack pattern, and factory floor plan before adjusting gripper
[agent] 检索词: engineer holding physical cardboard package sample next to printed pallet stacking diagram on clipboard, pointing at factory floor layout map on wall
[agent] 检索词: pre-changeover setup: engineer compares 3D package mockup with 2D pallet pattern drawing and facility layout schematic
[agent] 检索词: factory worker preparing for packaging line changeover, showing package samples, stack pattern reference, and plant layout documents
[agent] 选中: match_002_bound_002_asset_bf69621a458943a49bd1b72529d9b4e8_v1_00m50s-01m00s.mp4 —— 画面展示了工程师在围栏外查看码垛好的样件（白色桶装产品），背景有红色机械臂，符合'准备新包装样件、目标垛型'的视觉描述，且无烧录字幕或水印。
```

本轮没有 `[agent] 记录:` 行。磁盘缺明细的原因是 `VideoAutoCutApp/src/process.rs:68` 的 `run_command()` 使用 stdout/stderr inherit，只把启动和退出状态写到 run.log；该 Rust 代码未改。

**9. 向量第一名与 agent 选择逐镜对照**

向量第一由 run.log 的 `#1` 与 request.paths[0] 交叉核对，表中是导出片段文件名。模型分数、理由、耗时来自审计 JSON；理由为模型原文，不表示人工认可。全部 picked.origin 为 engine。

| 分镜 id | 引擎向量第 1 名文件 | agent 最终选中文件 | 相同 | 模型分数及理由原文 | agent 阶段耗时 |
| --- | --- | --- | --- | --- | --- |
| 01 `shot_d98ab4143e574a2b8b62a903f0a429e5` | `match_003_bound_003_asset_118d0186208247498acc520eafcdb532_v1_00m25s-00m51s.mp4` | `match_004_bound_004_asset_c2ee7c22ef8b4814abdc564d042962c5_v1_00m50s-01m20s.mp4` | 否 | 95；画面清晰展示了橙色机械臂和输送带上排列整齐的粉色包装箱，构图完整，无遮挡，完美契合'包装到位与机械臂动作'的观察视角。 | 28.63 秒 |
| 02 `shot_07d448a383434d95a22f5d89a3db4999` | `match_002_bound_002_asset_bf69621a458943a49bd1b72529d9b4e8_v1_00m50s-01m00s.mp4` | `match_001_bound_001_asset_15957870fe894ee5887b3a0a5ac33ff7_v1_01m15s-01m35s.mp4` | 否 | 95；画面清晰展示了白色袋料（Bagged items）在输送线上的状态，以及工人在旁整理/核对的动作，完美契合口播中关于'袋料...来料朝向、抓取位置...核对'的描述，且无烧录字幕干扰。 | 39.18 秒 |
| 03 `shot_7324810f6f87446f8f5d142947d0186f` | `match_005_bound_005_asset_9194697b483a419aac4438ec042c204f_v1_00m00s-00m30s.mp4` | `match_005_bound_005_asset_9194697b483a419aac4438ec042c204f_v1_00m00s-00m30s.mp4` | 是 | 95；画面清晰展示了红色机械臂抓取整托白色瓶装货物进行抬升和旋转的动作，完美对应'抓具带料抬起、转向'及'检查外廓'的视觉需求，且无遮挡或水印。 | 29.27 秒 |
| 04 `shot_523bc78b4bf042599d675594f9893127` | `match_006_bound_006_asset_cefb3f4b89804025af2fe79e37b784e9_v1_02m05s-02m18s.mp4` | `match_005_bound_005_asset_9194697b483a419aac4438ec042c204f_v1_00m50s-01m07s.mp4` | 否 | 95；画面清晰展示了码垛机器人将整层白色桶装产品放置在托盘上的动作，且抓具正在向上抬起（退出路径），能直观体现‘排列方向’和‘垛层边缘’的整齐度，完美契合分镜需求。 | 32.19 秒 |
| 05 `shot_bac9b0cc105a4925a1776fd0cfc919d4` | `match_002_bound_002_asset_bf69621a458943a49bd1b72529d9b4e8_v1_00m00s-00m30s.mp4` | `match_003_bound_003_asset_118d0186208247498acc520eafcdb532_v1_00m25s-00m51s.mp4` | 否 | 95；画面为标准的俯视视角（Overhead view），清晰展示了输送线、取料工位与码垛机器人的空间布局，完美契合'工位衔接可视化'和'整合视图'的需求，且无烧录字幕干扰。 | 27.72 秒 |
| 06 `shot_ecca604741194a3389df0c7cdfe5009f` | `match_005_bound_005_asset_9194697b483a419aac4438ec042c204f_v1_00m50s-01m07s.mp4` | `match_005_bound_005_asset_9194697b483a419aac4438ec042c204f_v1_00m50s-01m07s.mp4` | 是 | 90；画面清晰展示了红色码垛机器人正在抓取白色桶装物料进行堆叠的动作，属于典型的‘动态演示’（工位配置/运动画面），且无烧录字幕或水印，符合口播前半句‘这些运动画面可以帮助理解工位配置’的视觉需求。 | 26.90 秒 |
| 07 `shot_c2735fc73a504d04bbb662eb68bfbec8` | `match_002_bound_002_asset_bf69621a458943a49bd1b72529d9b4e8_v1_00m50s-01m00s.mp4` | `match_002_bound_002_asset_bf69621a458943a49bd1b72529d9b4e8_v1_00m50s-01m00s.mp4` | 是 | 85；画面展示了工程师在围栏外查看码垛好的样件（白色桶装产品），背景有红色机械臂，符合'准备新包装样件、目标垛型'的视觉描述，且无烧录字幕或水印。 | 27.81 秒 |

向量第一名的七行日志原文：

```text
[2026-09-17 12:10:45] stdout:   #1 [0.681531] 003_bound_003_asset_118d0186208247498acc520eafcdb532_v1.mp4 @ 00:25-00:51
[2026-09-17 12:11:21] stdout:   #1 [0.547166] 002_bound_002_asset_bf69621a458943a49bd1b72529d9b4e8_v1.mp4 @ 00:50-01:00
[2026-09-17 12:12:06] stdout:   #1 [0.606583] 005_bound_005_asset_9194697b483a419aac4438ec042c204f_v1.mp4 @ 00:00-00:30
[2026-09-17 12:12:41] stdout:   #1 [0.587896] 006_bound_006_asset_cefb3f4b89804025af2fe79e37b784e9_v1.mp4 @ 02:05-02:18
[2026-09-17 12:13:19] stdout:   #1 [0.563260] 002_bound_002_asset_bf69621a458943a49bd1b72529d9b4e8_v1.mp4 @ 00:00-00:30
[2026-09-17 12:13:52] stdout:   #1 [0.566414] 005_bound_005_asset_9194697b483a419aac4438ec042c204f_v1.mp4 @ 00:50-01:07
[2026-09-17 12:14:27] stdout:   #1 [0.584194] 002_bound_002_asset_bf69621a458943a49bd1b72529d9b4e8_v1.mp4 @ 00:50-01:00
```

对应证据目录如下，均相对于 R；每个目录内有 `material-policy-request.json`、`material-policy-report.json`、`material-agent-log.json`：

```text
clips/f46078f0efc246389caa6c81ea506ab3cd83e80182f48f2187017c9e7cc3019e/435af0c6480b497392fcc334587723e3c3a69224bf396d2e5037043938691ab7/01 · 码垛流程观察起点
clips/2531580122c261371ccc737cef943a107afdff9f4868cbaecbe875bb154b3c4c/7b943322c55713c52e6f27e0a99c5b3ca8b86d7c3a5c6c26b0ada3f5a5673cbc/02 · 袋料与箱体处理差异
clips/6f89c5004fed93dc4b7eeffc497af1004ce6c9b9dd7b43e4e9e4ed60a2c731cd/fe6cf987f85b6a58d40793279c16fa3c63dc61646960d8a30116aa9eb423e000/03 · 抓具运动安全检查
clips/5ff58cca9e98d131e65b97cea9730c6bada01b359be5f38ae3b22b58b19d78d6/e6b45bd683764404d60fc9b56a98af4012e7c1fdf9b17c89f60e7700d6ad22ed/04 · 落垛后质量确认
clips/01a85a09a2d3e0989f1102eca47b6d25af48804331b7990be9a9c2dc84584bad/b97cbdaa0f7394a4e672c506f382c1828500d17b849e98f1d8370255caf74373/05 · 工位衔接可视化
clips/8bad2b3dbce5bb9ef2f07c4144b23c99e48716b2c081cab55a0bc0ff487e7e05/358091031db741d4a014ed5d1919fd10ac6403ce73cb3551151a80976ff609c0/06 · 动态演示的局限性
clips/9e63591d648bd84214e1f6163e6a23498457e86966d5463c4c27e81e1e76e58f/d95f123d09778c54a877295506398a33c653001243cd3382d11c35cde85a8565/07 · 换型前准备工作
```

**10. 重搜发生情况**

| 镜号 | queries 条数 | 按记录顺序的 hits | 重搜目录及 MP4 数 |
| --- | --- | --- | --- |
| 01 | 4 | 10, 3, 3, 3 | `_agent_q01`、`_agent_q02`、`_agent_q03` 均存在，各 3 个 MP4 |
| 02 | 4 | 10, 3, 3, 3 | `_agent_q01`、`_agent_q02`、`_agent_q03` 均存在，各 3 个 MP4 |
| 03 | 4 | 10, 3, 3, 3 | `_agent_q01`、`_agent_q02`、`_agent_q03` 均存在，各 3 个 MP4 |
| 04 | 4 | 10, 3, 3, 3 | `_agent_q01`、`_agent_q02`、`_agent_q03` 均存在，各 3 个 MP4 |
| 05 | 4 | 10, 3, 3, 3 | `_agent_q01`、`_agent_q02`、`_agent_q03` 均存在，各 3 个 MP4 |
| 06 | 4 | 10, 3, 3, 3 | `_agent_q01`、`_agent_q02`、`_agent_q03` 均存在，各 3 个 MP4 |
| 07 | 4 | 10, 3, 3, 3 | `_agent_q01`、`_agent_q02`、`_agent_q03` 均存在，各 3 个 MP4 |

每镜 queries 第一条是引擎查询（hits=10），后 3 条是实际 agent 重搜（各 hits=3）。但每镜进入最终视觉评审的池均为 **engine:8、agent:0**；原请求每镜有 10 个引擎候选，池上限默认 8。代码原文：

```python
candidates = (engine_first + agent_found)[:max_candidates]
```

因此**重搜确实发生，但重搜产物没有进入最终判断**。该截断逻辑来自原分支，本次未修复；此前“完整通过”的表述遗漏了这一验收。

**11. 后端、模型、计时和错误**

七份最终日志共同字段：

```json
{"policy":"agent-select-trial","backend":"dashscope","model":"qwen3.6-plus","ok":true,"errors":[]}
```

本轮没有用 Pi。文字改写配置为 `DASHSCOPE_TEXT_MODEL=qwen-plus`；调用代码在无图片时选择该键、有图片时选视觉模型。审计顶层 model 仅记录视觉模型，没有单独保存文字模型字段。

**逐次模型 API 耗时：未核实。** 没有单次改写/单次看图计时；表中 26.90–39.18 秒是整个 agent 阶段，包含改写、重搜、抽帧、拼图和看图，不能当作单次模型耗时。

逐镜 errors 原文：

```text
01 errors: []
02 errors: []
03 errors: []
04 errors: []
05 errors: []
06 errors: []
07 errors: []
```

本轮实时日志中 HTTP 400/401/404/502、timed out、JSON 生成中断均出现 0 次。

此前手工失败文件 `policy-first-run.log` 原文：

```text
Qwen query optimize HTTP 401: {"code":"INVALID_API_KEY","message":"Invalid API key"}
```

此前第二镜保存的 `json-generation-failure-log.json` 的 errors 原文：

```json
[
  "模型判断失败: Qwen query optimize HTTP 400: {\"error\":{\"message\":\"\\u003c400\\u003e InternalError.Algo.InvalidParameter: Model output became abnormal while generating a JSON response for response_format. The generation was aborted because the partial output may be incomplete or invalid JSON. Please retry the request or adjust your prompt or JSON schema.\",\"type\":\"invalid_request_error\"}}"
]
```

该历史样本另有 `ok:false`、`judge:null`、`picked:[]`。此前第六镜 502/JSON 重试过程在上方 Windows 实测记录中有记载；当前软件只保留最后一轮，未从当前日志复取旧 502 逐条原文，不补造。

**12. 明确拒绝导致停止的分镜**

最近一轮没有，七镜全部有 picked。R/clips 现存 13 份审计文件也都 ok:true，其中包含旧指纹成功记录，不能把 13 当作本轮分镜数。

保存的第二镜历史失败是上述 HTTP 400，judge:null，属于没有取得模型判断。没有保存证据表明因所有候选明确 unacceptable 而停止。更早未保存的此类拒绝：**未核实**。

### 四、测试与打包

**13. 指定测试完整结果**

本次写报告时在 `D:\autocut\video-auto-cut\VideoAutoCut` 重新执行以下命令，退出码 0：

```powershell
python -m unittest tests.test_material_agent_select tests.test_material_selection_policy tests.test_python_boundaries
```

完整输出如下；前两行是模拟 JSON 错误的回归输出，不是本轮真实模型报错。

```text
[agent] 视觉模型 JSON 生成中断，原样重试一次
[agent] 视觉模型 JSON 生成中断，原样重试一次
............................................
----------------------------------------------------------------------
Ran 44 tests in 2.726s

OK
```

**14. 运行包**

- 已生成版本 `0.5.15-agent-trial`。
- ZIP：`D:\autocut\video-auto-cut\VideoAutoCutDesktop\runtime-release\VideoAutoCut-runtime-0.5.15-agent-trial.zip`。
- 633,346,192 字节；SHA-256：`c602a28d5a81ac79980fb2c266757993d16f3ad64b0a28c82fdb330df118ea32`。本次再次读取 ZIP 计算，结果一致。
- 同目录有 manifest.json 和 `.zip.sha256`。完整解压 18,720 条目、CRC、关键源码/引擎一致性、实际包嵌入式 Python 的 chromadb/Pillow/agent/policy 导入、引擎参数、ffprobe 启动均通过；结果在本机 `runtime-verification.json`。
- 包内 agent 默认关闭，不带生产 app.env、账号凭据。未上传线上，不能从 manifest 中的 URL 推断试验 ZIP 已公开可下载。

实际命令：

```powershell
$env:PATH = 'C:\Users\evstm\.cargo\bin;' + $env:PATH
$env:VIDEOAUTO_RUNTIME_VERSION = '0.5.15-agent-trial'
$env:VIDEOAUTO_RUNTIME_BASE_ROOT = 'D:\Video Edit\VideoAutoCut\workspace\runtime\0.5.14\VideoAutoCut'
# 在 D:\autocut\video-auto-cut\VideoAutoCutDesktop 执行
npm run release:pack:runtime
```

调用已有 `scripts/pack-release.ts --runtime` 和 `scripts/pack-runtime.ts` 的编译产物，执行 `cargo build --release --locked`，没有打桌面端。脚本本来就在 Git，最近修改提交分别为 `bd3fcb6`、`3b7a419`；本次没有新写发布脚本。

### 五、未解决与观察

**15. 未解决项**

| 项目 | 当前事实/卡点 | 已做与未做 |
| --- | --- | --- |
| 重搜候选未入池 | 10 个引擎候选先占位，上限 8，七镜均 engine:8/agent:0 | 已核对代码、查询、目录、来源；未改合并策略 |
| 磁盘日志缺 agent 明细 | Rust inherit 输出未保存；UI 有 42 行 | 已从 UI 提取；未改 Rust |
| 第 5 镜横倒仍被选中 | 拼图和成片第 31 秒横倒，模型却给 95 分称标准俯视 | 已查看图片；未改旋转处理、素材、提示词、判定 |
| 模型理由超出可见证据 | 具体列在第 16 项 | 只记录观察，未重跑模型 |
| Pi 未验收 | 此次 backend=dashscope | 没有 Pi 端到端结果 |
| 桌面恢复路径 | 既有实测记录载明长路径前缀与 `/material_manifest.json` 拼接导致 os error 123；原失败日志已覆盖 | 曾重启软件、从历史恢复后跑通；本次未复现，未改桌面源码 |
| 单调用计时与历史 GUI 保存归因 | 当前证据不足 | 标记未核实；不为补证据改设置或再跑任务 |

**16. 选片质量观察**

本次查看了每镜候选拼图 `_agent_frames/cNN/sheet.jpg`，不同选择查看两张，相同选择查看同一张；另提取并查看成片第 31 秒，本机证据 `report-final-31s.jpg`。以下仅覆盖这些静帧，没有逐帧观看全部原片。

| 镜号 | 实际观察及理由核对 |
| --- | --- |
| 01 | 向量第一的三帧横倒；选中项方向正常，能见橙色机械臂、输送线、粉色瓶装组合包装。方向和工位关系更易阅读；模型称“包装箱”，静帧更像瓶装组合包装，不能直接认可箱体类别。 |
| 02 | 向量第一是网栏后的瓶装货物；选中项有白色袋料、输送线及人员整理动作，更贴近“袋料”部分。但三帧没有展示袋料/箱体完整对照或两种抓具调整。 |
| 03 | 两者相同。能见红色机械臂、抓具和成组白色瓶装产品；仅凭三帧不能确认完整带料抬升、转向全过程，不能说优于向量第一。 |
| 04 | 向量第一有网栏遮挡；选中项的垛层边缘和上方抓具更直接可见，观察边缘更容易。抓具完整退出路径仍需看连续视频。 |
| 05 | 向量第一方向正常但有网栏；选中项横倒。模型称“标准的俯视视角（Overhead view）”，与所见不符：人、设备、地面一起侧转，转了 90 度不等于俯视。成片第 31 秒也横倒；在画面方向这项上比向量第一差。 |
| 06 | 两者相同。三帧可见机械臂和码放货物，未见破包、滑移、满垛稳定性试验，也不是动画仿真。理由只对应口播“运动画面帮助理解工位配置”部分。 |
| 07 | 两者相同。网栏后有穿工作服人员和瓶装产品；无法从帧确认人员是工程师。未见目标垛型图、现场布局图、明确抓具调整核对过程；理由比可见证据更宽泛。 |

此前完整解码和第 26 秒抽帧通过，不能推广为全部七镜画面正常；本节第 5 镜的横倒记录修正了这一验收遗漏。

## 第二批修复 2026-09-17（Mac 侧，针对 Windows 实测记录第 10/15/16 项）

| commit | 修什么 | 怎么修 |
|---|---|---|
| `ab9b8ae` | 重搜候选被截断，7 镜全部 engine:8 / agent:0 | 合并改按名额：去重键从裸文件名改为「源文件+起止秒」，agent 至少占 `ceil(上限×MATERIAL_AGENT_RESERVE_RATIO)`（默认 0.4，8 → 4），引擎按向量分顺序填其余；一方不足名额让给另一方 |
| `05e9b28` | 横倒画面被选中且被称作「俯视」 | 提示词要求每个候选给 `orientation`（upright/rotated/unsure），并写明「俯视 ≠ 横倒」；代码确定性兜底：rotated 一律不可用（模型分不采信），unsure 扣 30 分且排在所有 upright 之后；抽帧时 ffprobe 读旋转元数据记为 `metadata_rotation`（只记录不判定） |
| `e6474e7` | 分数扎堆 95、理由超出画面证据、第 4 条检索词跑题 | 评分口径改五档，≥90 必须 `missing` 为空；新增 `visible`/`missing` 字段，`reason` 只能引用 `visible`；检索词必须含口播里的具体物体和动作，禁泛化行业词 |

新增可调参数：`MATERIAL_AGENT_RESERVE_RATIO`（0–1，默认 0.4）。log 里新增 `orientation` 段和候选的 `metadata_rotation` 字段，`candidates` 里 origin 可统计 engine/agent 各几个。

验收清单（Windows 侧执行，结果回 Gitee issue IKGH73）：
1. GUI「素材匹配最低分」填 0 保存，`app.env` 里 `MATERIAL_MATCH_MIN_SCORE=0`，任务日志「匹配接受阈值: 0.00」。
2. 同一任务 `01_包装换型与码垛_CN` 重跑全部分镜，每镜 `material-agent-log.json` 的 `candidates` 里 origin=agent 的数量 ≥ 1（预期 4）。
3. 第 5 镜不再选中横倒片段；所有镜 `orientation` 段里没有 rotated 被选中；成片第 31 秒附近画面方向正常。
4. 7 镜分数不再全 ≥ 90；每条 ranking 有 `visible`/`missing`，`missing` 非空的分数 ≤ 89。
5. 4 条检索词都能说出「谁对什么做什么」，没有「通用场景」「验证」「解决方案」这类词。
6. 每镜 agent 阶段耗时与上轮（27–39 秒）相比增幅 ≤ 30%（多了 ffprobe 和更多候选）。
7. 测试：`python -m unittest tests.test_material_agent_select tests.test_material_selection_policy tests.test_python_boundaries` 全绿。

## 第二批 Windows 验收结果（2026-09-17）

被测 `d0bb033`：7 镜完整出片、阈值 0.00、51 项测试通过，第 5 镜方向修复在本次样本通过；候选来源、耗时及检索词仍有不通过项，另有视觉理由超出证据。未重新打包发布。详见 [完整验收记录](material-agent-select-batch2-validation-2026-09-17.md)。

## 第三批修复 2026-09-17（Mac 侧，针对 batch2 验收报告 A/B/C/耗时）

| commit | 修什么 | 怎么修 |
|---|---|---|
| `afbbd62` | 重搜命中的引擎候选被当重复丢弃（4 镜 agent:0，含被两次命中的引擎第 10 名） | 去重改合并来源：命中引擎候选标 `origin=both` 并记 `agent_hits / agent_queries / agent_rank`；名额分配把 both 算 agent 侧，按 agent_hits 降序优先进池；log `duplicates` 改 `merged`，`candidate_pool` 有 engine/agent/both 三计数 |
| `4c0cc45` | 网栏遮挡写「无遮挡」95 分；侧面平视写「俯视」；45 分「勉强可用」被选中 | 提示词新增必填 `obstruction`(none/partial/heavy) 与 `camera_angle`(overhead/high/eye_level/low/unsure)，先判机位遮挡再对照口播；代码 `deterministic_review()`：heavy 封顶 50 且不可用，partial 封顶 75，`MATERIAL_AGENT_MIN_ACCEPT_SCORE`（默认 60）以下一律不可用；全拒时 ok=false、errors 逐条写 missing、log 写 `fallback_suggestion`。log 的 `orientation` 段改名 `review` |
| `632cc2a` | 检索词仍有概念串、编造对象、剪辑叙述 | 提示词删「上位词兜底」改「另一个可见细节」，硬规则主体+动作+对象、只用文案里的名词、三条真实反例；代码 `query_is_concrete()` 黑名单 + 动词判定过滤，被拒记 `rejected_queries` 不重搜 |
| `db57aca` | agent 阶段耗时 +36%~73% | 评审输出限长（visible/missing ≤4 条 ≤15 字，reason ≤40 字，去 summary）；log/report 新增 `timings`（rewrite/search/frames/probe/judge 秒） |

⚠️ 兼容性：log 里 `orientation` 段改名 `review`；`report["agent"]` 新增 `rejected_queries`、`timings`。

验收清单（Windows 侧执行，结果回 issue IKGH73）：
1. 同一任务 `01_包装换型与码垛_CN` `--restart-all` 重跑；`candidate_pool` 里 both+agent ≥ 1 的分镜 ≥ 6/7；上轮 02/04 镜被两次命中的引擎第 10/9 名应进池（origin=both）。
2. 第 3 镜类：主体在网栏后的候选 `obstruction` ≠ none 且调整后分 ≤ 75；没有 heavy 遮挡候选被选中。
3. 第 5 镜类：`camera_angle` 与画面一致（侧面/平视不得判 overhead）；口播要 overhead 而候选不是时 `missing` 里有机位不符。此项若模型仍判错，贴 sheet 路径与原文，这一项只有提示词防线。
4. 第 7 镜类：调整后分 < 60 的候选没有被选中；若某镜全拒，任务在该镜停下，errors 有逐候选 missing，log 有 `fallback_suggestion`——**这是预期行为，不算失败**，回帖写明是哪一镜、fallback_suggestion 内容。
5. 28 条检索词（含引擎原词）里 agent 改写的 21 条：无黑名单词、无文案外新增材质/工件、无剪辑叙述；`rejected_queries` 若非空贴原文。
6. 耗时：贴每镜 `timings` 五项与 elapsed；判断标准改为 judge_seconds 相比上轮估算是否下降，总耗时不再硬卡 30%。
7. Windows 三组测试全绿。

## 第三批 Windows 验收结果（2026-09-17）

被测 `6fb56f1`：65 项 Windows 测试通过，01–06 均有 both/agent 入池，第 6 镜全拒并停止符合预期，第 7 镜未执行。第 5 镜仍把横倒当俯视选中，04 指定候选仍被配额截掉，检索词与模型可用性判断仍有不通过项；judge 总耗时相对上轮估算基本持平。未重新打包发布。详见 [完整验收记录](material-agent-select-batch3-validation-2026-09-17.md)。

## 第四批修复 2026-09-17（Mac 侧，针对 batch3 验收 + 用户决策「全拒时占位出片」）

| commit | 修什么 | 怎么修 |
|---|---|---|
| `b4c779c` | 同一横倒 sheet 在有「要俯视」文案的分镜被判 upright 选中 | 方向单独调一次模型（新 prompt `agent_orientation_check.md`，不给任何文案，只问重力方向）；独立判定 / 评审判定 / run 级缓存三方任一说 rotated 即 rotated；缓存 `clips/_agent_cache/orientation.json`，key=候选 clip 文件 sha256，同一段素材一旦判过横倒后续分镜直接沿用；timings 加 `orientation_seconds`；log 每候选记 `orientation_independent / orientation_judge / orientation_final / orientation_cache_hit` |
| `2f1716d` | pick 为空却被程序补选；3 条 missing 仍 85 分 | pick 为空 = 模型明确不推荐，硬拒，不再从 ranking 补；missing 条数封顶 1→89 / 2→75 / ≥3→55；**新 env `MATERIAL_AGENT_FALLBACK`（默认 `fill`）**：全拒时用备选占位继续出片（顺序 upright 优先 → 遮挡 none<partial<heavy → 调整分 → agent_hits），report 顶层 `fallback_used: true` + `fallback_reason`，picked reason 前缀「【占位】」，errors 保留逐候选 missing；`stop` 模式 = 任务在该镜停下 |
| `e09c9df` | `top-down shot` 漏拦、`connects` 误拒、编造尺寸 | `shot` 整词拦截但放行 shot blasting/peening；动词表大扩（connect/link/pass/tilt/spill/…，中文加 连接经过进出到停起降开合松靠贴升摆晃倒滑翻）；检索词里的数字尺寸分镜文案里没有就拒；机位词（overhead/top-down/俯视）明确放行；prompt 加「物体名词必须在分镜原文逐字可查」+ 5 个编造反例 |
| `ded60a7` | 模型不听 40 字限制 | 解析后截断（reason 60 字、列表项 20 字、列表 4 条，标 `truncated`）；`.env.example` 说明 `MATERIAL_AGENT_MAX_CANDIDATES` 调小可减 judge 时间但会挤掉 both/agent 名额 |

⚠️ 兼容性：report 顶层新增 `fallback_used`、`fallback_reason`；log `fallback_suggestion` 在 fill 模式下改名 `fallback_used`（stop 模式仍叫 `fallback_suggestion`）；每镜多一次视觉调用（方向独立判定）。

验收清单（Windows 侧执行，结果回 issue IKGH73）：
1. 同一任务 `--restart-all` 重跑，**应 7 镜全部跑完出成片**（第 6 镜预期走占位）。
2. 第 5 镜：那张横倒 sheet（sha `6dbc30c3…`）在所有分镜 `orientation_final=rotated`，不被选中；log 里能看到 `orientation_independent` 的判定和 `orientation_cache_hit`（第二次遇到起）。成片抽帧无横倒。
3. 第 6 镜：report `fallback_used=true`，引擎日志「[agent] 选中:」那行以【占位】开头；占位的是 upright + obstruction none 的候选（按上轮数据应是候选 4 或 7，不是 heavy 的候选 1）。
4. 第 2 镜类：pick 为空的分镜不再从 ranking 补选；missing ≥3 条的候选调整分 ≤55 未被选中。
5. 检索词：`top-down shot …` 被拒、含 connects 的通过、无「N 厘米」类编造尺寸；`rejected_queries` 贴原文。
6. timings 贴 orientation_seconds；judge_seconds 与上轮对比。
7. Windows 三组测试全绿。

## 第四批 Windows 验收与试验包（2026-09-17）

被测 `3d5f2e5`：80 项测试通过，7 镜完整生成 v004；02/06/07 为明确占位。固定第五镜候选池补充复测确认独立方向判断和缓存挡住了模型仍然推荐的横倒素材；成片9处抽查方向正常。第四批功能清单通过，另记录02/06/07独立方向响应顶层list导致的降级及画面内容仍有缺失。

已生成 `VideoAutoCut-runtime-0.5.15-agent-trial-batch4.zip`（633,365,651字节），SHA256 `0a768dfb6878e995bb9e2819ac84c364c3298b6e90b0beff8d292b22e7acc0e9`，ZIP完整性及受测四文件一致性通过。本机现有0.5.14目录保留经验证的第四批tools覆盖部署，未上传线上或重打桌面端。详见 [完整验收与打包记录](material-agent-select-batch4-validation-2026-09-17.md)。

## Pi 通路验证 2026-09-17（第一步「Pi 接进去」）

网关实测（`ai edit/网关可用模型_2026-09-17.md`）：引擎走中转 `https://api.evstai.com/v1`，能看图的只有 `qwen3.6-flash` / `qwen3.6-plus`（默认开思考，稳定 JSON 需 `enable_thinking:false`）。Pi 走同一网关的 provider 配置见 `VideoAutoCut/tools/material_gen/pi/models.evst-gateway.json`（`samplingParams` 会原样并进请求体，用它透传 `enable_thinking:false` 和 `response_format`）。那份是**正本**，随运行包一起发；`docs/pi-models.evst-gateway.json` 保留为同内容副本，改动以 tools 下那份为准。

Windows 侧步骤：
1. `pi --version` ≥ 0.85；把 `docs/pi-models.evst-gateway.json` 合并进 `%USERPROFILE%\.pi\agent\models.json` 的 `providers` 段（已有其他 provider 保留）。
2. 生产 `app.env` 追加段里改/加（不动原有行）：
   ```
   MATERIAL_AGENT_BACKEND=pi
   MATERIAL_AGENT_PI_PROVIDER=evst-gateway
   MATERIAL_AGENT_PI_MODEL=qwen3.6-plus
   MATERIAL_AGENT_PI_TEXT_MODEL=qwen-plus
   MATERIAL_AGENT_PI_THINKING=off
   ```
   key 不用配：provider 为 `evst-gateway` 时脚本自动复用账号下发的 `DASHSCOPE_API_KEY`（commit 见 git log「Pi 走网关复用 DashScope key」），不需要启动器注入，也不写文件。
3. 同一任务 `--restart-all` 重跑（新 run_id、新审计目录）。
4. 验收：
   - 7 镜 `material-agent-log.json` 顶层 `backend == "pi"`，零「pi 退出码」/「pi 模型调用失败」错误，独立方向调用零降级。
   - 7 镜选中项与 batch4（run_3396f98f…）逐镜对照：origin/候选文件/占位与否一致的镜数 ≥ 5/7（模型非确定，允许小差异；差异镜贴两边 reason）。
   - timings 逐镜贴出，对比 batch4：rewrite/orientation/judge 三项增幅（Pi 子进程启动开销预期每次 +1～2 秒）。
   - Windows 长路径：`_agent_frames/cNN/sheet.jpg` 以 `@` 传给 pi 能被读到（看 pi stderr 无 ENOENT）。
5. 通过后再做 A/B：只改 `MATERIAL_AGENT_PI_MODEL=qwen3.6-flash`（方向+评审都用 flash）重跑一次，对比选中一致镜数和 judge/orientation 耗时，给「flash 是否够用」的结论。
6. Pi 通路通过后的打包项（另开一轮）：把 pi 打进运行包 `node-runtime`，`MATERIAL_AGENT_PI_EXE` **指向包内 `…/pi-coding-agent/dist/bundle/cli.js`（不是 `.cmd`/`.bat` 之类的 shim）**，node 用 `MATERIAL_AGENT_NODE_EXE` 指向 `node-runtime` 里的 node 可执行文件，models.json 由脚本首次运行合并进用户目录。

### Windows 实测 1：pi.CMD 截断多行参数（`ee9c577`）

**现象**：按上面步骤配好后整跑，每个分镜的 Pi 调用都在 0.23 秒内失败，报 `ValueError: 模型没有返回 JSON 对象:`（冒号后为空）。pi 进程 `returncode=0`、`stderr` 为空，stdout 只有一个 session 事件，没有 `message_end`，所以 `assistant_text_from_pi_events()` 拿到空串。

**根因**：`shutil.which("pi")` 在 Windows 上解析到 npm 生成的 `C:\Users\<user>\AppData\Roaming\npm\pi.CMD`。这个 shim 经 cmd.exe 用 `"%_prog%" cli.js %*` 转发参数，**cmd 会把参数在第一个换行处截断**——`--system-prompt` 的多行内容只进去第一行，其后的 `--api-key`、`--`、`@图片`、用户文本全部丢失。pi 收到半截命令行，没有用户消息可答，直接退出。system prompt 和 user_text 都是多行，所以是必然失败而不是偶发。即使把换行去掉也不安全：cmd 对 `"` `%` `^` `&` `|` `<` `>` 同样有转义风险。

**修法**：新增 `pi_command() -> list[str] | None`，返回启动 pi 的命令前缀而不是单个可执行文件。`MATERIAL_AGENT_PI_EXE` 指向 `.js`/`.mjs`/`.cjs` 时返回 `[node, 该文件]`；解析结果是 `.cmd`/`.bat`（大小写不敏感）时到同目录找 `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`，找到就 `[node, cli.js]`，**找不到就抛 RuntimeError 并把 shim 路径和期望的 cli.js 路径都打出来**（不静默退回 shim——那等于让它继续静默返回空结果）；其他情况仍是 `[exe]`。node 的解析顺序是 `MATERIAL_AGENT_NODE_EXE` → pi 同目录的 `node.exe`/`node` → `PATH` 里的 node，都找不到也抛 RuntimeError。`ask_pi()` 只把这个前缀拼到原命令最前面，参数顺序、prompt、阈值、判断逻辑一律未动，`ask_dashscope` 未动。

**复验方式**：先用同一个冒烟脚本（单镜、一张 sheet、多行 system prompt）确认 pi 能返回 `message_end` 且 JSON 可解析、stderr 无 ENOENT（含 303 字符长路径的 `@` 传图），再做整跑；整跑仍按上面「Pi 通路验证」第 4 条的四项验收。

**`app.env` 的优先级坑（Windows 侧指出）**：`app.env` 第 97 行已经有一行 `MATERIAL_AGENT_BACKEND=dashscope`。启动器解析 `app.env` 是**后写生效**（后面的行覆盖前面的），但 `common.load_dotenv` 用的是 `os.environ.setdefault`，是**先写生效**（先出现的键赢）。所以「在文件末尾追加 `MATERIAL_AGENT_BACKEND=pi`」这个做法，在直接读 `app.env` 的路径（手动 PowerShell 跑脚本、或用 `VIDEOAUTO_ENV_PATH` 指过去）下**不生效**，仍然走 dashscope。正确改法：

- **已存在的键就地改那一行的值**——目前只有 `MATERIAL_AGENT_BACKEND`，把第 97 行直接改成 `MATERIAL_AGENT_BACKEND=pi`，不要在末尾另加一行；
- 其余 4 个新键（`MATERIAL_AGENT_PI_PROVIDER` / `MATERIAL_AGENT_PI_MODEL` / `MATERIAL_AGENT_PI_TEXT_MODEL` / `MATERIAL_AGENT_PI_THINKING`）文件里没有，仍追加在末尾段即可；
- 验证走到哪条后端，**以 agent log 里 `backend_name()` 的输出为准**（`material-agent-log.json` 顶层 `backend`），不要凭 `app.env` 长什么样推断。

### Windows 实测 2：Pi 通路通过，一致性 2/7 与横倒高分（`0ad50b9`）

**对方结果**：按上面的修法整跑，Pi 通路本身**通过**——7 镜 `backend == "pi"`，零 `pi 退出码` / `pi 模型调用失败`，长路径 `@` 传图正常。但选材结果不理想：与 batch4 逐镜对照只有 **2/7 一致**，**5/7 落到占位**。更要紧的是评审口径漂了：同一段**横倒画面**在 Pi 通路下被评审模型**两次打到 95 分**（dashscope 直调同样的片段最高只给 50），靠后面独立的方向判定才拦下来，没有漏进成片。另外 `eb55adf` 加的「顶层数组补一句对象格式要求重试一次」当时**只在 `ask_dashscope` 里**，Pi 路径没有等价物，模型一旦回顶层数组就直接丢掉整条独立判断。对方怀疑是输入顺序：`ask_pi` 的命令行是 `-- @img1 @img2 … user_text`（图片在前），而 `ask_dashscope` 是文本在前、图片在后。

**查清的 pi 拼装事实（实证，非推断）**：在 Mac 上用 pi 0.85.1 做了两组对照——把 provider 的 `baseUrl` 指向本地 `127.0.0.1` 的抓包服务，`HOME` 指到临时目录（不碰真实 `~/.pi`），分别以 `-- @a.jpg @b.jpg "USER_TEXT"` 和 `-- "USER_TEXT" @a.jpg @b.jpg` 各跑一次，拿到的 user message **完全一致**。结论：

1. **图文顺序与命令行顺序无关，pi 固定「文本在前、图片在后」，本来就和 dashscope 一致。** `parseArgs`（`src/cli/args.ts:83-90`）把 `--` 之后的位置参数按 `@` 前缀拆进 `fileArgs` 和 `messages` **两个数组**，命令行上的交错顺序当场就丢了；`buildInitialMessage`（`src/cli/initial-message.ts`）固定拼成 `<file name="…"></file>` 若干行 + `messages[0]` 当一段文本；`AgentSession.prompt`（`src/core/agent-session.ts:1269-1272`）固定组成 `[{type:"text",…}, 图片, 图片…]`。实证抓到的 user content 就是 `['text','image','image']`，text 块是 `<file name="…/a.jpg"></file>\n<file name="…/b.jpg"></file>\nUSER_TEXT_MARKER hello`。**所以「顺序」这个怀疑方向可以排除，横倒高分不是图文顺序造成的。**
2. **多个非 `@` 位置参数不会被空格拼成一段**，而是被当成**多轮对话逐条发送**（`src/modes/print-mode.ts:135-137` 对 `messages[1:]` 逐条再 `prompt` 一次）。实测传三个文本参数 → 三次独立请求。所以 `user_text` 必须是**单个**参数（现在就是）。
3. **图片确实转成 `image_url` data URI**：`convertMessages` 把 image 映射成 `{type:"image_url",image_url:{url:"data:image/jpeg;base64,…"}}`（`dist/bundle/chunks/openai-completions-*.js`），与 `ask_dashscope` 手拼的完全同形。`--system-prompt` **不是完全原样**进 system message：pi 会在末尾追加一行 `Current working directory: <cwd>`（`src/core/system-prompt.ts` 的 `customPrompt` 分支；`--no-skills --no-context-files` 已经挡掉技能和项目上下文的注入）。role 取 `system`（`evst-gateway` 的模型声明了 `reasoning:false` 且 `supportsDeveloperRole:false`，否则会变成 `developer`）。实证抓到的 system 内容就是 `SYSTEM_LINE_1\nSYSTEM_LINE_2\nCurrent working directory: …\n`。

**仍然存在的两点输入差异（无法消除，用 `@file` 传图就必然带上）**：pi 会在 user_text **前面**多加几行 `<file name="绝对路径"></file>` 占位；system 末尾多一行 `Current working directory:`。两者都是 pi 的固定行为，不是顺序问题。

**本次改动**：
- **不动命令行顺序**（改了也没用，已实证），改为把上面的拼装事实写进 `ask_pi` 的 docstring 和 `docs`，并用测试把「user_text 是最后一个、且只有一个非 `@` 位置参数」这个契约钉死，免得后人再以为调顺序能改模型输入。
- 给 `ask_pi` 补上与 `ask_dashscope` 等价的**顶层数组重试一次**。为此先修了 `extract_json_object`：它原本**认不出**顶层数组——单元素数组 `[{…}]` 会被花括号扫描把里面的对象抠出来当答案（把模型的格式错误静默吞掉），多元素数组则报 json 的 `Extra data`。现在顶层是 list 就统一抛 `顶层必须是 JSON 对象`（与 `tools/json_io.py` 同措辞），两条后端用同一个子串识别。提示句、日志行、识别子串抽成模块级常量 `TOP_LEVEL_LIST_NUDGE` / `TOP_LEVEL_LIST_RETRY_LOG` / `TOP_LEVEL_LIST_MARKER`，`ask_dashscope` 改为引用它们，避免两份漂移。重试后仍是数组就照常抛错，其余错误行为不变。
- 新增调试开关 `MATERIAL_AGENT_PI_DEBUG_COMMAND=1`（默认关，已写进 `.env.example`）：调 pi 前打一行 `[agent] pi command: …`，`--api-key` 的值打成 `***`，`--system-prompt` 和 user_text 只打前 60 字 + 总长度（换行转义成一行），方便 Windows 侧核对实际发出的参数而不泄漏 key 和全文。

**下一轮验收口径（改了门槛，别再用旧的）**：**不再用「与 batch4 逐镜一致 ≥5/7」当门槛**——batch4 是 dashscope 直调的结果，拿它当标准答案等于默认 dashscope 是对的，而本轮恰恰是两条后端口径都在漂。改为**与本轮 Pi+plus 结果对照**，逐项看这五个数：

| 指标 | 口径 | 目标 |
|---|---|---|
| 占位镜数 | `material-agent-log.json` 里落到占位的镜数 | 明显低于本轮的 5/7 |
| 横倒拦截次数 | 独立方向判定把评审选中项拦下来的次数 | 越低越好（拦得多说明评审在放水） |
| 评审给 rotated 片段 ≥80 分的次数 | 逐镜翻评审打分，数横倒片段拿到 ≥80 的次数 | **0** |
| 顶层数组重试次数 | 数日志里 `模型返回了顶层数组，补充对象格式要求后重试一次` 出现几次 | 记录即可，用来判断 `response_format` 是否真生效 |
| 耗时 | timings 里 rewrite / orientation / judge 三项逐镜 | 记录，与本轮对比 |

跑完 Pi+plus 这一轮后再做 **flash A/B**：只改 `MATERIAL_AGENT_PI_MODEL=qwen3.6-flash` 重跑，用上面同一张表对照 plus，给「flash 是否够用」的结论。

### Windows 实测 3：plus/flash A/B 结论与漏评防御（`af40f9b`）

**对方结论（A/B 跑完）**：Pi + `qwen3.6-plus` 这一轮**五指标全部通过**——占位镜数明显低于上一轮的 5/7，横倒拦截次数下降，顶层数组重试 **0 次**（`response_format` 确实生效），耗时可接受。`qwen3.6-flash` 这一轮**不能用于评审**：一是**编造画面内容 3 例**（`visible` 里写了画面中根本没有的东西），二是**两镜漏评**——8 个候选的 `ranking` 只回了 4 条（06 镜只有 1/4/5/6，07 镜只有 5/6/7/8）。07 镜因此被当成「4 个候选全被拒」落到占位，而漏掉的 c1 恰是已知的横倒片段，独立方向判定虽然兜住了没让它进成片，但 `inspect-run.py` 报了 `known rotated c1 was not blocked`（它只能看到「没被拦」，看不出「压根没评」）。速度上 flash 确实快：整跑 agent 379 秒 → 240 秒。另外「评审给 rotated 片段 ≥80 分」两轮**各出现 1 次**，但 dashscope 直调同一片段也会出现，判定为**模型本身的通病**而非 Pi 通路引入，独立方向判定能兜住，**不再单独追**。结论：**judge 用 plus，flash 不用于评审**；flash 可以考虑只承担方向判定这类单一问题（见下面的验收口径）。

**本次改动（只改防御，不动判断口径/阈值/选择算法）**：
- `judge_candidates` 解析完 `ranking` 后**比对覆盖率**：把 ranking 里出现过的候选序号与实际送进去的候选序号（`candidate["index"]`，本来就是 1..N）比一遍。缺了就打一行 `[agent] 评审漏评候选 …（已评/总数），补充要求逐个评审后重试一次`，在 **user_text 末尾**追加一句「ranking 必须包含全部 N 个候选，每个候选一项，不要省略」后**重试一次**（与顶层数组重试同构：常量 `JUDGE_COVERAGE_NUDGE` / `JUDGE_COVERAGE_RETRY_LOG`，只重试一次，候选清单与图片一字未改）。
- 重试后仍缺：**不抛错、不中断本镜**。打一行 `[agent] 评审仍漏评候选 …，按未评审记录，不参与 pick`，缺失序号记进 `material-agent-log.json` 的新字段 **`unreviewed`**（顶层，数组），同时往 `errors` 里写一条（`report.agent.errors` 也就带上了）。缺失候选**不补分、不进 `ranking`、不进 `review` 的打分行**；模型若把未评审的候选写进 `pick`，那一条被忽略并记一条 error。
- `review` 每行新增 **`reviewed`** 布尔：正常行 `true`；未评审的候选单出一行 `reviewed: false` + `note`，**没有 `adjusted_score` / `blocked` 字段**——`inspect-run.py` 这类检查由此能把「被评审/兜底拦下」和「压根没评」分开，不会再把漏评报成 `not blocked`。
- 顺带把 `ranking` 里**重复的候选序号**去重（保留第一次出现，旧代码是后面的静默覆盖前面的），重复序号记进 `judge.duplicate_candidates` 并写一条 error。序号读不出来或超出候选范围的条目**照旧原样传给上层**（上层照旧丢弃），没有顺手改。

**验收口径（Windows 侧下一轮）**：
1. **plus 整跑**：日志里 `评审漏评候选` 这行出现次数应为 **0**（plus 与 batch4 的 21 镜从未漏评，出现即是新情况，要贴出来）；`material-agent-log.json` 每镜 `unreviewed` 应为 `[]`，`review` 行数 == 候选数且全为 `reviewed: true`。若真出现漏评，看是否**重试一次后补齐**（补齐了只留一行重试日志、`unreviewed` 仍为 `[]`）。
2. **再跑一轮只切方向判定**：`MATERIAL_AGENT_ORIENTATION_MODEL=qwen3.6-flash`，其余保持 plus（这个变量对 pi 后端同样生效，只临时覆盖 `MATERIAL_AGENT_PI_MODEL`，评审仍是 plus）。对照上一轮的**五指标**（占位镜数 / 横倒拦截次数 / rotated ≥80 分次数 / 顶层数组重试次数 / 耗时），并**单独贴 `timings.orientation_seconds` 逐镜对比**，给「方向判定能不能降到 flash」的结论。

### Windows 实测 4：漏评 0 次，方向判定可降 flash（`88b9aeb`）——Pi 通路收口

**对方结果**：
- **plus 整跑**：日志里 `评审漏评候选` 出现 **0 次**，每镜 `unreviewed` 均为 `[]`，`review` 行数 == 候选数且全部 `reviewed: true`。上一轮加的漏评重试/记录属于防御，本轮没被触发。
- **方向判定切 flash**（`MATERIAL_AGENT_ORIENTATION_MODEL=qwen3.6-flash`，评审仍 plus）：横倒**拦截率 100%**，方向判定**耗时 -36%**。**样本只有 2 个 90° 横倒片段**，小角度倾斜这一轮没覆盖到，留给后面的「扶正」轮去验——所以这个结论只能说「90° 横倒 flash 够用」，不能推广成「方向判定一律可以降」。
- **试验期默认定为**：**评审 plus + 方向 flash**（即 `MATERIAL_AGENT_PI_MODEL=qwen3.6-plus` + `MATERIAL_AGENT_ORIENTATION_MODEL=qwen3.6-flash`）。
- **仍记录不追的一点**：plus 的评审分在边界片段上本身就会波动——同一片段两次跑出 55 和 75。不触发任何阈值动作（min_accept_score 一侧没跨），只记录，**不为此调阈值、不改判断口径**。

**结论**：Pi 通路到此收口，下一轮转到工程侧——把 pi 打进运行包，让用户不用装 pi、不用配路径。

## 第二轮：pi 打进运行包（2026-09-17）

目标：运行包自带 pi，脚本自动探测，用户侧 `app.env` 只需要选后端和模型，**不配任何路径**。

### 设计

| 点 | 做法 |
| --- | --- |
| pi 放哪 | `VideoAutoCut/tools/material_gen/pi/`。打包脚本 `VideoAutoCutDesktop/scripts/pack-runtime.ts` 本来就把整棵 `VideoAutoCut/tools/` 拷进运行包的 `tools/`（排除列表里只有 `material_gen/records` 和两个 `node_modules/.cache`，另有 `excludedDirNames` 排掉名为 `test`/`tests` 的目录——pi 里有 36 个文件落在这类目录下，实测不影响运行），所以**打包脚本一行都不用改**。`node_modules/` 不入库，打包前先在出包机上跑 `tools/material_gen/pi/install_pi.py` |
| node 从哪来 | 复用运行包根目录已有的 `node-runtime/node.exe`（模板包装 `tools/template_packaging.py` 在用），**不额外带 Node** |
| root 怎么算 | `runtime_root() = Path(__file__).resolve().parents[1]`，即 `tools/` 的上级——与 `template_packaging.render_overlay` 同一算法。仓库里是 `VideoAutoCut/`，运行包里是解压出的根目录 |
| pi 探测顺序 | `MATERIAL_AGENT_PI_EXE` → `root/tools/material_gen/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` → `PATH` 上的 `pi` |
| node 探测顺序 | `MATERIAL_AGENT_NODE_EXE` → `VIDEOAUTO_NODE_EXE`（运行包既有变量）→ `root/node-runtime/node.exe` → `root/node/node.exe` → pi 同目录的 node → `PATH`。中间三档与 `template_packaging.renderer_dependencies` 一致 |
| **backend 默认收紧** | **行为变更**：旧版 `backend_name()` 是「没配 `MATERIAL_AGENT_BACKEND` 但机器上找得到 pi 就默认 pi」。包内自带 pi 之后这条会让**所有**安装静默切到 pi 通路（模型、耗时、口径全变），所以改成：没显式配一律 `dashscope`，**只有显式 `MATERIAL_AGENT_BACKEND=pi` 才走 pi** |
| models.json 合并 | 新函数 `ensure_pi_provider_config()`，`backend=pi` 时在 `run_agent_selection` 判完后端处调用一次（第一次模型调用之前）。把包内 `models.{provider}.json` 的 `providers[provider]` 这**一个键**并进 pi 的用户 models.json |

判断口径、阈值、选择算法**一字未动**；`ask_pi` / `ask_dashscope` 的 prompt 与参数拼装未动。

### models.json 合并的查证依据（pi 0.85.1 源码）

- **配置目录能不能换**：能。`src/config.ts:528-534` 的 `getAgentDir()` 先读环境变量 `PI_CODING_AGENT_DIR`（`src/config.ts:507` 的 `ENV_AGENT_DIR`，由 `APP_NAME.toUpperCase()` 拼出来），没有才用 `homedir()/CONFIG_DIR_NAME/agent`；`CONFIG_DIR_NAME` 取自 package.json 的 `piConfig.configDir`（`src/config.ts:504`，值就是 `.pi`）。所以 Windows 默认是 `%USERPROFILE%\.pi\agent`，合并函数**尊重 `PI_CODING_AGENT_DIR`**。
- **能不能只换 models.json 一个文件的路径**：不能。`getModelsPath()`（`src/config.ts:541-543`）固定是 `getAgentDir()/models.json`，命令行没有对应参数（`--models` 是 Ctrl+P 的模型轮换列表，不是路径，见 `src/cli/args.ts:131`）。所以只能合并进用户目录。
- **schema**：顶层**只有一个键** `providers`——`src/core/model-config.ts:212-215` 的 `ModelsConfigSchema = Type.Object({ providers: Type.Record(Type.String(), ProviderConfigSchema) })`。合并因此只增/覆盖 `providers[provider]`，用户自己的其他 provider 和顶层其他键原样保留。
- **合并行为**：文件不存在 → 连父目录一起创建；存在 → 只动那一个 provider 键；内容已相同 → **不写**（幂等），打一行「已一致，跳过」。写入走临时文件 + `os.replace`。任何失败**不中断任务**，只打一行 `[agent] pi provider 配置 … 合并失败…` 警告（真配错了 pi 调用自己会报错，那时用户看得见）。`MATERIAL_AGENT_PI_SKIP_PROVIDER_MERGE=1` 可整体关掉。
- **pi 还往 `~/.pi` 写什么**（仅记录，不处理，已写进 `ask_pi` docstring）：会话文件已被 `--no-session` 关掉；`src/main.ts:649` 的 `runMigrations` 只在检测到旧版布局时才改写 `settings.json` / `auth.json` / `keybindings.json`；`models-store.json`（`src/core/models-store.ts:52`）只在动态刷新 provider 目录时写，本线路用 `--provider/--model` 固定模型不会触发；debug 日志要显式开关。

### 体积与「自包含」——实测更正（2026-09-17）

上一版这里（和 `pi/README.md`）写的**两句话都是错的**，按 Windows 实装订正：

- ~~「整个目录约 11MB」~~ → 按 README 命令 `--omit=dev` 实装 **13,678 文件 /（`du` 磁盘占用）约 421MB**。多出来的是 pi 自带 `npm-shrinkwrap.json` 写死的 **26 个平台的 `@esbuild/*`** 和 **10 个 `@mariozechner/clipboard-*`** 可选依赖，Windows npm 会一股脑全装。**加 `--omit=optional` 后约 13,548 文件 / 117.8MB（字节总和，实测 117,837,647 字节；`du` 磁盘占用约 137MB）**——只少 130 个文件，差出来的全是别的平台的二进制。两个口径别混：`du -sh` 按磁盘块向上取整，`install_pi.py --check` 打印 `lstat` 字节总和，上一版这里只写了 `du` 的数，和脚本打印对不上。精简版已实测能跑（方向判定 / 纯文本 / 整跑三轮全过），**打包一律用精简版**。
- ~~「`cli.js` 是自包含 bundle（约 8 MB）」~~ → **不自包含**。只留 `dist/` 启动报 `ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/chord'`（来自 `dist/bundle/chunks/chunk-JVUZSMYM.js`），`node_modules/` 必须整个带上。唯一依赖 esbuild 的就是 chord。

精简安装后剩 5 个原生产物：pi-tui 的 darwin / win32 `.node`，以及 esbuild postinstall 下载的 `esbuild/lib/downloaded-@esbuild-win32-x64-esbuild.exe`。npm 会提示 3 个包的 install script 不在 allowScripts：`@google/genai`（no-op）、`esbuild`（就是那个 postinstall 下载）、`protobufjs`。**esbuild 按当前平台下载二进制，所以在哪台机器发包就在哪台机器装。**

### `node_modules` 入库还是打包前现装（**待定**）

是否把 `node_modules/` 提交进仓库**还没定**，2026-09-18 与同事讨论（仓库本身已经 1–2GB，再加约 118MB（`du` 约 137MB）算不算大待判）。两条路都写清楚：

**A. 当前分支的做法：不入库，打包前用 `install_pi.py` 现装。** 仓库根 `.gitignore` 的 `VideoAutoCut/tools/material_gen/**/node_modules/` 保持生效，`VideoAutoCut/tools/material_gen/pi/.gitignore` 里的 `!node_modules/` 反向例外**注释掉**，这样 Windows 工作区装完 1.35 万个文件也不会出现在 `git status` 里（免得 `git add -A` 误提交）。运行包是交付物，仓库只存配置和脚本。

**B. 若决定入库。** 把那行 `# !node_modules/` 取消注释（子目录 `.gitignore` 优先级高于仓库根，`git check-ignore` 实测生效），用 `install_pi.py` 装**精简版**（约 1.35 万文件 / 117.8MB 字节总和，`du` 约 137MB）后提交。`node_modules/.cache/`、`node_modules/.package-lock.json`、`package-lock.json` 两条路都不入库（已在该 `.gitignore` 里排掉）。

**打包步骤两条路完全一样**，`pack-runtime.ts` 不用改。

### `install_pi.py`

`VideoAutoCut/tools/material_gen/pi/install_pi.py`，纯标准库，Windows / Mac 都能跑：

```bash
python VideoAutoCut/tools/material_gen/pi/install_pi.py            # 装 + 自检
python VideoAutoCut/tools/material_gen/pi/install_pi.py --check    # 只自检，不装
```

- 固定 `@earendil-works/pi-coding-agent@0.85.1`，执行 `npm install --prefix <pi 目录绝对路径> --no-save --omit=dev --omit=optional <pkg>@<ver>`。
- npm 走 `shutil.which("npm")`（Windows 上拿到 `npm.cmd`，`subprocess.run(..., shell=False)` 直接跑；参数里没换行，不会踩 `pi.cmd` 那个截断坑），可用 `MATERIAL_AGENT_NPM_EXE` 覆盖。
- 自检三项：`dist/bundle/cli.js` 存在、其 `package.json` 的 `version == 0.85.1`、chord 解析得到（不自包含的证据）；再打印 node_modules 的文件数与总字节，对照「约 13,548 个文件 / 117.8MB（字节总和；`du` 磁盘占用约 137MB）」这个基准就能看出可选依赖有没有被装进来。
- chord 那一项**不按固定路径判断**（shrinkwrap 装法下它在 pi 包自己的 `node_modules/` 里，不提升）：首选跑 `node -e "const {createRequire}=require('module'); console.log(createRequire(process.argv[1]).resolve('@earendil-works/chord/package.json'))" <cli.js>`，退出码 0 且路径存在即通过并打印解析到的路径；node 的找法与 `material_agent_select.node_executable()` 同序，一个都找不到才退回「嵌套位或顶层位任一存在」的路径检查（并打一行「未找到 node，按路径检查」）。
- 退出码非 0 即失败，stderr 逐条列原因。

### Windows 侧操作步骤

1. **拉分支**（`feature/material-agent-select`）。

2. **在出包机上现装 pi**（必须 Windows 侧装：esbuild 的 postinstall 按当前平台下载二进制）：

   ```powershell
   python VideoAutoCut\tools\material_gen\pi\install_pi.py
   python VideoAutoCut\tools\material_gen\pi\install_pi.py --check   # 打包前再确认一次
   ```

   等价的 npm 命令（`--omit=optional` 不能少）：

   ```powershell
   npm install --prefix VideoAutoCut\tools\material_gen\pi --no-save --omit=dev --omit=optional @earendil-works/pi-coding-agent@0.85.1
   node VideoAutoCut\tools\material_gen\pi\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js --version   # 应输出 0.85.1
   ```

   `node_modules/` **不提交**（入库与否待定，见上一节的 A / B 两条路）；装完 `git status` 里不应该出现它。

3. **打包**：`npm run release:pack:runtime`，版本号建议 `0.5.15-agent-trial-pi`。

4. **装到测试目录**，`app.env` 只需这几项（**不配 `MATERIAL_AGENT_PI_EXE` / `MATERIAL_AGENT_NODE_EXE`**）：

   ```
   MATERIAL_AGENT_BACKEND=pi          ← 就地改第 97 行那一行，不要在文件末尾另加
   MATERIAL_AGENT_PI_PROVIDER=evst-gateway
   MATERIAL_AGENT_PI_MODEL=qwen3.6-plus
   MATERIAL_AGENT_PI_TEXT_MODEL=qwen-plus
   MATERIAL_AGENT_PI_THINKING=off
   MATERIAL_AGENT_ORIENTATION_MODEL=qwen3.6-flash
   ```

   （`load_dotenv` 是 `setdefault`，先出现的键赢，所以已有的键必须**就地改**——同「Windows 实测 1」末尾那条坑。）

5. **验首启合并**：先把 `%USERPROFILE%\.pi\agent\models.json` **挪走**（改名备份，别删），再跑第一次任务。

### 验收清单

1. 开 `MATERIAL_AGENT_PI_DEBUG_COMMAND=1` 跑一次，`[agent] pi command:` 这行的前两个参数分别是**运行包内的 `node-runtime\node.exe`** 和**运行包内的 `…\material_gen\pi\…\dist\bundle\cli.js`**（都在安装目录下，不是 `%APPDATA%\npm` 或系统 Node）。
2. 首启日志有一行 `[agent] pi provider 配置 evst-gateway 已合并进 …\.pi\agent\models.json`；该文件被创建，`providers["evst-gateway"]` 与 `VideoAutoCut/tools/material_gen/pi/models.evst-gateway.json` 里的那段**逐字相同**。
3. 第二次跑同一任务，这行变成 `… 与 … 已一致，跳过`，文件修改时间不变。
4. 手工往 models.json 里加一个别的 provider（比如 `"deepseek": {...}`）和一个顶层其他键，再跑一次：那两项**原样还在**，只有 `evst-gateway` 被覆盖。
5. 同一任务 `--restart-all` 整跑一遍，贴**五指标**：占位镜数 / 横倒拦截次数 / 评审给 rotated 片段 ≥80 分次数 / 顶层数组重试次数 / 耗时（rewrite / orientation / judge 逐镜），与上一轮 plus+flash 对照应无明显退化。
6. 把 `app.env` 里的 `MATERIAL_AGENT_BACKEND` 注释掉再跑一次：`material-agent-log.json` 顶层 `backend` 必须是 **`dashscope`**（这是本轮的行为变更，包里有 pi 也不自动切）。
7. 设 `MATERIAL_AGENT_PI_SKIP_PROVIDER_MERGE=1` 跑一次：**没有**任何 `[agent] pi provider 配置` 日志，models.json 不被改。
8. 卸载/改名机器上全局的 pi（`%APPDATA%\npm\pi.cmd`）后再跑一次：仍然正常——证明用的确实是包内那份，不是 PATH 上的。

### Windows 实测 5：`0.5.15-agent-trial-pi` 打包验收（`5a00226`）

**结论：验收清单 8 项全过。** 运行包自带的 pi 从安装目录起，用户侧不配任何路径。

| 项 | 值 |
| --- | --- |
| 版本 | `0.5.15-agent-trial-pi` |
| 运行包大小 | **669,886,524 字节** |
| SHA-256 | `c2d0878159ca69608dc4c4bab93df3c9f71d5530312890243799ededae985bd3` |
| 包内 Node | **v25.5.0**（`node-runtime/node.exe`，pi 直接复用，没额外带 Node） |

**三轮关键场景（验收清单第 1 / 8 / 6 项）**：

| 轮 | 场景 | 结果 |
| --- | --- | --- |
| R1 | 默认（`MATERIAL_AGENT_BACKEND=pi`，不配 `MATERIAL_AGENT_PI_EXE` / `MATERIAL_AGENT_NODE_EXE`） | `[agent] pi command:` 前两个参数确实是安装目录下的 `node-runtime\node.exe` + `…\material_gen\pi\…\dist\bundle\cli.js`；**占位 4/7 镜**，**横倒片段选中 0**（拦截照常），顶层数组重试与评审漏评均未触发 |
| R2 | 把全局 `%APPDATA%\npm\pi.cmd` 改名后再跑 | 仍然正常——证明走的是**包内**那份，不是 PATH 上的 |
| R5 | 把 `app.env` 里的 `MATERIAL_AGENT_BACKEND` 注释掉再跑 | `material-agent-log.json` 顶层 `backend` **全程 `dashscope`**——包里有 pi 也不自动切，本轮的行为变更生效 |

**耗时**：走包内 pi 比上一轮每次调用**多约 2 秒**（cli.js 冷启动），判断口径与五指标无退化。

**三件本轮暴露、已在本次提交里处理的事**：

1. **体积与「自包含」两句写错了** —— 见上面「体积与自包含——实测更正」。按 README 原命令实装 **13,678 文件 /（`du`）约 421MB**，`--omit=optional` 后 **约 13,548 文件 / 117.8MB（字节总和；`du` 约 137MB）**；`dist/bundle` **不自包含**，缺 `@earendil-works/chord` 直接 `ERR_MODULE_NOT_FOUND`。
2. **`node_modules` 入库与否待定**（2026-09-18 与同事讨论）。当前分支**不入库**，打包前用 `install_pi.py` 现装；若决定入库，把 `pi/.gitignore` 的 `!node_modules/` 例外加回、装精简版后提交。两条路的操作见上一节。
3. **装了包内 pi 之后 `PiCommandTests` 有 3 条红** —— `test_missing_pi_returns_none`（ERROR：找不到 node）、`test_cmd_shim_resolves_bundled_cli_js_with_sibling_node`、`test_plain_pi_path_is_used_as_is`。它们只 patch 了 `shutil.which` / PATH，没隔离 `5a00226` 新加的包内探测（`bundled_pi_cli()` / `runtime_root()`），实装后 `pi_executable()` 先命中仓库里那份 `cli.js`（Mac 上没装所以一直绿）。已加 `IsolatedRuntimeRootMixin`：`PiCommandTests` / `PiPromptShapeTests` 在 `setUp` 里把 `runtime_root()` patch 到一棵空 tmp 目录，装没装都全绿；验证「包内探测」本身的 `BundledPiTests` / `PiProviderConfigTests` 仍各自造真实文件并自己 patch root，覆盖没丢。Mac 侧临时造一个空的包内 `cli.js` 复跑全套已确认隔离有效。

**`5c87aee` 复核（Windows）**：第 1 项（包内 pi 从安装目录起）、第 3 项（`PiCommandTests` 隔离后全绿）都过；**第 2 项 `install_pi.py --check` 失败**——npm 按 pi 自带的 `npm-shrinkwrap.json` 把依赖装进 `pi-coding-agent` 自己的 `node_modules/` 里**不提升**，chord 实际在 `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/chord`，顶层 `@earendil-works/` 下只有 `pi-coding-agent`，而自检写死的是顶层路径（npm 本身 `added 128 packages` 成功，`cli.js --version` = 0.85.1，pi 能跑，纯粹是自检写错）。

**本次修法**：自检的 chord 那一项改成**首选让 node 按运行时规则解析**——`node -e "…createRequire(process.argv[1]).resolve('@earendil-works/chord/package.json')" <cli.js>`，退出码 0 且路径存在即通过并打印解析结果（node 的找法与 `material_agent_select.node_executable()` 同序：`MATERIAL_AGENT_NODE_EXE` → `VIDEOAUTO_NODE_EXE` → 运行根 `node-runtime/node.exe` → `node/node.exe` → `PATH`）；一个 node 都找不到时退回路径检查，嵌套位或顶层位任一存在即通过并打一行「未找到 node，按路径检查」。同时把体积对照值从 `du` 口径改成字节口径（约 13,548 个文件 / 117.8MB，`du` 约 137MB），单测见 `tests/test_material_agent_select.py::InstallPiChordCheckTests`（嵌套 / 提升 / 两处都无 + 真 node 解析）。
