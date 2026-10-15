# 「只按脚本上屏」+ 卡片换行禁则 · Windows 验收清单（2026-09-21）

分支 `feature/material-agent-select`（`feature/packaging-script-only` 已快进并入，远端那条**保留不删**
但停在 `600180e`，是本分支的祖先，**不要再从它开工**）。在 `57ecd75` 之上的 commit，可各自单独回退：

| commit | 内容 | 能不能单独回退 |
|---|---|---|
| `8f24772` | 改动 A：只按脚本上屏（新 env `VIDEOAUTO_PACKAGING_SCRIPT_ONLY`，默认开） | 能 |
| `68405c6` | 改动 B：包装卡片换行禁则（数字+单位不拆、行首/行尾禁则、孤字回退） | 能（独立于 A） |
| `600180e` | 只有 docs | 能 |

> **本清单与 5 条包装测试合成一轮跑**（`docs/packaging-test-scripts-2026-09-21/README_测试说明.md`）。
> Windows 侧 9/21 上午那两条评论（`51291613` / `51291655`）**作废，不要执行**，一切以总开工单那条为准：
> 5 条测试直接按新行为（`script_only` 默认开）跑，README 里「新分支行为」那栏即本轮预期。
>
> 口径、代码落点、规则细节的正本在 `docs/packaging-agent-step1-2026-09-18.md` §8.9，本文不重复，只列**怎么验**。

**全程纪律**：app.env **就地改键，不能往文件末尾追加**（`common.load_dotenv` 是 `os.environ.setdefault`，
同名键第一次出现的那行生效）。每轮跑完还原生产 app.env。

---

## 0. 前置

```powershell
git checkout feature/material-agent-select
git pull                              # → 600180e
python VideoAutoCut\tools\material_gen\pi\install_pi.py --check
python VideoAutoCut\tools\material_gen\hyperframes\install_hyperframes.py --check --runtime-root "<已安装的运行包目录>"
```

两个 `--check` 都退出 0 再往下。不过就停，先修运行环境（`docs/packaging-agent-step1-2026-09-18.md` §6）。

---

## 1. 验收项

> 「基线」= `57ecd75` 上同一条任务、同一份输入的产物。**不用专门回退去跑一遍**：`ef1805c..57ecd75`
> 只差 6 个 docs 文件（`git diff --stat ef1805c 57ecd75` 可自证），代码逐字节相同，所以 9/18 那轮
> （`ef1805c` / 运行包 pkg2）留下的成片 sha256 与 run 目录**就是合法基线**，直接拿来对 A1/A12。
> 那轮的产物要是已经清掉了，再在 `57ecd75` 上补跑一条。

