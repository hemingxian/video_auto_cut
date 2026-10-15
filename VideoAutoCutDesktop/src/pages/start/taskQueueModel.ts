import { basename } from '../../lib/path.ts'
import { scriptMaterialKey } from './scriptMaterialScope.ts'
import { normalizeMaterialBindings } from './shotPlan.ts'
import { normalizeMaterialSourceMode } from './materialSourceMode.ts'
import { normalizeOutputResolution } from './outputFormatModel.ts'
import type { RunningTask, TaskStatus } from '../../types/videoauto'
import type { ShotPlanSnapshot } from './shotPlanState'
import type {
  MaterialMode,
  MaterialSourceMode,
  ShotMaterialBinding,
  StartTaskOptions,
  TaskQueueItem,
  TaskQueueMode,
  TaskStage,
  TaskWorkflowPlan,
  TaskWorkflowProgress,
  TaskWorkflowStage,
} from './types'

interface StartTaskViewModelOptions {
  scriptCount: number
  logs: string[]
  running: boolean
  selectedQueueItem: TaskQueueItem | null
  shotPlan: ShotPlanSnapshot
  taskStage: TaskStage
  workflowPlan?: TaskWorkflowPlan
  workflowProgress?: TaskWorkflowProgress
  workflowStage?: TaskWorkflowStage
}

interface MaterialQueueOptions {
  materialMode: MaterialMode
  source: string
  preferLocalMaterials?: boolean
  materialSourceMode?: MaterialSourceMode
}

interface QueueFactoryOptions extends MaterialQueueOptions {
  createId?: (index: number) => string
  createdAt?: string
}

export function normalizeScriptPaths(value: string | string[]): string[] {
  const rawPaths = Array.isArray(value) ? value : value.split(/\r?\n/)
  const paths = rawPaths
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)

  return Array.from(new Set(paths))
}

export function stageLabel(stage: TaskQueueMode): string {
  return stage === 'plan' ? '整理分镜' : '生成视频'
}

export function runningMessage(stage: TaskQueueMode): string {
  return stage === 'plan'
    ? '正在整理脚本内容，稍后可以预览每一段分镜。'
    : '正在生成视频。'
}

export function isAutomaticallyPreparingQueueItem(item: TaskQueueItem): boolean {
  return item.mode === 'plan' && item.status === 'done' && item.autoContinueToGenerate === true
}

export function queueItemMessage(item: TaskQueueItem): string {
  if (isAutomaticallyPreparingQueueItem(item)) return '正在准备生成所需素材。'
  if (item.status === 'queued') return '任务已加入队列，前面的任务完成后会自动开始。'
  if (item.mode === 'plan' && item.previewReady) return '分镜已整理完成。'
  if (item.status === 'running') return runningMessage(item.mode)
  if (item.status === 'failed') return item.message || '任务执行失败，请查看日志。'
  return item.mode === 'plan' ? '分镜已整理完成。' : '视频任务已完成。'
}

export function taskFromStatus(status: TaskStatus): RunningTask | null {
  if (!status.running) return null
  return {
    pid: status.pid,
    command: status.command,
    runId: status.runId,
    runPath: status.runPath,
    ...(status.shotsJson ? { shotsJson: status.shotsJson } : {}),
    startedAt: status.startedAt,
    status: 'running',
  }
}

export function queueItemToTask(item: TaskQueueItem): RunningTask {
  return {
    pid: item.pid,
    command: item.command,
    code: item.code,
    runId: item.runId,
    runPath: item.runPath,
    ...(item.shotsJson ? { shotsJson: item.shotsJson } : {}),
    startedAt: item.startedAt,
    status: item.status === 'running' ? 'running' : item.status === 'done' ? 'done' : undefined,
  }
}

