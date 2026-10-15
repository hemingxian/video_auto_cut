export type JsonRecord = Record<string, unknown>
export type MutableEnv = Record<string, string | undefined>
export type EnvReader = () => Record<string, string>
export type IpcSender = (channel: string, payload?: unknown) => void

export interface FileEntry {
  name: string
  path: string
  url: string
  size: number
  mtime: number
  ext: string
  materialId?: string
  assetId?: string
  assetVersion?: number
  sourceSha256?: string
  localStatus?: 'present' | 'missing' | 'damaged'
  analysisStatus?: 'pending' | 'analyzing' | 'ready' | 'failed'
  analysisError?: string
  cloudAnalysisStatus?: 'pending' | 'analyzing' | 'ready' | 'failed'
  cloudAnalysisError?: string
  analysisTransferStatus?: 'queued' | 'processing' | 'failed' | 'ready'
  analysisTransferDirection?: 'upload' | 'download'
  analysisTransferError?: string
  cloudStatus?: 'not_uploaded' | 'uploading' | 'verifying' | 'ready' | 'deleting' | 'failed' | 'deleted'
  cloudError?: string
  uploadTransferStatus?: 'queued' | 'uploading' | 'paused' | 'verifying' | 'failed' | 'canceled' | 'ready'
  uploadBytesTransferred?: number
  uploadTotalBytes?: number
  downloadTransferStatus?: 'downloading' | 'verifying' | 'failed' | 'ready'
  downloadBytesTransferred?: number
  downloadTotalBytes?: number
  publicationStatus?: 'private' | 'publishing' | 'public' | 'suspended' | 'removed'
  publicationId?: string
  publicationRevision?: number
  publicationReviewReason?: string
}

export interface RunArtifact extends FileEntry {
  shotId?: string
  kind: string
  relativePath: string
}

export interface RunRecord {
  id: string
  sourceRunId?: string
  outputFormat?: { aspectRatio: string; outputResolution: string; width: number; height: number }
  projectName: string
  path: string
  mtime: number
  logPath: string
  shotsPath: string
  shotsModifiedAt?: number
  finalVideo: string
  incrementalPath?: string
  artifacts: RunArtifact[]
}

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

export function getRecord(value: unknown, key: string): JsonRecord {
  return asRecord(asRecord(value)[key])
}

export function getArray(value: unknown, key: string): unknown[] {
  const item = asRecord(value)[key]
  return Array.isArray(item) ? item : []
}

export function stringValue(value: unknown, fallback = ''): string {
  return value === undefined || value === null ? fallback : String(value)
}

export function numberValue(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function optionalNumberValue(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number !== 0 ? number : undefined
}

export function errorMessage(error: unknown, fallback = '请求失败'): string {
  const record = asRecord(error)
  return stringValue(record.message || error, fallback)
}
