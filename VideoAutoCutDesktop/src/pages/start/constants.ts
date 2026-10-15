import type { EditableShotField } from './types'

export const editableFields: Array<{ key: EditableShotField; label: string; placeholder: string; rows?: number }> = [
  { key: 'title', label: '分镜标题', placeholder: '例如：①爆点' },
  { key: 'voice_text', label: '口播文案', placeholder: '这一段最终要朗读的文案', rows: 3 },
  { key: 'download_query', label: '素材搜索词', placeholder: '用来搜索素材，建议短而准', rows: 2 },
  { key: 'visual_query', label: '想要的画面', placeholder: '描述这一段需要什么画面，比如主体、场景、风格', rows: 3 },
  { key: 'clip_requirements', label: '剪辑要求', placeholder: '画面剪辑要求、动画效果、卡片提示等', rows: 2 },
]