export function queueItemOptions(item: TaskQueueItem): StartTaskOptions {
  const materialSourceMode = normalizeMaterialSourceMode(item.materialSourceMode, item.preferLocalMaterials)
  const downloadNewMaterials = item.mode === 'plan' ? item.downloadNewMaterials
    : materialSourceMode === 'library-only' ? false
      : materialSourceMode === 'pexels-only' ? true : item.downloadNewMaterials
  return {
    materialSourceMode,
    ...(item.aspectRatio ? { aspectRatio: item.aspectRatio } : {}),
    ...(item.outputResolution ? { outputResolution: item.outputResolution } : {}),
    scriptPath: item.scriptPath,
    ...(item.voiceScriptBodyPath ? { voiceScriptBodyPath: item.voiceScriptBodyPath } : {}),
    projectName: item.projectName,
    shotsJson: item.shotsJson,
    source: downloadNewMaterials ? 'pexels' : undefined,
    downloadNewMaterials,
    planOnly: item.mode === 'plan',
    ...(item.resumeRunPath ? { resumeRunPath: item.resumeRunPath } : {}),
    ...(item.restartAll ? { restartAll: true } : {}),
    ...(item.materialManifestPath
      ? { materialManifestPath: item.materialManifestPath }
      : {}),
  }
}

export function queueItemKey(item: Pick<TaskQueueItem, 'scriptPath' | 'shotsJson'>): string {
  return item.scriptPath || item.shotsJson || ''
}

export function isOpenQueueItem(item: Pick<TaskQueueItem, 'status'>): boolean {
  return item.status === 'queued' || item.status === 'running' || item.status === 'paused'
}

export function createQueueId(index: number): string {
  return `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`
}

function projectNameFromScriptPath(scriptPath: string): string {
  const fileName = basename(scriptPath, '未命名任务')
  return fileName.replace(/\.[^.]+$/, '') || fileName
}

function materialQueueFields({ materialMode, preferLocalMaterials, materialSourceMode }: MaterialQueueOptions, planOnly = false) {
  const resolvedSourceMode = normalizeMaterialSourceMode(materialSourceMode, preferLocalMaterials)
  const downloadNewMaterials = planOnly ? materialMode === 'download'
    : resolvedSourceMode === 'library-only' ? false
      : resolvedSourceMode === 'pexels-only' ? true : materialMode === 'download'
  return {
    source: downloadNewMaterials ? 'pexels' : undefined,
    downloadNewMaterials,
    materialSourceMode: resolvedSourceMode,
    preferLocalMaterials: resolvedSourceMode !== 'pexels-only',
  }
}

export function createScriptQueueItems({
  paths,
  mode,
  createId = createQueueId,
  createdAt = new Date().toISOString(),
  materialMode,
  source,
  autoContinueToGenerate = false,
  preferLocalMaterials = true,
  materialSourceMode,
  scriptMaterialBindings = {},
  aspectRatio = '16:9',
  outputResolution = '1080p',
  voiceScriptBodyPaths = {},
  reservedTaskIds = {},
}: QueueFactoryOptions & {
  paths: string[]
  mode: TaskQueueMode
  autoContinueToGenerate?: boolean
  scriptMaterialBindings?: Record<string, ShotMaterialBinding[]>
  aspectRatio?: string
  outputResolution?: string
  voiceScriptBodyPaths?: Record<string, string>
  reservedTaskIds?: Record<string, string>
}): TaskQueueItem[] {
  return paths.map((scriptPath, index) => ({
    id: reservedTaskIds[scriptMaterialKey(scriptPath)] || createId(index),
    mode,
    title: basename(scriptPath, '未命名任务'),
    status: 'queued',
    createdAt,
    scriptPath,
    ...(voiceScriptBodyPaths[scriptMaterialKey(scriptPath)] ? {
      voiceScriptBodyPath: voiceScriptBodyPaths[scriptMaterialKey(scriptPath)],
      voiceScript: true,
    } : {}),
    aspectRatio,
    outputResolution: normalizeOutputResolution(aspectRatio, outputResolution),
    scriptMaterialBindings: normalizeMaterialSourceMode(materialSourceMode, preferLocalMaterials) === 'pexels-only'
      ? [] : normalizeMaterialBindings(scriptMaterialBindings[scriptMaterialKey(scriptPath)]),
    projectName: projectNameFromScriptPath(scriptPath),
    autoContinueToGenerate: mode === 'plan' && autoContinueToGenerate,
    workflowStage: mode === 'generate' ? 'script' : undefined,
    workflowPlan: mode === 'plan' ? ['script', 'plan'] : undefined,
    ...materialQueueFields({ materialMode, source, preferLocalMaterials, materialSourceMode }, mode === 'plan'),
    logs: [],
  }))
}

