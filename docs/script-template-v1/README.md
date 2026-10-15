# 标准分镜模板 v1（VAC-SB-1）

2026-09-23 · Mac 入库 · 干跑基线 `feature/material-agent-select` = `1bc0fdb`

## 用途

- 作者（或转换器）按这份模板写分镜脚本，软件将来用**确定性模板导入器**读取，不经大模型。
- 列定义、颜色约定、「来源/核对」状态写法以 [`模板设计说明.md`](模板设计说明.md) 为准。
- 导入器、字段透传、分镜工作区的开发方案与验收单：[`../template-import-workspace-2026-09-23.md`](../template-import-workspace-2026-09-23.md)（§3.5 导入闸门、§6.2 真实文件干跑、§9 入库清单、§12 已拍板事项）。
- 本目录是模板正本：实施方（Codex）只读，不改；有问题回帖由 Mac 改。
- 客户原始脚本**不入库**；`转换演示_*` 两份是用客户原文转换出的结果，原文只记录文件名和 SHA-256（在各自「项目信息」sheet 的转换信息里）。

## 文件清单与 SHA-256

| 文件 | SHA-256 | 说明 |
|---|---|---|
| `分镜脚本模板_v1.xlsx` | `f42b223122a5649aaf12fc85862185b60da20530d39a4ab58d4710ab9375cf12` | 空白模板 |
| `分镜脚本示例_上下料_v1.xlsx` | `a8dcefeac18dfb68957189e80719a06e83af7dfc0507577d2385932e70b444a5` | 格式演示（作者手写口径），不出片 |
| `转换演示_v1表格.xlsx` | `64d23f4889081c0239f396db40a4ef18744779232376eeba90d96c5d1ff48b63` | 表格型客户稿转换演示；第 8 镜正文补黄 = 被拦下的负例 |
| `转换演示_md文本.xlsx` | `a85420b8bae0f5c0fb8e48d7eaea0b89bc1ccb62c46de615199d0a8ec3784154` | 文本型（md）客户稿转换演示 |
| `示例_食品码垛_v1.xlsx` | `33a47aefc3d6e97d7cb556f827cfccbbac9dd2aba8e9cb35ae227b165869cc0a` | Mac 原创 9 镜，端到端出片用 |
| `模板设计说明.md` | `979389ff4e65877fbcd916128b9001e503c574fb170c2c87617deb543f2f6b51` | 列定义正本 |
| `_生成脚本/vac_template.py` | `d40fc151860dd13f0cba23cfebdb897b685d97026d23c9629a8de89e35ce6d0b` | 模板生成器（样式、字典、填写说明） |
| `_生成脚本/example_data.py` | `b19a9444eedc48da6cee30bc3d03b8deb7b5b6ac2984d6785277ff7fd56382d0` | 上下料示例数据 |
| `_生成脚本/example_data_food.py` | `e6c520994d17dfd0348f2b02e12005e01b3e67338520ab326e47a57279df5ccd` | 食品码垛示例数据 |
| `_生成脚本/build_food.py` | `dc439cb361b33e4f6c60d60cebfe78f312dcca887424136170f63bcb5662c993` | 生成 `示例_食品码垛_v1.xlsx` |
| `_生成脚本/provenance.py` | `133fe9d04e558d0356410276383cd682c8ebe6ff941eda4445a9ef02a16c5b99` | 逐字出处校验 |
| `_生成脚本/convert_demo.py` | `b4be40a3c7ae482413ce5fef83f421d10543eb5254806f53a63f6175f7487066` | 转换演示（客户原文 → 模板），原文目录走命令行参数 |
| `_生成脚本/map_上下料B端_v1格式.json` | `5690d7b8b4e2f52505714e968a34ec4ca9f9d56684eb9774018ef9f9a37487b9` | 表格型列映射档案 |
| `_生成脚本/dryrun.py` | `7196a70d423bc38942c991459f8b94ed0be18b6fed19e4501dc4a5e1af3e30b0` | 单文件干跑（调仓库 `script_card_fields`） |
| `_生成脚本/dryrun_all.py` | `94b7e4d4267364c2026ee5fffc5e45dcf3a7f4963188d88af8949f82be2d980c` | 批量干跑 + 方案 §3.5 闸门静态预检，写 `干跑结果.json` |
| `_生成脚本/干跑结果.json` | `4ed0de6ed36933ac6592dee0536f380bdb17418948d827e6f92dff99d0008a07` | 5 份 xlsx 干跑原始输出 + 闸门预检 + 对照实验 + 逐字出处校验 |
| `_生成脚本/干跑结果_食品码垛.json` | `325bbed6e1e97806b2a424f4138da4ce4341059daab21c8e5bb539ec6f9e5c5c` | 食品码垛首次干跑（含占位探针 `reconcile_placeholder_probe`） |

xlsx 在 `.gitattributes` 里没有文本属性、仓库未设 `core.autocrlf`，按二进制原样入库；`.md/.py/.json` 本身就是 LF，`eol=lf` 不改字节。检出后 SHA-256 应与上表一致。

## 预期干跑结果

两层结果，都在 `_生成脚本/干跑结果.json`：

