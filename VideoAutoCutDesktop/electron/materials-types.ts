import type { FileEntry, JsonRecord } from './types.js'

type MaterialDirectoryKind = 'user' | 'raw' | 'cloud'

interface MaterialFolderNode {
  id: string
  name: string
  kind: MaterialDirectoryKind | null
  storageScope?: 'virtual' | 'user' | 'downloads'
  bindingFolderId?: string
  canCreate: boolean
  canImport?: boolean
  canRename: boolean
  canDelete: boolean
  folderCount?: number
  videoCount?: number
}

interface PreparedMaterialFolderOperation {
  folder: MaterialFolderNode
  directory: string
  videoPaths: string[]
}

interface RenameMaterialFolderResult {
  previousFolderId: string
  previousDirectory: string
  directory: string
  changed: boolean
  folder: MaterialFolderNode
}

interface DeleteMaterialFolderResult {
  folderId: string
  directory: string
  stagedDirectory?: string
  parentId: string
}

interface MaterialBreadcrumb {
  id: string
  name: string
}

interface MaterialDirectoryListing {
  root?: MaterialFolderNode
  current: MaterialFolderNode
  breadcrumbs: MaterialBreadcrumb[]
  rootFolders: MaterialFolderNode[]
  folders: MaterialFolderNode[]
  files: FileEntry[]
}

interface MaterialFolderSearchResult {
  folder: MaterialFolderNode
  breadcrumbs: MaterialBreadcrumb[]
}

interface SentrySearchPaths {
  exe: string
  python: string
  entry: string
}

interface SearchOptions {
  query?: unknown
  results?: unknown
  threshold?: unknown
  noTrim?: boolean
}

interface SearchResult {
  rank: number
  score: number
  name: string
  path: string
  start: string
  end: string
  text: string
  localPath?: string
  localUrl?: string
  localSize?: number
  localMtime?: number
  materialId?: string
  assetId?: string
  assetVersion?: number
  sourceSha256?: string
  localStatus?: FileEntry['localStatus']
  analysisStatus?: FileEntry['analysisStatus']
  analysisError?: string
  cloudStatus?: FileEntry['cloudStatus']
}

interface VectorIndexResult {
  ok: boolean
  skipped: boolean
  removedChunks: number
  message: string
  command?: string
  raw?: string
}

interface GeneratedRecord extends JsonRecord {
  id?: string | number
  output_path?: string
  record_dir?: string
}

interface DeleteGeneratedOptions {
  id?: unknown
  outputPath?: unknown
  output_path?: unknown
}

interface GeneratedRecordFiles {
  recordDir: boolean
}

interface DeleteResult {
  ok: boolean
  message?: string
  removedFile?: boolean
  index?: VectorIndexResult
  generatedRecords?: Array<{ id: unknown } & GeneratedRecordFiles>
}

interface DeleteLocalMaterialCopyOptions {
  materialId?: unknown
}

interface PreviewMaterialDeletionOptions {
  paths?: unknown
  folderIds?: unknown
}

interface MaterialDeletionImpact {
  ok: boolean
  message?: string
  materialCount: number
  folderCount: number
  localFileCount: number
  cloudCopyCount: number
  publicMaterialCount: number
  taskReferenceCount: number
  canDelete: boolean
  blockers: string[]
}

interface DeleteMaterialsOptions {
  paths?: unknown
}

interface DeleteMaterialsBatchResult {
  ok: boolean
  message?: string
  succeeded: number
  failed: number
  results: Array<{ path: string; ok: boolean; message?: string }>
}

interface RenameMaterialOptions {
  path?: unknown
  name?: unknown
}

interface RenameResult {
  ok: boolean
  message?: string
  file?: FileEntry
  index?: VectorIndexResult
}

interface MaterialFolderOptions {
  folderId?: unknown
}

interface CreateMaterialFolderOptions {
  parentFolderId?: unknown
  name?: unknown
}

interface RenameMaterialFolderOptions extends MaterialFolderOptions {
  name?: unknown
}

interface MoveMaterialFolderOptions extends MaterialFolderOptions {
  destinationFolderId?: unknown
}

interface MoveMaterialsOptions {
  paths?: unknown
  sourceFolderId?: unknown
  destinationFolderId?: unknown
}

interface MoveMaterialsResult {
  ok: boolean
  message?: string
  moved?: number
  files?: FileEntry[]
  folder?: MaterialFolderNode
  previousParentId?: string
}

interface ImportMaterialsOptions {
  folderId?: unknown
  selection?: unknown
}

interface MaterialFolderOperationResult {
  ok: boolean
  message?: string
  folder?: MaterialFolderNode
  previousFolderId?: string
  parentId?: string
  index?: VectorIndexResult
  generatedRecords?: Array<{ id: unknown } & GeneratedRecordFiles>
}

interface GenerateMaterialOptions {
  prompt?: unknown
  engine?: unknown
  reuseThreshold?: unknown
}

interface RunMaterialGroup {
  runId: string
  projectName: string
  raw: FileEntry[]
}

export {
  type CreateMaterialFolderOptions,
  type DeleteGeneratedOptions,
  type DeleteLocalMaterialCopyOptions,
  type DeleteMaterialFolderResult,
  type DeleteResult,
  type GenerateMaterialOptions,
  type GeneratedRecord,
  type GeneratedRecordFiles,
  type ImportMaterialsOptions,
  type MaterialBreadcrumb,
  type MaterialDirectoryKind,
  type MaterialDirectoryListing,
  type MaterialDeletionImpact,
  type MaterialFolderOperationResult,
  type MaterialFolderOptions,
  type MaterialFolderNode,
  type MaterialFolderSearchResult,
  type MoveMaterialFolderOptions,
  type MoveMaterialsOptions,
  type MoveMaterialsResult,
  type DeleteMaterialsBatchResult,
  type DeleteMaterialsOptions,
  type PreviewMaterialDeletionOptions,
  type PreparedMaterialFolderOperation,
  type RenameMaterialFolderOptions,
  type RenameMaterialFolderResult,
  type RenameMaterialOptions,
  type RenameResult,
  type RunMaterialGroup,
  type SearchOptions,
  type SearchResult,
  type SentrySearchPaths,
  type VectorIndexResult,
}
