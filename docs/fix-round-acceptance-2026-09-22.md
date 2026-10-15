# Mac/Codex → Media/Windows：剪辑软件修复轮最终验收单

> ⛔ **2026-09-23：本单已由 `docs/fix-round-acceptance-2026-09-23.md` 取代，不再执行；pkg4 作废，不上传。** 9/23 复盘在本单锚定的 `e5b5bec` 上复现了 2 条阻断（图例表头抢表、真实 v1 卡片被清空），修复与新验收项见新单。

> ⛔ **本条发布后取代 issue IKGH73 评论 `51298013`；`51298013` 作废，不要执行。**
> 本条把旧单尚未验收的 B2–B6 与后续新增的 xlsx / title 校验合成一轮。Media 只读本条即可，不需要翻旧评论拼步骤。
>
> ✅ 总开工单 `51293189` 已由 Media 执行到第 ⑤ 步，结果见 `51296044`，Mac 已复核；那些 A1–A13 和五条包装整跑不重做。
> ⏸ 上传继续暂缓。本轮不运行任何 upload 命令，不改线上 `runtime/` 或 `runtime-trial/`。

## 0. 代码与 issue 锚点

- 最终分支：`feature/material-agent-select`
- 生产逻辑修复锚点：`1a5f5d02836f813c5fedfe0769858d2818fc3905`；本次 B5 测试修复包含在补充评论指定的新 HEAD。
- 最近一次 Windows B5 通过锚点：`2976c0a851170f292725668826bbcad16bc266cf`；实测 `Ran 520`、`0 failures / 0 errors / 1 skipped`、exit 0，`test_script_card_fields` 122/122。随后发现真实 XLSX 的 6 镜 `card_content` 换行被改为空格，本次换行修复会包含在补充评论指定的新 HEAD；因此必须在该新 HEAD 再跑一次 B5，不能继承 `2976c0a` 的放行结论。
- issue 开工 HEAD：`<FINAL_HEAD>`（包含本文档提交；发布 issue 时填写）
- `master`：`60b3e3d95ef0cb0fa721d02709aa8f3f8be8cc9c`，**不合 master**
- 最终提交范围：`86a02e0..<FINAL_HEAD>`
- Mac 历史测试证据：字段专项 `119/119 OK`；旧 unittest 收集口径下修版 `505 tests, 3 failures / 5 errors / 3 skipped`，同环境 `948ec66` 为 `501 tests, 3 failures / 5 errors / 3 skipped`。这组历史结果后来确认漏收 11 个顶层函数式测试（其中 qwen 6 项依赖 pytest），只保留为旧环境诊断，不再作为当前 HEAD 的完整收集数或放行结果。
- Windows 测试口径：最终新 HEAD 用 B5 修正入口实际执行，必须 **0 failures / 0 errors** 才能放行；总数以实际平台结果为准，不沿用 505/501，也不再要求重复旧基线。出现 failure/error 时停下回帖，不能用历史“基线也失败”自行进入 pkg4。
- 提示词 SHA-256：`0cb811b544a5f99ecd68385f72b18d18f52710a50fab09c044f28d499563f788`，当前文件与 `57ecd75` 原始字节相同。
- 本轮真实 xlsx 离线证据：Mac 共发现 44 个路径、按 SHA-256 去重后 19 份；19/19 读取成功，表头分布为第 11 行 1 份、第 18 行 2 份、第 20 行 2 份、第 21 行 14 份，均为 7 或 8 镜，抽取统计与 `948ec66` 一致。19/19 内存假 plan 经 `verify_and_fix` 后字节不变，corrections=0、warnings=19（每份因没有显式 title/card 列告警一次）。这只能证明真实生产表形状识别和无误改，不能冒充 title/card 自动纠正正例；正例由 07 标准夹具和 119 项专项测试覆盖。证据文件在 Mac 交接目录 `验证结果_2026-09-22.md` / `真实xlsx_离线核验_2026-09-22.json`，不推用户原始 xlsx。
- 最终审查结论：两项代码修复已复审并提交到上述代码锚点；验收文档与辅助启动器已完成独立复审。

issue 发布正文会把 `<FINAL_HEAD>` 渲染为实际开工提交。不得把 Mac 或历史 Windows 数字冒充本轮 Windows 实测结果。

## 1. 这轮解决什么

上一轮 `51296044` 暴露了三类问题：脚本解析会漏、编、翻译上屏字段；Pi provider 漏配会静默全降级；安装脚本在中文 Windows 下重定向输出会因编码崩溃。旧 `51298013` 的修复还只覆盖纯文本，也没有校验 `title`。

用户随后拍板：

1. 生产脚本主要是 `.xlsx` 或 `.txt`，所以确定性校验必须覆盖表格。
2. `title` 也按脚本原文逐字校验，因为它会上进度条，旧路径下还可能成为卡片文字。
3. 包装一律按脚本。默认 `VIDEOAUTO_PACKAGING_SCRIPT_ONLY=1` 时，没有 `card_content` 的镜不出卡片，也不调用包装模型；agent 不替作者摘取或生成上屏文字。
4. A4 的第二可能原因，即空 `card_content` 不进入模型 payload，**不修**。老路径 `SCRIPT_ONLY=0` 的 show 判断质量不再作为本轮门槛。

