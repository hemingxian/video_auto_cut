import { Cloud, Search, Settings, Subtitles } from 'lucide-react'
import type { ConfigGroup } from '../types/app'
import { subtitleFontOptions } from './subtitleFonts'

export const configGroups: ConfigGroup[] = [
  {
    title: '基础设置',
    description: '默认素材来源和下载数量。',
    icon: Settings,
    items: [
      { key: 'SOURCE', label: '默认素材来源', description: '开始任务未单独选择时使用这里。', type: 'select', options: [{ label: '按程序默认', value: '' }, { label: 'Pexels（商用）', value: 'pexels' }, { label: 'Pixabay（商用）', value: 'pixabay' }, { label: 'Wikimedia Commons（按许可证）', value: 'wikimedia-commons' }] },
      { key: 'DOWNLOADS_PER_SHOT', label: '每个分镜下载数量', description: '建议 2 个，素材不够时再提高。', type: 'number', placeholder: '2', suffix: '个' },
      { key: 'MAX_SOURCE_DURATION', label: '素材最大时长', description: '限制下载素材长度，减少解析时间。', type: 'number', placeholder: '600', suffix: '秒' },
    ],
  },
  {
    title: '搜索与解析',
    description: '脚本文档解析、搜索词优化和素材匹配。',
    icon: Search,
    items: [
      { key: 'MATERIAL_MATCH_MIN_SCORE', label: '素材匹配最低分', description: '越高越严格；太高可能没有素材。', type: 'number', placeholder: '0.25' },
      { key: 'MATERIAL_RANDOM_BOUND_FALLBACK', label: '指定范围随机兜底', description: '默认关闭。指定素材范围内没有合格匹配时随机选片，并记录原因；无有效文件时仍停止。', type: 'switch' },
      { key: 'MATERIAL_EXCLUDE_OVERLAYS', label: '避开原字幕、logo 和水印', description: '默认关闭。采样检查候选画面，排除检测到的问题素材；检测失败不会当作通过。开启后会增加模型检测耗时。', type: 'switch' },
      { key: 'MATERIAL_AUTO_REUSE_MIN_SCORE', label: '自动复用最低分', description: '达到该分数才直接复用素材库；未达到会下载或生成新素材。', type: 'number', placeholder: '0.62' },
      { key: 'SENTRYSEARCH_TOP_K', label: '每次返回候选片段', description: '向量搜索返回的候选数量。', type: 'number', placeholder: '10', suffix: '条' },
      { key: 'DASHSCOPE_SCRIPT_MODEL', label: '脚本解析模型', description: '用于直接读取上传文件并输出分镜 JSON。', type: 'text', placeholder: 'qwen-long' },
      { key: 'DASHSCOPE_SCRIPT_TIMEOUT', label: '脚本解析超时', description: '大文件语义理解的请求超时秒数。', type: 'number', placeholder: '600', suffix: '秒' },
    ],
  },
  {
    title: '云端素材',
    description: '配置私有素材备份和跨设备恢复。',
    icon: Cloud,
    items: [
      { key: 'VIDEOAUTO_MATERIAL_AUTO_BACKUP_IMPORTS', label: '自动备份导入素材', description: '本地分析完成后备份视频和分析结果；关闭应用后，下次打开继续。', type: 'switch' },
    ],
  },
  {
    title: '画面样式',
    description: '统一配置字幕、底部进度条和最终画面预览。',
    icon: Subtitles,
    items: [
      { key: 'SUBTITLE_FONT', label: '字幕字体', description: '用于最终视频字幕的字体名称。', type: 'select', options: subtitleFontOptions },
      { key: 'SUBTITLE_FONT_SIZE', label: '字幕大小', description: '最终视频字幕字号。', type: 'number', placeholder: '68', suffix: 'px' },
      { key: 'SUBTITLE_AI_SAFE_AREA', label: 'AI 避让主体', description: '默认关闭。采样实际画面避让主体、人脸和原文字；黑边足够时无需检测，失败时提示并回到默认位置。', type: 'switch' },
      { key: 'SUBTITLE_PRIMARY_COLOUR', label: '文字颜色', description: '字幕主体颜色。', type: 'color', placeholder: '#FFFFFF' },
      { key: 'SUBTITLE_OUTLINE_COLOUR', label: '描边颜色', description: '字幕描边颜色。', type: 'color', placeholder: '#121212' },
      { key: 'PROGRESS_BAR', label: '显示进度条', description: '开启后在视频底部显示分段进度条。', type: 'switch' },
      { key: 'VIDEOAUTO_TEMPLATE_PACKAGING', label: '模板包装', description: '默认关闭。使用固定标题、参数和行动提示模板，叠加脚本写好的上屏文字。', type: 'switch' },
      { key: 'VIDEOAUTO_PACKAGING_SCRIPT_ONLY', label: '只按脚本上屏', description: '默认开启。只有脚本写了上屏内容的分镜才会出现卡片；关闭后未写的分镜会用分镜标题当卡片文字。', type: 'switch' },
    ],
  },
]
