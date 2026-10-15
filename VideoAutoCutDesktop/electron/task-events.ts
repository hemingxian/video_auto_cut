const WORKFLOW_EVENT_PREFIX = 'VACUT_EVENT:'

type ScriptImportIssue = {
  code: string
  message: string
  action?: string
  shot?: number
  cell?: string
  column?: string
  field?: string
  level?: string
}

type ScriptImportReport = {
  route: 'template'
  format: string
  file: string
  shots: number
  blocked: ScriptImportIssue[]
  warnings: ScriptImportIssue[]
}
const WORKFLOW_STAGES = new Set([
  'script',
  'plan',
  'query',
  'voice',
  'material',
  'card',
  'clip',
  'compose',
  'bgm',
  'done',
])
const WORKFLOW_STATUSES = new Set(['pending', 'running', 'completed', 'failed'])

type WorkflowProgressEvent = {
  stage?: string
  status?: string
  phase?: string
  current?: number
  total?: number
  label?: string
}

type WorkflowEvent = {
  workflowStage: string
  workflowProgress?: WorkflowProgressEvent
  workflowPlan?: string[]
  scriptImport?: ScriptImportReport
}

interface ExtractedTaskOutput extends WorkflowEvent {
  text: string
}

interface RunLocation {
  runId: string
  runPath: string
}

class TaskOutputDecoder {
  private pending = ''

  push(chunk: string): ExtractedTaskOutput | null {
    if (!chunk) return null
    this.pending += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const boundary = this.pending.lastIndexOf('\n')
    if (boundary < 0) return null

    const complete = this.pending.slice(0, boundary + 1)
    this.pending = this.pending.slice(boundary + 1)
    return extractWorkflowEvent(complete)
  }

