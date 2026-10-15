import type { MaterialDirectoryListing } from '../../types/videoauto'

export const MATERIAL_FOLDER_SEARCH_LIMIT = 80

export function createMaterialFolderSearchRequest(value: string) {
  const query = value.trim()
  return query ? { query, limit: MATERIAL_FOLDER_SEARCH_LIMIT } : null
}

export function formatDirectoryContents(listing: Pick<MaterialDirectoryListing, 'folders' | 'files'>) {
  const parts: string[] = []
  if (listing.folders.length > 0) parts.push(`${listing.folders.length} 个文件夹`)
  if (listing.files.length > 0) parts.push(`${listing.files.length} 个视频`)
  return parts.length ? parts.join(' · ') : '空文件夹'
}

export function hasDirectoryContents(listing: Pick<MaterialDirectoryListing, 'folders' | 'files'> | null) {
  return Boolean(listing && (listing.folders.length > 0 || listing.files.length > 0))
}

export function createMaterialDirectoryItems(listing: Pick<MaterialDirectoryListing, 'folders' | 'files'>) {
  return [
    ...listing.folders.map((folder) => ({ type: 'folder' as const, folder })),
    ...listing.files.map((file) => ({ type: 'video' as const, file })),
  ]
}
