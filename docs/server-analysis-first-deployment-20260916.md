# 本地分析后云备份：素材服务端部署记录

2026-09-16 11:13（Asia/Shanghai）验证完成。部署位置：`evs@110.185.164.162:/mnt/hmx/material_service`。

## 部署范围

仅替换 `app/repository.py` 与 `app/service.py`，配合桌面端“先完成本地分析、提交向量并收到服务端确认，再上传视频”的备份顺序：

- 素材列表与详情优先选择真实 `completed` 且分段数量完整的分析，避免较新的 `pending` 记录盖过有效结果。
- 客户端提交分析、主向量索引确认完成时，在同一事务中更新当前账号有权引用的素材版本与增量同步事件；索引重复确认不重复发布事件。
- 云文件校验成功不再自动创建新的默认 `pending` 分析；显式分析与状态检查接口保留。文件 `cloud_status` 仍只表达云文件状态。
- 向量先到达时，尚未完成视频备份的素材不会进入 pgvector 检索或远端向量候选映射；缺失分段的分析也被排除。

没有新增数据库迁移，没有修改历史分析状态，没有删除或批量改写素材数据。仅替换 `material-api`，数据库、上传服务和其他服务没有重启。

## 发布前检查与回滚备份

线上原文件 SHA-256 与上一版部署核对一致。候选以当前运行镜像为基础，仅复制两个 Python 源文件并编译检查，不重新安装依赖、不更换基础系统。新旧镜像全部 27 个 Python 分发包的版本摘要相同：`f5481a2d35480d95fa309c4aea7130c70a5a79ab297af13f453d9e3d58b2798f`。

| 项目 | 值 |
| --- | --- |
| 原 repository.py | `d0f7191cc200815bb55625011b95fdbb949f499b98dbf7caacc10e1f6a0585aa` |
| 新 repository.py | `08fa8cc2836c5afe29b0272009c9eb89a7bba700a5f97919f8e39e01334da39e` |
| 原 service.py | `9a6bb189f0d727c0c1f43874314510cf0826b169b7945e2cff89df53eed2de4b` |
| 新 service.py | `ba1b1d3fd9cf21363a3092b5236bf1116c94b496c70bca7474bf591f4838610c` |
| 原镜像 | `sha256:0ea9e20bc19ac1ee12157a0c94adb5efaa12437ef4a474b035531c5df774946d` |
| 新镜像 | `sha256:ace2627ef2abd4148d15f3bb44c27ef429eda8e79d45dd193b129d8b07d3cdcf` |
| 新 API 容器 | `0cb52f6ca2c9373c4abec66f460cff36b1331b154e0b095b0a3773205e220182` |
| 新容器启动时间 | `2026-09-16T03:12:58.500372938Z` |
| 备份目录 | `/mnt/hmx/material_service/backups/before-analysis-first-20260916` |
| 回滚镜像标签 | `material_service-material-api:before-analysis-first-20260916` |

部署脚本在健康检查失败时会恢复原源码、镜像并重新启动 API。本次发布成功，没有执行回滚。构建验证时临时使用的容器环境文件已清除，没有输出凭证。

## 验证结果

- 项目现有虚拟环境运行服务端全量测试：90 项通过。
- 上线前，候选镜像连接实际 PostgreSQL，使用当前应用的非超级用户连接，在事务内创建与生产表隔离的 TEMP 表；所有仓库方法只操作这些临时表，最终显式回滚。临时同步序列也单独建立，不消耗生产同步序列。
- 实际 SQL 验证通过：完整 `completed` 优先于较新 `pending`、当前账号两个素材别名收到同步事件、其他账号没有事件、索引重复确认不新增事件、文件未上传前检索为空、文件就绪后检索成功且遵循 RLS、不完整分析被排除。
- 使用真实 `vector(768)` 列和 pgvector 运算验证检索；没有调用模型或提交真实业务视频。
- 另用 6 张临时表验证分析凭据与向量分页往返、旧客户端兼容、相同结果重试、错误用户/素材身份拒绝、同一 profile 参数冲突拒绝；全部通过并回滚。迁移幂等验证仅作用于 TEMP 表，没有再次更改生产表。
- 新运行容器内部核验两份源码 SHA-256，与已通过验证的候选一致；Docker 状态为 `healthy`。
- 容器内 `http://127.0.0.1:8091/health/ready` 与外部 `http://110.185.164.162:9022/health/ready` 均返回 HTTP 200、`{"status":"ready"}`。
- PostgreSQL 容器 `eefbffa577768b5adde7012f4e68d62e74206b37dde3ce3f47fae59c6347bef2` 和上传服务 `ac5ca6f842a3236af8925baf9f2e935061aeccb305b22e9abb6ffceb621c2692` 的容器标识、镜像与启动时间保持不变。

验证脚本、候选报告及前后容器记录在 `.maintenance/analysis-first-deployment-20260916/`；服务器备份目录保留同份部署证据。验证脚本未加入运行镜像。

这次服务端验收覆盖协议与实际数据库行为，未执行用户账号的真实 COS 上传或完整视频生成，也没有把历史未分析素材强制标成已分析。旧设备已经缓存的历史状态仍需要正常刷新或后续真实状态事件更新。

## 回滚方式（未执行）

在服务器 `/mnt/hmx/material_service` 目录执行：

```sh
cp backups/before-analysis-first-20260916/repository.py app/repository.py
cp backups/before-analysis-first-20260916/service.py app/service.py
docker image tag material_service-material-api:before-analysis-first-20260916 material_service-material-api:latest
docker compose -f compose.yaml -f compose.production.yaml up -d --no-deps --no-build material-api
```

随后检查容器健康、接口就绪状态及原源码摘要。回滚无需数据库迁移或数据恢复。
