import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { RunningTask, RunItem } from '../../types/videoauto'
import type { RunActivityTarget } from '../runs/runHistoryModel'
import { normalizeOutputResolution } from './outputFormatModel'
import { prepareResumeGeneration } from './resumeGeneration'
import { isCompletedPlanOnlyRun } from './historyRestore'
import { useTimeoutRegistry } from '../../hooks/useTimeoutRegistry'
import { useMountedRef } from '../../hooks/useMountedRef'
import { activeSessionApi } from '../../lib/activeSessionApi'
import { useToast } from '../../hooks/useToast'
import { emptyShotPlanSnapshot, INITIAL_SHOTS_MESSAGE, loadLatestShotPlan, loadTaskShotPlan, loadShotPlanFromRun, type ShotPlanSnapshot } from './shotPlanState'
import { taskDisplayMeta } from './taskDisplay'
import {
  inferTaskStageFromCommand,
  inferWorkflowPlanFromShots,
  initialWorkflowStage,
} from './taskEventModel'
import { fallbackWorkflowStageForCommand } from './taskEventReducer'
import {
  selectionsToMaterialBindings,
  type ShotMaterialSelection,
} from './shotMaterialSelectionModel'
import {
  buildStartTaskViewModel,
  createScriptQueueItems,
  createShotsQueueItem,
  findQueueItemForPlan,
  isAutomaticallyPreparingQueueItem,
  isOpenQueueItem,
  normalizeScriptPaths,
  queueItemKey,
  queueItemMessage,
  queueItemOptions,
  queueItemToTask,
  prepareQueueItemForGeneration,
  runningMessage,
  samePathList,
  taskFromStatus,
} from './taskQueueModel'
import type {
  EditableShotField,
  MaterialMode,
  PlanOrigin,
  RestorableScriptField,
  ShotDraft,
  ShotScriptMetaField,
  TaskQueueItem,
  TaskStage,
  TaskWorkflowPlan,
  TaskWorkflowProgress,
  TaskWorkflowStage,
} from './types'
import { useTaskEventSubscription } from './useTaskEventSubscription'
import {
  acknowledgeShotWarning,
  confirmShotReview,
  normalizeShots,
  pendingReviewTotal,
  bodyReviewGate,
  resetAutomaticMaterialResolution,
  restoreScriptValue,
  shotsWithoutMaterialSelection,
  updateShotContent,
  updateShotScriptMeta,
} from './shotPlan'
import { normalizeMaterialSourceMode, type MaterialSourceMode } from './materialSourceMode'
import {
  applyScriptMaterialScope,
  retainScriptMaterialSelections,
  scriptMaterialBindingsByPath,
  scriptMaterialKey,
  type ScriptMaterialSelections,
} from './scriptMaterialScope'

function materialSourceSummary(mode: MaterialSourceMode, matched: number, fallback: number) {
  if (mode === 'pexels-only') return `仅 Pexels：${fallback} 个分镜从 Pexels 下载。`
  if (mode === 'library-only') return `仅素材库：匹配 ${matched} 个分镜，不从 Pexels 下载。`
  return `素材库 → Pexels：命中 ${matched} 个分镜，${fallback} 个分镜从 Pexels 下载。`
}

