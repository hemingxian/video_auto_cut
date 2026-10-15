import type { FileItem } from './common'

export type RunArtifact = FileItem & {
  shotId?: string
  kind: string
  relativePath: string
}

export type RunItem = {
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