export function findQueueItemForPlan(
  items: TaskQueueItem[],
  selectedId: string | null,
  shotsJson: string,
  currentRun: ShotPlanSnapshot['currentRun'],
): TaskQueueItem | null {
  const matchesPlan = (item: TaskQueueItem) => {
    if (item.shotsJson && item.shotsJson === shotsJson) return true
    if (currentRun?.path && item.runPath === currentRun.path) return true
    return Boolean(currentRun?.id && item.runId === currentRun.id)
  }
  const selectedItem = selectedId ? items.find((item) => item.id === selectedId) : undefined
  if (selectedItem && matchesPlan(selectedItem)) return selectedItem
  return items.find(matchesPlan) || null
}

export function prepareQueueItemForGeneration(
  item: TaskQueueItem,
  {
    shotsJson,
    workflowPlan,
    materialMode,
    source,
    materialManifestPath,
    preferLocalMaterials = item.preferLocalMaterials !== false,
    materialSourceMode = item.materialSourceMode,
  }: MaterialQueueOptions & {
    shotsJson?: string
    workflowPlan: TaskWorkflowPlan
    materialManifestPath?: string
  },
): TaskQueueItem {
  return {
    ...item,
    mode: 'generate',
    status: 'queued',
    shotsJson: shotsJson || item.shotsJson,
    materialManifestPath,
    workflowStage: 'query',
    workflowPlan,
    workflowProgress: undefined,
    ...materialQueueFields({ materialMode, source, preferLocalMaterials, materialSourceMode }),
    ...(normalizeMaterialSourceMode(materialSourceMode, preferLocalMaterials) === 'pexels-only'
      ? { scriptMaterialBindings: [] } : {}),
    pid: undefined,
    command: undefined,
    code: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    message: '已加入生成队列。',
  }
}

export function createShotsQueueItem({
  shotsJson,
  currentRun,
  workflowPlan,
  createId = createQueueId,
  createdAt = new Date().toISOString(),
  materialMode,
  source,
  materialManifestPath,
  preferLocalMaterials = true,
  materialSourceMode,
}: QueueFactoryOptions & {
  shotsJson: string
  currentRun: ShotPlanSnapshot['currentRun']
  workflowPlan: TaskWorkflowPlan
  materialManifestPath?: string
}): TaskQueueItem {
  return {
    id: createId(0),
    mode: 'generate',
    title: currentRun?.projectName || currentRun?.id
      ? `${currentRun.projectName || currentRun.id} 生成视频`
      : basename(shotsJson, '未命名任务'),
    status: 'queued',
    createdAt,
    shotsJson,
    projectName: currentRun?.projectName || basename(shotsJson, '未命名任务'),
    ...(currentRun?.outputFormat ? {
      aspectRatio: currentRun.outputFormat.aspectRatio,
      outputResolution: currentRun.outputFormat.outputResolution,
    } : {}),
    materialManifestPath,
    workflowStage: 'query',
    workflowPlan,
    ...materialQueueFields({ materialMode, source, preferLocalMaterials, materialSourceMode }),
    logs: [],
  }
}

export function samePathList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => item === right[index])
}

