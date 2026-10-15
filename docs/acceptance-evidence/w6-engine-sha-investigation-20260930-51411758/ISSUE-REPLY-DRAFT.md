51411758 的窄排查已完成，未重编、未重包、未替换 binary，也未执行 30/40、包内容/凭证验收、cleanup、上传、发布或合 master。

1. 隔离配置副本已按新授权处理：先核固定 exact path、非 reparse、337 bytes、SHA-256 `d3edd445ad45bda688a736b6b80f60d3399a0d44cc7a4843b9b26ad5d8f9d04c` 与主配置一致；再清除该副本只读属性并删除。现在副本不存在，主配置 SHA 前后不变，隔离 worktree 仍 detached `4c6fb40ff7371e73a0d0daa4c9ef0606610afc21` 且 normal status 为空。

2. `be8efb22…6adf` 与 `eadea195…9085` 都是 8,308,224 bytes，`--version` 都为 `VideoAuto 0.2.1`、exit 0。`3715aa4`、`311d5e5`、`4c6fb40` 的完整 `VideoAutoCutApp` tree ID 都是 `fd2a274bbb38466b1c2ba5ab68d848fd89280d1f`；`3715aa4/311d5e5→4c6fb40` 的 Rust/Cargo/构建配置 diff 均为空。

3. 两个 exe 全字节对比只有 27 bytes / 6 个连续区间不同：COFF timestamp、3 个 debug-directory entry 的 timestamp，以及 CodeView RSDS PDB GUID。按 PE 结构在内存屏蔽这 4 个 timestamp 字段与 16-byte GUID 后，两份完整 exe 逐字节相等，规范化 SHA-256 都为 `4425d7574e226fdf96a6023ae2f0bd28d71585307c4a2fb5357c5900f884413b`；`.text/.data/.pdata/.reloc` 全部相同，`.rdata` 的 24 个差异字节也全部落在上述 debug metadata。

4. 这不是“构建路径不同”证据。两边 PDB path 都只是 `VideoAutoCutEngine.pdb`，未发现不同的嵌入路径。可证明的结论是：现存两份 exe 的 SHA 差异全部由 PE 构建/调试元数据解释；不能进一步断言目录路径造成这些值。

5. 旧构建根路径由产物位置、Cargo manifest 与不带 `--manifest-path` 的命令定位/推断为 `D:\autocut\video-auto-cut\VideoAutoCutApp`，没有独立原始 cwd 收据。2026-09-29 的 `cargo build --release --locked` 日志只有 63 bytes，内容是缓存完成；旧 exe 的 COFF/文件时间是 2026-09-24，因此不能称 9 月 29 日 fresh rebuild。最早定位到的是 9 月 24 日 historical draft 构建报告，对应 `3715aa4` 和相同 Rust tree；没有找回更早原始 compiler log。新命令由 `pack-release.ts:102` 在 `D:\autocut\video-auto-cut-w6-51407111-4c6fb40ff737\VideoAutoCutApp` 执行相同 Cargo 参数。当前观测 toolchain 为 Rust/Cargo 1.98.1，但历史收据没有证明 9 月 24 日的精确 toolchain，故不宣称两次 toolchain 完全一致。

完整报告与机器收据：提交占位符。

之前 pkg5 的 wrapper/state/verify 仍未完成，本帖不声明该包可交付。现停下等待下一条明确指令。
