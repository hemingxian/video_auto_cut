# 运行包自带的 pi（`MATERIAL_AGENT_BACKEND=pi` 才用得上）

这个目录是**随运行包一起发出去的 pi**。打包脚本
`VideoAutoCutDesktop/scripts/pack-runtime.ts` 会把仓库里整棵 `VideoAutoCut/tools/`
拷进运行包的 `tools/`，所以只要 pi 装在这里，打包脚本**一行都不用改**，
用户侧也不用装 pi、不用配 `MATERIAL_AGENT_PI_EXE` / `MATERIAL_AGENT_NODE_EXE`。

`material_agent_select.py` 的探测顺序（`pi_executable()` / `node_executable()`）：

| 找什么 | 顺序 |
| --- | --- |
| pi | `MATERIAL_AGENT_PI_EXE` → 本目录 `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` → `PATH` 上的 `pi` |
| node | `MATERIAL_AGENT_NODE_EXE` → `VIDEOAUTO_NODE_EXE` → 运行包 `node-runtime/node.exe` → `node/node.exe` → pi 同目录的 node → `PATH` |

运行包根目录本来就自带 `node-runtime/node.exe`（模板包装在用），pi 直接复用它，
不额外带 Node。**不要**走 npm 生成的 `pi.cmd` / `pi.bat`：cmd 转发参数会在第一个
换行处截断，多行 system prompt 及其后的图片、用户文本全丢（见
`docs/material-agent-select-trial-2026-09-17.md` 的「Windows 实测 1」）。

## 体积与「自包含」的事实（2026-09-17 Windows 实测更正）

以前这份 README 写过「cli.js 是自包含 bundle，约 8 MB」「整个目录约 11MB」——**都是错的**：

| 装法 | 体积 | 文件数 |
| --- | --- | --- |
| `--omit=dev`（含可选依赖） | **约 421 MB**（`du` 磁盘占用口径） | **13,678** |
| `--omit=dev --omit=optional`（**要用这个**） | **117.8MB**（字节总和；`du` 磁盘占用约 **137MB**） | **约 13,548** |

两个口径别混：`du -sh` 报的是磁盘占用（按块数向上取整），`install_pi.py --check`
打印的是 `lstat` 字节总和——同一棵精简安装的 `node_modules` 实测 117,837,647 字节、
`du` 约 137MB。上一版这里只写了 `du` 的数，和脚本打印对不上。

多出来的那 200 多 MB 是 pi 自带 `npm-shrinkwrap.json` 写死的 26 个平台的 `@esbuild/*`
和 10 个 `@mariozechner/clipboard-*`，Windows npm 会一股脑全装。精简版只差 130 个文件，
已实测能跑（方向判定 / 纯文本 / 整跑三轮全过）。

**`dist/bundle/` 不自包含**：只留 `dist/` 启动会报
`ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/chord'`
（来自 `dist/bundle/chunks/chunk-JVUZSMYM.js`），所以 `node_modules/` 必须整个带上。
唯一依赖 esbuild 的就是 chord。

**chord 的位置不固定**：pi 自带 `npm-shrinkwrap.json`，npm 按它把依赖装进
`pi-coding-agent` **自己**的 `node_modules/` 里不提升——Windows 实测 chord 在
`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/chord`，
顶层 `node_modules/@earendil-works/` 下**只有** `pi-coding-agent`。所以别按固定路径
判断有没有 chord，交给 node 自己解析（`install_pi.py` 就是这么做的，见下）。

npm 会提示 3 个包的 install script 不在 allowScripts：`@google/genai`（no-op）、
`esbuild`（postinstall 下载 `downloaded-@esbuild-win32-x64-esbuild.exe`）、`protobufjs`。
精简安装后剩 5 个原生产物（pi-tui 的 darwin/win32 `.node` + 那个 esbuild exe），
本线路只用 cli.js 这一条通路，不受影响。

## 怎么装

```bash
python VideoAutoCut/tools/material_gen/pi/install_pi.py
```

等价的 npm 命令（`--omit=optional` 不能少）：

```powershell
npm install --prefix VideoAutoCut\tools\material_gen\pi --no-save --omit=dev --omit=optional @earendil-works/pi-coding-agent@0.85.1
```

`install_pi.py` 装完会自检：`dist/bundle/cli.js` 存在、其 `package.json` 里
`version == 0.85.1`、chord 能被解析到（不自包含的证据），并打印文件数与总字节。

