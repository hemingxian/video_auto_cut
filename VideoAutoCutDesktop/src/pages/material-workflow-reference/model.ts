export type ReferenceFolder = {
  id: string
  name: string
  videoCount: number
  folderCount: number
}

export type ReferenceMaterialStatus = 'ready' | 'processing' | 'failed'

export type ReferenceMaterial = {
  id: string
  name: string
  size: string
  duration: string
  resolution: string
  folderId: string
  folderName: string
  status: ReferenceMaterialStatus
  storage: 'local' | 'cloud' | 'both'
  visibility: 'private' | 'public'
  sprite: 'a' | 'b'
  spritePosition: string
}

export type ReferenceSelection = {
  id: string
  kind: 'folder' | 'material'
  name: string
  includeSubfolders?: boolean
  videoCount?: number
}

export function toggleReferenceSelection(
  selections: readonly ReferenceSelection[],
  selection: ReferenceSelection,
) {
  const exists = selections.some((item) => (
    item.id === selection.id && item.kind === selection.kind
  ))
  if (exists) {
    return selections.filter((item) => (
      item.id !== selection.id || item.kind !== selection.kind
    ))
  }
  return [...selections, selection]
}

export function toggleReferenceSubfolders(
  selections: readonly ReferenceSelection[],
  selectionId: string,
) {
  return selections.map((item) => (
    item.kind === 'folder' && item.id === selectionId
      ? { ...item, includeSubfolders: !item.includeSubfolders }
      : item
  ))
}

export function summarizeReferenceSelections(
  selections: readonly ReferenceSelection[],
) {
  const folders = selections.filter((item) => item.kind === 'folder')
  const materials = selections.filter((item) => item.kind === 'material')
  return {
    folderCount: folders.length,
    materialCount: materials.length,
    candidateCount: materials.length
      + folders.reduce((sum, item) => sum + (item.videoCount || 0), 0),
  }
}

export function filterReferenceMaterials(
  materials: readonly ReferenceMaterial[],
  query: string,
  filter: 'all' | 'local' | 'cloud' | 'failed' | 'pending',
) {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return materials.filter((item) => {
    const matchesQuery = !normalizedQuery
      || item.name.toLocaleLowerCase().includes(normalizedQuery)
      || item.folderName.toLocaleLowerCase().includes(normalizedQuery)
    if (!matchesQuery) return false
    if (filter === 'local') return item.storage === 'local' || item.storage === 'both'
    if (filter === 'cloud') return item.storage === 'cloud' || item.storage === 'both'
    if (filter === 'failed') return item.status === 'failed'
    if (filter === 'pending') return item.status === 'processing'
    return true
  })
}
