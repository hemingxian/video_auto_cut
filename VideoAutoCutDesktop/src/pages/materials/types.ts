export type SearchMode = 'file' | 'semantic'

export type MaterialImportProgressState = {
  sessionId: string
  status: 'copying' | 'verifying' | 'canceling' | 'completed' | 'canceled'
  fileName: string
  fileIndex: number
  totalFiles: number
  bytesProcessed: number
  totalBytes: number
  speedBytesPerSecond: number
  imported: number
  failed: number
  message: string
}

export type ResolvedSemanticVideo = {
  name: string
  path: string
  url: string
  size: number
  mtime: number
}
