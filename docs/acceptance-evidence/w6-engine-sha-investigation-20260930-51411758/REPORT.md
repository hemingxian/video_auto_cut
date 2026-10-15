# W6 引擎 SHA 只读排查报告（51411758）

## 结论

现存 `be8efb22…6adf` 与 `eadea195…9085` 引擎大小均为 8,308,224 bytes，`--version` 都输出 `VideoAuto 0.2.1` 并 exit 0。全文件逐字节比较只发现 27 个不同字节，分布在 6 个连续区间；它们全部属于 PE 构建/调试元数据：COFF timestamp、3 个 28-byte debug-directory entry 内重复的 timestamp，以及 16-byte CodeView RSDS PDB GUID。在内存中仅屏蔽这些结构字段后，两份完整文件逐字节相等，规范化 SHA-256 均为 `4425d7574e226fdf96a6023ae2f0bd28d71585307c4a2fb5357c5900f884413b`。

这不是“构建路径不同”的证据。两份二进制的 PDB path 都是 `VideoAutoCutEngine.pdb`，没有发现不同的嵌入路径字符串。当前证据能证明的窄结论是：这两份现存 exe 的 SHA 差异全部由构建/调试元数据解释；不能进一步断言目录路径造成这些元数据值。

## 来源与构建记录

- `3715aa4`、`311d5e5` 与冻结 W6 源 `4c6fb40` 的完整 `VideoAutoCutApp` Git tree ID 均为 `fd2a274bbb38466b1c2ba5ab68d848fd89280d1f`。
- `3715aa4→4c6fb40` 与 `311d5e5→4c6fb40` 对 `VideoAutoCutApp`、Cargo 输入、根 Rust toolchain/config 文件和 `.github` 构建配置的 `git diff --stat` / `--name-status` 均为空。
- 旧 U7 收据记录在 `311d5e5` 运行了 `cargo build --release --locked`，但 63-byte 日志只有 `Finished ... in 3.72s`。旧 exe 的 COFF timestamp 与文件时间均为 2026-09-24，早于 2026-09-29 的这次调用，因此后者只能证明缓存产物通过 build 调用，不能称为当日 fresh rebuild。
- 当前找到的最早留存构建报告是 historical draft `.codex-handoff/checkpoints/20260924-150525-user-paused-w5/live-handoff/step4-final-report-draft.md:5-9,37`，它在 2026-09-24 记录 HEAD `3715aa4` 与相同 `be8…`；提交内 `EARLIEST-BUILD-EVIDENCE.md` 保存原路径、SHA 和关键行摘录。没有找回该次更早的原始 compiler log，因此不把 draft 冒充原始日志。
- 旧构建根路径由产物位置、Cargo manifest 位置和不带 `--manifest-path` 的命令定位/推断为 `D:\autocut\video-auto-cut\VideoAutoCutApp`，没有独立原始 cwd 收据。2026-09-29 的 63-byte 日志证明命令成功结束，但按时间证据属于缓存完成。
- 本轮 W6 pack 从隔离工作目录 `D:\autocut\video-auto-cut-w6-51407111-4c6fb40ff737\VideoAutoCutApp` 的 `pack-release.ts:102` 使用同一 `cargo build --release --locked`，2026-09-30 编译出新留存引擎。
- 当前观测 Rust/Cargo 均为 1.98.1；历史收据没有证明 2026-09-24 的精确 toolchain，因此不声称两次 toolchain 完全一致。

## PE 结构取证

PE Debug Data Directory 的 RVA 为 7,125,312，大小 84，文件偏移 7,118,656；其中有 3 个 28-byte entry，Type 依次为 2（CodeView）、12、13。它们的 `TimeDateStamp` 字段起始偏移分别为 7,118,660、7,118,688、7,118,716；COFF header timestamp 位于偏移 264。

CodeView entry 指向偏移 7,119,112，以 `RSDS` 开头；GUID 从其后 4 bytes 的 7,119,116 开始。两边 Age 均为 1，PDB path 均为 `VideoAutoCutEngine.pdb`。old/new timestamp 为 1,790,220,913 / 1,790,732,091；GUID 为 `d04d3d96-357b-4f09-9f1f-1c3db870c470` / `81bf01a6-a9a0-4f2c-aaad-2c04bc7d6d27`。

区段比较结果：

- `.text`、`.data`、`.pdata`、`.reloc`：区段 SHA 相同，差异字节为 0。
- `.rdata`：24 个差异字节，全部属于 3 份 timestamp 与 PDB GUID。
- PE/COFF header：4-byte timestamp 中有 3 个字节值不同。

解析依据 Microsoft [PE format debug-directory layout](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format) 和 .NET runtime [CodeView RSDS layout](https://github.com/dotnet/runtime/blob/main/docs/design/specs/PE-COFF.md#codeview-debug-directory-entry-type-2)。Root 另用 .NET `PEReader` 独立复核，得到相同的 entry 类型、timestamp、CodeView 指针、GUID、Age 和 PDB path。

## 隔离配置副本清理

删除前只读确认唯一副本为固定 exact path、非 reparse、337 bytes、SHA-256 `d3edd445…9d04c`，与主配置一致且处于只读状态。按 51411758 新授权，先清除该副本只读属性，再删除固定目标。当前副本不存在，主配置 SHA 前后不变，隔离 worktree 仍 detached `4c6fb40…` 且 normal Git status 为空；主工作区仍只有两份受保护的用户 package 修改。

本轮没有重编、重包、替换 binary、执行 30/40、检查包内容或凭证、启动 cleanup、上传、发布或合并。本报告不能把之前的 pkg5 转为已验收可交付状态。