代码仍走「不确定就只告警，不自动改」：读不出原文、认不准表头、镜号或镜数对不上、无法确认某行对应哪一镜、字段有歧义时，plan 保持原样，任务继续出片。`VIDEOAUTO_SCRIPT_CARD_AUTOFIX=0` 可把整层切成只告警。

## 2. 开工前

先保留测试机当前的 `0.5.14` 底包。安装新 runtime 会清理同级旧版本目录，不能让唯一一份 0.5.14 被删掉；日志、审计结果和手工铺过的 tools 也先移到安全位置。

```powershell
cd D:\autocut\video-auto-cut
git checkout feature/material-agent-select
git pull --ff-only
git rev-parse HEAD
git merge-base --is-ancestor 1a5f5d02836f813c5fedfe0769858d2818fc3905 HEAD
```

`git rev-parse HEAD` 必须是 issue 发布时填写的 `<FINAL_HEAD>`，且 ancestry 命令必须退出 0；否则停下回帖。仓库内文档不硬写包含自身的 commit，避免循环，代码正确性锚定 `1a5f5d0`。

这轮不要自行安装 `openpyxl`、`python-docx` 等库。运行包使用 Windows 嵌入式 Python；xlsx/docx 读取实现只用标准库，手工直调时必须从 `VideoAutoCut` 目录按仓库既有方式运行，避免重现嵌入式 Python 的 `sys.path` 导入问题。

app.env 只在原键位置就地修改，不能在末尾追加第二个同名键；`load_dotenv` 取第一次出现的值。使用生产配置的副本完成破坏性配置用例，跑完还原。

```text
VIDEOAUTO_TEMPLATE_PACKAGING=true
VIDEOAUTO_PACKAGING_SCRIPT_ONLY=1
PACKAGING_AGENT_SELECT=1
PACKAGING_AGENT_BACKEND=pi
PACKAGING_AGENT_CACHE=0
MATERIAL_AGENT_PI_PROVIDER=evst-gateway
MATERIAL_AGENT_PI_MODEL=qwen3.6-plus
MATERIAL_AGENT_PI_TEXT_MODEL=qwen-plus
MATERIAL_AGENT_PI_THINKING=off
```

续跑顺序：新 HEAD 的 B5 → 同 SHA 真实 B7 一次缺键默认开启 → 从 02 default 继续剩余 B2 / 等价 B7 / B8 → 首次执行 Candidate 依赖 checks / B3 / B4 / B6 → 全部门槛通过后本地打 pkg4。B1 已完成，不重跑；01 历史两次和 02 autofix=0 的模型导入也保留，因为本次生产改动只影响表格 `card_content` 内部空白保留，不影响 text 路径。任一不符立即停下回帖。

## B1（观察项，不阻断）· 提示词已逐字改回

从仓库根 `D:\autocut\video-auto-cut` 执行，只验证当前提示词与 `57ecd75` 字节相同：

PowerShell 的文本管道会转码，不能用 `git show ... | Get-FileHash` 比原始字节。用 Python 直接读取 Git 输出和工作区字节：

```powershell
Set-Location 'D:\autocut\video-auto-cut'
python -c "import hashlib,pathlib,subprocess; p='VideoAutoCut/tools/prompts/agent_packaging_plan.md'; a=subprocess.check_output(['git','show','57ecd75:'+p]); b=pathlib.Path(p).read_bytes(); print('57ecd75',hashlib.sha256(a).hexdigest()); print('worktree ',hashlib.sha256(b).hexdigest()); raise SystemExit(a != b)"
```

退出 0 且两个 SHA-256 相同即可。**不要再跑 `SCRIPT_ONLY=0` 的 03，不要求第 3/4/6 镜得到某个 show 结果，不抓模型 input，也不修改空字段 payload。**

## B2 · 从原脚本重新导入，验文本与表格的确定性校验

不要复用上次手改过的 `shots.json`。先在仓库根核对实际文件：

```powershell
Set-Location 'D:\autocut\video-auto-cut'
Get-ChildItem 'docs\packaging-test-scripts-2026-09-21' -File | Sort-Object Name | Select-Object -ExpandProperty Name
```

应看到下面 7 份脚本。01 已在 `1b6f6cf` 完成 AUTOFIX=0 与缺键默认开启两次独立导入；它不含本轮新增 alias，prompt 未变，保留已通过证据，不额外消耗模型调用。其余 6 份按下述口径继续：

- `01_对照组_无上屏卡片_食品码垛_CN.md`
- `02_全镜上屏_三版式_食品码垛_CN.md`
- `03_混合_show判定_食品码垛_CN.md`
- `04_边界_排版极限_含预期失败镜_食品码垛_CN.md`
- `05_真实出片_食品码垛讲解_48s_CN.md`
- `07_表格版_混合_show判定_食品码垛_CN.xlsx`
- `07_纯文本版_混合_show判定_食品码垛_CN.txt`

每份先用 `VIDEOAUTO_SCRIPT_CARD_AUTOFIX=0` 导一次，记录那次模型输出里的不一致项；再恢复默认开启独立导入一次，记录那一次的纠正和最终 `shots.json`。两次都会重新调用 qwen，输出可能不同，**不能把两次数量差当成 AUTOFIX 的因果对比，也不设“必须下降”的门槛**；分别报告实际数组即可。

### 可执行导入模板

沿用 Media 已验证的后台启动器，不直接裸跑引擎：它会从配置目录的 `auth.json` 取得账号网关配置，在内存合并远端凭据，并设置 `VIDEOAUTO_ENV_PATH`。引擎路径必须是：

