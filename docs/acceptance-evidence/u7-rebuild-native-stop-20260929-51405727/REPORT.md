# 历史 51405727：U7 新 Candidate 构建完成；官方原生 UI 阻塞 STOP

> 当前结论见下方“51406527 恢复阶段”：native 已恢复，U7 唯一 GUI 导入已通过并封存。

## 结论

按 Mac 51405727，已在 source `311d5e5b02bbf8610036cf81bea66b736a92621a` 上执行 `cargo build --release --locked`，并从旧隔离 Candidate 底包复制出新的短根 Candidate `D:\vac\u7n`。旧 Candidate 和旧运行现场未修改。

新编译 `VideoAutoCutEngine.exe` 为 8,308,224 bytes，SHA256 `be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf`。该 SHA 与旧引擎相同，因为本次授权修复只改 Python tool，Rust 输入未变；不能只凭 exe SHA 声称修复已加载。因此本轮另将仓库 tracked tools 157/157 全量同步至新 Candidate 并逐文件核对，mismatch=0；新 Candidate 的 `tools/script_card_fields.py` SHA256 为 `ed9fcc788e7c8ef81ec3e23dd2bd45e09e55271106f3024c18a31e5ec8e77c57`，与 `311d5e5` 仓库文件一致。由 engine 与 157 个 tool 的 path+sha256 按收据顺序组成对象、压成 PowerShell ConvertTo-Json -Compress UTF-8 bytes 后计算的 canonical bundle identity digest 为 458ca5b8bf8675be820cdbffafa773770c99cd0836ff0e744e91a591861e3a7b。它不是 candidate-bundle-identity.json 文件本身的 SHA256；后者为 `fccb452a859ff7460e9bac5342858c5c1c033be90ca192d785a53748cde8ddd3`。

Pi installer `--check`、HyperFrames installer `--check --runtime-root D:\vac\u7n` 和引擎 `--help` 都退出 0；fixture SHA256 仍为 `32928ce140c3d8b25ad0b5ac482896b3698417f7de8401920c9129c3b030697e`；六项保护 6/6 未变。fresh user-data、生成数据、temp、output 均为 0 个文件（隔离 `current.json` 单独存在）。

## 实际加载身份钩子

审计 observer 已准备为每次目标 engine spawn 立即记录 child PID、请求 exe realpath、Node `child.spawnfile`、参数 SHA 和 spawn 时 exe SHA；正式关闭元数据也重复记录路径与 SHA。该 helper SHA256 见 manifest。

本轮官方 `@oai/sky` 原生 Windows 通道在首次调用、同会话重试以及 reset/reimport 后的最后一次尝试均返回 `native pipe unavailable` / `os error 2`。按 computer-use 技能的有限恢复规则停止。没有启动 GUI，因此没有正式 engine child，实际子进程路径/SHA 为 **N/A**；静态 Candidate SHA 或 `--help` 不能冒充正式启动瞬间 loaded identity。

## 次数与停止边界

- 正式 GUI 启动：0
- GUI 导入点击：0
- 文件上传：0
- Qwen/模型调用：0
- 手动重试：0
- 正式 engine spawn：0
- 直接 CLI `--help` 静态检查：1
- GUI observer `--help` spawn：0
- U7 唯一一次导入额度：未消耗

没有用 CLI 导入替代冻结 GUI 流程，没有修改产品代码、配置、fixture、旧 Candidate、W6 或任何既有证据。等待 Mac/用户处理官方原生 UI 能力后再决定下一步。

---

# 51406527 恢复阶段：U7 唯一 GUI 导入通过；证据封存后 STOP

## 本阶段结论

按 51406527，在新会话中通过官方 `@oai/sky` 做了一次实际 native `list_windows` 自检并成功。模块命名空间第一次写成 `sky.list_windows()` 时只产生 JavaScript `not a function`，没有进入 native；选择实际导出 `sky.sky` 后执行的 native 调用恰好一次。公开收据保留该事实和 13 个窗口的计数，省略与任务无关的私人窗口标题。

工单要求保留的旧 `native-capability-check-51406141.json` 原收据也已纳入本包：805 bytes，SHA256 `cc625616ee5757c5940a8d514f35c3dc0cbb0d824eb9e1085f6d40ef08ea75f3`。

随后仅启动隔离 Electron，并于 `2026-09-29T09:47:06.832Z` 对冻结文件 `07_表格版_混合_show判定_食品码垛_CN.xlsx` 点击一次“导入并整理分镜”。正式 child PID 30704，启动时实际路径为 `D:\vac\u7n\VideoAutoCutEngine.exe`，SHA256 `be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf`；exit code 0，stderr 0 bytes。stdout 7,145 bytes（SHA256 `2cebe59a750363e4c9fb91e18f5e91f7ca41ec666053a0399719768de253bc0c`），VACUT events 1,035 bytes / 5 行（SHA256 `5680d8804d26629bb9c7dafaa3590f1d045a0298707b9e3a22373326cc77d196`）。

规范化结果为 7 镜。对冻结作者原文逐项比较 `title`、`card_content`、`card_hint`，共 21/21 exact，mismatch=0；包括第 3 镜 `镜头B`、第 4 镜长标题及第 6 镜 `开场`。唯一字段校正是第 1 镜缺失的 `card_content` 按原文恢复。GUI 截图记录导入完成及列表第 1–4 镜；应用在补拍第 5–7 镜及字段详情前已自然关闭，因此这些字段的完整证明来自保存的 7 镜 JSON 与 21 项逐字比较收据，截图不声称覆盖全部 21 项，也未为补图重启或重复导入。

stdout 开头的“分镜数: 6”是 `cli.rs` 的默认 `--shots 6` 在 `main.rs` 脚本解析前打印的启动参数，不是解析结果。随后 `normalize_script` 明确打印“分镜数: 7”，保存的 normalized JSON、最终 shots JSON 和 GUI 均为实际 7 镜。

## 本阶段调用计数与证据边界

- GUI 导入点击：1；手动重试：0；自动重试：0。
- 文件上传：1；`qwen-long` 主解析逻辑调用：1。
- voice review：0。实际 7 镜均含 `voice_text` 与 `subtitle`；`normalize_script.py:238-241` 的谓词只有缺任一类文本才请求 voice review。
- label review：0。实际中文 subtitle 与含汉字 title 使 `progress_labels.py:38-68` 的 7 项 `needs_review` 均为 false，pending=0。

以上是产品流程与日志可证明的逻辑调用次数。未保存模型 provider 的原始响应，也未在网络层独立抓取底层 HTTP 请求，因此不把“主解析逻辑调用 1”扩张为可独立证明的底层 HTTP 次数。`common.py` 的重试会打印警告；正式 stdout 无该警告，与自动重试 0 一致。

## 本阶段身份与停止边界

Candidate bundle 仍为 `D:\vac\u7n`：engine 加 157 个 tracked tools 全量重哈希 mismatch=0，canonical bundle digest `458ca5b8bf8675be820cdbffafa773770c99cd0836ff0e744e91a591861e3a7b`。fixture SHA256 为 `32928ce140c3d8b25ad0b5ac482896b3698417f7de8401920c9129c3b030697e`，六项保护 6/6 未变。

结果核验后通过 native Alt+F4 关闭隔离窗口；Electron PID 42904 与 launcher PID 31136 均退出，端口 4173/9 无监听。U7 唯一额度已消耗，禁止第二次导入。本阶段没有执行 Food、W6、legacy、产品修改、上传产品、merge 或 release；证据/回帖完成后 STOP 等 Mac。
