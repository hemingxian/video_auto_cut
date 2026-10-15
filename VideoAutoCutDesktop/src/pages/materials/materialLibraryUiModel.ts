import type { FileItem, MaterialDirectoryListing } from '../../types/videoauto'

export type MaterialAnalysisState = 'ready' | 'processing' | 'failed' | 'pending'
export type MaterialStorageState = 'local' | 'cloud' | 'both' | 'missing' | 'damaged' | 'damaged_cloud' | 'sync_failed'
export type MaterialUploadTransferState = 'queued' | 'uploading' | 'paused' | 'verifying' | 'failed' | 'canceled'
export type MaterialBackupState = 'waiting_analysis' | 'analyzing' | 'analysis_failed' | 'queued' | 'uploading' | 'verifying' | 'syncing_analysis' | 'incomplete' | 'failed' | 'paused' | 'canceled' | 'ready'
export type MaterialDownloadTransferState = 'downloading' | 'verifying' | 'failed'
export type MaterialVisibility = 'private' | 'publishing' | 'public' | 'suspended'
export type MaterialLibraryFilter = 'all' | 'local' | 'cloud' | 'sync_failed' | 'pending'
export type MaterialLibraryFilterCounts = Record<MaterialLibraryFilter, number>
export type MaterialLibraryViewMode = 'grid' | 'list'
export type MaterialThumbnailTone =
  | 'alpine'
  | 'city'
  | 'coast'
  | 'forest'
  | 'night'
  | 'studio'
  | 'sunset'
  | 'teal'

export type MaterialUiMetadata = {
  localAvailable?: boolean
  analysis: MaterialAnalysisState
  analysisTransferFailed?: boolean
  backup?: MaterialBackupState
  storage: MaterialStorageState
  uploadTransfer?: MaterialUploadTransferState
  uploadBytesTransferred?: number
  uploadTotalBytes?: number
  uploadSpeedBytesPerSecond?: number
  downloadTransfer?: MaterialDownloadTransferState
  downloadBytesTransferred?: number
  downloadTotalBytes?: number
  downloadSpeedBytesPerSecond?: number
  visibility: MaterialVisibility
  cardBadges?: Array<'analysis' | 'storage' | 'visibility'>
  duration?: string
  resolution?: string
  folderName?: string
  owner?: string
  thumbnailTone?: MaterialThumbnailTone
}

export type MaterialUiMetadataMap = Record<string, Partial<MaterialUiMetadata>>

export function hasImportedMaterials(files: readonly FileItem[]) {
  return files.length > 0
}

export function hasReusableMaterialAnalysis(file: FileItem | undefined) {
  return file?.analysisStatus === 'ready'
    || (file?.cloudStatus === 'ready' && file.cloudAnalysisStatus === 'ready')
}

export function materialBackupStateFor(file: FileItem): MaterialBackupState | undefined {
  if (file.cloudStatus === 'ready' && file.cloudAnalysisStatus === 'ready') return 'ready'
  const upload = file.uploadTransferStatus
  if (upload === 'paused' || upload === 'canceled') return upload
  const analysisUpload = file.analysisTransferDirection !== 'download' && file.analysisTransferStatus
  const requested = Boolean(upload || analysisUpload || ['uploading', 'verifying', 'ready', 'failed'].includes(file.cloudStatus || ''))
  if (!requested) return undefined
  if (file.analysisStatus === 'failed') return 'analysis_failed'
  if (file.cloudStatus === 'failed' || upload === 'failed' || analysisUpload === 'failed') return 'failed'
  if (file.cloudStatus === 'ready' && file.localStatus !== 'present') return 'incomplete'
  if (file.analysisStatus === 'analyzing') return 'analyzing'
  if (file.analysisStatus !== 'ready' && file.cloudAnalysisStatus !== 'ready') return 'waiting_analysis'
  if (file.cloudStatus === 'verifying' || upload === 'verifying') return 'verifying'
  if (file.cloudStatus === 'uploading' || upload === 'uploading') return 'uploading'
  if (file.cloudStatus === 'ready' || analysisUpload === 'processing') return 'syncing_analysis'
  return 'queued'
}