- **仓库干跑**（键 = 文件名）：`1bc0fdb` 的 `script_card_fields.collect_blocks` / `reconcile`。这一层**不读底色、不读「来源/核对」**。
- **闸门预检**（键 `闸门预检_方案§3.5`）：按开发方案 §3.5 的颜色/状态规则静态读 xlsx，是将来模板导入器应给出的阻断/提醒。不是仓库代码的输出。

| 文件 | 仓库干跑 | 镜数 | card_layout（镜号） | 闸门预检（§3.5） |
|---|---|---|---|---|
| `分镜脚本模板_v1.xlsx` | `skipped:table` / tier `skipped`（空表，无分镜） | 0 | — | **阻断** `no_shots` |
| `分镜脚本示例_上下料_v1.xlsx` | `ok` / `certain`，表头第 1 行 | 9 | 1、2、8、9 `headline_sub`；5、7 `equal_lines` | 0 阻断，0 提醒；第 3 镜无卡片无提示；第 7 镜锚点含 `subtitle` |
| `转换演示_v1表格.xlsx` | `ok` / `certain` | 8 | 1、4 `headline_sub` | **阻断 2 条**：第 8 镜 `I9` 口播、`K9` 上屏文字 `text_cell_pending`（原文国内/海外两版）。提醒：`ai_suggested` 43 格（每镜景别/运镜/拍摄角度/画面内容/搜索关键词，第 1、7、8 镜另有转场）、`status_pending` 8 镜、第 8 镜 `status_note` 2 行 |
| `转换演示_md文本.xlsx` | `ok` / `certain` | 7 | 无（第 1 镜单行「5 个误区」） | 0 阻断。提醒：`ai_suggested` 44 格（每镜段落/景别/运镜/拍摄角度/画面内容/搜索关键词，第 1、7 镜另有转场）、`status_pending` 7 镜 |
| `示例_食品码垛_v1.xlsx` | `ok` / `certain` | 9 | 1、3、9 `headline_sub`；4、8 `equal_lines` | 0 阻断。提醒：`status_note` 9 条——每镜「来源/核对」第 2 行「Mac 原创（2026-09-23），非客户稿转换；画面按 9/17 冻结食品码垛素材核对」（第一行均为「已确认」）；第 8 镜锚点含 `subtitle` |

`reconcile` 交叉检查（模拟模型输出）：五份里有分镜的四份，`ideal`（逐字照抄）都是 0 处纠正、0 告警；`buggy`（故意没剥标签/丢失/臆造/翻译）上下料示例 4 处、两份转换演示各 4 处、食品码垛 3 处（其第 2 镜本就无卡片，「丢失」不构成错误），全部被纠正。

说明：

- `转换演示_v1表格.xlsx` 是按 2026-09-23 拍板 3 重新生成的版本：第 8 镜口播/上屏补黄，「来源/核对」追加「待确认原因：…」一行。仓库干跑层与首版逐字节相同（它不读颜色），变化只体现在闸门预检层：首版 0 阻断，现为 2 条阻断。`模板设计说明.md` §5 对 v1 第 8 镜的描述写于补黄前，以本表为准。
- 要让 `转换演示_v1表格.xlsx` 能导入：在 Excel 里删掉第 8 镜不用的那一版（只能删不能改字），清掉 `I9`、`K9` 黄色，状态改为「已确认」。
- 反例（不是模板）：`docs/packaging-test-scripts-2026-09-21/07_表格版_混合_show判定_食品码垛_CN.xlsx` 等，见方案 §6.2。

## 如何重跑

在仓库根目录：

```bash
# 1) 干跑 + 闸门预检（不调模型/API、不联网），结果合并写回 干跑结果.json
cd docs/script-template-v1/_生成脚本
VAC_TOOLS="$(git rev-parse --show-toplevel)/VideoAutoCut/tools" \
  python3 -B dryrun_all.py 干跑结果.json ../分镜脚本模板_v1.xlsx ../分镜脚本示例_上下料_v1.xlsx \
  ../转换演示_v1表格.xlsx ../转换演示_md文本.xlsx ../示例_食品码垛_v1.xlsx
git diff --stat -- 干跑结果.json    # 代码未变时应无差异

# 2) 单文件干跑（打印到 stdout，不含 reconcile）
VAC_TOOLS=... python3 -B dryrun.py ../分镜脚本示例_上下料_v1.xlsx

# 3) 重新生成示例
python3 -B build_food.py                      # -> ../示例_食品码垛_v1.xlsx

# 4) 重新生成转换演示（需要客户原文，原文不在仓库）
python3 -B convert_demo.py --orig-dir <放原文的目录> --out <输出目录> --only v1   # 或 md / all
```

注意：

- 用 `-B`，别把 `__pycache__/` 带进仓库；Excel 打开时留下的 `~$*.xlsx` 锁文件也不要提交。
- `convert_demo.py` 会把当前时间写进「项目信息 › 转换时间」，重新生成后 xlsx 的 SHA-256 必然变化；只改一份时用 `--only`，另一份保持不动。
- `干跑结果.json` 里 `对照_*` 三项（模板内含示例 sheet 未填/已填、分镜表多加一列音效）是首版用临时改过的副本跑出的对照实验，`dryrun_all.py` 不重跑、原样保留；`逐字出处校验_v1/_md` 来自 `convert_demo.py` 的输出，本次重新生成后与首版相同。

