import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'

import type { RunningTask, TaskEvent } from '../../types/videoauto'
import {
  closeRunningTask,
  createRunningTaskFromEvent,
  fallbackWorkflowStageForCommand,
  mergeRunningTaskEvent,
  reduceTaskQueueEvent,
  resolveClosedWorkflowState,
} from './taskEventReducer'
import {
  inferTaskStageFromCommand,
  normalizeWorkflowPlan,
  normalizeWorkflowProgress,
  normalizeWorkflowStage,
  shouldRefreshMaterialPreview,
  shouldRefreshPlanPreview,
} from './taskEventModel'
import { loadTaskShotPlan, type ShotPlanSnapshot } from './shotPlanState'
import { taskDisplayMeta } from './taskDisplay'
import { queueItemToTask } from './taskQueueModel'
import { normalizeMaterialSourceMode } from './materialSourceMode'
import { notifyTaskClose, taskResultToast } from './taskCloseNotice'
import type {
  PlanOrigin,
  TaskQueueItem,
  TaskStage,
  TaskWorkflowPlan,
  TaskWorkflowProgress,
  TaskWorkflowStage,
} from './types'

interface MutableValue<Value> {
  current: Value
}

type QueueItemUpdater = Partial<TaskQueueItem> | ((item: TaskQueueItem) => TaskQueueItem)

interface TaskEventSubscriptionOptions {
  activeQueueItemIdRef: MutableValue<string | null>
  currentTaskRef: MutableValue<RunningTask | null>
  queueItemsRef: MutableValue<TaskQueueItem[]>
  runningRef: MutableValue<boolean>
  selectedQueueIdRef: MutableValue<string | null>
  startNextQueueItemRef: MutableValue<() => void>
  taskStageRef: MutableValue<TaskStage>
  workflowPlanRef: MutableValue<TaskWorkflowPlan | undefined>
  workflowProgressRef: MutableValue<TaskWorkflowProgress | undefined>
  workflowStageRef: MutableValue<TaskWorkflowStage | undefined>
  applyWorkflowPlan: (plan: TaskWorkflowPlan | undefined, queueId?: string | null) => void
  applyWorkflowProgress: (progress: TaskWorkflowProgress | undefined, queueId?: string | null) => void
  applyWorkflowStage: (
    stage: TaskWorkflowStage | undefined,
    progress?: TaskWorkflowProgress,
    queueId?: string | null,
  ) => void
  loadAndApplyShotPlan: (
    origin?: PlanOrigin,
    task?: RunningTask | null,
  ) => Promise<ShotPlanSnapshot>
  onSuccessfulPlanClose?: (item: TaskQueueItem) => Promise<void>
  scheduleMaterialPreviewRefresh: (task: RunningTask, queueId?: string | null) => void
  scheduleTimeout: (callback: () => void, delay: number) => number
  setCurrentTask: Dispatch<SetStateAction<RunningTask | null>>
  setLogs: Dispatch<SetStateAction<string[]>>
  setRunning: Dispatch<SetStateAction<boolean>>
  setTaskStage: Dispatch<SetStateAction<TaskStage>>
  setWorkflowPlan: Dispatch<SetStateAction<TaskWorkflowPlan | undefined>>
  setWorkflowProgress: Dispatch<SetStateAction<TaskWorkflowProgress | undefined>>
  setWorkflowStage: Dispatch<SetStateAction<TaskWorkflowStage | undefined>>
  showToast: (message: string, tone?: 'success' | 'error') => void
  updateQueueItem: (id: string, updater: QueueItemUpdater) => void
}

function taskLogLabel(event: Pick<TaskEvent, 'command'>): string {
  const label = taskDisplayMeta({ command: event.command }).label
  return label ? `任务 ${label}` : '任务'
}

function bgmFailureMessage(workflowProgress: TaskWorkflowProgress | undefined): string {
  const message = workflowProgress?.label || '背景音乐处理失败，请查看日志'
  const value = message.trim()
  return !value || /[。！？.!?]$/.test(value) ? value : `${value}。`
}