export function materialBackupLabel(state: MaterialBackupState) {
  const labels: Record<MaterialBackupState, string> = {
    waiting_analysis: '等待本地分析', analyzing: '本地分析中', analysis_failed: '分析失败，备份未完成',
    queued: '等待云备份', uploading: '备份视频中', verifying: '云端校验中',
    syncing_analysis: '备份分析结果中', incomplete: '分析结果未备份',
    failed: '云备份失败', paused: '备份已暂停', canceled: '备份已取消', ready: '云备份完成',
  }
  return labels[state]
}

export const materialFilterOptions: ReadonlyArray<{
  value: MaterialLibraryFilter
  label: string
}> = [
  { value: 'all', label: '全部' },
  { value: 'local', label: '本地' },
  { value: 'cloud', label: '云端' },
  { value: 'sync_failed', label: '同步失败' },
  { value: 'pending', label: '未分析' },
]

const defaultMetadata: MaterialUiMetadata = {
  analysis: 'pending',
  storage: 'local',
  visibility: 'private',
  cardBadges: ['storage', 'analysis'],
  resolution: '—',
  folderName: '本地素材',
  owner: '当前用户',
  thumbnailTone: 'teal',
}

export function materialMetadataFor(
  file: FileItem,
  overrides: MaterialUiMetadataMap | undefined,
  folderName?: string,
): MaterialUiMetadata {
  const hasLocal = file.localStatus === undefined || file.localStatus === 'present'
  const hasCloud = file.cloudStatus === 'ready'
  const storage: MaterialStorageState = file.localStatus === 'damaged'
    ? hasCloud ? 'damaged_cloud' : 'damaged'
    : file.localStatus === 'missing' && !hasCloud
      ? 'missing'
      : file.cloudStatus === 'failed' && file.uploadTransferStatus !== 'paused' && file.uploadTransferStatus !== 'canceled'
    ? 'sync_failed'
    : hasLocal && hasCloud
      ? 'both'
      : hasCloud
        ? 'cloud'
        : 'local'
  const analysis: MaterialAnalysisState = hasReusableMaterialAnalysis(file)
    ? 'ready'
    : file.analysisStatus === 'analyzing'
      ? 'processing'
      : file.analysisStatus === 'failed'
        ? 'failed'
        : 'pending'
  const visibility: MaterialVisibility = file.publicationStatus === 'public'
    ? 'public'
    : file.publicationStatus === 'publishing'
      ? 'publishing'
      : file.publicationStatus === 'suspended'
        ? 'suspended'
        : 'private'
  const uploadTransfer = file.uploadTransferStatus && file.uploadTransferStatus !== 'ready'
    ? file.uploadTransferStatus
    : undefined
  const downloadTransfer = file.downloadTransferStatus && file.downloadTransferStatus !== 'ready'
    ? file.downloadTransferStatus
    : undefined
  return {
    ...defaultMetadata,
    localAvailable: file.localStatus === undefined && overrides?.[file.path]?.storage
      ? ['local', 'both', 'sync_failed'].includes(overrides[file.path].storage!) : hasLocal,
    folderName: folderName || defaultMetadata.folderName,
    analysis,
    backup: materialBackupStateFor(file),
    analysisTransferFailed: file.analysisTransferStatus === 'failed'
      || (file.analysisTransferStatus !== 'ready' && Boolean(file.analysisTransferError)),
    storage,
    uploadTransfer,
    uploadBytesTransferred: file.uploadBytesTransferred,
    uploadTotalBytes: file.uploadTotalBytes,
    downloadTransfer,
    downloadBytesTransferred: file.downloadBytesTransferred,
    downloadTotalBytes: file.downloadTotalBytes,
    visibility,
    ...overrides?.[file.path],
  }
}

export function materialMatchesFilter(
  metadata: MaterialUiMetadata,
  filter: MaterialLibraryFilter,
) {
  if (filter === 'all') return true
  if (filter === 'local') return metadata.localAvailable ?? (metadata.storage === 'local' || metadata.storage === 'both')
  if (filter === 'cloud') return metadata.storage === 'cloud'
    || metadata.storage === 'both'
    || metadata.storage === 'damaged_cloud'
  if (filter === 'sync_failed') return metadata.storage === 'sync_failed' || metadata.analysisTransferFailed === true
  return metadata.analysis === 'pending'
}