## 0.5.16 新增（2026-10-08，Mac 入库，基于 `a29d74f`）

需求单：[`../script-input-0.5.16-2026-10-08.md`](../script-input-0.5.16-2026-10-08.md)（步骤 0 的交付物就是本节文件）。空白 Excel 模板沿用上表 `分镜脚本模板_v1.xlsx`，不重复入库。

| 文件 | SHA-256 | 说明 |
|---|---|---|
| `字段规范_v1.md` | `b7eb0235cf5f7a2bb7aee13346a05a1295393e21f514476d0f8ef4cdde17b21a` | 字段正本（Excel/Markdown 通用），需求单 §3 + §4.1–4.2 的定稿 |
| `分镜脚本模板_v1.md` | `ab8102b9c4a284212289924dcc5d26c91b8719c587da67ac4aaa582b27c4b0c2` | 空白 Markdown 模板（项目信息 + 2 个空分镜）；导入预期：识别为模板、`no_shots` 阻断（与空白 xlsx 一致） |
| `示例_食品码垛_v1.md` | `7fefba1f66ada67dcf410060ab4c9d86a2d9eb12e8875c188807d5be858dae4f` | 与 `示例_食品码垛_v1.xlsx` 同内容的标准 Markdown（9 镜、26 个项目信息键），`build_md.py` 从 xlsx 生成，`check_md_vs_xlsx.py` 自检 0 差异 |
| `AI写脚本提示词_v1.md` | `3aa1382b94bafbae24dbe45967fe379082733fb6984d5c8709ed650ade151967` | 给客户的提示词（线下发，随空白模板和示例一起） |
| `示例_食品码垛_散文.md` | `78d75fd8c8ae8e9666d021d0d25942d9055354c25f42103f3ea5e96711e630c1` | 非标准散文脚本（走 AI 整理路）：9 段、9 句配音原文与示例逐字相同；全文只有 1 处「特写」（第 3 段）、1 处「上屏：」（第 4 段）；另有 1 处「跟」在口播「节拍才跟得上产线」里，用来测需求单 §6.3 第 5 条 |
| `示例_食品码垛_口播稿.txt` | `a6c7083e333e349a71d4cc12d14b5713080a281fc9ff39e5d9f581bc13c275eb` | 口播稿模式样例：首行「标题：…」、次行「说明：…」（预览窗应默认不勾），正文 5 段 = 9 镜口播按顺序拼接（去空白后逐字相等，已核） |
| `md负例/负例1_镜号跳号_应阻断.md` | `4c10bf3b23c64e8334d441fa7ba10fb8f8410a201bf7e62bbb7c1e243d160506` | 第 4 镜写成「分镜 5」→ 预期阻断 `shot_no_invalid` |
| `md负例/负例2_字段重复_应阻断.md` | `dcb6ef655baeb09c738ed2be1210eb6f19a20ca7c2f001f60f8f93dc8f2a4677` | 第 4 镜「运镜」写两次 → 预期阻断（字段重复） |
| `md负例/负例3_正文待确认_应阻断.md` | `7972519c2e45858f29fed66c2ba2a805dd6449f72ef68cdaa7ab0cff46a26c1e` | 第 2 镜「来源/核对」= 待确认 + `AI建议：口播、景别` → 预期阻断 `text_cell_pending`（正文黄格等价） |
| `md负例/提醒例_制作字段待确认_可导入.md` | `6aebedd2b3561d0848d8031ef106b6ee0bddfe0e6e09a49f796a1a7406aa3bd7` | 第 3 镜 `AI建议：景别、拍摄角度` → 预期可导入，`ai_suggested=[shot_size, camera_angle]` + `status_pending` |
| `_生成脚本/build_md.py` | `e622acb35f2f5499cba78feedd63e19a7c402f162911e67555ac84ab83057d3f` | 从入库 xlsx 生成上面的 md 示例、空白 md 模板和 4 份 md 负例 |
| `_生成脚本/check_md_vs_xlsx.py` | `5d528eeefb3c1b743fdacac2b31140acade997d74a6ee84876242f2a78b56c57` | 自检：用仓库导入器同款读取读 xlsx、用独立的最小解析器读 md，逐字段比对；`--selftest` 另跑 3 个改坏的副本确认能抓到 |

重跑：

```bash
cd docs/script-template-v1/_生成脚本
python3 build_md.py                       # 需要 openpyxl；只写 md，不碰 xlsx
VAC_TOOLS=../../../VideoAutoCut/tools python3 check_md_vs_xlsx.py --selftest   # 预期：9 镜，不一致 0 处，3 个 selftest 都「能抓到」
```

已知差异（比较时剔除，理由见需求单 §4.2）：0.5.15 xlsx 导入器的 `project_info` 会多一个 `"项目": "填写"`（把表头行当成键值）；md 没有这行。`check_md_vs_xlsx.py` 读 xlsx 时跳过表头行。
