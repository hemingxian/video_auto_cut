# Windows 原生 UI 验收证据（2026-09-28）

- 源提交：`7298afb8b10659dbdc3518a4e7f55425330e76f5`
- 分支：`feature/material-agent-select`
- 操作方式：官方 computer-use `@oai/sky`，真实 Windows Electron 桌面窗口。
- 截图：Sky 原始 JPEG 保留在本地审计目录；此目录仅收录无内容改动的 PNG 转码。`screenshots.json` 记录原 JPEG 与 PNG SHA-256、尺寸及逐像素一致校验。
- 本轮没有点击 Generate。

## 结果

| 范围 | 结果 | 证据摘要 |
|---|---|---|
| U1 | 通过 | 9 镜、9 个素材绑定、食品目录 6 素材、16:9 / 1080p、标准模板日志标记 |
| U2 | 通过 | 镜 1 与镜 8 的完整字段、字幕，以及景别/运镜/拍摄角度/转场四个下拉框 |
| U3 | 通过 | 镜 2 字幕编辑保留；镜 3 景别与镜 4 卡片/版式修改标记 |
| U4 | 通过 | 镜 3 景别和镜 4 卡片/版式恢复；生成标题改/复原；原空画面改/复原并重开持久化 |
| 应修 2 专项 | 通过 | `A2`、镜号 `-1` 的队列阻断卡片与“打开所在文件夹” |
| U5 | 通过 | 7 镜、初始 51 项待确认；单项确认、整镜归零、只看待确认、保存重开 |
| U6 | **失败并停止** | 实时日志有 `I9`/`K9` 两条 `text_cell_pending`，队列失败项却没有阻断详情和“打开所在文件夹” |
| U7 | 未运行 | U6 停点后未消耗最后 1 次导入 Qwen |
| 食品 E2E / W6 | 未运行 | 门禁关闭 |

## 调用与导入

详见 `import-ledger.json`。本轮实际进行 6 次模板规范化导入；导入 Qwen、包装 agent、素材 agent、TTS 和其他模型调用均为 0。两个 synthetic regression fixture 只用于已授权的专项 UI 复现：坏镜号 fixture 通过现有 `VideoAutoCut/tests/test_script_template.py` 的 `write_template` / `template_row` helper 生成，固定字段为镜号 `-1`、标题“坏镜号负例”、画面“坏镜号仍应阻断”，对应既有 `shot_no_invalid` 用例；原空画面 fixture 使用同一 helper，固定标题/画面/搜索词为空，对应既有生成标题与 `visual_missing` 用例。

## U6 停点

冻结输入 `docs/script-template-v1/转换演示_v1表格.xlsx` 的 SHA-256 为 `64d23f4889081c0239f396db40a4ef18744779232376eeba90d96c5d1ff48b63`。`U6_formal_I9_K9_realtime_log.png` 显示 I9/K9 两条阻断诊断；`U6_formal_queue_failed_no_blocked_panel.png` 显示队列选中且已滚到末尾，但缺少应有的 2 项阻断卡片。按工单要求未重试、未改输入、未改判断逻辑，并停止 U7。
