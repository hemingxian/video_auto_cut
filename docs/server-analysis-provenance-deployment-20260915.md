# 云分析复用参数部署验证

2026-09-15，按本次发布授权更新 110.185.164.162 的 `/mnt/hmx/material_service`，仅重建 material-api。

新增可选 `analysis_provenance`，记录源 SHA/大小、完整分析配置、时间范围和静帧范围。上传时绑定素材内容及模型身份；同一 profile ID 不能被不同分析参数覆盖。分页携带完整凭据，客户端比较各页一致性后恢复共享缓存。原客户端及无凭据历史结果仍兼容，历史结果不会被冒认为符合新缓存参数。

迁移 `015_analysis_provenance.sql` 只新增 nullable JSONB 列。上线前 60 项服务端测试通过；另在实际 PostgreSQL 的事务临时表中运行真实仓库方法，验证向量/凭据分页往返、旧客户端、同 ID 重试和身份/参数冲突，最后显式回滚，未写业务数据。

上线后容器 healthy，`/health/ready` 返回 ready；迁移记录和 nullable JSONB 列均验证存在。部署代码摘要与验收候选一致。当前镜像 `sha256:89f89c37729537b8dce6646ed8406ea3966a4ea860ab5a79e2108b5f2e3e98e0`。

回退保留：源码目录 `backups/before-provenance-059-20260915`；镜像 `material_service-material-api:before-provenance-059`。新增可空列可保留，旧版代码忽略它，无需删除分析或素材数据。
