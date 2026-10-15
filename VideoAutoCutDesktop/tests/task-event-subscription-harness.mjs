import React from 'react'
import { registerHooks } from 'node:module'

let resolverRegistered = false

async function loadSubscriptionHook() {
  if (!resolverRegistered) {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try {
          return nextResolve(specifier, context)
        } catch (error) {
          if (specifier.startsWith('.') && !/\.[A-Za-z0-9]+$/.test(specifier)) {
            return nextResolve(`${specifier}.ts`, context)
          }
          throw error
        }
      },
    })
    resolverRegistered = true
  }
  return import('../src/pages/start/useTaskEventSubscription.ts')
}

export function createSubscriptionQueueItem(overrides = {}) {
  return {
    id: 'queue-u6',
    mode: 'plan',
    title: '转换演示_v1表格.xlsx',
    status: 'running',
    createdAt: '2026-09-28T12:39:10.000Z',
    downloadNewMaterials: false,
    autoContinueToGenerate: false,
    scriptPath: 'D:\\fixtures\\转换演示_v1表格.xlsx',
    pid: 4100,
    command: 'python normalize_script.py --plan-only',
    workflowStage: 'script',
    workflowPlan: ['script', 'plan'],
    workflowProgress: { stage: 'script', status: 'running', phase: 'normalizing' },
    startedAt: '2026-09-28T12:39:10.010Z',
    message: '正在导入脚本',
    logs: ['>>> 任务 导入脚本\n'],
    ...overrides,
  }
}

export async function runTaskEventSubscriptionScenario({
  initialQueueItem = createSubscriptionQueueItem(),
  outputEvent,
  overwriteRefWithStaleItem = true,
  followupQueueItem,
}) {
  const { useTaskEventSubscription } = await loadSubscriptionHook()
  const activeQueueItemIdRef = { current: initialQueueItem.id }
  const currentTaskRef = {
    current: {
      pid: initialQueueItem.pid,
      command: initialQueueItem.command,
      status: 'running',
      startedAt: initialQueueItem.startedAt,
    },
  }
  const queueItemsRef = { current: [initialQueueItem] }
  const runningRef = { current: true }
  const selectedQueueIdRef = { current: null }
  const startNextQueueItemRef = { current: () => undefined }
  const taskStageRef = { current: 'plan' }
  const workflowPlanRef = { current: initialQueueItem.workflowPlan }
  const workflowProgressRef = { current: initialQueueItem.workflowProgress }
  const workflowStageRef = { current: initialQueueItem.workflowStage }
  let subscriber
  let cleanup

  const reactInternals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const previousDispatcher = reactInternals.H
  const previousWindow = globalThis.window
  reactInternals.H = {
    useRef(initialValue) {
      return { current: initialValue }
    },
    useEffect(create) {
      cleanup = create()
    },
  }
  globalThis.window = {
    videoAutoCut: {
      onTaskEvent(callback) {
        subscriber = callback
        return () => undefined
      },
    },
  }

  const updateQueueItem = (id, updater) => {
    const next = queueItemsRef.current.map((item) => {
      if (item.id !== id) return item
      return typeof updater === 'function' ? updater(item) : { ...item, ...updater }
    })
    queueItemsRef.current = next
  }

  try {
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
      applyWorkflowPlan: () => undefined,
      applyWorkflowProgress: () => undefined,
      applyWorkflowStage: () => undefined,
      loadAndApplyShotPlan: async () => ({ shots: [] }),
      scheduleMaterialPreviewRefresh: () => undefined,
      scheduleTimeout: () => 0,
      setCurrentTask: () => undefined,
      setLogs: () => undefined,
      setRunning: () => undefined,
      setTaskStage: () => undefined,
      setWorkflowPlan: () => undefined,
      setWorkflowProgress: () => undefined,
      setWorkflowStage: () => undefined,
      showToast: () => undefined,
      updateQueueItem,
    })
    if (typeof subscriber !== 'function') throw new Error('task event subscriber was not registered')

    if (outputEvent) subscriber(outputEvent)
    if (overwriteRefWithStaleItem) queueItemsRef.current = [initialQueueItem]
    subscriber({
      type: 'close',
      code: 2,
      pid: initialQueueItem.pid,
      command: initialQueueItem.command,
    })
    const firstClosed = structuredClone(queueItemsRef.current[0])
    if (!followupQueueItem) return firstClosed

    queueItemsRef.current = [followupQueueItem]
    activeQueueItemIdRef.current = followupQueueItem.id
    subscriber({
      type: 'start',
      pid: followupQueueItem.pid,
      command: followupQueueItem.command,
    })
    subscriber({
      type: 'close',
      code: 1,
      pid: followupQueueItem.pid,
      command: followupQueueItem.command,
    })
    return {
      firstClosed,
      followupClosed: structuredClone(queueItemsRef.current[0]),
    }
  } finally {
    if (typeof cleanup === 'function') cleanup()
    reactInternals.H = previousDispatcher
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
}
