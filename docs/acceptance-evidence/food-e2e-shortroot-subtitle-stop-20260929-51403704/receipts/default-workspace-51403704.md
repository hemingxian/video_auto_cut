# 51403704 普通用户默认工作区只读审计

## 结论

普通 Windows 用户按安装器默认值安装，首次启动且不在设置页填写工作区时，产品工作区是：

`%LOCALAPPDATA%\VideoAutoCut\workspace`

若 `LOCALAPPDATA` 不可用，安装器回退到 `$PROFILE\AppData\Local\VideoAutoCut`；Desktop 运行时则回退到 Electron `app.getPath('home')\AppData\Local\VideoAutoCut`。`APPDATA` 仅用于旧版 roaming 工作区迁移路径，不是当前默认工作区。

以本机用户名 `evstm` 代入但不使用本机自定义设置，默认工作区为 `C:\Users\evstm\AppData\Local\VideoAutoCut\workspace`，51 个字符。普通 Desktop 本地素材流程在 `VideoAutoCutDesktop/electron/material-local-store.ts:3460` 生成 `run_` 加去连字符 UUID，即36字符 preferred manifest run id；例如 `run_175e3315e0624f028eba293d66a9dece`。搭配项目名 `未命名任务` 时，包装第9镜工作目录为：

`C:\Users\evstm\AppData\Local\VideoAutoCut\workspace\video\runs\20260929\未命名任务\.videoautocut\runs\run_175e3315e0624f028eba293d66a9dece\final_clips\packaging\0009_final`

长度为166个 Python/Windows 路径字符串字符。沿用同一36字符 manifest run id 和12字符示例项目名时为173字符。CLI 没有 preferred manifest id 时，`main.rs:1033-1044` 的实际格式含毫秒，例如 `run_20260929_143223_123_15304`（29字符），搭配 `未命名任务` 时为159字符。这些都是具体实例，不是全局最大值。

本机实际安装设置不同：注册表 HKCU/HKLM `Software\VideoAutoCut\UserDataRoot` 都是 `D:\Video Edit\VideoAutoCut`，其 `config\app.env` 没有 `VIDEOAUTO_WORKSPACE_DIR` 或 `VIDEOAUTO_DATA_ROOT` 覆盖，因此本机当前工作区推导为 `D:\Video Edit\VideoAutoCut\workspace`（36字符）。这不是普通用户默认值，也与验收 audit root 无关。

## 取值链

1. 安装器默认 user-data root：`VideoAutoCutDesktop/build/installer.nsh:84-100`，先 `LOCALAPPDATA`，缺失则 `$PROFILE\AppData\Local`，再追加 `VideoAutoCut`；安装时写注册表和安装目录 marker：`:256-285`。
2. Desktop userData 优先级：`VideoAutoCutDesktop/electron/main.ts:87-100` 依次读取 `VIDEOAUTO_USER_DATA_ROOT`、安装 marker、HKCU、HKLM，最后回退 `LOCALAPPDATA\VideoAutoCut`；`resolveLocalAppDataRoot` 的 fallback 在 `:49-51`。
3. Desktop 工作区优先级：`main.ts:136-140` 为进程 `VIDEOAUTO_DATA_ROOT` → app.env `VIDEOAUTO_WORKSPACE_DIR` → app.env `VIDEOAUTO_DATA_ROOT`；`workspace-service.ts:168-172` 在没有配置时追加 `userDataRoot\workspace`，相对配置也相对 userData root。
4. `APPDATA` 只出现在 `main.ts:142-145` 的 legacy roaming 路径 `%APPDATA%\VideoAutoCut Studio\workspace`。
5. Desktop 传给 engine：`workspace-service.ts:453-465` 同时设置 `VIDEOAUTO_DATA_ROOT` 和 `VIDEOAUTO_WORKSPACE_DIR` 为已解析的 `dataRoot`。
6. Engine 优先级：`VideoAutoCutApp/src/paths.rs:30-34` 为 `VIDEOAUTO_DATA_ROOT` → `VIDEOAUTO_WORKSPACE_DIR` → engine root；随后 `:57-58` 使用 `<data_root>\video\runs`。Python 工具的独立 fallback 同样是 `VIDEOAUTO_DATA_ROOT` → `VIDEOAUTO_WORKSPACE_DIR` → runtime root（`VideoAutoCut/tools/common.py:59-66`）。正常 Desktop 启动会显式传值，所以 engine/Python fallback 不改变上述产品默认。

## run 与包装目录公式

`VideoAutoCutApp/src/main.rs:1001-1023` 创建：

`<data_root>\video\runs\<YYYYMMDD>\<project_name>\.videoautocut\runs\<run_id>`

`main.rs:1087-1095` 对项目名清理并截到64个 Rust Unicode scalar；`main.rs:988-997` 对 manifest `run_id` 限制为 ASCII 字母数字、`_`、`-` 且最多128字符。没有 manifest id 时，`:1033-1044` 生成时间/PID id。最终片段为 `final_video.rs:71-78` 的 `final_clips\0009_final.mp4`；包装 cwd 是 `render_segment.py:593-603` 的 `out.parent / "packaging" / out.stem`，因此目标 cwd 为：

`<data_root>\video\runs\<date>\<project>\.videoautocut\runs\<run_id>\final_clips\packaging\0009_final`

Windows 字符串长度公式（不带 `\\?\` 前缀）是：

`len(data_root) + len(project_name) + len(run_id) + 74`

条件界而非全局上界：按路径字符串字符计，若使用代码可见的64字符项目名和128字符 manifest run id，本机默认51字符 root 得317字符。`run_task_name` 在调用 `sanitize_filename` 后再按64个 Rust Unicode scalar 截断；本审计没有核第三方库内部字节截断语义，因此不把 supplementary-character 的 UTF-16 推算声称为可达最大值。userData root 可由环境、安装 marker、注册表或用户设置为任意绝对路径，源码没有全局长度上限，因此不存在可由源码给出的全局最大完整路径。

本审计没有读取或输出密钥，没有修改配置，也没有使用验收 audit root 代替产品默认。
