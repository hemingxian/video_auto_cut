# W6 pkg5 verify STOP（51412327）

## 结果

按 51412327，现有 pkg5 和隔离 manifest 先复核身份不变，00 archive continuation 成功且没有重包。随后唯一一次 30 verify 已消费，在第一个实际步骤 `safe isolated pkg5 extract` exit 1。流程立即停止；40 hash 未执行，cleanup 未启动，也没有修改 helper、判断门槛或重跑。

这是 **safe extract 失败**，根因未调查。本报告不把异常归因为路径长度、archive 损坏或任何其他原因，也不据此声称包内容不合格。

## 冻结输入

- source：detached `4c6fb40ff7371e73a0d0daa4c9ef0606610afc21`，normal Git status 为空。
- pkg5：669,984,472 bytes，SHA-256 `662882deedd897b04043b2cb78ff1a40c17fcfd09cfd80885ace3e1dfd5002f5`，STOP 时复核不变。
- isolated manifest：433 bytes，SHA-256 `c80642c7370fe4a310a30ab1ea3b8852093b7986dd8cd67f8588ace69c1bda0c`，STOP 时复核不变。
- 51412327 接受的新 engine SHA-256：`eadea1955d1aed3543de74fd647ede7f2e1638ae903b9bd056213e2e75ea9085`；接受依据为证据提交 `e82be4c8c38e21847d215f7508c0025862b700c3`。
- 隔离 release 配置副本在开工前已删除，主配置未变。

## 原始失败

`extract.log` 为 1,071 bytes，SHA-256 `5b44d148495b2b3b78a973344f961dd35f8fda6080d620fa3b6c66890e88d342`。原始 traceback 显示 extractor 在为以下 ZIP entry 打开目标文件时收到 `FileNotFoundError: [Errno 2] No such file or directory`：

```text
VideoAutoCut/tools/material_gen/pi/node_modules/@earendil-works/pi-coding-agent/node_modules/@anthropic-ai/sdk/_vendor/partial-json-parser/parser.d.mts.map
```

异常发生后局部 `extracted/` 现场保留在本机审计目录。本证据提交不复制该局部树，不包含 binary 或任何配置内容。

## 实际阶段与边界

- 00 archive state：1 次，exit 0。
- 30 verify：1 次，exit 1；额度已消费。
- 40 hash：0 次。
- 完整包内文件清单、package contents、ZIP entry gate、包内依赖检查、三配置凭证扫描、包内 engine 核验、delivery hash：均未执行。
- 本轮重包 0、cleanup 0、上传 0、发布 0、合 master 0。

主六保护在 00 前快照符合冻结值；主工作区仍只有用户的 `package.json` 与 `package-lock.json` 两项修改。当前按工单 STOP，等待新指令。