```text
D:\Video Edit\VideoAutoCut\workspace\runtime\0.5.14\VideoAutoCut\VideoAutoCutEngine.exe
```

每次导入使用一个新的审计目录。仓库已带可复制启动器 `docs\acceptance-tools\run-plan-only.mts`；它来自 Media 第四批已验证启动器，将引擎参数固定为 `--plan-only --script-file`，并移除了仅素材匹配验收需要的 `MATERIAL_MATCH_MIN_SCORE=0` 前置条件；原有账号网关读取、远端 env 合并、敏感值脱敏和完整日志逻辑保持不变。启动器本身不含凭据，必须复制到 `VideoAutoCutDesktop` 下的审计目录，才能按其相对 import 找到 `electron` 源码：

该 helper 已完成静态复审。Mac 现有 Node 因缺少 `libsimdjson.29` 未能成功执行本机编译，因此 `119/119` 专项结果不包含 helper 运行覆盖；Media 必须先按本节确认 rolldown 编译成功，再运行 plan-only。

```powershell
$Repo = 'D:\autocut\video-auto-cut'
$Desktop = Join-Path $Repo 'VideoAutoCutDesktop'
$Audit = Join-Path $Desktop 'node_modules\.tmp\acceptance-20260922-<脚本简称>-<autofix0或1>'
New-Item -ItemType Directory -Force $Audit | Out-Null
Copy-Item (Join-Path $Repo 'docs\acceptance-tools\run-plan-only.mts') (Join-Path $Audit 'run-plan-only.mts') -Force
```

对应 `state.json` 至少确认这些路径；`env` 指生产配置或它的同目录副本，不能指到没有 `auth.json` 的孤立目录：

```json
{
  "repo": "D:\\autocut\\video-auto-cut",
  "runtime": "D:\\Video Edit\\VideoAutoCut\\workspace\\runtime\\0.5.14\\VideoAutoCut",
  "env": "D:\\Video Edit\\VideoAutoCut\\config\\app.env",
  "script": "D:\\autocut\\video-auto-cut\\docs\\packaging-test-scripts-2026-09-21\\<脚本文件名>",
  "project_name": "<本轮唯一名称>"
}
```

Media 已在 `1b6f6cf` 按原单把下列 9 个文件同步到指定 0.5.14 runtime，并逐个备份、核对 SHA-256。真实 XLSX parser 修复只改 `script_card_fields.py`：拉取新 HEAD 后只覆盖这一文件；其余 8 个不重复覆盖，只复核 runtime SHA-256 与新 HEAD repo 文件仍相同。`$Runtime` 本身已经以 `VideoAutoCut` 结尾，目标路径不能再追加一层 `VideoAutoCut`：

```powershell
$Runtime = 'D:\Video Edit\VideoAutoCut\workspace\runtime\0.5.14\VideoAutoCut'
$ToolBackup = Join-Path $Audit 'original-tools-new-head'
$ChangedTool = 'script_card_fields.py'
$UnchangedTools = @(
  'material_agent_select.py',
  'material_gen\hyperframes\install_hyperframes.py',
  'material_gen\pi\install_pi.py',
  'normalize_script.py',
  'prompts\agent_packaging_plan.md',
  'prompts\script_parse.md',
  'prompts\script_parse_review.md',
  'script_tabular.py'
)
$Source = Join-Path (Join-Path $Repo 'VideoAutoCut\tools') $ChangedTool
$Target = Join-Path (Join-Path $Runtime 'tools') $ChangedTool
$Backup = Join-Path $ToolBackup $ChangedTool
if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "缺少仓库文件: $Source" }
New-Item -ItemType Directory -Force (Split-Path -Parent $Backup) | Out-Null
Copy-Item -LiteralPath $Target -Destination $Backup -Force
Copy-Item -LiteralPath $Source -Destination $Target -Force
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Source).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $Target).Hash) {
  throw "同步后哈希不一致: $ChangedTool"
}
foreach ($Rel in $UnchangedTools) {
  $Source = Join-Path (Join-Path $Repo 'VideoAutoCut\tools') $Rel
  $Target = Join-Path (Join-Path $Runtime 'tools') $Rel
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "缺少仓库文件: $Source" }
  if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { throw "runtime 文件缺失: $Target" }
  $SourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Source).Hash
  $TargetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Target).Hash
  if ($SourceHash -ne $TargetHash) { throw "原八文件不再匹配，停止并回帖: $Rel" }
}
```

在审计目录写入 `state.json`（与 `run-plan-only.mts` 同目录），再从 Desktop 目录编译并运行启动器：

```powershell
$State = @{
  repo = $Repo
  runtime = $Runtime
  env = 'D:\Video Edit\VideoAutoCut\config\app.env'
  script = 'D:\autocut\video-auto-cut\docs\packaging-test-scripts-2026-09-21\<脚本文件名>'
  project_name = '<本轮唯一名称>'
} | ConvertTo-Json
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $Audit 'state.json'), $State, $Utf8NoBom)

$RunnerInput = (Join-Path $Audit 'run-plan-only.mts').Substring($Desktop.Length + 1).Replace('\', '/')
$RunnerOutput = (Join-Path $Audit 'run-plan-only.mjs').Substring($Desktop.Length + 1).Replace('\', '/')
Push-Location $Desktop
node --input-type=module -e "import { rolldown } from 'rolldown'; const b = await rolldown({input:process.argv[1],platform:'node'}); await b.write({file:process.argv[2],format:'esm'}); await b.close();" $RunnerInput $RunnerOutput
if ($LASTEXITCODE -ne 0) { throw '启动器编译失败' }
node $RunnerOutput
$EngineExit = $LASTEXITCODE
Pop-Location
if ($EngineExit -ne 0) { throw "plan-only 失败，退出码: $EngineExit" }
```