  flush(): ExtractedTaskOutput | null {
    if (!this.pending) return null
    const remaining = this.pending
    this.pending = ''
    return extractWorkflowEvent(remaining)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function normalizeWorkflowStage(value: unknown): string {
  const stage = String(value || '').trim()
  return WORKFLOW_STAGES.has(stage) ? stage : ''
}

function normalizeWorkflowStatus(value: unknown): string {
  const status = String(value || '').trim()
  return WORKFLOW_STATUSES.has(status) ? status : ''
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeWorkflowProgress(
  value: unknown,
  fallbackStage: string,
  fallbackStatus = '',
  fallbackPhase = '',
): WorkflowProgressEvent | undefined {
  const record = asRecord(value)
  const stage = normalizeWorkflowStage(record.stage) || fallbackStage || undefined
  const status = normalizeWorkflowStatus(record.status) || fallbackStatus || undefined
  const phase = cleanText(record.phase) || fallbackPhase
  const current = optionalNumber(record.current)
  const total = optionalNumber(record.total)
  const label = cleanText(record.label)

  if (!stage && !status && !phase && current === undefined && total === undefined && !label) {
    return undefined
  }

  return {
    ...(stage ? { stage } : {}),
    ...(status ? { status } : {}),
    ...(phase ? { phase } : {}),
    ...(current !== undefined ? { current } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(label ? { label } : {}),
  }
}

function normalizeWorkflowPlan(value: unknown): string[] | undefined {
  const record = asRecord(value)
  const rawStages = Array.isArray(value)
    ? value
    : Array.isArray(record.stages) ? record.stages : []
  const stages = rawStages
    .map(normalizeWorkflowStage)
    .filter((stage): stage is string => Boolean(stage && stage !== 'card' && stage !== 'done'))
  const uniqueStages = Array.from(new Set(stages))
  return uniqueStages.length ? uniqueStages : undefined
}

function normalizeScriptImportIssue(value: unknown): ScriptImportIssue | undefined {
  const record = asRecord(value)
  const code = cleanText(record.code)
  const message = cleanText(record.message)
  if (!code || !message) return undefined
  const shot = optionalNumber(record.shot)
  const validShot = shot !== undefined && Number.isInteger(shot) && shot >= 1 ? shot : undefined
  return {
    code,
    message,
    ...(cleanText(record.action) ? { action: cleanText(record.action) } : {}),
    ...(validShot !== undefined ? { shot: validShot } : {}),
    ...(cleanText(record.cell) ? { cell: cleanText(record.cell) } : {}),
    ...(cleanText(record.column) ? { column: cleanText(record.column) } : {}),
    ...(cleanText(record.field) ? { field: cleanText(record.field) } : {}),
    ...(cleanText(record.level) ? { level: cleanText(record.level) } : {}),
  }
}

function normalizeScriptImport(value: unknown): ScriptImportReport | undefined {
  const record = asRecord(value)
  if (record.route !== 'template') return undefined
  const format = cleanText(record.format)
  const file = cleanText(record.file)
  const shots = optionalNumber(record.shots)
  if (!format || !file || shots === undefined || !Number.isInteger(shots) || shots < 0 || !Array.isArray(record.blocked) || !Array.isArray(record.warnings)) {
    return undefined
  }
  const normalizeIssues = (issues: unknown[]): ScriptImportIssue[] => issues
    .slice(0, 200)
    .map(normalizeScriptImportIssue)
    .filter((item): item is ScriptImportIssue => Boolean(item))
  const blocked = normalizeIssues(record.blocked)
  const warnings = normalizeIssues(record.warnings)
  if (record.blocked.length && !blocked.length) {
    blocked.push({ code: 'script_import_blocked', message: '导入被阻断，详见日志' })
  }
  return { route: 'template', format, file, shots, blocked, warnings }
}

function parseWorkflowEventLine(line: string): WorkflowEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith(WORKFLOW_EVENT_PREFIX)) return null

  try {
    const payload = asRecord(JSON.parse(trimmed.slice(WORKFLOW_EVENT_PREFIX.length)))
    const workflowStage = normalizeWorkflowStage(payload.workflowStage || payload.stage)
    const workflowStatus = normalizeWorkflowStatus(payload.workflowStatus || payload.status)
    const workflowPhase = cleanText(payload.workflowPhase || payload.phase)
    const workflowProgress = normalizeWorkflowProgress(
      payload.workflowProgress || payload.progress || {},
      workflowStage,
      workflowStatus,
      workflowPhase,
    )
    const workflowPlan = normalizeWorkflowPlan(payload.workflowPlan || payload.stages)
    const scriptImport = normalizeScriptImport(payload.scriptImport)
    if (!workflowStage && !workflowProgress && !workflowPlan && !scriptImport) return null
    return { workflowStage, workflowProgress, workflowPlan, ...(scriptImport ? { scriptImport } : {}) }
  } catch {
    return null
  }
}

function extractWorkflowEvent(text: string): ExtractedTaskOutput {
  const lines = text.replace(/\r/g, '').split('\n')
  let workflowStage = ''
  let workflowProgress: WorkflowProgressEvent | undefined
  let workflowPlan: string[] | undefined
  let scriptImport: ScriptImportReport | undefined
  const visibleLines: string[] = []

  for (const line of lines) {
    const parsed = parseWorkflowEventLine(line)
    if (parsed) {
      workflowStage = parsed.workflowStage || workflowStage
      workflowProgress = parsed.workflowProgress || workflowProgress
      workflowPlan = parsed.workflowPlan || workflowPlan
      scriptImport = parsed.scriptImport || scriptImport
    } else {
      visibleLines.push(line)
    }
  }

  return {
    text: visibleLines.join('\n'),
    workflowStage,
    workflowProgress,
    workflowPlan,
    ...(scriptImport ? { scriptImport } : {}),
  }
}

function portableBasename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) || filePath
}

function localPathWithoutNamespace(value: unknown): string {
  return String(value || '').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
}

function parseRunPath(text = ''): RunLocation | null {
  const normalized = text.replace(/\r/g, '')
  const line = normalized
    .split('\n')
    .find((item) => item.includes('运行目录:') || item.includes('杩愯鐩綍:'))
  const runPath = localPathWithoutNamespace(line?.replace(/^.*(?:运行目录:|杩愯鐩綍:)\s*/, '').trim())
  if (!runPath) return null

  return {
    runId: portableBasename(runPath),
    runPath,
  }
}

export {
  TaskOutputDecoder,
  extractWorkflowEvent,
  localPathWithoutNamespace,
  parseRunPath,
  parseWorkflowEventLine,
}

export type {
  ExtractedTaskOutput,
  RunLocation,
  WorkflowEvent,
  WorkflowProgressEvent,
}
