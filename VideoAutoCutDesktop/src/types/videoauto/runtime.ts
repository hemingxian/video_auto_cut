export type RuntimeProgress = {
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}

export type RuntimeStatus =
  | 'missing'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'ready'
  | 'error'

export type RuntimeState = {
  status: RuntimeStatus
  ready: boolean
  localVersion: string
  latestVersion: string
  runtimeRoot: string
  manifestUrl: string
  url: string
  sha256: string
  size: number
  notes: string
  message: string
  error: string
  progress: RuntimeProgress | null
  updatedAt: string
}
