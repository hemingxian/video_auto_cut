# COS 分片上传修复与真实验证（2026-09-08）

## 原因与修复

上传服务按 67108864 字节（64 MiB）切换到分片上传。现存历史记录中，131 次普通上传成功，457 次分片上传尝试失败；最早失败日志为北京时间 9 月 4 日 11:38。COS 原始错误为 AccessDenied。

腾讯云控制台确认 `video_upload` 的自定义策略 `policygen-20260724164613`（ID 280340247）只有 PutObject、HeadObject、GetObject、DeleteObject。版本 2 最后修改于 7 月 24 日，未包含分片上传授权。

已于北京时间 9 月 8 日 10:01:19 保存并启用版本 3，在原有资源范围内补充：

- cos:InitiateMultipartUpload
- cos:UploadPart
- cos:CompleteMultipartUpload
- cos:AbortMultipartUpload

资源范围保持为广州区域私有素材桶全部对象，以及共享素材桶 videos、mp3、images 三个既有前缀。未授予管理权限，未增加其他存储桶，版本 2 保留用于回退。

真实验证另发现服务端 `mark_upload_result` 没有产生增量同步记录：上传完成后客户端仍可能显示旧状态。本次将素材状态变更、同账号有效素材记录的版本更新、增量事件写入放在同一事务中。相同结果重复回调不会重复通知；已删除记录及其他账号不会被更新。

## 实际失败视频验证

| 项目 | 结果 |
| --- | --- |
| 文件 | 上下料B端视频脚本_v1_v001.mp4 |
| 大小 | 77947037 字节（74.3 MiB） |
| 原素材 ID | mat_7b85d78f06e54a3d9ee408cfb8464cd7 |
| 上传方式 | multipart，5 个分片 |
| 分片大小 | 前 4 个各 16777216 字节，最后 10838173 字节 |
| 恢复验证 | 第 1 片完成后调用恢复接口，正确返回已完成片及字节数 |
| 最终云端状态 | ready |
| 完整文件读取 | 成功，大小及 SHA-256 与本地原文件一致 |
| 实际验证时间 | 北京时间 10:03:41–10:04:19 |
| 客户端同步验证 | 10:10:10，cloudStatus=ready、uploadTransferStatus=ready、localStatus=present、analysisStatus=ready |

SHA-256：`f6cfc25720f7ffb53c988c4fc8aadef4b41315d636b4b2f203c5d12bb0e0cb1f`。

上传会话：`upl_caa303b03ef04db9a369f6cd85cc0b3a`。复用原素材记录和原视频，没有生成测试视频或新增重复素材。完整读取仅做校验，不另存一份视频。

私有素材目录及共享 videos、mp3、images 目录的分片初始化/取消全部通过，临时分片任务均已取消。

## 服务端验证与部署

- 51 项服务端测试通过。
- 使用实际生产 SQL 在 PostgreSQL 临时表事务中验证：状态变化通知全部有效别名；重复结果不重复通知；失败状态变化可同步；其他账号、已删除及其他素材不受影响。测试事务已回滚。
- 已构建并更新 `material_service-material-api-1`，健康检查通过。
- 部署文件与容器文件 SHA-256 均为 `64b92a8403839a49c34e92f606dc8f3148ca489e5e59b30d1ff104b21e7a9774`。
- 回退镜像：`material_service-material-api:before-upload-sync-20260908`。
- 原文件备份：`/mnt/hmx/material_service/app/repository.py.before-upload-sync-20260908`。
- 针对此次在旧代码下完成验证的视频，按素材身份和 SHA-256 校验后补发 1 条完成通知；客户端随后通过正常增量同步取得成功状态。

本次没有发布新客户端安装包，也不代表其他历史失败素材已全部补传；此前失败的视频可使用现有“重试上传”。