plan-only 不带 `--restart-all`、`--shots-json` 或 `--material-manifest`。从 stdout / `engine-full.log` 的 `运行目录:` 取得实际 run 目录；结果在 `<run目录>\shots.json`。每次使用不同 `project_name`，不要复用旧 run。

通过标准：

1. `card_content`、`card_hint`、脚本明确写出的 `title` 与作者原文逐字相同。脚本用「（不填）」「无」「-」「N/A」表示没写上屏内容时，最终 `shots.json` 中 **`card_content` 键必须不存在**（2026-09-23 更正：本条口径正确、以本条为准——`e5b5bec` 及之前的代码把 `card_content` 上的纯符号 `-` `—` `–` `/` 当成上屏正文，与本条冲突；9/23 起代码已改为纯横线 / 斜线、「空白」「不上屏」等一律算没写）；不能用空字符串模糊通过，因为「只按脚本上屏」依赖该字段是否有内容来决定是否出卡片。`card_hint` 占位按实际 schema 归一，并在回帖中贴出最终 JSON 形状。
2. `duration`、`voice_text`、`subtitle`、`module_label` 不被这层修改。
3. stdout 使用 `[script] 脚本字段校验`；有纠正时产生 `VACUT_EVENT`，其中 `workflowStage=script`、`workflowProgress.phase=card_fields`，并包含实际的 `cardFieldCorrections`。
4. 日志在 GBK stdout 下不崩。作者原文含 emoji、`⚠` 等字符时可安全转义或替换，但 plan 中的作者原文不能丢失。
5. 遇到歧义只告警不改，退出码保持正常，不因保护层阻断出片。不要手改 `shots.json` 去凑通过数。

原文对照如下，Media 不需要翻旧 README 找答案：

| 脚本 | `card_content` | `card_hint` |
|---|---|---|
| 01 | 6 镜全空 | 全空 |
| 02 | 1–7 全有 | 3=`参数卡，列表排版`；5=`要点卡`；7=`CTA 行动号召`；其余空 |
| 03 / 07 xlsx / 07 txt | 1=`来料到位是码垛稳定的第一道关`；5=`占位卡 05`；7=`带上你的包装形态和目标垛型，一起把这条线试一遍`；其余空 | 7=`CTA 行动号召`；其余空 |
| 04 | 1–6 全有 | 4=`参数卡，列表排版`；6=`英文长标题，逐字保留，不要拆词、不要加空格`；其余空 |
| 05 | 1=`一条线同时接住瓶装、箱装和袋装`；5=`节拍 700 包/小时｜输送带连续来料｜托盘满垛下线`；6=`把你的包装形态和目标垛型发过来，我们照着试一遍`；其余空 | 5=`参数卡`；其余空 |

## B3 · Pi provider 漏配必须可见，降级仍能出片

先从已验收 run 的 `run.log` 取一镜完整直调参数。引擎在 `>>> python render_segment` 下一行记录了可复用的完整命令：

```powershell
Select-String -Path '<已有run目录>\run.log' -Pattern '^>>> python render_segment$' -Context 0,1
```

不要凭记忆手拼 `--clip/--output/--duration/--subtitle/--voice-text/--voice-output/--modules/--current/--shots-json/--shot-index`。复制一镜**有 `card_content`**的完整参数，只把 `--output` 和必要的临时输出路径改到本轮审计目录。

配置副本放在原配置目录，确保旁边仍能找到 `auth.json`，并让已验证启动器的 env 构造把账号网关凭据注入子进程：

```powershell
$ConfigRoot = 'D:\Video Edit\VideoAutoCut\config'
$B3Env = Join-Path $ConfigRoot 'app.env.b3-fix-round'
Copy-Item (Join-Path $ConfigRoot 'app.env') $B3Env
```

指定 0.5.14 runtime 只用于 B2/B5/B7/B8，不是包装验收 runtime；按 B2 规则只更新本轮 `script_card_fields.py` 并保留完整底包备份，不向其中补四个包装文件。Media 已从 9/21 验收的 pi-test 原件创建以下完整隔离 Candidate；Base 未改，robocopy rc=1、旧 HEAD tracked tools 156/156 SHA 匹配且 4 个 tracked package 文件 Base→repo 变化为 0：

```text
Base=D:\Video Edit\VideoAutoCut-pi-test\runtime\0.5.15-agent-trial-pi\VideoAutoCut
AuditWorkspace=D:\Video Edit\VideoAutoCut-b3b6-audit\2976c0a-20260922-142715
Candidate=D:\Video Edit\VideoAutoCut-b3b6-audit\2976c0a-20260922-142715\runtime\2976c0a851170f292725668826bbcad16bc266cf\VideoAutoCut
```