export function buildStartTaskViewModel({
  scriptCount,
  logs,
  running,
  selectedQueueItem,
  shotPlan,
  taskStage,
  workflowPlan,
  workflowProgress,
  workflowStage,
}: StartTaskViewModelOptions) {
  const hasScript = scriptCount > 0
  const hasVisiblePlan = Boolean(shotPlan.currentRun?.shotsPath && shotPlan.shots.length)
  const selectedPlanReady = Boolean(selectedQueueItem?.mode === 'plan' && selectedQueueItem.previewReady)
  const finalVideoReady = Boolean(shotPlan.currentRun?.finalVideo)
  const selectedGenerationFailed = Boolean(
    selectedQueueItem?.mode === 'generate' && selectedQueueItem.status === 'failed',
  )
  const globalWorkflowFailed = Boolean(!selectedQueueItem && workflowProgress?.status === 'failed')
  const globalGenerationFailed = globalWorkflowFailed && hasVisiblePlan
  const selectedCancelled = selectedQueueItem?.workflowProgress?.phase === 'cancelled'
  const globalCancelled = globalWorkflowFailed && workflowProgress?.phase === 'cancelled'
  const selectedFailureLabel = selectedCancelled
    ? '已停止'
    : selectedQueueItem?.workflowStage === 'bgm'
      ? '背景音乐失败'
      : '执行失败'
  const globalFailureLabel = globalCancelled
    ? '已停止'
    : workflowStage === 'bgm'
      ? '背景音乐失败'
      : '执行失败'
  const viewRunning = selectedQueueItem
    ? selectedQueueItem.status === 'running' && !selectedPlanReady
    : running
  const activeMode = selectedQueueItem?.mode || taskStage
  const canRetryCurrentPlan = hasVisiblePlan && (selectedGenerationFailed || globalGenerationFailed)
  const canContinueCurrentPlan = hasVisiblePlan && (canRetryCurrentPlan || !finalVideoReady || shotPlan.dirty)
  const generateButtonText = viewRunning
    ? activeMode === 'plan' ? '正在整理分镜' : '生成视频中'
    : canRetryCurrentPlan
    ? '从失败步骤继续'
    : shotPlan.dirty
      ? '保存并生成'
      : finalVideoReady && shotPlan.planOrigin === 'current' && hasVisiblePlan
        ? '视频已生成'
        : shotPlan.planOrigin === 'current' && hasVisiblePlan
          ? '继续生成视频'
          : scriptCount > 1
            ? '批量生成视频'
            : '直接生成视频'
  const taskStatusLabel = selectedQueueItem
    ? selectedQueueItem.status === 'queued'
      ? '排队中'
      : selectedPlanReady
        ? '分镜已就绪'
        : selectedQueueItem.status === 'running'
          ? `${stageLabel(selectedQueueItem.mode)}中`
          : selectedQueueItem.status === 'failed'
            ? selectedFailureLabel
            : selectedQueueItem.mode === 'plan'
              ? '分镜已就绪'
              : '任务已完成'
    : globalWorkflowFailed
      ? globalFailureLabel
      : running
        ? taskStage === 'plan'
          ? hasVisiblePlan ? '分镜已整理' : '整理分镜中'
          : '生成视频中'
        : hasVisiblePlan ? '当前方案' : '待开始'

  return {
    hasScript,
    scriptCount,
    hasVisiblePlan,
    canGenerate: !viewRunning && (hasScript || canContinueCurrentPlan),
    generateButtonText,
    taskStatusLabel,
    viewRunning,
    viewTaskStage: selectedQueueItem?.mode || taskStage,
    viewWorkflowStage: selectedQueueItem?.workflowStage || workflowStage,
    viewWorkflowPlan: selectedQueueItem?.workflowPlan || workflowPlan,
    viewWorkflowProgress: selectedQueueItem?.workflowProgress || workflowProgress,
    viewWorkflowFailed: selectedQueueItem ? selectedQueueItem.status === 'failed' : globalWorkflowFailed,
    viewLogs: selectedQueueItem?.logs || logs,
  }
}