| # | 项 | 做法 | 通过标准 |
|---|---|---|---|
| **A1** | **包装关闭 → 与基线逐字节一致** | app.env `VIDEOAUTO_TEMPLATE_PACKAGING=false`（`VIDEOAUTO_PACKAGING_SCRIPT_ONLY` 保持默认，不管设没设），跑一条验证过的旧任务 | 每镜成片 **sha256 与 `57ecd75` 的基线逐字节相同**。这是本轮最硬的一条：包装关掉时本分支必须零影响。不同就是阻断，附两份 ffprobe + sha256 |
| **A2** | **包装开 + script_only 默认 → 只有写了 card_content 的镜出卡片** | app.env `VIDEOAUTO_TEMPLATE_PACKAGING=true`、`PACKAGING_AGENT_SELECT=1`、`PACKAGING_AGENT_BACKEND=pi`、`PACKAGING_AGENT_CACHE=0`，**外加 `MATERIAL_AGENT_PI_PROVIDER=evst-gateway` / `MATERIAL_AGENT_PI_MODEL=qwen3.6-plus` / `MATERIAL_AGENT_PI_TEXT_MODEL=qwen-plus` / `MATERIAL_AGENT_PI_THINKING=off` 这 4 个键**（漏配 provider 会 100% 静默降级，见 README §4.1 的警告框）；**`VIDEOAUTO_PACKAGING_SCRIPT_ONLY` 这一轮就是不设**（验「缺键=开」）。跑 `03_混合_show判定`（3 镜有 `card_content`、4 镜没有） | ① `packaging/*/overlay.webm` **只有那 3 镜有**，另外 4 镜**必须没有**；② 那 4 镜**不产生 `packaging-agent-log.json`**（= 零模型调用）；③ 那 4 镜的 stdout 有 `[packaging] 分镜 N 本镜脚本未写上屏内容，按脚本模式跳过包装（不调用模型）`，并且**照样有两行 `VACUT_EVENT`**（第一行 label 是「按脚本跳过 N/M」），桌面端包装进度不跳号；④ **7 镜全部出片可播**（不上卡片 ≠ 不出片）；⑤ 有卡片那 3 镜的 `render.log` 全 `0 errors` |
| **A3** | **零模型调用要真的零** | 同 A2 这一轮，数 `packaging-agent-log.json` 的份数 | 份数 == 有 `card_content` 的镜数。整跑合成段耗时应明显短于 `script_only=0` 那轮（每跳一镜省一次模型调用 ≈3–8s + 一次 overlay 渲染 ≈45s） |
| **A4** | **`script_only=0` → 老行为** | 同一份 shots.json + manifest（换新 `run_id`），app.env 就地加 `VIDEOAUTO_PACKAGING_SCRIPT_ONLY=0` 再跑一遍 `03` | ① **7 镜全部**产生 `packaging-agent-log.json`；② 没写 `card_content` 的镜按 agent 的 `show` 决定出不出 overlay（README 第三节 `03` 的预期表不变：3/4/6 应 `show=false`）；③ 第 5 镜若出现 `decision.overridden == "author_card_content"` 单独报 |
| **A5** | **桌面端开关读写 app.env 正确且就地改键** | 打开桌面端 →「画面样式」→ 字幕页签底部。先确认「模板包装」关着时**看不到**子开关；打开「模板包装」→ 出现「只按脚本上屏（推荐）」且显示**开启** | ① 子开关切「关闭」后，app.env 里 `VIDEOAUTO_PACKAGING_SCRIPT_ONLY` 那一行**就地变成 false**，**没有**在文件末尾多出第二行同名键；② 再切回「开启」同样就地改回；③ 用 `Select-String VIDEOAUTO_PACKAGING_SCRIPT_ONLY app.env` 确认**全文件只有一行**这个键 |
| **A6** | **旧 app.env 没有这个键时的默认** | 复制一份生产 app.env，**手工把 `VIDEOAUTO_PACKAGING_SCRIPT_ONLY` 整行删掉**。(a) 直接命令行跑一镜 `render_segment.py --template-packaging`，用一个**没有** `card_content` 的分镜；(b) 再开一次桌面端 | (a) 不出 overlay（= 缺键按**开**算）；(b) 桌面端启动后 app.env **自动补上** `VIDEOAUTO_PACKAGING_SCRIPT_ONLY=true`，且 UI 上子开关显示「开启」。两者结论必须一致 |
| **A7** | **切词回归两例 · 真渲截图** | 跑 `01_对照组` 里那条会分页的镜（或直接用 `04` 第 4 镜）＋ `05` 第 5 镜 | ① **「路径确认」例**：分页的那镜 `template.json` 的 `pages` 末页应是 `确认`（**不是单独一个 `认`**），真渲帧截图上第二页要看得到完整的「确认」两个字；② **「托盘满垛下线」例**（`02-3` / `05-5`）：`pages` 第二行应是 `下线`（不是单独一个 `线`）；③ 两条都要附**真渲截图**，不能只看 json |
| **A8** | **超长词硬失败不变** | 跑 `04` 第 6 镜（放最后） | 报错原文仍是 `模板上屏文字包含无法完整显示的超长词，请缩短上屏文字。`；agent 开着时前面先记一条 `overlay_fallback`；`render_segment` 退出 1 |
| **A9** | **分页老 bug 不复发** | `04` 第 4 镜（97 字长清单，`parameters`，实算 5 行 / 2 页） | `render.log` `0 errors`；`index.html` 每页有 `tl.set("#page-i",{opacity:0},…)` 硬收尾 |
| **A10** | **单测两态 0 failed** | ① §8 #7 那套模块 + 本轮新增两个：`python -m unittest tests.test_packaging_agent tests.test_template_packaging tests.test_material_agent_select tests.test_material_selection_policy tests.test_python_boundaries tests.test_render_segment_packaging tests.test_text_layout`；② 全量 `python -m unittest discover -s tests -p "test_*.py"`。**两个都跑两态**：`VIDEOAUTO_PACKAGING_SCRIPT_ONLY=1` 与 `=0`（`PACKAGING_AGENT_SELECT` 也建议 0/1 各跑） | **Windows 上 0 failures / 0 errors**。① 的用例数：基线 195 → 本分支 **216**（+21）；② 全量：基线 349 → 本分支 **369**（Windows 实测；Mac 上数出来是 370，多的那 1 个是
`test_qwen_cloud_embedder` 的**导入失败占位**——`unittest.loader._FailedTest`，缺可选依赖时
unittest 会为它塞一个假用例并计入 errors。Windows 上该模块导入得了，就没有这个占位）。Mac 上那 7 项固有失败（`/var` 符号链接、Homebrew ffmpeg、缺可选依赖）Windows 不复现——Windows 若红，那才是真问题。重点看新增的 `test_template_packaging.ScriptOnlyTests`、`test_render_segment_packaging.ScriptOnlyWiringTests`、`test_text_layout.PackagingKinsokuTests`（尤其 `test_kinsoku_never_widens_a_line_beyond_plain`，它钉的是「换行规则不许把能出片的卡片弄挂」） |
| **A11** | **真 lint 0 errors** | `scripts/verify.ps1` 的 Python/前端部分 + 打运行包 | 本步骤**零新增运行期依赖**，包体积不应变化。`npm run lint` 的 **10 处 `react-hooks/set-state-in-effect` 是既有问题**（§9.2 第 3 条），**不得新增第 11 处**；本分支改的四个前端文件（`VisualStylePanel.tsx` / `settings.ts` / `useConfigPageState.ts` / `workspace-service.ts`）**一处 lint 都不该有**。`tsc -p tsconfig.json` 与 `tsc -p tsconfig.electron.json` 必须 0 error；`npm test` 应与基线同为 376 pass / 21 fail（Mac 固有，Windows 上应更好）。以上 Mac 侧已全部实测 |
| **A12** | **字幕与进度条没被波及** | 任取一条**关掉模板包装**的旧任务，与基线比 | 成片 sha256 相同（= A1）。改动 B 只给包装路径加了 `kinsoku=True`，字幕与进度条的调用全是位置参数、走老逻辑；A1 过了这条就过了 |
| **A13** | **手写非 `true` 的开关值不会被静默改掉** | app.env 就地把 `VIDEOAUTO_PACKAGING_SCRIPT_ONLY` 改成 `1`（或 `yes`），打开桌面端设置页看这个开关，然后**改另一个不相干的设置**（比如字幕字号）触发自动保存 | 开关显示「开启」；保存之后 app.env 里那一行仍是 `1`/`yes` **或** 变成 `true`，**绝不能变成 `false`**。这是复审抓到的既有 bug（设置页以前只认精确的 `'true'`），本轮一并修了 |

