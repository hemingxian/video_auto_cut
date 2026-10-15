import type { FileItem, MaterialDirectoryListing, MaterialFolderNode, MaterialSelectionSummary } from '../../types/videoauto'
import { basename } from '../../lib/path.ts'
import type { ShotMaterialBinding } from './types'

export type ShotMaterialSelection = {
  id: string
  kind: 'file' | 'folder'
  name: string
  includeSubfolders?: boolean
  videoCount?: number
  candidateKeys?: string[]
  candidateScope?: string
  file?: FileItem
  folder?: MaterialFolderNode
}

// Only new selections inherit this default. Persisted bindings retain their saved scope.
export function createFolderMaterialSelection(folder: MaterialFolderNode): ShotMaterialSelection {
  return {
    id: folder.id,
    kind: 'folder',
    name: basename(folder.name, '未命名文件夹'),
    includeSubfolders: true,
    folder,
  }
}

export function materialSelectionKey(selection: ShotMaterialSelection): string {
  return selection.kind === 'file'
    ? `material:${selection.file?.materialId || selection.id}`
    : `folder:${selection.folder?.bindingFolderId || selection.folder?.id || selection.id}`
}

export function materialSelectionScope(selection: ShotMaterialSelection): string {
  return `${materialSelectionKey(selection)}:${selection.kind === 'folder' && selection.includeSubfolders === true}`
}

export function applyMaterialSelectionSummary(
  selections: ShotMaterialSelection[],
  summary: MaterialSelectionSummary,
): ShotMaterialSelection[] {
  const entries = new Map(summary.entries.map((entry) => [entry.key, entry.candidateKeys]))
  return selections.map((selection) => {
    const candidateKeys = entries.get(materialSelectionKey(selection))
    if (!candidateKeys) throw new Error('部分素材范围未完成统计，请重试。')
    return { ...selection, candidateKeys, candidateScope: materialSelectionScope(selection), videoCount: candidateKeys.length }
  })
}

export function isLocalMaterialFolder(folder: MaterialFolderNode): boolean {
  return folder.kind === 'user' || folder.kind === 'raw'
}

export function isLocalMaterialFile(file: FileItem): boolean {
  return file.localStatus === 'present' && Boolean(file.path) && Boolean(file.materialId?.startsWith('mat_'))
}

export function localMaterialListing(listing: MaterialDirectoryListing): MaterialDirectoryListing {
  return {
    ...listing,
    folders: listing.folders.filter(isLocalMaterialFolder),
    rootFolders: listing.rootFolders?.filter(isLocalMaterialFolder),
    files: listing.files.filter(isLocalMaterialFile),
  }
}

export function summarizeShotMaterialSelections(selections: ShotMaterialSelection[]) {
  const folders = selections.filter((item) => item.kind === 'folder')
  const files = selections.filter((item) => item.kind === 'file')
  return {
    candidateCount: selections.every((item) => item.candidateKeys && item.candidateScope === materialSelectionScope(item))
      ? new Set(selections.flatMap((item) => item.candidateKeys || [])).size
      : null,
    fileCount: files.length,
    folderCount: folders.length,
  }
}

export function materialVideoPreviewUrl(file: FileItem): string {
  if (!file.url || file.localStatus === 'missing' || file.localStatus === 'damaged') return ''
  return file.url
}

export function selectionsToMaterialBindings(
  selections: ShotMaterialSelection[],
): ShotMaterialBinding[] {
  const bindings: ShotMaterialBinding[] = []
  const seen = new Set<string>()
  for (const selection of selections) {
    if (selection.kind === 'file') {
      const materialId = selection.file?.materialId || selection.id
      if (!materialId.startsWith('mat_')) continue
      const key = `material:${materialId}`
      if (seen.has(key)) continue
      seen.add(key)
      bindings.push({ binding_type: 'material', material_id: materialId })
      continue
    }
    const folderId = selection.folder?.bindingFolderId || selection.folder?.id || selection.id
    if (!folderId) continue
    const key = `folder:${folderId}`
    if (seen.has(key)) continue
    seen.add(key)
    bindings.push({
      binding_type: 'folder',
      folder_id: folderId,
      include_subfolders: selection.includeSubfolders === true,
    })
  }
  return bindings
}

export function materialBindingsToSelections(
  bindings: ShotMaterialBinding[],
): ShotMaterialSelection[] {
  return bindings.map((binding) => binding.binding_type === 'material'
    ? {
        id: binding.material_id,
        kind: 'file' as const,
        name: binding.material_id,
      }
    : {
        id: binding.folder_id,
        kind: 'folder' as const,
        name: binding.folder_id,
        includeSubfolders: binding.include_subfolders,
      })
}
