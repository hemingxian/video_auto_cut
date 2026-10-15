import type { RunArtifact } from '../../types/videoauto'

export const artifactOrder = ['成片', '视频', '音频', '字幕', '图片', '数据', '其他'] as const

export type ArtifactKind = '全部' | typeof artifactOrder[number]

export type ArtifactGroup = {
  kind: typeof artifactOrder[number]
  items: RunArtifact[]
}

export function artifactKindOf(item: RunArtifact): typeof artifactOrder[number] {
  if (item.kind === '视频' && /^output[\\/]/.test(item.relativePath || '')) return '成片'
  return artifactOrder.includes(item.kind as typeof artifactOrder[number])
    ? item.kind as typeof artifactOrder[number]
    : '其他'
}

export function groupArtifacts(artifacts: RunArtifact[]) {
  const visible = artifacts.filter((item) => item.name !== 'run.log')
  const groups = new Map<typeof artifactOrder[number], RunArtifact[]>()
  for (const item of visible) {
    const key = artifactKindOf(item)
    groups.set(key, [...(groups.get(key) || []), item])
  }
  const groupList: ArtifactGroup[] = artifactOrder.map((kind) => ({ kind, items: groups.get(kind) || [] }))
  return { visible, groupList }
}
