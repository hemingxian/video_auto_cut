# 步骤 6 Windows 续跑路径窄修证据

本修正对应 Mac 回帖 51492839，基于 detached HEAD `35c9287881fa4ab528e7afa5a11598653d18467a`。范围仅限桌面端 Windows 运行目录解析、续跑参数组装及其测试；没有修改或编译引擎，没有修改 package/lock、runtime、样例、远程配置或其他业务模式。

## 改动

- 将 `materials-service.ts` 已有的 Windows namespace 清理逻辑提取为 `task-events.ts` 导出的 main 侧共享函数。
- 解析引擎的 `运行目录:` 行时，将 `\\?\D:\...` 转为 `D:\...`，将 `\\?\UNC\server\share\...` 转为 `\\server\share\...`。
- renderer 续跑不再使用 `` `${item.runPath}/shots.json` ``。它使用重新加载的 run 记录，main 进程任务服务在启动边界再次清理 `resumeRunPath`，并用 `path.join(runPath, 'shots.json')` 统一生成实际 `--shots-json` 参数。
- main 启动边界的再次清理覆盖历史队列中已经保存为 extended path 的 `runPath`；任务启动状态随后持有普通路径，因此成功续跑后的队列更新会覆盖旧值。没有批量迁移磁盘上的历史持久化数据。

## 验证

已运行命令、exit code、工具返回的安全摘录及全部 11 条 lint 诊断见 [verification-excerpts.txt](acceptance-evidence/step6-resume-path-20261009/verification-excerpts.txt)。该文件明确区分摘录与完整原始日志，没有为补证据重跑通过项。

- 聚焦：`task-events.test.mjs` + `task-service.test.mjs`，32/32 passed。覆盖 drive、UNC 行解析，以及历史 extended drive/UNC 输入最终产生 `--shots-json === path.join(normalRunPath, 'shots.json')`。
- Desktop 全量：446 total，444 passed，2 个既有 skipped，0 failed。冻结基线为 445 total / 443 passed / 2 skipped；新增 1 个测试，结果差额一致。
- `npm run build`：exit 0，renderer、electron、preload 均完成。
- `npm run lint`：exit 1，仍为冻结基线的 10 errors + 1 warning；诊断文件、位置和规则与 `docs/acceptance-evidence/step5-s2-wrap-20261009/final-validation/desktop-lint-step5-final.log` 一致，本修正文件没有新增诊断。
- `git diff --check`：exit 0。
- release 引擎 `VideoAutoCutApp/target/release/VideoAutoCutEngine.exe` 为 8,311,296 bytes，SHA-256 `41995f53fae3d89c9486e6980b33b98a3f2e434f73a0706ad71948af40e6c871`；本轮未运行 Cargo。

## 尚未执行

本证据只覆盖源码窄修与本地 Desktop 验证。desktop-only 重打包、51491612 的配置/依赖/`@undefined` 复核、覆盖安装、真实暂停继续及步骤 6 E2E 均留给后续验收，本文不声称已经通过。