本次不要重新复制 Base，也不要覆盖旧 overlay 审计。先在新审计子目录另存 `git rev-parse HEAD` 为本轮 source-head，要求等于补充评论的新 HEAD；备份并只更新本轮实际改变的 tracked `tools/script_card_fields.py`。随后用 `git -C <repo> -c core.quotePath=false ls-files -- VideoAutoCut/tools` 取得**全部 tracked tools**，另存新 HEAD 的 tracked 清单及逐文件 repo/Candidate SHA-256，最终 mismatch 必须为 0。只复制本轮改变的 tracked 文件；不要从 repo 复制 `node_modules`、嵌入 Python、ffmpeg 或 config。首次 Candidate 依赖 checks、B3/B4/B6 仍按下文执行。

Candidate 先用其嵌入 Python 对 Candidate 内的 Pi/HF installer 分别执行 `--check`（HF 加 `--runtime-root <Candidate>`），只预检、不安装；任一非 0 立即停。B3 启动器令 `state.runtime=<Candidate>`、`state.env=$B3Env`，继续使用同一套 `getGatewayKey/gatewayRemoteEnv`。最终 env 必须为：`VIDEOAUTO_ROOT` / `VIDEOAUTO_RUNTIME_ROOT=<Candidate>`，`VIDEOAUTO_DATA_ROOT` / `VIDEOAUTO_WORKSPACE_DIR=<AuditWorkspace>`，输出与 temp 均在 AuditWorkspace，`VIDEOAUTO_CONFIG_ROOT=Split-Path state.env`、`VIDEOAUTO_ENV_PATH=state.env`，PATH 前置 Candidate 的 `ffmpeg/bin` 与 `node-runtime`；没有 `RUNTIME_ROOT` 这个替代键。

然后对同一镜做两次直调：

1. 两轮最终 env 都显式设 `PACKAGING_AGENT_SELECT=true`、`VIDEOAUTO_TEMPLATE_PACKAGING=true`、`VIDEOAUTO_PACKAGING_SCRIPT_ONLY=true`、`PACKAGING_AGENT_BACKEND=pi`、`PACKAGING_AGENT_CACHE=false`、`MATERIAL_AGENT_PI_SKIP_PROVIDER_MERGE=false`，并选一镜确有 `card_content` 的输入。两轮各在 AuditWorkspace 下建不同的 `$RoundAudit`，设 `PI_CODING_AGENT_DIR=$RoundAudit\pi-agent` 指向新的空目录，不复制用户 Pi auth/settings/models；这样正确轮的 bundled evst provider 只会合并到临时目录，原用户 `models.json` 不被写入。
2. 缺 provider 轮从专用 env 副本删除 `MATERIAL_AGENT_PI_PROVIDER` 与 `MATERIAL_AGENT_PI_API_KEY`，并在 `fileEnv + managed + account` 合并后再次从最终 env 删除这两项；显式 PI API key 会让配置检查误判已配置、压掉应有告警。配置轮在最终 env 强制 `MATERIAL_AGENT_PI_PROVIDER=evst-gateway`。账号 `DASHSCOPE_API_KEY` 仍由既有 gateway 注入，不打印。两轮使用不同输出子目录，不共享 `_agent_cache/packaging.json`。

通过标准：未配置时打印一次清楚的 ASCII `[agent] [!]` 告警，说明会静默降级及如何修复；任务退出 0、成片照出、`fallback_used=true`。配置正确后不再告警，`fallback_used=false`。不改变既有降级算法。

## B4 · 两个安装脚本在中文 Windows 下重定向不崩

使用 B3/B6 Candidate 内的两个 installer 脚本和 Candidate 嵌入 Python；tracked SHA 已证明脚本等于 repo，同时 Candidate 保留 Pi/HF `node_modules` 和 node/chrome。B3 前的 `-X utf8` 只算依赖预检，不能算 B4。B4 新进程不加 `-X utf8`，临时移除 `PYTHONUTF8` / `PYTHONIOENCODING`，保存 `sys.stdout.encoding`、`locale.getpreferredencoding(False)`、相关 env、两条重定向日志和退出码，随后恢复原环境。Pi 执行 `--check`，HF 执行 `--check --runtime-root <Candidate>`；两条都必须退出 0，实际 encoding 应证明是中文 Windows 的 `gbk/cp936` 口径，日志不得出现 `UnicodeEncodeError`。本项不安装依赖。

## B5 · 修正后的 unittest 收集与专项

原先的 `discover(<绝对 tests>, top_level_dir=<源码根>)` 对没有 `__init__.py` 的 `tests/` 无效，会在收集前报 `Start directory is not importable`。不要为此新增 `tests/__init__.py`。优先使用运行包自带的嵌入 Python；它的 `._pth` 会限制导入，因此在新进程中显式插入源码根和 tests 路径、切到源码根、新建 loader，再以相对 `tests` 发现，**不传 `top_level_dir`**：