export function visibleMaterialFiles(
  listing: MaterialDirectoryListing | null,
  filter: MaterialLibraryFilter,
  overrides?: MaterialUiMetadataMap,
) {
  if (!listing) return []
  return listing.files.filter((file) => materialMatchesFilter(
    materialMetadataFor(file, overrides, listing.current.name),
    filter,
  ))
}

export function materialFilterCounts(
  listing: MaterialDirectoryListing | null,
  overrides?: MaterialUiMetadataMap,
): MaterialLibraryFilterCounts {
  const counts: MaterialLibraryFilterCounts = {
    all: 0,
    local: 0,
    cloud: 0,
    sync_failed: 0,
    pending: 0,
  }
  if (!listing) return counts

  for (const file of listing.files) {
    const metadata = materialMetadataFor(file, overrides, listing.current.name)
    counts.all += 1
    if (materialMatchesFilter(metadata, 'local')) counts.local += 1
    if (materialMatchesFilter(metadata, 'cloud')) counts.cloud += 1
    if (materialMatchesFilter(metadata, 'sync_failed')) counts.sync_failed += 1
    if (materialMatchesFilter(metadata, 'pending')) counts.pending += 1
  }
  return counts
}

export function analysisLabel(state: MaterialAnalysisState) {
  if (state === 'ready') return '已分析'
  if (state === 'processing') return '分析中'
  if (state === 'failed') return '分析失败'
  return '待分析'
}

export function storageLabel(state: MaterialStorageState) {
  if (state === 'cloud') return '云端'
  if (state === 'both') return '本地和云端'
  if (state === 'missing') return '本地缺失'
  if (state === 'damaged') return '本地损坏'
  if (state === 'damaged_cloud') return '本地损坏，可恢复'
  if (state === 'sync_failed') return '同步失败'
  return '本地'
}

export function uploadTransferLabel(state: MaterialUploadTransferState) {
  if (state === 'queued') return '等待上传'
  if (state === 'uploading') return '上传中'
  if (state === 'paused') return '已暂停'
  if (state === 'verifying') return '云端校验中'
  if (state === 'failed') return '上传失败'
  return '已取消'
}

export function downloadTransferLabel(state: MaterialDownloadTransferState) {
  if (state === 'downloading') return '下载中'
  if (state === 'verifying') return '下载校验中'
  return '下载失败'
}

function transferProgressPercent(transferredValue: number | undefined, totalValue: number | undefined) {
  const total = totalValue || 0
  if (total <= 0) return undefined
  const transferred = Math.max(0, transferredValue || 0)
  return Math.max(0, Math.min(100, Math.round(transferred * 100 / total)))
}

export function materialUploadProgressPercent(metadata: Pick<
  MaterialUiMetadata,
  'uploadBytesTransferred' | 'uploadTotalBytes'
>) {
  return transferProgressPercent(metadata.uploadBytesTransferred, metadata.uploadTotalBytes)
}

export function materialDownloadProgressPercent(metadata: Pick<
  MaterialUiMetadata,
  'downloadBytesTransferred' | 'downloadTotalBytes'
>) {
  return transferProgressPercent(metadata.downloadBytesTransferred, metadata.downloadTotalBytes)
}

export function materialSelectionAfterToggle(
  selected: ReadonlySet<string>,
  path: string,
) {
  const next = new Set(selected)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

export function materialSelectionAfterPageToggle(
  selected: ReadonlySet<string>,
  pagePaths: readonly string[],
) {
  const next = new Set(selected)
  const selectablePaths = [...new Set(pagePaths.filter(Boolean))]
  const allSelected = selectablePaths.length > 0
    && selectablePaths.every((path) => next.has(path))
  for (const path of selectablePaths) {
    if (allSelected) next.delete(path)
    else next.add(path)
  }
  return next
}
