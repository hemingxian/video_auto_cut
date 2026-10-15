export type ScriptImportIssue = {
  code: string
  message: string
  action?: string
  shot?: number
  cell?: string
  column?: string
  field?: string
  level?: string
}

export type ScriptImportReport = {
  route: 'template' | 'organized'
  format: string
  file: string
  shots: number
  blocked: ScriptImportIssue[]
  warnings: ScriptImportIssue[]
}

export type TaskEvent = {
  type: 'start' | 'stdout' | 'stderr' | 'close' | 'stopping'
  text?: string
  code?: number
  pid?: number
  command?: string
  runId?: string
  runPath?: string
  workflowStage?: string
  workflowPlan?: string[]
  workflowProgress?: {
    stage?: string
    status?: string
    phase?: string
    current?: number
    total?: number
    label?: string
  }
  scriptImport?: ScriptImportReport
}

export type RunningTask = {
  pid?: number
  command?: string
  code?: number | null
  runId?: string
  runPath?: string
  shotsJson?: string
  startedAt?: string
  status?: 'running' | 'stopping' | 'done'
}

export type TaskStatus = {
  running: boolean
} & RunningTask

export type TaskStartResult = {
  ok: boolean
  message?: string
  pid?: number
} & Partial<TaskStatus>
