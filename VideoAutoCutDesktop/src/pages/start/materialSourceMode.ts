import type { MaterialSourceMode } from './types'
export type { MaterialSourceMode } from './types'

export function normalizeMaterialSourceMode(value: unknown, legacyPrefer?: boolean): MaterialSourceMode {
  if (value === 'library-only' || value === 'library-first' || value === 'pexels-only') return value
  return legacyPrefer === false ? 'pexels-only' : 'library-first'
}

export const materialSourceModeOptions: Array<{ value: MaterialSourceMode; label: string; description: string }> = [
  { value: 'library-only', label: '仅素材库', description: '仅使用本地和当前账号云端素材；未命中时提示补充素材，不从 Pexels 下载。' },
  { value: 'library-first', label: '素材库 → Pexels', description: '先匹配本地和当前账号云端素材，未命中时从 Pexels 下载。' },
  { value: 'pexels-only', label: '仅 Pexels', description: '直接从 Pexels 下载，不使用素材库或手工绑定范围。' },
]