---

## 2. 回帖要报的东西

1. **A1 / A6 / A13 的结论各一行**（这三条是「会不会影响现有用户」的闸门）。
2. **A2 的逐镜表**：镜号 / 有没有 `card_content` / 有没有 `overlay.webm` / 有没有 `packaging-agent-log.json` /
   `decision.template` / `reason` 原文。
3. **A3**：模型调用次数、合成段耗时，与 A4 那轮对比。
4. **A4 的逐镜表**：与 `README_测试说明.md` 第三节 `03` 的预期表逐镜对。
5. **A7 的两张真渲截图** + 对应 `template.json` 的 `pages` 原文。
6. **A10 两态的 tests / failures / errors 三个数**。
7. **A11**：`npm run lint` 的 error 总数（应仍是 10）+ tsc 结果 + 包体积对比。
8. **手改了 shots.json 的哪几处**（沿用上一轮的要求）。
9. 任何与 `docs/packaging-agent-step1-2026-09-18.md` §8.9 写的口径对不上的现象，单独拎出来报。

---

## 3. 已知会变、不是 bug

- `01_对照组_无上屏卡片`（6 镜全无 `card_content`）在默认模式下**一张卡片都不上**，
  `show` 那一维**测不到**了——这条脚本的原设计目的（看 agent 怎么判 `show`）在默认模式下失效，
  要测它必须 `VIDEOAUTO_PACKAGING_SCRIPT_ONLY=0`。见 README 的「57ecd75 行为 / 新分支行为」两栏。
- 卡片换行的「纯代价」约 1.1%：极少数含密集符号的文案会比以前多占一行。已用 4000 条随机语料 ×
  4 组真实卡片几何实测——**不会多出超宽行、不会丢字**，也没有一例把原本能出片的卡片打成「超长词」。
- `04` 第 5 镜 `parameters` 版式下「节拍」仍被切成 `…节` / `拍确认`。
  整句没有任何标点，判词边界只能上词典分词，本轮不引入，**已知不修**。
