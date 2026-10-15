# 步骤 5 S2 范围修正证据（2026-10-09）

本修正对应 Mac 回帖 51489425，基于 `38e041ecf4ecba7ef05831e9bdfc3ce5441d4f3a`。只修正 S2 空白处理超出字幕范围的问题和两条 macOS 路径测试期望；Rust、Desktop、缓存产品逻辑及其他步骤 5 功能均未改动。未重编 release，引擎 SHA-256 仍为 `41995f53fae3d89c9486e6980b33b98a3f2e434f73a0706ad71948af40e6c871`。

## 修正内容

`wrap_text(..., cjk_word_boundaries=False)` 的默认和 `kinsoku=True` 路径恢复 a3e64b4 行为。`text_units()` 的 `\s+` 分组、单空格 pending、显式换行后缩进清理、orphan reflow 的 `rstrip`、kinsoku moved 和数字单位 glue 均保持旧实现。字幕专用 `cjk_word_boundaries=True` 使用独立 units/分支，继续保留 S2 的中文词边界和 U+0020，不削弱食品 9 镜的逐 codepoint/旧行尾标点测试。

卡片 normal 与 `headline_sub` 均移除 `white-space:pre`，并直接断言生成 HTML 不含该样式。旧步骤 5 证据里的两张 card-space fixture/PNG 来源于先前对授权范围的误解，本修正明确撤销其验收含义；食品 1/3/8/9 的旧 HTML 前后相同证据仍只说明这些无空格样例未发生视觉变化。

两条 cache 测试仅将期望路径也调用 `resolve()`，适配 macOS `/var` 到 `/private/var`；产品 cache 代码未变。

## a3e64b4 差分

测试通过 `git show a3e64b4:VideoAutoCut/tools/text_layout.py` 加载真实旧模块作为 oracle，没有复制或重写旧算法。默认与 kinsoku 两模式共 374 次比较：

- Mac 指定的 4 个失败样例，加中英混排、U+3000 全角空格、CRLF，共 7 类 × 2 模式 = 14。
- 18 个确定性字符串 × 10 个宽度 × 2 模式 = 360，覆盖空串、首尾/连续空白、tab、显式换行、数字单位、标点、标识符和混合文字。

所有返回行列表均与 a3e64b4 相等。

## 测试

focused 使用审计嵌入式 Python、`-I -B -X utf8`：

- `test_text_layout.py`：43/43，通过；相对 38e041e 的 41 项新增 2 项差分/范围测试。
- `test_template_packaging.py`：17/17，通过；相对 38e041e 的 18 项撤销 1 项超范围卡片空白恢复测试，同时保留 normal/headline 无 CSS 的直接断言。
- `test_script_template.py`：40/40，通过，N1 审计 225 states。
- 原卡片基线：`test_packaging_agent.py` 32 OK（1 个既有 skip），`test_script_card_fields.py` 193 OK（1 个既有 skip）。

测试数量净增 1，没有新增 skip。focused 原始记录见 [README](acceptance-evidence/step5-s2-wrap-scope-fix-20261009/README.md) 和 [receipt](acceptance-evidence/step5-s2-wrap-scope-fix-20261009/focused-receipt.json)。

最终全量使用 `D:/Video Edit/VideoAutoCut/workspace/runtime/0.5.15/VideoAutoCut/python-3.11.9-embed-amd64/python.exe -I -B -X utf8`：693 total / 691 passed / 2 existing skipped / 0 failed，89.771 秒；N1 再次实际审计 225 states。见 [命令](acceptance-evidence/step5-s2-wrap-scope-fix-20261009/python-full.command.txt)、[日志](acceptance-evidence/step5-s2-wrap-scope-fix-20261009/python-full.log) 和 [receipt](acceptance-evidence/step5-s2-wrap-scope-fix-20261009/python-full-receipt.json)。

保护文件与正式引擎复核见 [receipt](acceptance-evidence/step5-s2-wrap-scope-fix-20261009/root-protected-engine-receipt.json)：主目录两份 package 文件和 step1 七份历史候选未变化；未打包、上传、出片或进入步骤 6。
