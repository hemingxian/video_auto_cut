VideoAuto 视频自动化助手
=======================

目标流程：
输入一个主题 -> 千问生成分镜脚本 -> 每个分镜生成下载关键词和画面检索描述 -> yt-dlp 下载候选视频 -> SentrySearch 用 qwen-cloud 检索并剪出片段 -> ffmpeg 按分镜顺序合成 final.mp4。

目录要求：
VideoAuto\
  VideoAutoCutEngine.exe                 # Rust 主控程序，cargo build 后复制到这里
  yt-dlp.exe
  ffmpeg.exe                    # 用于最终合成；没有它就无法合成 final.mp4
  www.youtube.com_cookies.txt   # 可选，但 YouTube 经常需要
  .env                          # API Key 配置文件
  sentrysearch\sentrysearch.exe
  video\                        # 输出目录

配置：
1. 复制 .env.example 为 .env
2. 修改 .env 中的 DASHSCOPE_API_KEY

使用：
双击 VideoAutoCutEngine.exe，按提示输入主题。

命令行示例：
VideoAutoCutEngine.exe --topic "治愈系小猫成长视频" --shots 6 --downloads-per-shot 5 --clips-per-shot 1

只生成分镜，不下载剪辑：
VideoAutoCutEngine.exe --topic "治愈系小猫成长视频" --shots 6 --plan-only

使用已有分镜 JSON：
VideoAutoCutEngine.exe --shots-json "video\runs\某次运行\shots.json"

清理已删除视频的旧索引：
VideoAutoCutEngine.exe clean-missing

输出：
video\runs\时间戳\shots.json       每次运行的分镜
video\runs\时间戳\raw\              每个分镜下载的视频
video\runs\时间戳\clips\            每个分镜剪出的片段
video\output\final_时间戳.mp4        最终合成视频

注意：
- index 阶段会调用 qwen3-vl-embedding，会消耗 DashScope 额度。
- search 阶段也会调用一次文本 embedding，但消耗远小于 index。
- 同一个视频重复 index 通常会跳过，不会重复消耗；但同路径覆盖新视频需要先清理索引。
- 不要把自己的 .env / cookies 发给别人。
