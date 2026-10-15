# W6 本地打包 STOP：唯一正式 pack 因隔离 worktree 缺本地发布配置退出 1

## 结论

按 51407111，W6 锁定源提交为 `4c6fb40ff7371e73a0d0daa4c9ef0606610afc21`，并在 detached worktree `D:\autocut\video-auto-cut-w6-51407111-4c6fb40ff737` 中准备本地 pkg5。主工作区两份用户 package 修改未复制；主六项保护对象从前到后 SHA 全部不变。

唯一正式 `npm run release:pack:runtime` 调用执行 1 次并 exit 1。`npm run build:scripts` 的 TypeScript 编译已完成；随后 `pack-release.js --runtime` 在启动引擎 build 或生成 archive 前报告：隔离 worktree 中找不到 gitignored 本地发布配置 `VideoAutoCutDesktop/release-upload.local.json`。日志中的 `[发布失败]` 是脚本统一错误标签；本轮没有调用 upload、publish 或远端 release。按有效工单停止，没有把主工作区本地配置复制到隔离 worktree，也没有重跑 pack。

因此本轮没有 pkg5，不宣称 W6 PASS：`pack_complete=false`、`verify_complete=false`、`hashes_complete=false`；30 verify 与 40 hash-report 调用均为 0，engine build 未开始，包内容验收未开始。上传、发布、合 master、产品 UI、模型调用和 cleanup 均为 0。

## 正式 pack 前的准备过程

正式 pack 前出现三次准备 helper 问题，均未生成包，也不是产品内容验收失败：

1. v1 的 00 中，PowerShell 大小写不敏感且 dot-source 共用脚本作用域，局部 `$protected` 覆盖 `$script:Protected`，在写 SOURCE-LOCK 前停止。修正为 `ProtectedSpecs` 与 `protectedSnapshot` 后，用六项快照最小复现验证规格表仍为 OrderedDictionary。
2. v2 的 10 已创建正确 HEAD 的 clean worktree 和 Desktop `node_modules` junction，但旧 helper 假定 gitignored `runtime-release/manifest.json` 会出现在提交中。续接 helper 先核 worktree、junction、未安装状态和 ignore 规则，再把受保护主 manifest 原字节 seed 到隔离目标；seed SHA 仍为 `b92c9477703b91d503974881c103b0b35cb8878f819691caa28cdae764f99942`。
3. 首次 20 已成功物理安装并检查 Pi/HyperFrames，但旧状态 helper 把自身固定 records probe 当作意外 untracked 文件，在正式 pack 前停止。最终 helper 对 `git status --untracked-files=all` 只允许精确路径 `VideoAutoCut/tools/material_gen/records/_probe_w6.txt`，并独立核其固定 SHA；所有其他 tracked/untracked 变化仍拒绝。

Pi `0.85.1` 与 HyperFrames `0.7.3` 的安装/check 日志均保留；续接前又各执行一次只读 `--check` 并成功。两轮 owned probes 均由 finally 按固定 SHA 精确删除，worktree 最终 clean。本轮独立 `TEMP`/`TMP` 位于审计目录，正式失败后没有 `VideoAutoCut-runtime-stage-*` 残留。

## 身份与敏感边界

- SOURCE-LOCK、worktree HEAD 和 pack 前 HEAD 均为完整 `4c6fb40ff7371e73a0d0daa4c9ef0606610afc21`。
- runtime 输入锚点为 `311d5e5b02bbf8610036cf81bea66b736a92621a`；到锁定源的 `VideoAutoCut/`、`VideoAutoCutApp/` 无差异。
- tracked tools 为 157；`script_card_fields.py` SHA256 为 `ed9fcc788e7c8ef81ec3e23dd2bd45e09e55271106f3024c18a31e5ec8e77c57`。
- 预期 engine SHA 仍为 `be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf`，但本次正式 pack 未进入 engine build，不能用预期值冒充本次新构建产物。
- 证据不包含 `release-upload.local.json`、`app.env` 或用户 models 文件内容，仅保留既有 SHA 保护收据。

当前 STOP 等 Mac/用户决定下一步。不得从本现场自行 seed 发布配置或第二次打包，也不得启动包后 cleanup。
