# 51404601 既有食品成片补验报告

## 结论

本轮只读取 `694dd2f` 对应的既有成片、9 个 final clips、9 个 ASS、run `shots.json` 和冻结 xlsx。没有启动 engine 或模型，没有重新导入、重渲染或修改任何原产物。

按 Mac 51404601 修正后的字幕口径，9 镜 ASS 局部文字/时间审计为 9/9 PASS；指定的卡片、有/无卡片画面和软换行抽帧也通过。成片实际容器时长为 **80.021029 秒**，不是工单中的参考“约 84 秒”，差额为 **-3.978971 秒**。工单没有给硬容差，本报告只记录实际值，补验完成后等待 Mac 判断，不据此武断宣称整个食品 E2E PASS。

## 成片与分段

最终成片本地路径为 `D:\vac\f3\w\video\runs\20260929\f3\f3最终视频\f3_v001.mp4`，28,185,133 bytes，SHA256 `a465f2d3da209939a5bbb2eaae6cd7074ce1b4197b1a3ba4a95a989abb822bce`，与补验前基线一致。整片没有上传。

ffprobe 实际结果：

- video：H.264，1920×1080，30/1 fps，80.000000 秒；
- audio：AAC，48 kHz，双声道，80.010000 秒；
- container：80.021029 秒；
- 相对工单参考约 84 秒：-3.978971 秒。

9 个 final clips 的实际时长依次为 8、9、11、8、8、10、8、10、8 秒，总和 80 秒；全局起点为 0、8、17、28、36、44、54、62、72 秒。原 concat list 明确按 `0001_final.mp4` 到 `0009_final.mp4` 顺序拼接。9 clips SHA 与补验前基线 9/9 相同。帧时间由这些 ffprobe 时长累加计算，builder 对生成的帧文件名/全局时间做了断言。

## 9 镜 ASS 修正口径审计

审计按每个 ASS 事件逐项匹配源字幕，只允许事件末尾缺失 Mac 指定白名单 `[\s、，,。！？!?；;：:.…]`；事件内部标点和文字逐字；软换行最多吞一个普通空格；time tolerance 明确为 0 秒。

结果为 9/9 PASS：35 个物理事件、34 个允许的事件尾标点消费；manual/source/time/parse/overlap ambiguity 均为 0，每镜 unique solution=1。合成正反例小测 6/6 通过（`receipts/synthetic-test-results.json`）。第 8 镜是唯一同时间物理多行组：0.00–9.50 秒、y=993/1075，两行拼接零字符损失。其它镜均为时间分段事件。逐镜表与完整匹配证据见 `receipts/ass-text-summary.md` 和 `receipts/ass-text-audit.json`。

这是一项局部 ASS 验收结论。它遵循 51404601 新口径，不改变产品，也不追溯修改旧证据。

## 抽帧与卡片

所有帧都从最终成片通过 ffmpeg 视频解码取得；这不是 pipeline 渲染。

- 第 1 镜 local 4.0s / global 4.000s：标题卡仍在；xlsx 上屏文字去掉“大字：/副行：”标签后为 `包装线末端，最重复的一道活` 与 `箱装食品码垛工作站`。实际 template content codepoint 完全相等；第一行视觉软换行为 `包装线末端，最重` / `复的一道活`，拼接无丢字。画面同时显示未人工修改字幕 `最重复、最累人的一道活`。
- 第 2 镜沿用 local 2.0s / global 10.000s 与 local 6.0s / global 14.000s 两帧，作为修正口径下的既有显示证据。
- 第 5 镜 local 4.8s / global 40.800s：xlsx 卡片字段为 `—`，实际无卡片；字幕可见 `进库存放`。
- 第 8 镜 local 4.0s / global 66.000s：卡片四行 `箱体尺寸 · 重量`、`产线节拍（箱/小时）`、`托盘规格`、`目标垛型` 与 xlsx 去掉“参数卡：”标签后的内容 codepoint 完全相等；卡片提示 `参数列表` 不作为上屏文字。字幕视觉两行在 `托盘规` / `格` 处软换行，拼接为 `先备好四样：箱体尺寸和重量、每小时箱数、托盘规格、目标垛型`，零字符损失。

Sol 与 root 均以原分辨率查看三张新增帧，结论一致。`card-exact.json` 使用实际 `template.json` content 与 xlsx K/L 列做精确 codepoint 比较，避免仅凭像素判断全宽括号、中点和空格。

## 只读边界与完整性

补验新增 pipeline engine/model/import/render 调用均为 0。仅运行 ffprobe、ffmpeg 单帧解码和只读 Python 审计。9 ASS、9 clips、最终成片、final run shots 均未修改；9 ASS 与补验前哈希 9/9 相同，final run shots SHA256 `b1fa7de76279e29abf3cabdad83faea771cad950357cc2ec00a47ed1034a46c8`。六项保护 SHA 6/6 相同。

旧模型次数、28 项 post-plan 深比较、默认工作区和短根 formal 事实沿用已接受的证据 commit `694dd2f01c57193103f903d0f5ee7dbab8fc84e0`，本包不重复复制长证据。当前仍不授权 U7 修复、重新导入、W6、长路径产品修复或字幕产品改动。