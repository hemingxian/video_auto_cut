# 0.5.10 素材服务端部署记录

2026-09-15 17:29（Asia/Shanghai）验证完成。部署位置为 `evs@110.185.164.162:/mnt/hmx/material_service`。

## 改动与部署范围

仅更新 `app/repository.py` 的文件夹写入异常分类：

- RLS / 权限拒绝返回 `403 folder_access_denied`，说明当前账号无法访问该文件夹，不暴露其他账号或数据库细节。
- 仅同级名称唯一约束冲突返回 `409 folder_name_conflict`。
- 其他数据库或程序异常保留原始服务端异常，不再一律误报“同级文件夹名称已存在”。

仅重建并替换 `material-api`。未新增数据库迁移，未修改业务数据、RLS、永久角色或权限，未重启数据库、上传服务及其他服务。本修复只改善服务端错误分类；客户端生成当前账号的文件夹标识由同版本桌面端改动负责。

## 部署前核对与备份

线上原 `repository.py` 与 Git `2a609161a2462274a9d490fb280f234db7548682` 对应文件字节完全一致，无额外线上修改需要合并。

| 项目 | 值 |
| --- | --- |
| 原源文件 SHA-256 | `610171390971156995e3ba7570af778b9f540c14e266b8441786d4b882e8f260` |
| 新源文件 SHA-256 | `d0f7191cc200815bb55625011b95fdbb949f499b98dbf7caacc10e1f6a0585aa` |
| 原镜像 | `sha256:89f89c37729537b8dce6646ed8406ea3966a4ea860ab5a79e2108b5f2e3e98e0` |
| 新镜像 | `sha256:0ea9e20bc19ac1ee12157a0c94adb5efaa12437ef4a474b035531c5df774946d` |
| 新容器 | `d2748c861cd218aee4db47a49001fe878f67d07fa5e9a62dff9aca5d9ce6ffb0` |
| 源文件备份目录 | `/mnt/hmx/material_service/backups/before-account-isolation-0510-20260915` |
| 回滚镜像标签 | `material_service-material-api:before-account-isolation-0510` |

新旧镜像全部 27 个 Python 分发包版本一致，依赖版本清单 SHA-256 均为 `f5481a2d35480d95fa309c4aea7130c70a5a79ab297af13f453d9e3d58b2798f`。

## 验证结果

- 本地服务端全量测试：80 项通过，其中本次新增异常分类及批量同步测试 20 项。
- 实际 PostgreSQL 临时表验证：旧账号文件夹 ID 在当前账号 UPSERT 时触发 `42501` RLS；当前账号新 ID、相同名称可成功；同账号同级同名触发 `23505`，诊断约束名为 `material_folder_owner_id_parent_folder_id_name_key_key`，与新分类常量一致。其他账号记录保持不可见且不被修改。全部测试写入已回滚，确认临时对象移除。
- 新运行容器内部：核验源文件 SHA-256，调用新 helper 验证权限、同名、其他唯一键错误的分类与隐私边界，全部通过；不写业务数据。
- Docker 状态：`healthy`。
- 容器内 `http://127.0.0.1:8091/health/ready` 与外部 `http://110.185.164.162:9022/health/ready` 均返回 HTTP 200、`{"status":"ready"}`。
- Postgres 容器 `eefbffa577768b5adde7012f4e68d62e74206b37dde3ce3f47fae59c6347bef2`、上传服务容器 `ac5ca6f842a3236af8925baf9f2e935061aeccb305b22e9abb6ffceb621c2692` 的容器标识及启动时间保持不变。

本地验证脚本及详细证据位于 `.maintenance/folder-rls-20260915/`，没有安装进生产服务。

## 回滚方式（未执行）

在服务器 `/mnt/hmx/material_service` 目录执行：

```sh
cp backups/before-account-isolation-0510-20260915/repository.py app/repository.py
docker image tag material_service-material-api:before-account-isolation-0510 material_service-material-api:latest
docker compose -f compose.yaml -f compose.production.yaml up -d --no-deps --no-build material-api
```

随后复核健康状态与源文件 SHA-256。回滚同样不需要数据库迁移或权限变更。
