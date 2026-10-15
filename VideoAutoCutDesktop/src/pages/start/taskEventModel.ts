import type { TaskEvent } from '../../types/videoauto'
import type { ShotPlanSnapshot } from './shotPlanState'
import type {
  TaskQueueItem,
  TaskQueueMode,
  TaskWorkflowPlan,
  TaskWorkflowProgress,
  TaskWorkflowStage,
  TaskWorkflowStatus,
} from './types'

const WORKFLOW_STAGES = new Set<TaskWorkflowStage>([
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
const WORKFLOW_PLAN_STAGES = new Set<TaskWorkflowPlan[number]>([
  'script',
  'plan',
  'query',
  'voice',
  'material',
  'clip',
  'compose',
  'bgm',
])
const WORKFLOW_STATUSES = new Set<TaskWorkflowStatus>(['pending', 'running', 'completed', 'failed'])
const MATERIAL_PREVIEW_REFRESH_STAGES = new Set<TaskWorkflowStage>(['material', 'clip', 'compose', 'bgm', 'done'])

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function hasText(value: unknown): boolean {
  return value !== null && value !== undefined && Boolean(String(value).trim())
}

function textHasBgmIntent(text: string): boolean {
  const lowered = text.toLowerCase()
  const hasBgm = lowered.includes('bgm')
    || lowered.includes('background music')
    || text.includes('背景音乐')
    || text.includes('配乐')
  if (!hasBgm) return false

  return !(
    text.includes('不要背景音乐')
    || text.includes('不需要背景音乐')
    || text.includes('无背景音乐')
    || text.includes('不要配乐')
    || text.includes('不需要配乐')
    || text.includes('无配乐')
    || lowered.includes('no bgm')
    || lowered.includes('without bgm')
    || lowered.includes('no background music')
    || lowered.includes('without background music')
  )
}

function valueHasBgmIntent(value: unknown): boolean {
  if (typeof value === 'string') return textHasBgmIntent(value)
  if (Array.isArray(value)) return value.some(valueHasBgmIntent)
  if (!value || typeof value !== 'object') return false

  return Object.entries(value).some(([key, item]) => textHasBgmIntent(key) || valueHasBgmIntent(item))
}

function planRootHasBgmIntent(root?: ShotPlanSnapshot['planRoot']): boolean {
  const backgroundMusic = root?.background_music
  if (backgroundMusic && typeof backgroundMusic === 'object' && !Array.isArray(backgroundMusic)) {
    const bgm = backgroundMusic as Record<string, unknown>
    if (bgm.enabled === false) return false
    if (bgm.enabled === true) return true
    if (hasText(bgm.description) || hasText(bgm.query)) return true
  }

  return valueHasBgmIntent(root?.content_blocks)
    || valueHasBgmIntent(root?.extra_requirements)
    || valueHasBgmIntent(root?.shots)
}

export function inferTaskStageFromCommand(command = ''): TaskQueueMode {
  return command.includes('--plan-only') ? 'plan' : 'generate'
}

export function normalizeWorkflowStage(value: unknown): TaskWorkflowStage | undefined {
  const stage = String(value || '').trim() as TaskWorkflowStage
  return WORKFLOW_STAGES.has(stage) ? stage : undefined
}

export function normalizeWorkflowProgress(
  value: unknown,
  fallbackStage?: TaskWorkflowStage,
): TaskWorkflowProgress | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const record = value as Record<string, unknown>
  const stage = normalizeWorkflowStage(record.stage) || fallbackStage
  const rawStatus = String(record.status || '').trim() as TaskWorkflowStatus
  const status = WORKFLOW_STATUSES.has(rawStatus) ? rawStatus : undefined
  const phase = String(record.phase || '').trim()
  const current = optionalNumber(record.current)
  const total = optionalNumber(record.total)
  const label = String(record.label || '').trim()

  if (!stage && !status && !phase && current === undefined && total === undefined && !label) return undefined

  return {
    ...(stage ? { stage } : {}),
    ...(status ? { status } : {}),
    ...(phase ? { phase } : {}),
    ...(current !== undefined ? { current } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(label ? { label } : {}),
  }
}

export function normalizeWorkflowPlan(value: unknown): TaskWorkflowPlan | undefined {
  const rawStages = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { stages?: unknown }).stages)
      ? (value as { stages: unknown[] }).stages
      : []
  if (!rawStages.length) return undefined

  const stages = rawStages
    .map(normalizeWorkflowStage)
    .filter((stage): stage is TaskWorkflowPlan[number] => Boolean(
      stage && WORKFLOW_PLAN_STAGES.has(stage as TaskWorkflowPlan[number]),
    ))
  const uniqueStages = Array.from(new Set(stages))
  return uniqueStages.length ? uniqueStages : undefined
}

export function initialWorkflowStage(item: Pick<TaskQueueItem, 'mode' | 'shotsJson'>): TaskWorkflowStage {
  if (item.mode === 'plan') return 'script'
  return item.shotsJson ? 'query' : 'script'
}

export function shouldRefreshPlanPreview(event: Pick<TaskEvent, 'text'>): boolean {
  const text = (event.text || '').toLowerCase()
  return text.includes('shots.json')
    || text.includes('分镜')
    || text.includes('优化搜索词')
    || text.includes('download_query')
}

export function shouldRefreshMaterialPreview(
  event: Pick<TaskEvent, 'text' | 'workflowStage'>,
  currentStage?: TaskWorkflowStage,
): boolean {
  const stage = normalizeWorkflowStage(event.workflowStage) || currentStage
  if (stage && MATERIAL_PREVIEW_REFRESH_STAGES.has(stage)) return true

  const text = (event.text || '').toLowerCase()
  return text.includes('raw')
    || text.includes('clips')
    || text.includes('final_clips')
    || text.includes('候选片段')
    || text.includes('剪辑片段')
    || text.includes('兜底素材')
    || text.includes('下载素材')
    || text.includes('云端素材')
    || text.includes('下载到视频')
    || text.includes('素材已生成')
}

export function inferWorkflowPlanFromShots(
  shots: ShotPlanSnapshot['shots'],
  planRoot?: ShotPlanSnapshot['planRoot'],
): TaskWorkflowPlan {
  const hasVoice = shots.some((shot) => shot.voiceover !== false && hasText(shot.voice_text))
  const hasBgm = planRootHasBgmIntent(planRoot)

  return [
    'script',
    'plan',
    'query',
    'material',
    ...(hasVoice ? ['voice' as const] : []),
    'clip',
    'compose',
    ...(hasBgm ? ['bgm' as const] : []),
  ]
}