export function useStartTaskController() {
  const mountedRef = useMountedRef()
  const api = useMemo(() => activeSessionApi(window.videoAutoCut, () => mountedRef.current), [mountedRef])
  const [scriptPaths, setScriptPaths] = useState<string[]>([])
  const [scriptMaterialSelections, setScriptMaterialSelections] = useState<ScriptMaterialSelections>({})
  const [voiceScriptModes, setVoiceScriptModes] = useState<Record<string, boolean>>({})
  const [voiceScriptBodyPaths, setVoiceScriptBodyPaths] = useState<Record<string, string>>({})
  const [voiceScriptTaskIds, setVoiceScriptTaskIds] = useState<Record<string, string>>({})
  const [aspectRatio, setAspectRatio] = useState('16:9')
  const [outputResolution, setOutputResolution] = useState('1080p')
  const [source, setSource] = useState('pexels')
  const [materialSourceMode, setMaterialSourceMode] = useState<MaterialSourceMode>('library-first')
  const [running, setRunning] = useState(false)
  const [currentTask, setCurrentTask] = useState<RunningTask | null>(null)
  const [taskStage, setTaskStage] = useState<TaskStage>('idle')
  const [workflowStage, setWorkflowStage] = useState<TaskWorkflowStage | undefined>(undefined)
  const [workflowPlan, setWorkflowPlan] = useState<TaskWorkflowPlan | undefined>(undefined)
  const [workflowProgress, setWorkflowProgress] = useState<TaskWorkflowProgress | undefined>(undefined)
  const [logs, setLogs] = useState<string[]>([])
  const [queueItems, setQueueItems] = useState<TaskQueueItem[]>([])
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [shotDrawerOpen, setShotDrawerOpen] = useState(false)
  const [shotPlan, setShotPlan] = useState<ShotPlanSnapshot>(() => emptyShotPlanSnapshot(INITIAL_SHOTS_MESSAGE))
  const [shotsMessage, setShotsMessage] = useState(INITIAL_SHOTS_MESSAGE)
  const [draftSaveStatus, setDraftSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [draftSavedAt, setDraftSavedAt] = useState('')
  const taskStageRef = useRef<TaskStage>('idle')
  const workflowStageRef = useRef<TaskWorkflowStage | undefined>(undefined)
  const workflowPlanRef = useRef<TaskWorkflowPlan | undefined>(undefined)
  const workflowProgressRef = useRef<TaskWorkflowProgress | undefined>(undefined)
  const currentTaskRef = useRef<RunningTask | null>(null)
  const runningRef = useRef(false)
  const queueItemsRef = useRef<TaskQueueItem[]>([])
  const selectedQueueIdRef = useRef<string | null>(null)
  const activeQueueItemIdRef = useRef<string | null>(null)
  const queueStartingRef = useRef(false)
  const followRunningQueueRef = useRef(true)
  const startNextQueueItemRef = useRef<() => void>(() => undefined)
  const planReadyToastRunRef = useRef('')
  const materialPreviewRefreshTimerRef = useRef<number | null>(null)
  const draftRevisionsRef = useRef(new Map<string, number>())
  const draftSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const generationPreparingRef = useRef(false)
  const queuePausedRef = useRef(false)
  const [queuePaused, setQueuePaused] = useState(false)
  const [generationPreparing, setGenerationPreparing] = useState(false)
  const [preparingRunTarget, setPreparingRunTarget] = useState<RunActivityTarget | null>(null)
  const materialSourceModeRef = useRef<MaterialSourceMode>('library-first')
  const { clearTimeout, scheduleTimeout } = useTimeoutRegistry()
  const { toast, toastTone, showToast } = useToast(2200)

  function queueDraftSave<T>(operation: () => Promise<T>): Promise<T> {
    const result = draftSaveQueueRef.current.catch(() => undefined).then(operation)
    draftSaveQueueRef.current = result.then(() => undefined, () => undefined)
    return result
  }

  const materialMode: MaterialMode = shotPlan.shots.length && shotPlan.shots.every((shot) => !shot.download_material)
    ? 'library' : 'download'
  const scripts = useMemo(() => scriptPaths.join('\n'), [scriptPaths])
  const selectedQueueItem = useMemo(
    () => queueItems.find((item) => item.id === selectedQueueId) || null,
    [queueItems, selectedQueueId],
  )
  const runningQueueItem = useMemo(
    () => queueItems.find((item) => item.status === 'running') || null,
    [queueItems],
  )
  const selectedTaskLabel = selectedQueueItem?.title || shotPlan.currentRun?.projectName || (currentTask ? taskDisplayMeta(currentTask).label : '')
  const activeTaskLabel = selectedQueueItem?.title || runningQueueItem?.title || selectedTaskLabel

  useEffect(() => {
    currentTaskRef.current = currentTask
  }, [currentTask])

  useEffect(() => {
    runningRef.current = running
  }, [running])

  useEffect(() => {
    queueItemsRef.current = queueItems
  }, [queueItems])

  useEffect(() => {
    workflowStageRef.current = workflowStage
  }, [workflowStage])

  useEffect(() => {
    workflowPlanRef.current = workflowPlan
  }, [workflowPlan])

  useEffect(() => {
    workflowProgressRef.current = workflowProgress
  }, [workflowProgress])

  useEffect(() => {
    selectedQueueIdRef.current = selectedQueueId
  }, [selectedQueueId])

  const applyShotPlan = useCallback((next: ShotPlanSnapshot) => {
    setShotPlan(next)
    setShotsMessage(next.message)
  }, [])

  const resetShotPlan = useCallback((message: string) => {
    applyShotPlan(emptyShotPlanSnapshot(message))
  }, [applyShotPlan])

  const resetInputContext = useCallback(() => {
    selectedQueueIdRef.current = null
    setSelectedQueueId(null)
    followRunningQueueRef.current = true
    planReadyToastRunRef.current = ''
    resetShotPlan(INITIAL_SHOTS_MESSAGE)

    if (runningRef.current) return

    currentTaskRef.current = null
    taskStageRef.current = 'idle'
    workflowStageRef.current = undefined
    workflowPlanRef.current = undefined
    workflowProgressRef.current = undefined
    setCurrentTask(null)
    setTaskStage('idle')
    setWorkflowStage(undefined)
    setWorkflowPlan(undefined)
    setWorkflowProgress(undefined)
  }, [resetShotPlan])

  const notifyPlanReady = useCallback((next: ShotPlanSnapshot) => {
    if (taskStageRef.current !== 'plan' || !next.shots.length) return

    const runKey = next.currentRun?.id || next.currentRun?.shotsPath || 'current'
    if (planReadyToastRunRef.current === runKey) return

    planReadyToastRunRef.current = runKey
    showToast('分镜已整理好，可以继续生成视频。')
  }, [showToast])

  const loadAndApplyShotPlan = useCallback(async (origin: PlanOrigin = 'current', task: RunningTask | null = currentTaskRef.current, knownRun?: RunItem) => {
    let next = knownRun ? await loadShotPlanFromRun(knownRun, origin) : task ? await loadTaskShotPlan(task, origin) : await loadLatestShotPlan(origin)
    let acceptedDraftMode: unknown
    const taskId = next.currentRun?.id
    if (taskId) {
      try {
        const draft = await api.loadTaskDraft<Record<string, unknown>>(taskId)
        if (draft) draftRevisionsRef.current.set(taskId, draft.revision)
        if (draft?.snapshot && typeof draft.snapshot === 'object'
          && (!next.currentRun?.shotsModifiedAt || Date.parse(draft.updatedAt) >= next.currentRun.shotsModifiedAt)) {
          const draftShots = normalizeShots(draft.snapshot.shots)
          if (draftShots.length) {
            acceptedDraftMode = draft.snapshot.material_source_mode
            next = {
              ...next,
              planRoot: draft.snapshot,
              shotTopic: String(draft.snapshot.topic || ''),
              shots: draftShots,
              dirty: false,
            }
          }
          draftRevisionsRef.current.set(taskId, draft.revision)
          setDraftSaveStatus('saved')
          setDraftSavedAt(new Date(draft.updatedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }))
        }
      } catch (error) {
        console.error('[VideoAutoCut] load local task draft failed', error)
      }
    }
    const queueItem = findQueueItemForPlan(queueItemsRef.current, selectedQueueIdRef.current, next.currentRun?.shotsPath || '', next.currentRun)
    let restoredMode = next.planRoot.material_source_mode
    if (next.currentRun?.path) {
      try {
        const stored = JSON.parse(await api.readFile(`${next.currentRun.path}/material-source-mode.json`))
        restoredMode = stored.material_source_mode || restoredMode
      } catch { /* Older runs can still restore their draft or queue setting. */ }
    }
    const nextSourceMode = normalizeMaterialSourceMode(
      acceptedDraftMode || queueItem?.materialSourceMode || restoredMode,
      queueItem?.preferLocalMaterials,
    )
    materialSourceModeRef.current = nextSourceMode
    setMaterialSourceMode(nextSourceMode)
    const scopedRoot = nextSourceMode === 'pexels-only' ? next.planRoot
      : applyScriptMaterialScope(next.planRoot, queueItem?.scriptMaterialBindings)
    if (scopedRoot !== next.planRoot) {
      next = { ...next, planRoot: scopedRoot, shots: normalizeShots(scopedRoot.shots), dirty: true }
    }
    applyShotPlan(next)
    notifyPlanReady(next)
    return next
  }, [api, applyShotPlan, notifyPlanReady])

  const scheduleMaterialPreviewRefresh = useCallback((task: RunningTask, queueId?: string | null) => {
    if (queueId && selectedQueueIdRef.current !== queueId) return
    if (materialPreviewRefreshTimerRef.current !== null) {
      clearTimeout(materialPreviewRefreshTimerRef.current)
    }

    materialPreviewRefreshTimerRef.current = scheduleTimeout(() => {
      materialPreviewRefreshTimerRef.current = null
      loadAndApplyShotPlan('current', task).catch(() => undefined)
    }, 900)
  }, [clearTimeout, loadAndApplyShotPlan, scheduleTimeout])

  const updateQueueItem = useCallback((id: string, updater: Partial<TaskQueueItem> | ((item: TaskQueueItem) => TaskQueueItem)) => {
    const next = queueItemsRef.current.map((item) => {
      if (item.id !== id) return item
      return typeof updater === 'function' ? updater(item) : { ...item, ...updater }
    })
    queueItemsRef.current = next
    setQueueItems(next)
  }, [])

  const applyWorkflowStage = useCallback((stage: TaskWorkflowStage | undefined, progress?: TaskWorkflowProgress, queueId = activeQueueItemIdRef.current) => {
    workflowStageRef.current = stage
    workflowProgressRef.current = progress
    setWorkflowStage(stage)
    setWorkflowProgress(progress)
    if (queueId) updateQueueItem(queueId, { workflowStage: stage, workflowProgress: progress })
  }, [updateQueueItem])

  const applyWorkflowProgress = useCallback((progress: TaskWorkflowProgress | undefined, queueId = activeQueueItemIdRef.current) => {
    workflowProgressRef.current = progress
    setWorkflowProgress(progress)
    if (queueId) updateQueueItem(queueId, { workflowProgress: progress })
  }, [updateQueueItem])

  const applyWorkflowPlan = useCallback((plan: TaskWorkflowPlan | undefined, queueId = activeQueueItemIdRef.current) => {
    workflowPlanRef.current = plan
    setWorkflowPlan(plan)
    if (queueId) updateQueueItem(queueId, { workflowPlan: plan })
  }, [updateQueueItem])

  const markQueueItemFailed = useCallback((queueId: string, message: string) => {
    activeQueueItemIdRef.current = null
    currentTaskRef.current = null
    runningRef.current = false
    taskStageRef.current = 'idle'
    workflowStageRef.current = undefined
    workflowPlanRef.current = undefined
    workflowProgressRef.current = undefined
    setCurrentTask(null)
    setRunning(false)
    setTaskStage('idle')
    setWorkflowStage(undefined)
    setWorkflowPlan(undefined)
    setWorkflowProgress(undefined)
    updateQueueItem(queueId, (item) => ({
      ...item,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      message,
      logs: item.logs.concat(`\n${message}\n`),
    }))
    showToast(message)
    scheduleTimeout(() => startNextQueueItemRef.current(), 300)
  }, [scheduleTimeout, showToast, updateQueueItem])

  const selectQueueItemRecord = useCallback((item: TaskQueueItem, manual = false) => {
    if (manual) followRunningQueueRef.current = false
    selectedQueueIdRef.current = item.id
    setSelectedQueueId(item.id)
    materialSourceModeRef.current = normalizeMaterialSourceMode(item.materialSourceMode, item.preferLocalMaterials)
    setMaterialSourceMode(materialSourceModeRef.current)
    workflowStageRef.current = item.workflowStage
    workflowPlanRef.current = item.workflowPlan
    workflowProgressRef.current = item.workflowProgress
    setWorkflowStage(item.workflowStage)
    setWorkflowPlan(item.workflowPlan)
    setWorkflowProgress(item.workflowProgress)

    if (item.runId || item.runPath) {
      loadAndApplyShotPlan('current', queueItemToTask(item)).catch(() => undefined)
      return
    }

    resetShotPlan(queueItemMessage(item))
  }, [loadAndApplyShotPlan, resetShotPlan])

  const selectQueueItem = useCallback((id: string) => {
    const item = queueItemsRef.current.find((current) => current.id === id)
    if (item) selectQueueItemRecord(item, true)
  }, [selectQueueItemRecord])

  const blockPendingBodyReview = useCallback((shots: ShotDraft[], item?: TaskQueueItem, plan?: ShotPlanSnapshot): boolean => {
    const gate = bodyReviewGate(shots)
    if (!gate.blocked) return false
    if (item) updateQueueItem(item.id, { status: 'paused', autoContinueToGenerate: false, message: gate.message })
    if (!item || selectedQueueIdRef.current === item.id) {
      if (plan) applyShotPlan({ ...plan, shots, dirty: false })
      setShotDrawerOpen(true)
      scheduleTimeout(() => document.getElementById(`shot-editor-${gate.firstIndex}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0)
    }
    showToast(gate.message)
    return true
  }, [applyShotPlan, scheduleTimeout, showToast, updateQueueItem])

  const confirmPendingProductionReview = useCallback((shots: ShotDraft[], item: TaskQueueItem): boolean => {
    const pendingReviews = pendingReviewTotal(shots)
    if (!pendingReviews || item.reviewWarningsConfirmed) return true
    if (!window.confirm(`还有 ${pendingReviews} 条提醒未确认，仍然生成？`)) {
      updateQueueItem(item.id, { status: 'paused', autoContinueToGenerate: false, message: '制作字段提醒尚未确认。' })
      return false
    }
    updateQueueItem(item.id, { reviewWarningsConfirmed: true })
    return true
  }, [updateQueueItem])

  const startNextQueueItem = useCallback(async () => {
    if (!mountedRef.current || queueStartingRef.current || queuePausedRef.current || generationPreparingRef.current || runningRef.current || queueItemsRef.current.some(isAutomaticallyPreparingQueueItem)) return

    const nextItem = queueItemsRef.current.find((item) => item.status === 'queued')
    if (!nextItem) return
    queueStartingRef.current = true
    try {

    if (nextItem.mode === 'generate' && (nextItem.runPath || nextItem.runId)) {
      const latest = await loadTaskShotPlan(queueItemToTask(nextItem), 'current')
      if (blockPendingBodyReview(latest.shots, nextItem, latest)) return
      if (!confirmPendingProductionReview(latest.shots, nextItem)) return
    }

    const startedAt = new Date().toISOString()
    const runningItem: TaskQueueItem = {
      ...nextItem,
      status: 'running',
      startedAt,
      workflowStage: nextItem.workflowStage || initialWorkflowStage(nextItem),
      workflowPlan: nextItem.workflowPlan,
      workflowProgress: undefined,
      message: runningMessage(nextItem.mode),
    }

    activeQueueItemIdRef.current = nextItem.id
    runningRef.current = true
    taskStageRef.current = nextItem.mode
    workflowStageRef.current = runningItem.workflowStage
    workflowPlanRef.current = runningItem.workflowPlan
    workflowProgressRef.current = undefined
    currentTaskRef.current = queueItemToTask(runningItem)
    setCurrentTask(queueItemToTask(runningItem))
    setRunning(true)
    setTaskStage(nextItem.mode)
    setWorkflowStage(runningItem.workflowStage)
    setWorkflowPlan(runningItem.workflowPlan)
    setWorkflowProgress(undefined)
    if (nextItem.mode === 'plan') planReadyToastRunRef.current = ''
    updateQueueItem(nextItem.id, () => runningItem)
    if (followRunningQueueRef.current || !selectedQueueIdRef.current) selectQueueItemRecord(runningItem, false)

    try {
      const result = await api.startTask(queueItemOptions(runningItem))
      if (result.ok) {
        const launchedTask: RunningTask = {
          ...(currentTaskRef.current || {}),
          pid: result.pid || currentTaskRef.current?.pid,
          command: result.command || currentTaskRef.current?.command,
          runId: result.runId || currentTaskRef.current?.runId,
          runPath: result.runPath || currentTaskRef.current?.runPath,
          startedAt: result.startedAt || startedAt,
          status: 'running',
        }
        currentTaskRef.current = launchedTask
        setCurrentTask(launchedTask)
        updateQueueItem(nextItem.id, (item) => ({
          ...item,
          pid: launchedTask.pid,
          command: launchedTask.command,
          runId: launchedTask.runId,
          runPath: launchedTask.runPath,
          startedAt: launchedTask.startedAt,
        }))
        return
      }

      const message = result.message || '启动任务失败'
      if (result.running) {
        const task = taskFromStatus({
          running: true,
          pid: result.pid,
          command: result.command,
          runId: result.runId,
          runPath: result.runPath,
          startedAt: result.startedAt,
        })
        activeQueueItemIdRef.current = null
        currentTaskRef.current = task
        taskStageRef.current = inferTaskStageFromCommand(task?.command)
        runningRef.current = true
        setCurrentTask(task)
        setRunning(true)
        setTaskStage(taskStageRef.current)
        updateQueueItem(nextItem.id, (item) => ({
          ...item,
          status: 'queued',
          startedAt: undefined,
          message: '等待当前后台任务结束',
        }))
        showToast(message)
        return
      }

      markQueueItemFailed(nextItem.id, message)
    } catch (error) {
      const message = `启动任务失败：${String(error)}`
      markQueueItemFailed(nextItem.id, message)
    }
    } catch (error) {
      const message = `启动任务失败：${String(error)}`
      markQueueItemFailed(nextItem.id, message)
    } finally {
      queueStartingRef.current = false
    }
  }, [api, mountedRef, markQueueItemFailed, selectQueueItemRecord, showToast, updateQueueItem, blockPendingBodyReview, confirmPendingProductionReview])

  useEffect(() => {
    startNextQueueItemRef.current = () => {
      void startNextQueueItem()
    }
  }, [startNextQueueItem])

  const enqueueQueueItems = useCallback((items: TaskQueueItem[]) => {
    const currentItems = queueItemsRef.current
    const pendingKeys = new Set(currentItems.filter(isOpenQueueItem).map(queueItemKey))
    const newItems: TaskQueueItem[] = []

    for (const item of items) {
      const key = queueItemKey(item)
      if (pendingKeys.has(key)) continue
      newItems.push(item)
    }

    if (!newItems.length) {
      showToast('这些任务已经在队列中。')
      return false
    }

    const nextQueue = currentItems.concat(newItems)
    const firstQueuedItem = newItems[0]
    queueItemsRef.current = nextQueue
    setQueueItems(nextQueue)
    followRunningQueueRef.current = true
    if (firstQueuedItem) selectQueueItemRecord(firstQueuedItem, false)
    const queuedCount = newItems.length
    showToast(queuedCount > 1 ? `已加入 ${queuedCount} 个任务，按顺序处理。` : '已加入任务队列。')
    scheduleTimeout(() => startNextQueueItemRef.current(), 0)
    return true
  }, [scheduleTimeout, selectQueueItemRecord, showToast])

  useEffect(() => {
    let alive = true

    api.taskStatus().then((status) => {
      if (!alive || !status.running) return

      const task = taskFromStatus(status)
      const stage = inferTaskStageFromCommand(task?.command)
      const fallbackWorkflowStage = fallbackWorkflowStageForCommand(task?.command)
      currentTaskRef.current = task
      runningRef.current = true
      taskStageRef.current = stage
      workflowStageRef.current = fallbackWorkflowStage
      setCurrentTask(task)
      setRunning(true)
      setTaskStage(stage)
      setWorkflowStage(fallbackWorkflowStage)
      setShotsMessage(runningMessage(stage))
      setLogs((items) => items.length ? items : [`>>> ${task?.command || '后台任务正在运行'}\n`])
      loadAndApplyShotPlan('current', task).catch(() => undefined)
    }).catch(() => undefined)

    return () => {
      alive = false
    }
  }, [api, loadAndApplyShotPlan])

  const continueAfterAutomaticPlan = useCallback(async (item: TaskQueueItem) => {
    const sourceModeForGeneration = normalizeMaterialSourceMode(item.materialSourceMode, item.preferLocalMaterials)
    if (queuePausedRef.current || queueItemsRef.current.find((entry) => entry.id === item.id)?.pauseRequested) {
      updateQueueItem(item.id, { status: 'paused', autoContinueToGenerate: false })
      return
    }
    generationPreparingRef.current = true
    setGenerationPreparing(true)
    setPreparingRunTarget({ runId: item.runId, runPath: item.runPath, shotsJson: item.shotsJson })
    try {
      const planned = await loadTaskShotPlan(queueItemToTask(item), 'current')
      const taskId = planned.currentRun?.id
      const shotsPath = planned.currentRun?.shotsPath
      if (!taskId || !shotsPath || !planned.shots.length) {
        throw new Error('分镜任务没有生成可继续使用的分镜文件')
      }

      const savedDraft = await api.loadTaskDraft<Record<string, unknown>>(taskId)
      if (savedDraft) draftRevisionsRef.current.set(taskId, savedDraft.revision)
      const scopedRoot = savedDraft && (!planned.currentRun?.shotsModifiedAt || Date.parse(savedDraft.updatedAt) >= planned.currentRun.shotsModifiedAt)
        ? savedDraft.snapshot : sourceModeForGeneration === 'pexels-only' ? planned.planRoot : applyScriptMaterialScope(planned.planRoot, item.scriptMaterialBindings)
      const scopedShots = normalizeShots(scopedRoot.shots)
      if (blockPendingBodyReview(scopedShots, item, { ...planned, planRoot: scopedRoot })) return
      if (!confirmPendingProductionReview(scopedShots, item)) return
      const automatic = await api.autoResolveShotMaterials({
        shots: scopedShots,
        fallbackSource: 'pexels',
        materialSourceMode: sourceModeForGeneration,
        reuseUnchanged: true,
      })
      const generationShots = normalizeShots(automatic.shots)
      const resolvedMaterialMode: MaterialMode = generationShots.some((shot) => shot.download_material)
        ? 'download'
        : 'library'
      const currentRevision = draftRevisionsRef.current.get(taskId) || 0
      const nextRoot = {
        ...scopedRoot,
        schema_version: 2,
        material_source_mode: sourceModeForGeneration,
        task_revision: currentRevision + 1,
        topic: String(scopedRoot.topic || planned.shotTopic),
        shots: generationShots,
      }
      const draft = await api.saveTaskDraft({
        taskId,
        schemaVersion: 2,
        expectedRevision: currentRevision,
        snapshot: nextRoot,
      })
      await api.writeFile(shotsPath, JSON.stringify(nextRoot, null, 2))
      draftRevisionsRef.current.set(taskId, draft.revision)
      if (!automatic.ok) {
        if (selectedQueueIdRef.current === item.id) {
          applyShotPlan({ ...planned, planRoot: nextRoot, shots: generationShots, dirty: false })
          setShotDrawerOpen(true)
        }
        throw new Error(automatic.message || '素材库未找到全部分镜所需的素材，请补充素材或切换模式')
      }
      const prepared = await api.prepareGenerationManifest({
        taskId,
        taskRevision: draft.revision,
        shots: generationShots,
      })
      draftRevisionsRef.current.set(taskId, draft.revision)
      setDraftSaveStatus('saved')
      setDraftSavedAt(new Date(draft.updatedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }))

      const summary = materialSourceSummary(sourceModeForGeneration, automatic.matched, automatic.fallback)
      const nextItem = {
        ...prepareQueueItemForGeneration(item, {
          shotsJson: shotsPath,
          workflowPlan: inferWorkflowPlanFromShots(generationShots, nextRoot),
          materialMode: resolvedMaterialMode,
          source: item.source || '',
          materialManifestPath: prepared.manifestPath,
        }),
        reviewWarningsConfirmed: true,
        autoContinueToGenerate: false,
        logs: item.logs.concat(`\n${summary}\n`),
        pauseRequested: false,
      }
      if (queuePausedRef.current || queueItemsRef.current.find((entry) => entry.id === item.id)?.pauseRequested) {
        nextItem.status = 'paused'
      }
      updateQueueItem(item.id, () => nextItem)
      if (selectedQueueIdRef.current === item.id) {
        applyShotPlan({
          ...planned,
          shotTopic: nextRoot.topic,
          planRoot: nextRoot,
          shots: generationShots,
          dirty: false,
          message: '',
        })
        setLogs(nextItem.logs)
      }
      showToast(`素材准备完成：复用素材库 ${automatic.matched} 个，下载 ${automatic.fallback} 个。`)
    } finally {
      generationPreparingRef.current = false
      setGenerationPreparing(false)
      setPreparingRunTarget(null)
    }
  }, [api, applyShotPlan, showToast, updateQueueItem, blockPendingBodyReview, confirmPendingProductionReview])

  useTaskEventSubscription({
    activeQueueItemIdRef,
    currentTaskRef,
    queueItemsRef,
    runningRef,
    selectedQueueIdRef,
    startNextQueueItemRef,
    taskStageRef,
    workflowPlanRef,
    workflowProgressRef,
    workflowStageRef,
    applyWorkflowPlan,
    applyWorkflowProgress,
    applyWorkflowStage,
    loadAndApplyShotPlan,
    onSuccessfulPlanClose: continueAfterAutomaticPlan,
    scheduleMaterialPreviewRefresh,
    scheduleTimeout,
    setCurrentTask,
    setLogs,
    setRunning,
    setTaskStage,
    setWorkflowPlan,
    setWorkflowProgress,
    setWorkflowStage,
    showToast,
    updateQueueItem,
  })

  useEffect(() => {
    const taskId = shotPlan.currentRun?.id
    if (!taskId || !shotPlan.dirty || !shotPlan.shots.length) return
    const timer = window.setTimeout(() => {
      setDraftSaveStatus('saving')
      queueDraftSave(async () => {
        const currentRevision = draftRevisionsRef.current.get(taskId) || 0
        const snapshot = {
          ...shotPlan.planRoot,
          schema_version: 2,
          material_source_mode: materialSourceModeRef.current,
          task_revision: currentRevision + 1,
          topic: shotPlan.shotTopic,
          shots: shotPlan.shots,
        }
        const record = await api.saveTaskDraft({
          taskId,
          schemaVersion: 2,
          expectedRevision: currentRevision,
          snapshot,
        })
        draftRevisionsRef.current.set(taskId, record.revision)
        setDraftSaveStatus('saved')
        setDraftSavedAt(new Date(record.updatedAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }))
      }).catch((error) => {
        console.error('[VideoAutoCut] autosave local task draft failed', error)
        setDraftSaveStatus('failed')
      })
    }, 800)
    return () => window.clearTimeout(timer)
  }, [
    api,
    shotPlan.currentRun?.id,
    shotPlan.dirty,
    shotPlan.planRoot,
    shotPlan.shotTopic,
    shotPlan.shots,
  ])

  function moveQueueItemToGenerate(
    item: TaskQueueItem,
    shotsJson?: string,
    materialManifestPath?: string,
    resolvedMaterialMode: MaterialMode = materialMode,
    resolvedShots = shotPlan.shots,
    resolvedRoot = shotPlan.planRoot,
    sourceModeForGeneration = materialSourceModeRef.current,
    restartAll = false,
  ) {
    if (item.status === 'running') {
      showToast('当前任务正在执行，完成后再继续生成视频。')
      return true
    }

    if (item.status === 'queued' && item.mode === 'generate') {
      showToast('这个任务已经在生成队列中。')
      return true
    }

    const nextItem = prepareQueueItemForGeneration(item, {
      shotsJson,
      workflowPlan: inferWorkflowPlanFromShots(resolvedShots, resolvedRoot),
      materialMode: resolvedMaterialMode,
      source,
      materialSourceMode: sourceModeForGeneration,
      materialManifestPath,
    })

    nextItem.restartAll = restartAll
    nextItem.reviewWarningsConfirmed = true
    nextItem.resumeRunPath = undefined
    updateQueueItem(item.id, () => nextItem)
    followRunningQueueRef.current = true
    selectQueueItemRecord(nextItem, false)
    showToast('已加入生成队列。')
    scheduleTimeout(() => startNextQueueItemRef.current(), 0)
    return true
  }

  function updateScriptPaths(value: string) {
    const nextPaths = normalizeScriptPaths(value)
    const changed = !samePathList(scriptPaths, nextPaths)
    setScriptPaths(nextPaths)
    setScriptMaterialSelections((current) => retainScriptMaterialSelections(current, nextPaths))
    const retainedKeys = new Set(nextPaths.map(scriptMaterialKey))
    setVoiceScriptModes((current) => Object.fromEntries(Object.entries(current).filter(([key]) => retainedKeys.has(key))))
    setVoiceScriptBodyPaths((current) => Object.fromEntries(Object.entries(current).filter(([key]) => retainedKeys.has(key))))
    setVoiceScriptTaskIds((current) => Object.fromEntries(Object.entries(current).filter(([key]) => retainedKeys.has(key))))
    if (changed) resetInputContext()
  }

  function updateVoiceScript(scriptPath: string, enabled: boolean, bodyPath?: string) {
    const key = scriptMaterialKey(scriptPath)
    setVoiceScriptModes((current) => enabled ? { ...current, [key]: true } : Object.fromEntries(Object.entries(current).filter(([item]) => item !== key)))
    setVoiceScriptBodyPaths((current) => enabled && bodyPath ? { ...current, [key]: bodyPath } : Object.fromEntries(Object.entries(current).filter(([item]) => item !== key)))
    setVoiceScriptTaskIds((current) => enabled
      ? { ...current, [key]: current[key] || crypto.randomUUID() }
      : Object.fromEntries(Object.entries(current).filter(([item]) => item !== key)))
  }

  async function chooseScriptFiles() {
    const picked = await api.chooseScriptFiles()
    const pickedPaths = normalizeScriptPaths(picked)
    if (!pickedPaths.length) return

    const nextPaths = Array.from(new Set(scriptPaths.concat(pickedPaths)))
    const changed = !samePathList(scriptPaths, nextPaths)
    setScriptPaths(nextPaths)
    if (changed) resetInputContext()
  }

  function updateScriptMaterials(scriptPath: string, selections: ShotMaterialSelection[]) {
    if (materialSourceModeRef.current === 'pexels-only') { showToast('仅 Pexels 模式不能绑定素材范围。'); return }
    const key = scriptMaterialKey(scriptPath)
    if (!scriptPaths.some((path) => scriptMaterialKey(path) === key)) return
    setScriptMaterialSelections((current) => {
      const next = { ...current }
      if (selections.length) next[key] = selections
      else delete next[key]
      return next
    })
  }

  function startImportedScripts(autoContinueToGenerate = false, preparedBodyPaths: Record<string, string> = {}) {
    if (!scriptPaths.length) {
      showToast('请先选择脚本文件。')
      return
    }
    const effectiveBodyPaths = { ...voiceScriptBodyPaths, ...preparedBodyPaths }
    const unconfirmedVoice = scriptPaths.find((path) => voiceScriptModes[scriptMaterialKey(path)] && !effectiveBodyPaths[scriptMaterialKey(path)])
    if (unconfirmedVoice) {
      showToast('请先确认每份口播稿的正文。')
      return
    }
    if (enqueueQueueItems(createScriptQueueItems({
      paths: scriptPaths,
      mode: 'plan',
      materialMode: 'download',
      source,
      materialSourceMode: materialSourceModeRef.current,
      autoContinueToGenerate,
      aspectRatio,
      outputResolution,
      scriptMaterialBindings: scriptMaterialBindingsByPath(scriptMaterialSelections),
      voiceScriptBodyPaths: effectiveBodyPaths,
      reservedTaskIds: voiceScriptTaskIds,
    }))) {
      setScriptPaths([])
      setScriptMaterialSelections({})
      setVoiceScriptModes({})
      setVoiceScriptBodyPaths({})
      setVoiceScriptTaskIds({})
    }
  }

  async function analyzeShots(preparedBodyPaths: Record<string, string> = {}) {
    startImportedScripts(false, preparedBodyPaths)
  }

  function generateImportedScripts(preparedBodyPaths: Record<string, string> = {}) {
    startImportedScripts(true, preparedBodyPaths)
  }

  async function stopTask() {
    const result = await api.stopTask()
    if (!result.ok && result.message) showToast(result.message)
  }

  async function pauseQueue() {
    queuePausedRef.current = true
    setQueuePaused(true)
    const activeId = activeQueueItemIdRef.current
    if (activeId) updateQueueItem(activeId, { pauseRequested: true, autoContinueToGenerate: false })
    if (runningRef.current) await stopTask()
    showToast('队列已暂停，已完成的分镜和文件会保留。')
  }

  async function pauseCurrentTask() {
    const id = activeQueueItemIdRef.current
    if (id) updateQueueItem(id, { pauseRequested: true, autoContinueToGenerate: false })
    await stopTask()
  }

  function continueQueue() {
    queuePausedRef.current = false
    setQueuePaused(false)
    const paused = queueItemsRef.current.find((item) => item.status === 'paused')
    if (paused) { void resumeQueueItem(paused.id); return }
    if (!queueItemsRef.current.length && workflowProgressRef.current?.phase === 'cancelled' && shotPlan.currentRun && !runningRef.current) {
      void generateVideo()
      return
    }
    startNextQueueItemRef.current()
  }

  async function restoreRun(run: RunItem) {
    if (runningRef.current || generationPreparingRef.current) {
      showToast('请先暂停当前任务，再恢复草稿。')
      return false
    }
    if (!run.shotsPath) { showToast('该任务尚未生成分镜，请重新添加原脚本。'); return false }
    if (shotPlan.dirty && !await saveShots(false)) return false
    selectedQueueIdRef.current = null
    setSelectedQueueId(null)
    const task = { runId: run.id, runPath: run.path, status: 'done' as const }
    currentTaskRef.current = task
    setCurrentTask(task)
    try {
      const restored = await loadAndApplyShotPlan('current', task, run)
      if (!restored.shots.length) { showToast(restored.message || '该任务没有可恢复的分镜'); return false }
      let resumable = false
      try {
        const checkpoint = JSON.parse(await api.readFile(`${run.path}/checkpoint.json`))
        resumable = checkpoint.version === 1 && !run.finalVideo
        if (resumable && !run.incrementalPath) {
          const jobPlan = JSON.parse(await api.readFile(`${run.path}/job_plan.json`))
          if (isCompletedPlanOnlyRun(jobPlan, checkpoint)) resumable = false
        }
      } catch { /* Older plans can still start a new generation. */ }
      const progress: TaskWorkflowProgress | undefined = resumable ? { status: 'failed', phase: 'interrupted', label: '任务中断，可从断点继续' } : undefined
      workflowProgressRef.current = progress
      setWorkflowProgress(progress)
      workflowStageRef.current = undefined
      setWorkflowStage(undefined)
      setTaskStage('generate')
      taskStageRef.current = 'generate'
      followRunningQueueRef.current = false
      setShotDrawerOpen(false)
      showToast(resumable ? '已恢复到工作台，可从失败步骤继续或重新生成全部。' : '已恢复到工作台。')
      return true
    } catch (error) {
      showToast(`恢复失败：${String(error)}`)
      return false
    }
  }

  async function resumeQueueItem(id: string) {
    const item = queueItemsRef.current.find((entry) => entry.id === id)
    if (!item || runningRef.current || generationPreparingRef.current) return
    const isCurrentPlan = selectedQueueIdRef.current === id || Boolean(shotPlan.currentRun
      && (item.runId === shotPlan.currentRun.id || item.runPath === shotPlan.currentRun.path))
    const changedCurrentPlan = isCurrentPlan && (shotPlan.dirty || normalizeMaterialSourceMode(item.materialSourceMode, item.preferLocalMaterials) !== materialSourceModeRef.current)
    if (shotPlan.dirty && !await saveShots(false)) return
    let reviewBlocked = false
    try {
      selectedQueueIdRef.current = id
      setSelectedQueueId(id)
      followRunningQueueRef.current = true
      generationPreparingRef.current = true
      setGenerationPreparing(true)
      setPreparingRunTarget({ runId: item.runId, runPath: item.runPath, shotsJson: item.shotsJson })
      queuePausedRef.current = false
      setQueuePaused(false)
      updateQueueItem(id, { pauseRequested: false })
      if (item.mode === 'generate' && item.runPath) {
        const sourceMode = isCurrentPlan ? materialSourceModeRef.current : normalizeMaterialSourceMode(item.materialSourceMode, item.preferLocalMaterials)
        const latest = await loadTaskShotPlan(queueItemToTask(item), 'current')
        const latestShots = latest.shots
        const resumedRun = latest.currentRun
        if (!resumedRun) throw new Error('分镜任务没有可继续使用的运行目录')
        if (blockPendingBodyReview(latestShots, item, latest)) { reviewBlocked = true; return }
        if (!confirmPendingProductionReview(latestShots, item)) { reviewBlocked = true; return }
        const resumed = await prepareResumeGeneration(api, resumedRun, sourceMode, changedCurrentPlan)
        if (resumed.draft) {
          draftRevisionsRef.current.set(resumed.draft.taskId, resumed.draft.revision)
          setDraftSaveStatus('saved')
          if (isCurrentPlan) setShotPlan((current) => ({ ...current, planRoot: resumed.root, shots: resumed.shots, dirty: false }))
        }
        updateQueueItem(id, { status: 'queued', pauseRequested: false, code: undefined,
          shotsJson: resumedRun.shotsPath, resumeRunPath: resumedRun.path, runPath: resumedRun.path, restartAll: false,
          materialManifestPath: resumed.materialManifestPath, materialSourceMode: sourceMode,
          downloadNewMaterials: resumed.shots.some((shot) => shot.download_material),
          workflowProgress: undefined, message: resumed.changed ? '保留未修改分镜的结果，继续生成。' : '从原检查点继续生成。' })
        return
      }
      const resumablePlan = item.runPath || item.runId ? await loadTaskShotPlan(queueItemToTask(item), 'current') : null
      if (resumablePlan?.shots.length) {
        await continueAfterAutomaticPlan({ ...item, pauseRequested: false })
      } else {
        updateQueueItem(id, { status: 'queued', pauseRequested: false, code: undefined, runId: undefined, runPath: undefined })
      }
      startNextQueueItemRef.current()
    } catch (error) {
      updateQueueItem(id, { status: 'failed' })
      showToast(`恢复失败：${String(error)}`)
    } finally {
      generationPreparingRef.current = false
      setGenerationPreparing(false)
      setPreparingRunTarget(null)
      if (!reviewBlocked) scheduleTimeout(() => startNextQueueItemRef.current(), 0)
    }
  }

  async function removeQueueItem(id: string) {
    const item = queueItemsRef.current.find((entry) => entry.id === id)
    if (!item || item.status === 'running' || isAutomaticallyPreparingQueueItem(item)) {
      showToast('请先暂停任务，再移出队列。')
      return
    }
    const remaining = queueItemsRef.current.filter((entry) => entry.id !== id)
    queueItemsRef.current = remaining
    setQueueItems(remaining)
    if (selectedQueueIdRef.current === id) resetInputContext()
    showToast('已移出队列，历史任务和草稿仍保留。')
  }

  function updateShotField(index: number, field: EditableShotField, value: string) {
    if (runningRef.current || generationPreparingRef.current) { showToast('请先暂停任务，等待当前操作结束后编辑。'); return }
    setDraftSaveStatus('idle')
    setShotPlan((current) => ({
      ...current,
      shots: current.shots.map((shot, itemIndex) => itemIndex === index ? updateShotContent(shot, field, value) : shot),
      dirty: true,
    }))
  }

  function updateShotMetaField(index: number, field: ShotScriptMetaField, value: string) {
    if (runningRef.current || generationPreparingRef.current) { showToast('请先暂停任务，等待当前操作结束后编辑。'); return }
    setDraftSaveStatus('idle')
    setShotPlan((current) => ({
      ...current,
      shots: current.shots.map((shot, itemIndex) => itemIndex === index ? updateShotScriptMeta(shot, field, value) : shot),
      dirty: true,
    }))
  }

  function confirmShotFields(index: number, fields: string[] | 'all') {
    if (runningRef.current || generationPreparingRef.current) { showToast('请先暂停任务，等待当前操作结束后编辑。'); return }
    setDraftSaveStatus('idle')
    setShotPlan((current) => ({
      ...current,
      shots: current.shots.map((shot, itemIndex) => itemIndex === index ? confirmShotReview(shot, fields) : shot),
      dirty: true,
    }))
  }

  function acknowledgeShotReviewWarning(index: number, id: string) {
    if (runningRef.current || generationPreparingRef.current) { showToast('请先暂停任务，等待当前操作结束后编辑。'); return }
    setDraftSaveStatus('idle')
    setShotPlan((current) => ({
      ...current,
      shots: current.shots.map((shot, itemIndex) => itemIndex === index ? acknowledgeShotWarning(shot, id) : shot),
      dirty: true,
    }))
  }

  function restoreShotField(index: number, field: RestorableScriptField) {
    if (runningRef.current || generationPreparingRef.current) { showToast('请先暂停任务，等待当前操作结束后编辑。'); return }
    setDraftSaveStatus('idle')
    setShotPlan((current) => ({
      ...current,
      shots: current.shots.map((shot, itemIndex) => itemIndex === index ? restoreScriptValue(shot, field) : shot),
      dirty: true,
    }))
  }

  function updateShotMaterials(
    index: number,
    selections: ShotMaterialSelection[],
    downloadMaterial: boolean,
  ) {
    if (materialSourceModeRef.current === 'pexels-only') { showToast('仅 Pexels 模式不能手工绑定素材。'); return }
    if (runningRef.current || generationPreparingRef.current) { showToast('请先暂停任务，等待当前操作结束后编辑。'); return }
    setDraftSaveStatus('idle')
    const materialBindings = downloadMaterial ? [] : selectionsToMaterialBindings(selections)
    setShotPlan((current) => ({
      ...current,
      shots: current.shots.map((shot, itemIndex) => itemIndex === index
        ? {
            ...shot,
            download_material: downloadMaterial,
            material_bindings: materialBindings,
            material_resolution: undefined,
          }
        : shot),
      dirty: true,
    }))
  }

  function updateMaterialSourceMode(value: MaterialSourceMode) {
    if (runningRef.current || generationPreparingRef.current || queueItemsRef.current.some(isAutomaticallyPreparingQueueItem)) {
      showToast('任务执行期间不能切换素材获取模式。')
      return
    }
    if (value === materialSourceModeRef.current) return
    materialSourceModeRef.current = value
    setMaterialSourceMode(value)
    setDraftSaveStatus('idle')
    setShotPlan((current) => ({
      ...current,
      planRoot: { ...current.planRoot, material_source_mode: value },
      shots: value === 'pexels-only'
        ? current.shots.map(shot => ({ ...shot, download_material: true, material_bindings: [], material_resolution: undefined }))
        : resetAutomaticMaterialResolution(current.shots),
      dirty: current.shots.length ? true : current.dirty,
    }))
  }

  function updateTopic(value: string) {
    if (runningRef.current || generationPreparingRef.current) { showToast('请先暂停任务，等待当前操作结束后编辑。'); return }
    setDraftSaveStatus('idle')
    setShotPlan((current) => ({ ...current, shotTopic: value, dirty: true }))
  }

  async function saveShots(showSaved = true) {
    if (runningRef.current) { showToast('请先暂停任务，再保存草稿。'); return false }
    const shotsPath = shotPlan.currentRun?.shotsPath
    if (!shotsPath) {
      showToast('请先预览分镜。')
      return false
    }

    try {
      setDraftSaveStatus('saving')
      const taskId = shotPlan.currentRun?.id
      const currentRevision = taskId
        ? draftRevisionsRef.current.get(taskId) || 0
        : Number(shotPlan.planRoot.task_revision) || 0
      const nextRoot = {
        ...shotPlan.planRoot,
        schema_version: 2,
        material_source_mode: materialSourceModeRef.current,
        task_revision: currentRevision + (taskId ? 1 : 0),
        topic: shotPlan.shotTopic,
        shots: shotPlan.shots,
      }
      const saved = await queueDraftSave(async () => {
        const queuedRevision = taskId
          ? draftRevisionsRef.current.get(taskId) || 0
          : Number(shotPlan.planRoot.task_revision) || 0
        const queuedRoot = {
          ...nextRoot,
          task_revision: queuedRevision + (taskId ? 1 : 0),
        }
        if (taskId) {
          const draft = await api.saveTaskDraft({
            taskId,
            schemaVersion: 2,
            expectedRevision: queuedRevision,
            snapshot: queuedRoot,
          })
          draftRevisionsRef.current.set(taskId, draft.revision)
          queuedRoot.task_revision = draft.revision
          setDraftSavedAt(new Date(draft.updatedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }))
        }
        await api.writeFile(shotsPath, JSON.stringify(queuedRoot, null, 2))
        return queuedRoot
      })
      setShotPlan({ ...shotPlan, planRoot: saved, dirty: false })
      setDraftSaveStatus('saved')
      if (showSaved) showToast('分镜已保存。')
      return true
    } catch (error) {
      setDraftSaveStatus('failed')
      showToast(`保存失败：${String(error)}`)
      return false
    }
  }

  async function generateVideoInternal(restartAll = false) {
    const reviewGate = bodyReviewGate(shotPlan.shots)
    if (reviewGate.blocked) {
      setShotDrawerOpen(true)
      scheduleTimeout(() => document.getElementById(`shot-editor-${reviewGate.firstIndex}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0)
      showToast(reviewGate.message)
      return
    }
    const pendingReviews = pendingReviewTotal(shotPlan.shots)
    if (pendingReviews && !window.confirm(`还有 ${pendingReviews} 条提醒未确认，仍然生成？`)) return
    const sourceModeForGeneration = materialSourceModeRef.current
    const currentShotsPath = shotPlan.currentRun?.shotsPath || ''
    const hasVisiblePlan = Boolean(currentShotsPath && shotPlan.shots.length)
    const shouldUseVisiblePlan = shotPlan.dirty || shotPlan.planOrigin === 'current'
    if (hasVisiblePlan && shouldUseVisiblePlan) {
      if (shotPlan.dirty) {
        const saved = await saveShots(false)
        if (!saved) return
      } else {
        const taskId = shotPlan.currentRun?.id
        const currentRevision = taskId
          ? draftRevisionsRef.current.get(taskId) || 0
          : Number(shotPlan.planRoot.task_revision) || 0
        const currentRoot = {
          ...shotPlan.planRoot,
          schema_version: 2,
          material_source_mode: sourceModeForGeneration,
          task_revision: currentRevision,
          topic: shotPlan.shotTopic,
          shots: shotPlan.shots,
        }
        try {
          await api.writeFile(currentShotsPath, JSON.stringify(currentRoot, null, 2))
        } catch (error) {
          showToast(`保存生成快照失败：${error instanceof Error ? error.message : String(error)}`)
          return
        }
      }
      let generationShots = shotPlan.shots
      let generationRoot = {
        ...shotPlan.planRoot,
        schema_version: 2,
        material_source_mode: sourceModeForGeneration,
        task_revision: draftRevisionsRef.current.get(shotPlan.currentRun?.id || '') || 0,
        topic: shotPlan.shotTopic,
        shots: shotPlan.shots,
      }
      let generationRevision = Number(generationRoot.task_revision) || 0
      let resolvedMaterialMode: MaterialMode
      try {
        const taskId = shotPlan.currentRun?.id
        if (!taskId) throw new Error('当前分镜缺少稳定任务标识')
        const automatic = await api.autoResolveShotMaterials({
          shots: shotPlan.shots,
          fallbackSource: 'pexels',
          materialSourceMode: sourceModeForGeneration,
          reuseUnchanged: true,
        })
        generationShots = normalizeShots(automatic.shots)
        resolvedMaterialMode = generationShots.some((shot) => shot.download_material)
          ? 'download'
          : 'library'

        if (automatic.matched > 0 || automatic.fallback > 0 || automatic.blocked) {
          const currentRevision = draftRevisionsRef.current.get(taskId) || 0
          const nextRoot = {
            ...shotPlan.planRoot,
            schema_version: 2,
            material_source_mode: sourceModeForGeneration,
            task_revision: currentRevision + 1,
            topic: shotPlan.shotTopic,
            shots: generationShots,
          }
          const record = await api.saveTaskDraft({
            taskId,
            schemaVersion: 2,
            expectedRevision: currentRevision,
            snapshot: nextRoot,
          })
          await api.writeFile(currentShotsPath, JSON.stringify(nextRoot, null, 2))
          draftRevisionsRef.current.set(taskId, record.revision)
          generationRevision = record.revision
          generationRoot = nextRoot
          setShotPlan((current) => ({
            ...current,
            planRoot: nextRoot,
            shots: generationShots,
            dirty: false,
          }))
          setDraftSaveStatus('saved')
          setDraftSavedAt(new Date(record.updatedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }))
          setLogs((items) => items.concat(
            `\n${materialSourceSummary(sourceModeForGeneration, automatic.matched, automatic.fallback)}\n`,
          ))
        }
        if (!automatic.ok) {
          setShotDrawerOpen(true)
          throw new Error(automatic.message || '素材库未找到全部分镜所需的素材，请补充素材或切换模式')
        }
      } catch (error) {
        showToast(`素材准备失败：${error instanceof Error ? error.message : String(error)}`)
        return
      }

      let materialManifestPath: string
      try {
        const taskId = shotPlan.currentRun?.id
        if (!taskId) throw new Error('当前分镜缺少稳定任务标识')
        const missingShots = shotsWithoutMaterialSelection(generationShots)
        if (missingShots.length) {
          const names = missingShots.slice(0, 5).map((shot) => (
            `${String(shot.index + 1).padStart(2, '0')} ${shot.title}`
          ))
          const suffix = missingShots.length > names.length
            ? `等 ${missingShots.length} 个分镜`
            : ''
          setShotDrawerOpen(true)
          showToast(`请先选择素材：${names.join('、')}${suffix}`)
          return
        }
        const prepared = await api.prepareGenerationManifest({
          taskId,
          taskRevision: generationRevision,
          shots: generationShots,
        })
        materialManifestPath = prepared.manifestPath
      } catch (error) {
        showToast(`素材范围校验失败：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      const currentQueueItem = findQueueItemForPlan(
        queueItemsRef.current,
        selectedQueueIdRef.current,
        currentShotsPath,
        shotPlan.currentRun,
      )
      setShotDrawerOpen(false)
      if (currentQueueItem) {
        moveQueueItemToGenerate(
          currentQueueItem,
          currentShotsPath,
          materialManifestPath,
          resolvedMaterialMode,
          generationShots,
          generationRoot,
          sourceModeForGeneration,
          restartAll,
        )
        return
      }
      enqueueQueueItems([{ ...createShotsQueueItem({
        shotsJson: currentShotsPath,
        currentRun: shotPlan.currentRun,
        workflowPlan: inferWorkflowPlanFromShots(generationShots, generationRoot),
        materialMode: resolvedMaterialMode,
        source,
        materialSourceMode: sourceModeForGeneration,
        materialManifestPath,
      }), restartAll, reviewWarningsConfirmed: pendingReviews > 0 }])
      return
    }

    if (!scriptPaths.length) {
      showToast('请先选择脚本文件，或先预览当前分镜。')
      return
    }
    if (scriptPaths.some((path) => voiceScriptModes[scriptMaterialKey(path)] && !voiceScriptBodyPaths[scriptMaterialKey(path)])) {
      showToast('请先确认每份口播稿的正文。')
      return
    }

    if (enqueueQueueItems(createScriptQueueItems({
      paths: scriptPaths,
      mode: 'plan',
      materialMode: 'download',
      source,
      materialSourceMode: sourceModeForGeneration,
      autoContinueToGenerate: true,
      aspectRatio,
      outputResolution,
      scriptMaterialBindings: scriptMaterialBindingsByPath(scriptMaterialSelections),
      voiceScriptBodyPaths,
      reservedTaskIds: voiceScriptTaskIds,
    }))) {
      setScriptPaths([])
      setScriptMaterialSelections({})
      setVoiceScriptModes({})
      setVoiceScriptBodyPaths({})
      setVoiceScriptTaskIds({})
    }
  }

  async function retryGeneration() {
    const run = shotPlan.currentRun
    if (!run?.path || !run.shotsPath) { showToast('找不到原任务，无法断点续跑。'); return }
    const pausedItem = queueItemsRef.current.find((item) => (item.status === 'paused' || item.status === 'failed') && item.mode === 'generate' && (item.runId === run.id || item.runPath === run.path))
    if (pausedItem) { await resumeQueueItem(pausedItem.id); return }
    if (runningRef.current || generationPreparingRef.current) return
    const changedPlan = shotPlan.dirty
    if (shotPlan.dirty && !await saveShots(false)) return
    if (blockPendingBodyReview(shotPlan.shots, pausedItem)) return
    if (pausedItem && !confirmPendingProductionReview(shotPlan.shots, pausedItem)) return
    generationPreparingRef.current = true
    setGenerationPreparing(true)
    setPreparingRunTarget({ runId: run.id, runPath: run.path, shotsJson: run.shotsPath })
    try {
      const resumed = await prepareResumeGeneration(api, run, materialSourceModeRef.current, changedPlan)
      if (resumed.draft) {
        draftRevisionsRef.current.set(run.id, resumed.draft.revision)
        setDraftSaveStatus('saved')
        setShotPlan((current) => ({ ...current, planRoot: resumed.root, shots: resumed.shots, dirty: false }))
      }
      queuePausedRef.current = false
      setQueuePaused(false)
      enqueueQueueItems([{ ...createShotsQueueItem({
        shotsJson: run.shotsPath, currentRun: run,
        workflowPlan: inferWorkflowPlanFromShots(resumed.shots, resumed.root),
        materialMode: resumed.shots.some((shot) => shot.download_material) ? 'download' : 'library', source, materialSourceMode: materialSourceModeRef.current,
        materialManifestPath: resumed.materialManifestPath,
      }), resumeRunPath: run.path }])
    } catch (error) {
      showToast(`恢复失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      generationPreparingRef.current = false
      setGenerationPreparing(false)
      setPreparingRunTarget(null)
      scheduleTimeout(() => startNextQueueItemRef.current(), 0)
    }
  }

  async function generateVideo(restartAll = false) {
    const pausedGeneration = shotPlan.currentRun && queueItemsRef.current.some((item) => item.mode === 'generate'
      && (item.status === 'paused' || item.status === 'failed')
      && (item.runId === shotPlan.currentRun?.id || item.runPath === shotPlan.currentRun?.path))
    if (!restartAll && (derived.generateButtonText === '从失败步骤继续' || pausedGeneration)) {
      await retryGeneration()
      return
    }
    if (generationPreparingRef.current || queueItemsRef.current.some(isAutomaticallyPreparingQueueItem)) {
      showToast('正在准备生成，请稍候。')
      return
    }
    queuePausedRef.current = false
    setQueuePaused(false)
    generationPreparingRef.current = true
    setGenerationPreparing(true)
    setPreparingRunTarget(shotPlan.currentRun ? {
      runId: shotPlan.currentRun.id, runPath: shotPlan.currentRun.path, shotsJson: shotPlan.currentRun.shotsPath,
    } : null)
    try {
      await generateVideoInternal(restartAll)
    } finally {
      generationPreparingRef.current = false
      setGenerationPreparing(false)
      setPreparingRunTarget(null)
    }
  }

  const refreshSelectedShotsPreview = useCallback(() => {
    const selectedItem = selectedQueueIdRef.current
      ? queueItemsRef.current.find((item) => item.id === selectedQueueIdRef.current)
      : null
    return loadAndApplyShotPlan('current', selectedItem ? queueItemToTask(selectedItem) : currentTaskRef.current).then(() => undefined)
  }, [loadAndApplyShotPlan])

  const derived = buildStartTaskViewModel({
    scriptCount: scriptPaths.length,
    logs,
    running,
    selectedQueueItem,
    shotPlan,
    taskStage,
    workflowPlan,
    workflowProgress,
    workflowStage,
  })
  const preparingMaterials = generationPreparing || queueItems.some(isAutomaticallyPreparingQueueItem)
  const protectedRunTargets: RunActivityTarget[] = [
    ...(running && currentTask ? [currentTask] : []),
    ...queueItems.filter((item) => item.status === 'running' || isAutomaticallyPreparingQueueItem(item)),
    ...(preparingRunTarget ? [preparingRunTarget] : []),
  ]

  function forgetRun(id: string) {
    const remaining = queueItemsRef.current.filter((item) => item.runId !== id)
    queueItemsRef.current = remaining
    setQueueItems(remaining)
    if (shotPlan.currentRun?.id === id) resetInputContext()
  }

  return {
    ...derived,
    hasPendingVoiceScript: scriptPaths.some((path) => voiceScriptModes[scriptMaterialKey(path)] && !voiceScriptBodyPaths[scriptMaterialKey(path)]),
    canGenerate: derived.canGenerate && !preparingMaterials,
    generateButtonText: preparingMaterials ? '正在准备生成' : derived.generateButtonText,
    taskStatusLabel: preparingMaterials ? '素材准备中' : selectedQueueItem?.status === 'paused' ? '已暂停' : derived.taskStatusLabel,
    scripts,
    aspectRatio,
    setAspectRatio: (value: string) => {
      setAspectRatio(value)
      setOutputResolution((current) => normalizeOutputResolution(value, current))
    },
    outputResolution,
    setOutputResolution,
    scriptMaterialSelections,
    voiceScriptModes,
    voiceScriptBodyPaths,
    voiceScriptTaskIds,
    updateVoiceScript,
    source,
    materialMode,
    materialSourceMode,
    manualMaterialSelectionDisabled: materialSourceMode === 'pexels-only',
    materialStrategyDisabled: running || preparingMaterials,
    protectedRunTargets,
    running,
    queueItems,
    selectedQueueId,
    selectedTaskLabel,
    activeTaskLabel,
    taskStage: derived.viewTaskStage,
    workflowStage: derived.viewWorkflowStage,
    workflowPlan: derived.viewWorkflowPlan,
    workflowProgress: derived.viewWorkflowProgress,
    workflowFailed: derived.viewWorkflowFailed,
    logs: derived.viewLogs,
    logOpen,
    shotDrawerOpen,
    currentRun: shotPlan.currentRun,
    shotTopic: shotPlan.shotTopic,
    shots: shotPlan.shots,
    planRoot: shotPlan.planRoot,
    dirty: shotPlan.dirty,
    draftSaveStatus,
    draftSavedAt,
    toast,
    toastTone,
    shotsMessage,
    setSource,
    setMaterialSourceMode: updateMaterialSourceMode,
    setLogOpen,
    setShotDrawerOpen,
    updateScriptPaths,
    updateScriptMaterials,
    chooseScriptFiles,
    selectQueueItem,
    stopTask,
    queuePaused,
    pauseQueue,
    pauseCurrentTask,
    continueQueue,
    resumeQueueItem,
    removeQueueItem,
    restoreRun,
    forgetRun,
    analyzeShots,
    generateImportedScripts,
    generateVideo: () => generateVideo(),
    regenerateAll: () => generateVideo(true),
    refreshShotsPreview: refreshSelectedShotsPreview,
    updateShotField,
    updateShotMetaField,
    confirmShotFields,
    acknowledgeShotReviewWarning,
    restoreShotField,
    updateShotMaterials,
    updateTopic,
    saveShots,
  }
}

export type StartTaskController = ReturnType<typeof useStartTaskController>
