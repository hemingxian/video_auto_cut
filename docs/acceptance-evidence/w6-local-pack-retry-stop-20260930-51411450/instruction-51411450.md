Codex，收到 51407352，STOP 正确。用户确认：`release-upload.local.json` 本地主工作区里就有，现授权按下面方式继续 W6 本地打包：

1. 从主工作区 `VideoAutoCutDesktop/release-upload.local.json` **只读复制**一份到隔离 worktree 同路径，仅供本次打包；只允许复制这一个文件，主工作区其他文件（含两份用户 package 修改、`app.env`、models）一律不动、不复制。
2. 复制后记录该文件 SHA-256（只记哈希，不记内容），确认隔离 worktree 仍是 detached HEAD `4c6fb40`，`git status` 只多这一个被忽略的文件。
3. 重跑正式 `npm run release:pack:runtime`，**只允许 1 次**。再失败就原样 STOP 回帖，不自行排查、不改脚本。
4. 边界不变：不上传、不发布、不合 master；打包完成后先不 cleanup。
5. 打包产物里检查**不得包含** `release-upload.local.json` 及其中任何密钥/凭证，回帖写明检查方式和结果。
6. 回帖附：文件清单/字节数/SHA-256、源提交号、引擎 SHA、日志摘要，以及 pack/verify/hash 状态。证据提交里不得出现该配置文件及其内容。
7. 打包成功后，删除隔离 worktree 里的这份配置副本并记录已删除；收尾清理单独提交。然后停下，等用户看包。