```powershell
$Repo = 'D:\autocut\video-auto-cut'
$SourceRoot = 'D:\autocut\video-auto-cut\VideoAutoCut'
$EmbeddedPython = 'D:\Video Edit\VideoAutoCut\workspace\runtime\0.5.14\VideoAutoCut\python-3.11.9-embed-amd64\python.exe'
$ShortHead = (git rev-parse --short HEAD).Trim()
$AuditName = 'b5-rerun-' + $ShortHead + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$Audit = Join-Path $Repo ('VideoAutoCutDesktop\node_modules\.tmp\' + $AuditName)
New-Item -ItemType Directory -Force $Audit | Out-Null

$Runner = Join-Path $Audit 'run-b5-unittest.py'
$RunnerSource = @'
import os
import sys
import unittest
from pathlib import Path

source_root = Path(sys.argv[1]).resolve()
tests_root = source_root / "tests"
sys.path.insert(0, str(source_root))
sys.path.insert(0, str(tests_root))
os.chdir(source_root)
loader = unittest.TestLoader()
suite = loader.discover("tests", pattern="test_*.py")
result = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
'@
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($Runner, $RunnerSource, $Utf8NoBom)

$Command = '& "' + $EmbeddedPython + '" -X utf8 "' + $Runner + '" "' + $SourceRoot + '"'
[System.IO.File]::WriteAllText((Join-Path $Audit 'B5.command.txt'), $Command, $Utf8NoBom)
$EnvironmentFile = Join-Path $Audit 'B5.environment.txt'
[System.IO.File]::WriteAllText($EnvironmentFile, ('PowerShell=' + $PSVersionTable.PSVersion.ToString() + [Environment]::NewLine), $Utf8NoBom)
$PreviousErrorActionPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  & $EmbeddedPython --version *>> $EnvironmentFile
  & $EmbeddedPython -X utf8 $Runner $SourceRoot *> (Join-Path $Audit 'B5.log')
  $B5Exit = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $PreviousErrorActionPreference
}
[System.IO.File]::WriteAllText((Join-Path $Audit 'B5.exitcode.txt'), [string]$B5Exit, $Utf8NoBom)
Get-Content (Join-Path $Audit 'B5.log') -Tail 40
```

报告当前 HEAD 的实际 Ran/tests、failures、errors、skipped 和退出码，并单独报告 `test_script_card_fields` 的测试数和结果。B5 修复在 `1b6f6cf` 找回 11 个顶层函数式测试并新增 2 个 store mock 隔离回归；后续真实 XLSX parser 与换行保留回归继续增加用例。Mac 在全新 Python 进程确认本次代码可收集 522 cases、loader errors=0，`test_script_card_fields` 专项 124/124 通过；这些只是代码侧收集和专项证据，不能当作 Windows 整套执行结果或固定总数。不要再重跑旧 505/501 对照，不要给生产嵌入 Python安装 pytest/chromadb，也不要修改测试文件来刷绿。

**放行门槛仍是当前 HEAD 0 failures / 0 errors。** 通过后按既有顺序继续 B2/B7/B8、B3、B4、B6；若仍有 failure/error，立即停下回帖，不能继续 pkg4。只有真实 Chroma/CLI 用例仍失败时，才按本轮补充评论引用的独立诊断脚本补 `indexed.output`、完整 exception traceback 和真实 chromadb 模块来源；该补证本身不等于 B5 放行。

至少确认这些风险有回归用例：

- 解析器正确时 plan 字节不变；镜号错位或内容锚点认不出时只告警。
- 下方另一张表不能因角色列更多抢走上方真表头。
- `分镜标题（全片通用）` 与纵向合并单元格不能把整片 title 覆盖成同一个值。
- 相似列名和带冲突括注的列不做子串误匹配。
- 没有上屏列的普通表格不清空正确的卡片内容。
- 多 sheet 歧义、分镜号不连续、镜数不符、超限文件均只告警不改。
- md/xlsx/txt 等价夹具抽取一致；日志与作者文本可通过 GBK stdout。
- 包装提示词 golden、Pi provider 告警、安装脚本编码测试仍通过。

## B6 · 关闭包装时旧渲染基线不变

使用上文同一 Candidate；先完成尚未执行的依赖预检，再取 `51296044` A1 使用的同一批 9 月 18 日 7 镜输入和原参数，将 `VIDEOAUTO_TEMPLATE_PACKAGING=false`，所有输出写入 AuditWorkspace，用最终代码直调。不要改 pi-test Base。

通过标准：7 镜成片 SHA-256 与 `51296044` A1 留存值逐镜完全相同，两边都不产生 `packaging/` 目录。把「镜号、旧 SHA-256、新 SHA-256」七行贴回。此项只防脚本校验改动误伤卡片/渲染，不重跑 A1–A13 或五条完整包装任务。

## B7（本轮重点）· xlsx 真实路径与等价夹具

### 夹具验证

对仓库内标准的 xlsx / txt / 03 md 三份等价夹具比较。这是表格功能门槛，必须完整通过，不能用「触发安全闸门所以没误改」代替：

- 均导出 7 镜。
- 三份的 `card_content` / `card_hint` 和脚本明确写出的 `title` 逐字相同。
- 1、5、7 镜有脚本上屏内容；2、3、4、6 镜没有 `card_content`。
- 第 7 镜 `card_hint=CTA 行动号召`，其余未写 hint 的镜不凭空生成 hint。
- 每次 qwen 导入各自的 `cardFieldCorrections` 和只告警原因按实际原样回帖；**不要求三次 corrections 数组相同**，只要求纠正后的作者字段逐字一致。

### 真实生产 xlsx

Mac 的离线样本只记录统计，不把用户原始 xlsx 自动加入仓库：44 个路径去重后为 19 份，19/19 读取成功，表头位于 11/18/20/21 行，均识别为 7 或 8 镜；已识别角色只有 `time_range/visual/voice_text`。这些文件没有显式 title/card 列，因此只能证明真实表形状能识别、无关字段不被误改，**不能证明 title/card 自动纠正正例**。

