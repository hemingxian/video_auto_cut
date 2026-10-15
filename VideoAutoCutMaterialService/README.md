# VideoAutoCut 云素材业务服务

该服务位于桌面软件和内部 COS 上传服务之间，承担登录鉴权、用户/设备隔离、PostgreSQL 权威数据、上传会话编排、SHA-256 复核以及语义搜索降级。它不会向 Electron 返回 Bucket、object_key、永久 COS 凭证或向量数据库凭证。

## 服务边界

- Electron 只连接本服务，并使用软件现有登录 Token。
- 本服务使用服务端环境变量调用 `video-auto-cut_upload`。
- `video-auto-cut_upload` 仍然是内部服务，只负责 COS 临时授权和对象操作。
- PostgreSQL `pgvector` 默认作为云端主检索和权威向量索引；如配置外部向量服务，`pgvector` 继续作为完整备份和故障降级。
- 用户私有素材的权限范围先由 PostgreSQL 计算，云向量结果返回后再次按 PostgreSQL 复核。

## 本地启动

```powershell
Set-Location D:\work\project\project\video-auto-cut-V2\VideoAutoCutMaterialService
Copy-Item .env.example .env
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
```

填写 `.env` 中的数据库、现有登录用户信息接口、内部上传服务和向量服务配置。所有密钥只写入服务端环境变量，不写入项目或桌面软件。

语义检索默认使用 `MATERIAL_VECTOR_BACKEND=pgvector`。配置
`MATERIAL_EMBEDDING_TOKEN`（也兼容服务端已有的 `DASHSCOPE_API_KEY`）后，
服务会调用百炼 `qwen3-vl-embedding` 生成 768 维查询向量。历史分析分段由
`014_pgvector_primary_backfill.sql` 幂等回填；只有实际分段数与分析记录一致时，
素材的云分析状态才会更新为 `ready`。

使用 Docker 启动 PostgreSQL/pgvector：

```powershell
$env:MATERIAL_POSTGRES_OWNER_PASSWORD='使用部署系统注入的迁移账号强密码'
$env:MATERIAL_POSTGRES_PASSWORD='使用部署系统注入的应用账号强密码'
docker compose up -d postgres
.\.venv\Scripts\python.exe -m app.migrate
.\.venv\Scripts\python.exe -m app
```

桌面端现有设置页填写 `VIDEOAUTO_MATERIAL_API_BASE_URL`。生产环境必须填写本服务的 HTTPS 地址，不能填写 COS 地址或内部上传服务地址。

## 上传模式

小于阈值的文件沿用单对象 PUT；达到阈值后自动使用 COS Multipart。桌面端按服务端返回的分片大小并行上传，已完成分片写入本地可靠会话和服务端数据库，应用重启后可续传。COS 完成合并后，业务服务仍会流式读取云端对象并校验完整 SHA-256 与文件大小，校验完成前不会标记为可用。

`video-auto-cut_upload` 必须部署包含 `/v1/multipart-sessions` 路由的版本，并配置相同的 16 MiB 分片大小。上传服务仍只允许内网访问；Electron 不持有它的内部 Token。

## 数据库迁移

`python -m app.migrate` 使用 PostgreSQL advisory lock 串行应用 `migrations` 目录中的脚本，并记录到 `schema_migration`。Docker 镜像会在 API 启动前自动执行。现有数据卷升级时不能只依赖 PostgreSQL 初始化目录，必须运行该命令。

生产部署必须区分 `material_owner` 迁移账号和 `video_auto_cut` 应用账号。API 只使用 `MATERIAL_DATABASE_URL` 中的受限应用账号；`MATERIAL_MIGRATION_DATABASE_URL` 只提供给部署阶段。用户数据表启用了 FORCE RLS，不能让 API 使用 PostgreSQL 超级用户或带 `BYPASSRLS` 的角色。

## 验证

```powershell
.\.venv\Scripts\python.exe -m pytest
```
