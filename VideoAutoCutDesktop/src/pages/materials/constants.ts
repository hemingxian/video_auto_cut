import type { MaterialKind } from '../../types/app'
import type { MaterialLibrary } from '../../types/videoauto'

export const emptyLibrary: MaterialLibrary = { user: [], runs: [] }

export const materialKindLabels: Record<MaterialKind, string> = {
  user: '本地素材',
  raw: '云端素材',
}

export const searchModeOptions = [
  { label: '文件名搜索', value: 'file' },
  { label: '语义搜索', value: 'semantic' },
]