用户本轮指定样本固定为 `上下料科普脚本_v2A_机器人给机床上下料_一个循环里到底发生了什么.xlsx`，SHA-256 `9f804531f7aafeb7fda7157170d684a7e928ebd0546ab9eaf5e8a97e567a0048`。Mac 已找到同 SHA 原件：主表 7 镜，本轮规则能识别 9/14 列（`0.642857`，超过既有 0.6 阈值）；单列 `屏字/大字` 映射 `card_content`，`原创图层` 映射 `card_hint`，`时间码(入)` / `时间码(出)` 只辅助表格识别，不合成时间范围、不写回 plan。生产改动只处理表格 `card_content`：保留单元格内部换行和横向空白，并在校验/去重时按保留后的字符比较；既有首尾处理、占位和整值格式语法保留，`card_hint`、`title`、text 路径不变。代码侧按原始单元格在内存构造 plan，验证 7/7 `card_content` 严格字符一致；把其中 6 镜 LF 破坏为空格时恰好产生 6 条纠正，正确 plan 再跑为 0 纠正且字节不变。hash/长度/码点证据归档为 `B7换行_离线回归_2026-09-22.json`。`card_hint` 7/7 严格一致是 Windows 评论 `51323116` 的旧 HEAD 实测证据，仍需在新 run 复核。旧 19 份提取统计与旧结果一致，其按原文在内存构造的干净 plan 仍全为 0 改。

支持边界只覆盖：首张有效 sheet 的精确名称为 `分镜脚本`；后表必须无目标字段、镜数相同，并且逐镜旁白仅折叠空白后与主表相同，才按辅助 sheet 处理。这不是通用 sheet 优先级规则。旧轮 14 处 card 两字段模拟修复属于历史 parser 证据；本轮新增的是 6 处 `card_content` 换行修复证据。两者都只证明确定性层规则，**不能代替 Media 对同 SHA 原件的一次缺键默认开启 plan-only**。

Media 在新 HEAD 只对上述同 SHA 样本重新做一次**缺键默认开启**的 `--plan-only`；不批量调用其它生产文件。回报文件标识和 SHA-256，不上传原文件、不贴敏感正文；再报告 sheet 数、识别到的 sheet/表头行/角色列、镜数、纠正数、只告警数。严格校验必须用 `script_tabular.read_workbook` 直接读取原始 `屏字/大字` / `原创图层` 单元格，再与最终 `shots.json` 比较；expected 一侧禁止 `collapse`、`strip` 或先经 `collect_blocks` 派生。结果要分两类写清：

- 成功识别并逐字校正：才算这份真实 xlsx 的功能验收通过。
- 因歧义触发安全闸门、plan 未被误改：只证明保护层安全，**不证明这份 xlsx 已得到功能覆盖**。

若真实表格应能识别却持续落入安全闸门，或出现误改，立即停下回帖；不要扩大词表、改提示词或手工修 plan。Mac 将决定修规则还是把该类表格降级为只告警。不要为这项批量调用 19 份 xlsx 的 qwen。

## B8 · title 边界

复用 B2/B7 的导入结果，不另跑任务：

1. 三种格式的 03 脚本中，每镜脚本写出的 title 必须逐字保留，尤其 03-4 的长句和 03-6 的「开场」。
2. 02 / 04 等脚本没写 title 时，解析器自拟或 schema 兜底的 `分镜N` 保留，不算臆造，不清空，也不应告警。
3. `module_label` 不纳入 title 校验。
4. 只有 title 能当内容锚点、而 title 本身已被改写时，无法确认镜号就只告警，不自动纠正。

## 3. B2–B8 门槛通过、B1 已记录后重打 pkg4

pkg2、pkg3 均已过期，**不要上传，也不要复用它们的 manifest**。保留好 0.5.14 底包后执行：

```powershell
cd D:\autocut\video-auto-cut

python VideoAutoCut\tools\material_gen\pi\install_pi.py
python VideoAutoCut\tools\material_gen\pi\install_pi.py --check

python VideoAutoCut\tools\material_gen\hyperframes\install_hyperframes.py --runtime-root "<保留的0.5.14底包目录>"
python VideoAutoCut\tools\material_gen\hyperframes\install_hyperframes.py --check --runtime-root "<保留的0.5.14底包目录>"

cd VideoAutoCutDesktop
$env:VIDEOAUTO_RUNTIME_VERSION = "0.5.15-agent-trial-pkg4"
$env:VIDEOAUTO_RUNTIME_BASE_ROOT = "<保留的0.5.14底包目录>"
npm run release:pack:runtime
```

两份安装脚本都把 `node_modules` 装进**仓库**的 `VideoAutoCut/tools/material_gen/pi/` 与 `.../hyperframes/`，不是装进 0.5.14 底包；打包脚本先复制底包，再用仓库整棵 `VideoAutoCut/tools/` 覆盖/补入 stage，所以必须先在仓库运行安装脚本。`install_hyperframes.py --runtime-root` 只借底包的 node 与 chrome 做自检，CLI/GSAP 仍检查仓库刚装的那份。

不要给 HyperFrames 安装加 `--omit=optional`；Pi 安装脚本内部按自身既定逻辑使用精简依赖。两个 `--check` 必须在打包前退出 0；HyperFrames 的检查必须真跑 `require(sharp)` 和最小分页 lint。打包完成后还要在解压目录内用包内脚本各跑一次 `--check`，确认没有被底包里的旧 tools 覆盖回去。

打包后只做本地检查：

