51412327 的现有 pkg5 验证已按规则 STOP；没有重包、修改 helper/门槛、重跑、cleanup、上传、发布或合 master。

- source：detached `4c6fb40ff7371e73a0d0daa4c9ef0606610afc21`。
- pkg5：669,984,472 bytes，SHA-256 `662882deedd897b04043b2cb78ff1a40c17fcfd09cfd80885ace3e1dfd5002f5`，STOP 时不变。
- isolated manifest：433 bytes，SHA-256 `c80642c7370fe4a310a30ab1ea3b8852093b7986dd8cd67f8588ace69c1bda0c`，STOP 时不变。
- engine 冻结值：`eadea1955d1aed3543de74fd647ede7f2e1638ae903b9bd056213e2e75ea9085`，依据 51412327 / `e82be4c`。
- 00 archive continuation：1 次，exit 0，未重包。
- 30 verify：唯一 1 次已消费，在第一个 `safe isolated pkg5 extract` 步骤 exit 1。原始 `extract.log` 1,071 bytes，SHA-256 `5b44d148495b2b3b78a973344f961dd35f8fda6080d620fa3b6c66890e88d342`；traceback 是打开深层 `partial-json-parser/parser.d.mts.map` 目标时的 `FileNotFoundError [Errno 2]`。
- 40 hash：0 次。完整文件清单、contents、ZIP gate、依赖检查、三配置凭证扫描、包内 engine 核验及 delivery hash 均未执行。

这里只报告 safe extract 失败；根因未调查，不能归因为路径长度或 archive 损坏，也不声称包内容不合格。局部解压现场只留本机，证据不含局部树、binary 或配置内容。

证据与报告：提交占位符。

现停下等待下一条明确指令；cleanup=0。