chord 那一项**首选用 node 按运行时规则解析**：跑
`node -e "const {createRequire}=require('module'); console.log(createRequire(process.argv[1]).resolve('@earendil-works/chord/package.json'))" <cli.js>`，
解析出来的就是 cli.js 运行时真正会加载的那份，嵌套装还是提升装都认。node 的找法与
`material_agent_select.node_executable()` 同序：`MATERIAL_AGENT_NODE_EXE` →
`VIDEOAUTO_NODE_EXE` → 运行根 `node-runtime/node.exe` → `node/node.exe` → `PATH`。
一个 node 都找不到时退回路径检查——嵌套位
（`…/pi-coding-agent/node_modules/@earendil-works/chord`）或顶层位
（`node_modules/@earendil-works/chord`）任一存在即通过，并打一行「未找到 node，按路径检查」。

想单独自检（比如打包前确认工作区已装好）：

```bash
python VideoAutoCut/tools/material_gen/pi/install_pi.py --check
```

退出码非 0 就是没装好。换 npm 用 `MATERIAL_AGENT_NPM_EXE` 指到具体可执行文件
（Windows 上是 `npm.cmd`）。

## 入库还是打包前现装（**待定**）

`node_modules/` 是否提交进仓库**还没定**，2026-09-18 与同事讨论（仓库本身已经 1–2GB，
再加约 118MB（`du` 约 137MB）算不算大待判）。两条路都写在这儿：

**A. 当前分支的做法：不入库，打包前现装**

仓库根 `.gitignore` 的 `VideoAutoCut/tools/material_gen/**/node_modules/` 保持生效，
本目录 `.gitignore` 里的 `!node_modules/` 反向例外已注释掉，所以装完 1.35 万个文件
也不会出现在 `git status` 里（免得 `git add -A` 误提交）。
**打包前必须先在这台机器上跑一次 `install_pi.py`，`--check` 通过再 `npm run release:pack:runtime`。**
运行包是交付物，仓库只存配置和脚本。

**B. 若决定入库**

1. 把本目录 `.gitignore` 里的 `# !node_modules/` 取消注释（子目录 `.gitignore`
   优先级高于仓库根，`git check-ignore` 实测生效）；
2. 用 `install_pi.py` 装**精简版**（约 1.35 万文件 / 117.8MB 字节总和，`du` 约 137MB），
   `--check` 通过；
3. 提交 `node_modules/`（`.cache/`、`.package-lock.json`、`package-lock.json` 仍不入库，
   已在 `.gitignore` 里排掉）。

**打包步骤两条路都一样**，`pack-runtime.ts` 不用改。

平台相关：精简安装后仍有 darwin / win32 两套 `.node`，但 esbuild 的 postinstall 会按
**当前平台**下载二进制，所以**在哪台机器上发包，就在哪台机器上装**——Windows 出包就在
Windows 上跑 `install_pi.py`。

## 目录结构（装完）

```
VideoAutoCut/tools/material_gen/pi/
├─ .gitignore                    # node_modules 入库与否的开关（当前注释掉例外＝不入库）
├─ .gitkeep
├─ README.md                     # 本文件
├─ install_pi.py                 # 装 pi + 自检（纯标准库，Windows/Mac 都能跑）
├─ models.evst-gateway.json      # provider 配置正本（docs/ 下那份是副本）
└─ node_modules/                 # 约 1.35 万文件 / 117.8MB（du 约 137MB），**不自包含，必须整个带上**
   ├─ @earendil-works/pi-coding-agent/
   │  ├─ package.json            # 版本号从这里核对
   │  ├─ dist/bundle/cli.js      # 脚本要找的就是它
   │  └─ node_modules/@earendil-works/chord/   # ← shrinkwrap 布局：chord 实际在这儿
   └─ …                          # 其余运行期依赖（npm 可能提升一部分到顶层）
```

打包脚本的 `excludedDirNames` 里有 `test` / `tests`，pi 的依赖里有 36 个文件落在这类
目录下，不会进包——实测不影响运行。

## provider 配置

`models.evst-gateway.json` 是**正本**（`docs/pi-models.evst-gateway.json` 保留同内容副本）。
文件名约定 `models.{provider}.json`：`MATERIAL_AGENT_PI_PROVIDER` 是哪个名字，
脚本就找哪个文件，以后加 provider 照这个命名放进来即可。

`material_agent_select.ensure_pi_provider_config()` 在 `backend=pi` 时首启调用一次：
把 `providers.{provider}` 这一个键合并进 `%USERPROFILE%\.pi\agent\models.json`
（尊重 `PI_CODING_AGENT_DIR`），文件不存在就连父目录一起创建，已有内容里其他 provider
和顶层其他键原样保留，内容相同则不写。自己维护 models.json 的机器可用
`MATERIAL_AGENT_PI_SKIP_PROVIDER_MERGE=1` 关掉。
