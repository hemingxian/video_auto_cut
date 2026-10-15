# 飞书问题核对：0.5.7（2026-09-15）

核对来源：[剪辑软件 Bug 反馈](https://lcn65ukbahf3.feishu.cn/wiki/I4luwp7Fri1IUiks2K4cB3wUnId?fromScene=spaceOverview&table=tbl00XjfmI9h50si&view=vewLVjoOQw)。

本次读取 36 条记录，其中 35 条有问题内容、第 36 条为空。序号对应本次读取时的飞书行号。当天核对公网桌面端与引擎更新清单均为 **0.5.7**，远端 master 与 v0.5.7 均对应 **8ba9ec6**。

## 结果

- 已发布修复：13 条。
- 部分修复或实现：12 条。
- 仍未解决或未实现：9 条。
- 信息不足：1 条。

“已发布修复”指该条明确描述的缺陷已有代码和验证依据，并已包含在发布版本中；不代表每位反馈用户的原设备、原脚本和原成片都已重新验收。本次未修改代码、服务端或飞书状态。

飞书前 20 条的备注大多停留在 9 月 7 日。其中“0dac865 未打包”“0642068 未推送”等发布说明已过时；这些改动已经进入 0.5.7。但第 4、5 条仍有未覆盖的失败路径，不应仅沿用表内“已解决”。

## 逐条核对

| 行号 | 问题 | 当前判断 | 结论及未完成部分 |
| --- | --- | --- | --- |
| 1 | 取消添加素材也提示已导入 | **已发布修复** | 空导入结果直接退出，不再显示成功提示。 |
| 2 | 素材库总根目录不能新建文件夹 | **已发布修复** | 按后续确认的需求实现：总根保留本地/云端入口，在相应存储下创建文件夹。 |
| 3 | 重装后余额变 0 | **部分修复** | 未取得余额显示“暂未获取”；原账号真实余额是否恢复，仍缺升级前后账户证据。 |
| 4 | 给分镜指定素材后生成失败 | **部分修复** | 登记等待和跨设备目录编号映射已发布；父目录/子目录范围不一致仍能导致候选为空，不能关闭整条。 |
| 5 | 素材范围选择层级混乱 | **部分修复** | 当前目录选择、面包屑、子目录选项已有；默认范围与递归计数不一致，左侧目录还仅显示前 10 项。 |
| 6 | 素材分析后没有出现在云端 | **部分修复** | 云目录同步、云端分析复用和上传通知已修；分析和上传是两个步骤，关闭自动同步时不会自动上传。原账号个案需复验。 |
| 7 | 显示候选匹配 0，但实际匹配成功 | **已发布修复** | 按原备注的工作区计数问题核对：已分开显示“已绑定素材的分镜数”和“下载候选片段数”。 |
| 8 | 预览分镜后再生成，流程不显示 | **已发布修复** | 预览转生成会更新原队列条目并推导完整后续流程；仅预览完成不会标成片完成。 |
| 9 | 素材管理有问题，如图 | **信息不足** | 原记录涉及多个现象，缺少唯一可验收的问题描述；不能用其他行修复结果代替关闭。 |
| 10 | 点击不同素材，右侧详情不切换 | **已发布修复** | 详情目标随选中路径更新，播放器按所选素材重建；原用户设备未在本轮重新验收。 |
| 11 | 上传失败导致素材不在本地显示 | **已发布修复** | 本地列表按文件在本机是否可用判断，不再把上传失败等同于本地不存在。 |
| 12 | 一直同步失败 | **部分修复** | 已知 COS 分片权限缺失和上传完成通知故障已修并上线，原失败视频有真实上传验证；历史失败并未全部自动补传，其他新失败需按原因核对。 |
| 13 | 素材库总根只展示本地/云端文件夹 | **已发布修复** | 总根展示两个存储入口；搜索结果可显示文件。 |
| 14 | 失败任务删除和存草稿 | **已发布修复** | 队列可移除失败项，历史任务可回收删除，分镜可保存/恢复草稿；运行期间误锁其他任务删除另见第 35 条。 |
| 15 | 任务显示脚本名称，未完成可继续 | **已发布修复** | 队列/历史优先显示脚本或项目名，支持恢复工作台和有效检查点续跑；旧任务缺检查点或配置变化时须重新生成。 |
| 16 | 暂停后改脚本/素材范围，只重算修改区域 | **部分修复** | 暂停、编辑、范围调整和草稿已有；修改后的完整流程仍要求重新生成全部，未实现引擎按修改分镜局部重算。 |
| 17 | 暂停全部任务 | **已发布修复** | 任务队列内有暂停全部和继续队列；工作台仅控制当前任务，符合后续确认的范围。 |
| 18 | 成片独立文件夹 | **已发布修复** | 已有真实磁盘目录“{项目名}最终视频”和独立成片分类，不只是界面分类。 |
| 19 | 英文 TTS 术语读法不完整失败 | **已发布修复** | 纯英文口播跳过中文夹英文术语改写；混合口播仍保留术语确认，不保证所有 TTS 外部调用都成功。 |
| 20 | 第 7 分镜搜索词混中文，之前结果未保存 | **已发布修复** | 英文校验、最多三次纠正、逐分镜保存和跳过已完成优化均已实现；模型持续不合格仍可停止，但不丢之前结果。 |
| 21 | 英文字幕断句问题 | **仍未解决** | 实际换行函数会丢单词间空格，并按字符拆长词；纯函数复现已确认，现有对齐测试没有覆盖此缺陷。 |
| 22 | 中文脚本的进度条是英文 | **部分修复** | 提示词已有目标语言要求，但上屏直接沿用 module_label/title，缺少语言一致性校验与纠正；原图确有中文字幕配英文进度标签。 |
| 23 | 英文进度条单词显示不完整 | **仍未解决** | 标签按固定字符数截断并加省略号，窄画幅再次截断，没有按英文词边界处理。 |
| 24 | 原素材字幕/logo 去除、裁剪或不用，提供开关 | **仍未解决** | 主生成流程未形成识别原字幕/logo 后自动去除、裁剪或拒用的策略，也没有所要求的完整开关。 |
| 25 | AI 自动调整字幕安全区域 | **部分修复** | 已有按画面、黑边、进度条的几何位置规则；没有识别人脸、工件或已有文字后避让的 AI 安全区。 |
| 26 | 增加免费商用字体 | **仍未解决** | 仍为原有系统字体选项，未发现新增字体文件及其授权包；本结论不判断现有系统字体的商用权利。 |
| 27 | 四种比例及 720p/4K 输出尺寸 | **部分修复** | 四种固定尺寸已有：1920×1080、1440×1080、1080×1920、1080×1440；没有 1280×720 和横/竖 4K 选项。原表“3840×210”还需确认目标数值。 |
| 28 | HyperFrames 默认包装动画 | **部分修复** | 独立生成素材页面已有 HyperFrames；自动剪辑主流程仍关闭卡片生成，没有接入默认包装动画。 |
| 29 | 素材库切换卡顿 | **部分修复** | 重复扫描、缓存首屏和后台同步优化已发布，本机基准明显改善；尚无所有用户设备的体验验收，不能承诺完全无感。 |
| 30 | 完成后列表多出一个同名任务 | **仍未解决** | 历史页按运行目录逐条展示，预览和生成会形成两个不同 run，尚未合并成同一逻辑任务。原图与此相符；没有证据说明视频真正执行了两次。 |
| 31 | 外部素材明确开关，没匹配则随机使用 | **部分修复** | 三种来源模式已发布；未实现随机素材兜底。仅素材库缺素材时阻断，素材库优先则回退 Pexels。 |
| 32 | 最低匹配分时仍选到明显 logo/水印 | **仍未解决** | 最低分控制语义匹配，不检测 logo/水印；没有独立拒用规则。已保存的低分片段当前还可能仅警告后继续使用。 |
| 33 | 素材选择左侧导航不能滚动查看全部 | **仍未解决** | 左侧直接截取前 10 个文件夹，第 11 个起不渲染；CSS 有滚动也无法显示被截掉的项。 |
| 34 | 0.1 阈值下中英文素材选不上 | **仍未解决** | 阈值接入引擎已修，但本次错误是素材目录展开为空。已知子目录范围漏洞仍在；需出错设备版本和 shots.json 确认本次具体原因。 |
| 35 | 有任务运行时不能删除其他任务 | **仍未解决** | 历史页删除按钮使用全局运行状态禁用；后端本来只阻止删除当前任务，前端限制范围过大。 |

## 优先处理的具体缺陷

1. **素材准备失败（4、5、34）**：统一界面数量、本地展开和服务端展开的素材范围；默认是否包含子目录需要一致。当前用户设备的具体任务原因仍待其版本号及 shots.json 核实。
2. **英文字幕和进度条（21、22、23）**：保留英文空格、按单词换行，避免字符截断；校验章节标签与视频语言一致。
3. **左导航缺目录（33）**：移除固定前 10 项的截断，显示真实完整目录列表。
4. **运行中误锁删除（35）**：只锁定当前正在运行或准备的任务。
5. **历史任务重复展示（30）**：关联预览和生成的运行记录，保留过程记录但以一个逻辑任务展示。

表内紧急需求还包括输出 720p/4K、外部素材与随机兜底、水印素材控制；它们与上述确定缺陷分开验收。

## 关键代码与验证依据

- 发布版本及验证范围：[release-0.5.7.md](D:/work/project/project/video-auto-cut-V2/docs/release-0.5.7.md)。发布前桌面 269 项通过，引擎 82 项单元与 5 项集成通过；各有 2 项原有跳过/忽略。
- 本次额外重跑已有任务模型/服务回归 47 项、媒体离线回归 60 项，均通过；这些测试没有覆盖所有原图表现。本次未调用模型生成真实视频。
- 导入空结果：[useMaterialsLibrary.ts](D:/work/project/project/video-auto-cut-V2/VideoAutoCutDesktop/src/pages/materials/useMaterialsLibrary.ts:300)；本地可用性独立于上传状态：[materialLibraryUiModel.ts](D:/work/project/project/video-auto-cut-V2/VideoAutoCutDesktop/src/pages/materials/materialLibraryUiModel.ts:81)。
- 目录登记与校验：[material-cloud-service.ts](D:/work/project/project/video-auto-cut-V2/VideoAutoCutDesktop/electron/material-cloud-service.ts:1904)；本地根强制递归：[material-local-store.ts](D:/work/project/project/video-auto-cut-V2/VideoAutoCutDesktop/electron/material-local-store.ts:2647)；服务端候选为空分支：[service.py](D:/work/project/project/video-auto-cut-V2/VideoAutoCutMaterialService/app/service.py:932)。
- 左导航前 10 项截断：[ShotMaterialPickerDialog.tsx](D:/work/project/project/video-auto-cut-V2/VideoAutoCutDesktop/src/pages/start/ShotMaterialPickerDialog.tsx:560)。目录卡片数量来自递归统计，与默认不含子目录的绑定不一致。
- 全局锁历史任务删除：[RunsPage.tsx](D:/work/project/project/video-auto-cut-V2/VideoAutoCutDesktop/src/pages/RunsPage.tsx:44)；后端仅锁当前任务：[ipc-handlers.ts](D:/work/project/project/video-auto-cut-V2/VideoAutoCutDesktop/electron/ipc-handlers.ts:241)。
- 预览和生成在历史中分别列出：[workspace-service.ts](D:/work/project/project/video-auto-cut-V2/VideoAutoCutDesktop/electron/workspace-service.ts:658)。原截图中同脚本两条时间不同，一条已完成、一条无完成标记，与这一链路相符。
- 修改分镜后续跑限制：[useStartTaskController.ts](D:/work/project/project/video-auto-cut-V2/VideoAutoCutDesktop/src/pages/start/useStartTaskController.ts:840)。
- 英文字幕丢空格：[common.py](D:/work/project/project/video-auto-cut-V2/VideoAutoCut/tools/common.py:378)；标签截断：[common.py](D:/work/project/project/video-auto-cut-V2/VideoAutoCut/tools/common.py:545)。
- 进度条优先使用 module_label：[final_video.rs](D:/work/project/project/video-auto-cut-V2/VideoAutoCutApp/src/final_video.rs:273)；字幕几何布局：[render_segment.py](D:/work/project/project/video-auto-cut-V2/VideoAutoCut/tools/render_segment.py:211)。
- 固定输出尺寸：[output_format.rs](D:/work/project/project/video-auto-cut-V2/VideoAutoCutApp/src/output_format.rs:4)；原有字体列表：[subtitleFonts.ts](D:/work/project/project/video-auto-cut-V2/VideoAutoCutDesktop/src/config/subtitleFonts.ts:1)。
- 英文口播修复：[prepare_voice.py](D:/work/project/project/video-auto-cut-V2/VideoAutoCut/tools/prepare_voice.py:178)；逐分镜优化和保存：[optimize_queries.py](D:/work/project/project/video-auto-cut-V2/VideoAutoCut/tools/optimize_queries.py:155)。
- 素材低分仍可能使用：[material_clip.rs](D:/work/project/project/video-auto-cut-V2/VideoAutoCutApp/src/material_clip.rs:616)；主流程关闭卡片：[final_video.rs](D:/work/project/project/video-auto-cut-V2/VideoAutoCutApp/src/final_video.rs:254)。
- 原 COS 权限及上传通知修复的真实证据：[cos-multipart-fix-20260908.md](D:/work/project/project/video-auto-cut-V2/docs/cos-multipart-fix-20260908.md)。
- 跨设备云分析恢复验证：[cloud-analysis-reuse-rc11-validation.md](D:/work/project/project/video-auto-cut-V2/docs/cloud-analysis-reuse-rc11-validation.md)。
