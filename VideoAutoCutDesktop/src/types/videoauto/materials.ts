import type { FileItem } from './common'

export type MaterialDirectoryKind = 'user' | 'raw' | 'cloud'

export type MaterialSelectionSummary = {
  candidateCount: number
  entries: Array<{ key: string; candidateKeys: string[] }>
}

export type MaterialFolderNode = {
  id: string
  name: string
  kind: MaterialDirectoryKind | null
  storageScope?: 'virtual' | 'user' | 'downloads'
  bindingFolderId?: string
  folderCount?: number
  videoCount?: number
  canCreate?: boolean
  canImport?: boolean
  canRename?: boolean
  canDelete?: boolean
}

export type MaterialBreadcrumb = {
  id: string
  name: string
}

export type MaterialDirectoryListing = {
  root?: MaterialFolderNode
  current: MaterialFolderNode
  breadcrumbs: MaterialBreadcrumb[]
  rootFolders?: MaterialFolderNode[]
  folders: MaterialFolderNode[]
  files: FileItem[]
}

export type MaterialFolderSearchResult = {
  folder: MaterialFolderNode
  breadcrumbs: MaterialBreadcrumb[]
}

export type MaterialRun = {
  runId: string
  projectName: string
  raw: FileItem[]
}

export type MaterialLibrary = {
  user: FileItem[]
  runs: MaterialRun[]
}

export type SemanticSearchResult = {
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
  localStatus?: FileItem['localStatus']
  analysisStatus?: FileItem['analysisStatus']
  analysisError?: string
  cloudStatus?: FileItem['cloudStatus']
}

export type SemanticSearchResponse = {
  ok: boolean
  code?: number
  command?: string
  message?: string
  raw: string
  results: SemanticSearchResult[]
}

export type AutomaticMaterialDecision = {
  shotId: string
  status: 'reused' | 'fallback' | 'skipped' | 'blocked'
  strategy: 'library' | 'download' | 'manual'
  query: string
  reason: string
  materialId?: string
  materialName?: string
  score?: number
  fallbackSource?: string
}

export type AutomaticMaterialResolution = {
  ok: boolean
  shots: Array<Record<string, unknown>>
  decisions: AutomaticMaterialDecision[]
  matched: number
  fallback: number
  skipped: number
  blocked?: number
  message?: string
  threshold: number
}

export type GenerateMaterialResult = {
  ok: boolean
  mode?: 'reused' | 'generated'
  message?: string
  pid?: number
  threshold?: number
  reuse?: SemanticSearchResult
}

export type GeneratedMaterialRecord = {
  id: string
  created_at: string
  prompt: string
  engine: string
  generation_mode?: string
  title: string
  duration?: number
  ai_script_error?: string
  plan_path: string
  prompt_path: string
  source_path?: string
  animation_agent_state_path?: string
  rendered_path?: string
  record_dir: string
  output_path: string
}

export type DeleteIndexResult = {
  ok: boolean
  skipped?: boolean
  removedChunks?: number
  message?: string
  raw?: string
  command?: string
}

export type DeleteMaterialResult = {
  ok: boolean
  message?: string
  removedFile?: boolean
  index?: DeleteIndexResult
  generatedRecords?: Array<{
    id?: string
    recordDir?: boolean
  }>
  details?: DeleteMaterialResult[]
}

export type MaterialDeletionImpact = {
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

export type DeleteMaterialsBatchResult = {
  ok: boolean
  message?: string
  succeeded: number
  failed: number
  results: Array<{ path: string; ok: boolean; message?: string }>
}

export type RenameMaterialResult = {
  ok: boolean
  message?: string
  file?: FileItem
  index?: DeleteIndexResult
}

export type MoveMaterialsResult = {
  ok: boolean
  message?: string
  moved?: number
  files?: FileItem[]
  folder?: MaterialFolderNode
  previousParentId?: string
}

export type MaterialFolderOperationResult = {
  ok: boolean
  message?: string
  folder?: MaterialFolderNode
  previousFolderId?: string
  parentId?: string
  index?: DeleteIndexResult
}