export function useTaskEventSubscription({
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
  onSuccessfulPlanClose,
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
}: TaskEventSubscriptionOptions) {
  const stoppingRef = useRef(false)
  const latestScriptImportRef = useRef<{
    queueId: string
    report: NonNullable<TaskQueueItem['scriptImport']>
  } | null>(null)

  useEffect(() => window.videoAutoCut.onTaskEvent((event: TaskEvent) => {
    const activeQueueId = activeQueueItemIdRef.current
    const eventWorkflowStage = normalizeWorkflowStage(event.workflowStage)
    const eventWorkflowPlan = normalizeWorkflowPlan(event.workflowPlan)
    const eventWorkflowProgress = normalizeWorkflowProgress(
      event.workflowProgress,
      eventWorkflowStage || workflowStageRef.current,
    )
    if (eventWorkflowPlan) applyWorkflowPlan(eventWorkflowPlan, activeQueueId)
    if (eventWorkflowStage) applyWorkflowStage(eventWorkflowStage, eventWorkflowProgress, activeQueueId)
    else if (eventWorkflowProgress) applyWorkflowProgress(eventWorkflowProgress, activeQueueId)

    if (event.type === 'start') {
      stoppingRef.current = false
      latestScriptImportRef.current = null
      const stage = inferTaskStageFromCommand(event.command)
      const fallbackWorkflowStage = fallbackWorkflowStageForCommand(event.command)
      const task = createRunningTaskFromEvent(event)
      currentTaskRef.current = task
      runningRef.current = true
      taskStageRef.current = stage
      workflowStageRef.current = eventWorkflowStage || fallbackWorkflowStage
      workflowPlanRef.current = eventWorkflowPlan
      workflowProgressRef.current = eventWorkflowProgress
      setCurrentTask(task)
      setRunning(true)
      setTaskStage(stage)
      setWorkflowStage(eventWorkflowStage || fallbackWorkflowStage)
      setWorkflowPlan(eventWorkflowPlan)
      setWorkflowProgress(eventWorkflowProgress)

      const line = `>>> ${taskLogLabel(event)} ${event.command || ''}\n`
      setLogs((items) => items.concat(line))
      if (activeQueueId) {
        updateQueueItem(activeQueueId, (item) => reduceTaskQueueEvent(item, {
          type: 'start',
          event,
          fallbackWorkflowStage,
          line,
          task,
          workflowStage: eventWorkflowStage,
          workflowPlan: eventWorkflowPlan,
          workflowProgress: eventWorkflowProgress,
        }))
      }
    }

    if (event.type === 'stopping') {
      stoppingRef.current = true
      const line = `\n正在停止${taskLogLabel(event)}...\n`
      setLogs((items) => items.concat(line))
      if (activeQueueId) {
        updateQueueItem(activeQueueId, (item) => reduceTaskQueueEvent(item, {
          type: 'stopping',
          line,
        }))
      }
    }

    if (event.text || event.scriptImport) {
      if (event.text) setLogs((items) => items.concat(event.text || ''))
      if (activeQueueId && event.scriptImport) {
        latestScriptImportRef.current = { queueId: activeQueueId, report: event.scriptImport }
      }
      const nextTask = mergeRunningTaskEvent(currentTaskRef.current, event)
      currentTaskRef.current = nextTask
      setCurrentTask(nextTask)

      if (activeQueueId) {
        updateQueueItem(activeQueueId, (item) => reduceTaskQueueEvent(item, {
          type: 'output',
          event,
          task: nextTask,
        }))
      }

      const eventStage = event.command ? inferTaskStageFromCommand(event.command) : taskStageRef.current
      if (event.text && eventStage === 'plan' && shouldRefreshPlanPreview(event)) {
        scheduleTimeout(() => {
          const activeQueueItem = activeQueueId
            ? queueItemsRef.current.find((item) => item.id === activeQueueId)
            : null
          const loadPreview = (!activeQueueId || selectedQueueIdRef.current === activeQueueId)
            && !activeQueueItem?.autoContinueToGenerate
            ? loadAndApplyShotPlan('current', nextTask)
            : loadTaskShotPlan(nextTask, 'current')

          loadPreview.then((next) => {
            if (activeQueueId && next.shots.length) {
              updateQueueItem(activeQueueId, (item) => ({
                ...item,
                previewReady: true,
                message: '分镜已整理完成。',
              }))
            }
          }).catch(() => undefined)
        }, 500)
      }

      if (event.text && eventStage === 'generate' && shouldRefreshMaterialPreview(event, workflowStageRef.current)) {
        scheduleMaterialPreviewRefresh(nextTask, activeQueueId)
      }
    }

    if (event.type === 'close') {
      let automaticContinuationQueued = false
      const cancelled = stoppingRef.current
      const stage = event.command ? inferTaskStageFromCommand(event.command) : taskStageRef.current
      const {
        workflowStage: closeWorkflowStage,
        workflowPlan: closeWorkflowPlan,
        workflowProgress: closeWorkflowProgress,
      } = resolveClosedWorkflowState({
        code: event.code,
        cancelled,
        eventWorkflowStage,
        eventWorkflowPlan,
        currentWorkflowStage: workflowStageRef.current,
        currentWorkflowPlan: workflowPlanRef.current,
        currentWorkflowProgress: workflowProgressRef.current,
      })
      const closedTask = closeRunningTask(currentTaskRef.current, event)
      const line = `\n${taskLogLabel(event)}结束，退出码：${event.code}\n`
      currentTaskRef.current = closedTask
      setCurrentTask(closedTask)
      runningRef.current = false
      setRunning(false)
      workflowStageRef.current = closeWorkflowStage
      workflowPlanRef.current = closeWorkflowPlan
      workflowProgressRef.current = closeWorkflowProgress
      setWorkflowStage(closeWorkflowStage)
      setWorkflowPlan(closeWorkflowPlan)
      setWorkflowProgress(closeWorkflowProgress)
      setLogs((items) => items.concat(line))

      if (activeQueueId) {
        const currentItem = queueItemsRef.current.find((item) => item.id === activeQueueId)
        const latestScriptImport = latestScriptImportRef.current?.queueId === activeQueueId
          ? latestScriptImportRef.current.report
          : undefined
        const closedQueueItem = currentItem ? reduceTaskQueueEvent(latestScriptImport
          ? { ...currentItem, scriptImport: latestScriptImport }
          : currentItem, {
          type: 'close',
          event,
          finishedAt: new Date().toISOString(),
          line,
          task: closedTask,
          workflowStage: closeWorkflowStage,
          workflowPlan: closeWorkflowPlan,
          workflowProgress: closeWorkflowProgress,
        }) : null

        if (closedQueueItem) {
          updateQueueItem(activeQueueId, () => closedQueueItem)
          if (
            event.code === 0
            && !cancelled
            && stage === 'plan'
            && closedQueueItem.autoContinueToGenerate
            && onSuccessfulPlanClose
          ) {
            automaticContinuationQueued = true
            const sourceMode = normalizeMaterialSourceMode(closedQueueItem.materialSourceMode, closedQueueItem.preferLocalMaterials)
            showToast(sourceMode === 'pexels-only'
              ? '分镜已整理，正在准备从 Pexels 下载素材。'
              : sourceMode === 'library-only'
                ? '分镜已整理，正在匹配本地和云端素材。'
                : '分镜已整理，正在优先匹配本地和云端素材。')
            scheduleTimeout(() => {
              void onSuccessfulPlanClose(closedQueueItem).catch((error) => {
                const message = `素材准备失败：${error instanceof Error ? error.message : String(error)}`
                updateQueueItem(activeQueueId, (item) => ({
                  ...item,
                  status: 'failed',
                  autoContinueToGenerate: false,
                  message,
                  logs: item.logs.concat(`\n${message}\n`),
                }))
                showToast(message)
              }).finally(() => {
                scheduleTimeout(() => startNextQueueItemRef.current(), 100)
              })
            }, 0)
          } else if (selectedQueueIdRef.current === activeQueueId) {
            const resultMessage = closedQueueItem.status === 'paused'
              ? '任务已暂停，可编辑草稿后继续。'
              : taskResultToast(stage, closeWorkflowStage, closeWorkflowProgress, event.code, closedQueueItem.scriptImport?.blocked.length)
            void notifyTaskClose(
              () => loadAndApplyShotPlan('current', queueItemToTask(closedQueueItem)),
              showToast,
              resultMessage,
              event.code !== 0,
            )
          } else if (event.code !== 0) {
            showToast(closeWorkflowProgress?.phase === 'cancelled'
              ? `${closedQueueItem.title} 已停止。`
              : closeWorkflowStage === 'bgm'
                ? `${closedQueueItem.title}：${bgmFailureMessage(closeWorkflowProgress)}`
                : `${closedQueueItem.title} 执行失败，请查看日志。`, 'error')
          }
        }
      } else {
        void notifyTaskClose(
          () => loadAndApplyShotPlan('current', closedTask),
          showToast,
          taskResultToast(stage, closeWorkflowStage, closeWorkflowProgress, event.code),
          event.code !== 0,
        )
      }

      latestScriptImportRef.current = null
      stoppingRef.current = false
      activeQueueItemIdRef.current = null
      taskStageRef.current = 'idle'
      setTaskStage('idle')
      if (!automaticContinuationQueued) {
        scheduleTimeout(() => startNextQueueItemRef.current(), 500)
      }
    }
  }), [
    activeQueueItemIdRef,
    applyWorkflowPlan,
    applyWorkflowProgress,
    applyWorkflowStage,
    currentTaskRef,
    loadAndApplyShotPlan,
    onSuccessfulPlanClose,
    queueItemsRef,
    runningRef,
    scheduleMaterialPreviewRefresh,
    scheduleTimeout,
    selectedQueueIdRef,
    setCurrentTask,
    setLogs,
    setRunning,
    setTaskStage,
    setWorkflowPlan,
    setWorkflowProgress,
    setWorkflowStage,
    showToast,
    startNextQueueItemRef,
    taskStageRef,
    updateQueueItem,
    workflowPlanRef,
    workflowProgressRef,
    workflowStageRef,
  ])
}
