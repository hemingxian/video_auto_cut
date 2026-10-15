export type UpdateStatus =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export type UpdateProgress = {
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}

export type UpdateInfo = {
  version: string
  releaseName?: string
  releaseDate?: string
  releaseNotes?: string
}

export type UpdateState = {
  status: UpdateStatus
  currentVersion: string
  configured: boolean
  canCheck: boolean
  isPackaged: boolean
  feedUrl: string
  feedSource: string
  available: boolean
  downloaded: boolean
  availableVersion: string
  message: string
  error: string
  progress: UpdateProgress | null
  updateInfo: UpdateInfo | null
  lastCheckedAt: string
}

export type UpdateActionResult = {
  ok: boolean
  status: UpdateState
}
