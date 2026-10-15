# VideoAutoCut

VideoAutoCut 是一套面向 Windows 的自动化视频生产工具。仓库按运行职责拆成四个子项目：

| 目录 | 职责 | 主要技术 |
| --- | --- | --- |
| `VideoAutoCutApp/` | 工作流编排、任务规划和外部进程调度 | Rust |
| `VideoAutoCut/` | 字幕、配音、素材检索和视频渲染工具 | Python |
| `VideoAutoCutDesktop/` | 桌面交互、运行时管理和任务状态展示 | Electron、React、TypeScript |
| `VideoAutoCutWeb/` | 产品官网 | HTML、CSS、JavaScript |

## 架构边界

- Rust 引擎负责编排，不复制 Python 工具中的具体媒体处理算法。
- Python 工具通过命令行参数、JSON 文件和 `VACUT_EVENT` 事件与引擎通信，不依赖桌面端实现。
- Electron 主进程封装文件系统、网络和子进程能力；渲染进程只通过类型化 preload API 访问这些能力。
- 官网是独立静态资源，不引用桌面端的构建产物。
- 大体积运行时、用户配置、密钥和生成素材不进入 Git；完整清单见 [RUNTIME.md](RUNTIME.md)。

## 第三方代码边界

- `VideoAutoCut/sentrysearch/` 是上游开源依赖，不纳入本项目的日常风格重构；升级应使用独立变更并保留上游差异可追踪性。
- `VideoAutoCut/tools/animation_agent/official/` 保存外部项目的官方参考资料，不做本地格式化或结构调整。
- 项目质量门禁只检查自有的生成流水线、Rust 主控、桌面端和官网代码，不修改打包进来的依赖源码。

## 本地开发

桌面端：

```powershell
Set-Location VideoAutoCutDesktop
npm ci
npm run dev
```

Rust 引擎：

```powershell
Set-Location VideoAutoCutApp
cargo run -- --help
```

Python 工具依赖随发布运行时提供。开发时可使用仓库内的嵌入式 Python，或兼容的 Python 3.11 环境。

## 质量门禁

提交前从仓库根目录运行：

```powershell
./scripts/verify.ps1
```

该命令依次执行 Python 语法检查和单元测试、官网脚本与交互测试、Rust 格式/Clippy/测试，以及桌面端单元测试、lint 和完整构建。仅调试单个子项目时，可以使用 `-SkipPython`、`-SkipWeb`、`-SkipRust` 或 `-SkipDesktop` 跳过无关步骤。

GitHub Actions 会在推送和拉取请求上执行同一组质量检查。任何行为变更都应同时添加覆盖正常路径、输入边界和失败路径的测试。
