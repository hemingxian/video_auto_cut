const MATERIAL_DRAG_KIND = 'video-auto-cut/material-files'

export type MaterialDragData = {
  kind: typeof MATERIAL_DRAG_KIND
  paths: string[]
  sourceFolderId: string
}

export function createMaterialDragData(paths: string[], sourceFolderId: string): MaterialDragData {
  return {
    kind: MATERIAL_DRAG_KIND,
    paths: [...new Set(paths.filter(Boolean))],
    sourceFolderId,
  }
}

export function readMaterialDragData(value: Record<string, unknown>): MaterialDragData | null {
  if (value.kind !== MATERIAL_DRAG_KIND || typeof value.sourceFolderId !== 'string') return null
  if (!Array.isArray(value.paths) || value.paths.some((path) => typeof path !== 'string')) return null
  const paths = [...new Set(value.paths.filter(Boolean))]
  if (!paths.length) return null
  return createMaterialDragData(paths, value.sourceFolderId)
}