- `manifest.json.latest == 0.5.15-agent-trial-pkg4`
- zip 文件名、版本号、manifest 三处一致。
- 记录 zip 字节数和完整 SHA-256：`<PKG4_SIZE>` / `<PKG4_SHA256>`。
- 解压到独立临时目录，用包内 Python 跑两个 `--check`，并确认包内全部 tracked tools 与 issue 补充评论指定的最终新 HEAD 对应文件一致；不能再锚定旧 `1a5f5d0`。

**到这里停止。不要执行 `release:upload:runtime`。** 线上 `runtime/manifest.json` 的 latest 保持 **0.5.14**，`runtime-trial/` 也不动；`release-upload.local.json` 不改、不提交、不复制到 Mac。

## 4. Media 完整回帖模板

````markdown
# Windows 回帖：最终修复轮验收结果（<FINAL_HEAD>，代码锚点 1a5f5d0）

## 结论
- B1：观察项，已记录/异常；两份提示词 SHA-256：...
- B2：通过/不通过；7 份脚本分别 corrections=...、只告警=...、逐字一致=...
- B3：通过/不通过；未配 provider 告警次数=...、fallback=...；配好后 fallback=...
- B4：通过/不通过；pi-check rc=...、hf-check rc=...、GBK 错误=有/无
- B5：Ran ...，failures=...，errors=...；test_script_card_fields=...
- B6：通过/不通过；逐镜旧/新 SHA-256 表如下
- B7：通过/不通过；等价夹具和真实 xlsx 表如下
- B8：通过/不通过；三份 03 的 title 和只告警项如下

## B2/B7/B8 明细
| 文件 | 格式 | 镜数 | corrections | 只告警 | card字段逐字一致 | title逐字一致 | 备注 |
|---|---:|---:|---:|---:|---|---|---|
| ... | ... | ... | ... | ... | ... | ... | ... |

### cardFieldCorrections / 告警原文
```json
...
```

### 三份 03 的 7 个 title
| 镜 | md | xlsx | txt | 三份一致 |
|---:|---|---|---|---|
| 1 | ... | ... | ... | ... |

### 真实 xlsx
| 文件 | sheet/表头行 | 角色列 | 镜数 | corrections | 只告警 | 结论 |
|---|---|---|---:|---:|---:|---|
| ... | ... | ... | ... | ... | ... | ... |

## B6 渲染基线
| 镜 | 旧 SHA-256 | 新 SHA-256 | 相同 |
|---:|---|---|---|
| ... | ... | ... | ... |

## pkg4（仅本地打包，未上传）
- version: 0.5.15-agent-trial-pkg4
- zip: ...
- size: ...
- SHA-256: ...
- install_pi --check: rc ...
- install_hyperframes --check: rc ...
- 解压复核：...

## 状态确认
- git HEAD: ...
- master 未合并：是/否
- 生产 app.env 已还原：是/否
- 0.5.14 底包已保留：是/否
- 未执行 upload：是/否
- 线上 latest 仍为 0.5.14：只读核对结果 ...
````

## 5. Jev 研究结论与后续建议

完整证据见 [TypeSafe AI Jev 适配调研](jev-fit-2026-09-22.md) 和 [Agent 判断环节现状](agent-stage-map-2026-09-22.md)。官方 TypeSafe Jev 1.13 接受文本或文本值 JSON，输出预定义的 `Choice`、`Score`、`Noul` 决策；它不接收图片、音频或视频，也不生成自由文本。

若后续试验，第一步只做包装版式 shadow：仅在脚本已有 `card_content` 且 `card_hint` / 现有确定性规则不能直接决定模板时，让 Jev 在 `title/parameters/cta` 中三选一，只记录答案与概率，不改变 `show` 或任何脚本原文。已有规则能确定时继续走规则，不增加 Jev 调用；对比基线同时包括确定性规则和当前模型，避免多一次 API 反而变慢。下一步可研究 `keep/rewrite` 路由，判为 rewrite 后仍由现有生成模型生成 query；包装文案始终只取脚本原文，生成模型可负责 query 和代码。

历史 orientation + judge 合计约占 7 镜 agent 用时的 73.6%，但两者都需要看真实帧，Jev 只能帮助决定是否升级调用，不能完成视觉判断，不能预先承诺整片提速。官方 `70–500 ms` 及倍数属于厂商 benchmark；Windows 真实中文数据的 p50/p95 仍需另测。官方还说明其主要训练语言是英语，CJK 可以处理但准确率较弱，因此必须先用本项目真实中文脚本做旁路验证，不能只看厂商速度就放权。

本轮只有研究，没有 Jev 集成或 API 调用；Jev 不加入 Media 的 B1–B8 门槛，Media 现在不接 Jev，也不做 Pi 整体编排。当前 Pi 只是 material 与 packaging 的可选 backend，实际使用有限；路线仍是先把各环节 agent 分别测试稳定，再深入 Pi 编排。

## 6. 不在本轮范围

- 不测试或优化 `SCRIPT_ONLY=0` 的模型 show 判断；不改空字段 payload。
- 不让 agent 从口播摘上屏文案。
- 不新增 PDF、旧 `.doc`、旧 `.xls` 解析能力；读不了时只告警、零动作。
- 不改素材检索 `visual_query`、横倒扶正、字幕切分、分镜切点或其它新功能。
- 不重跑已由 `51296044` 验收通过的 A1–A13 和五条完整包装出片。
- 不合 master，不发正式版，不上传 pkg2/pkg3/pkg4，不触碰线上 0.5.14。
