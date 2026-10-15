import type { MaterialCardItem } from '../../types/app'
import type { MaterialLibrary, SemanticSearchResult } from '../../types/videoauto'
import { basename } from '../../lib/path'
import { materialKindLabels } from './constants'
import type { ResolvedSemanticVideo } from './types'

export function buildMaterialCards(library: MaterialLibrary) {
  const items: MaterialCardItem[] = []

  for (const file of library.user) {
    items.push({
      ...file,
      kind: 'user',
      kindLabel: materialKindLabels.user,
      group: '本地素材',
      projectName: '本地素材',
      runId: '',
    })
  }

  for (const run of library.runs) {
    const projectName = run.projectName || run.runId
    for (const file of run.raw) items.push({ ...file, kind: 'raw', kindLabel: materialKindLabels.raw, group: projectName, projectName, runId: run.runId })
  }

  return items.sort((a, b) => b.mtime - a.mtime)
}

export function findSemanticLocalVideo(item: SemanticSearchResult, allCards: MaterialCardItem[]): ResolvedSemanticVideo | null {
  const localPath = item.localPath || ''
  const matchedByBackend = localPath ? allCards.find((card) => card.path.toLowerCase() === localPath.toLowerCase()) : undefined
  if (matchedByBackend) {
    return {
      name: matchedByBackend.name,
      path: matchedByBackend.path,
      url: matchedByBackend.url,
      size: matchedByBackend.size,
      mtime: matchedByBackend.mtime,
    }
  }

  const name = (item.name || '').toLowerCase()
  const sourcePath = (item.path || '').toLowerCase()
  const matched = allCards.find((card) => {
    const cardName = card.name.toLowerCase()
    const cardPath = card.path.toLowerCase()
    return cardName === name || cardPath === sourcePath || sourcePath.includes(cardName) || cardPath.includes(name)
  })
  if (matched) {
    return {
      name: matched.name,
      path: matched.path,
      url: matched.url,
      size: matched.size,
      mtime: matched.mtime,
    }
  }

  if (localPath && item.localUrl) {
    return {
      name: basename(item.name || localPath, '未命名视频'),
      path: localPath,
      url: item.localUrl,
      size: item.localSize || 0,
      mtime: item.localMtime || 0,
    }
  }

  return null
}
