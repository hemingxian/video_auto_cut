export type EnvMap = Record<string, string>

export type FileItem = {
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
