import type { RunningTask, TaskEvent } from '../../types/videoauto'
import type {
  TaskQueueItem,
  TaskWorkflowPlan,
  TaskWorkflowProgress,
  TaskWorkflowStage,
} from './types'

interface TaskWorkflowEventState {
  workflowStage?: TaskWorkflowStage
  workflowPlan?: TaskWorkflowPlan
  workflowProgress?: TaskWorkflowProgress
}

interface StartQueueAction extends TaskWorkflowEventState {
  type: 'start'
  event: TaskEvent
  fallbackWorkflowStage: TaskWorkflowStage
  line: string
  task: RunningTask
}

interface OutputQueueAction {
  type: 'output'
  event: TaskEvent
  task: RunningTask
}

interface StoppingQueueAction {
  type: 'stopping'
  line: string
}

interface CloseQueueAction extends TaskWorkflowEventState {
  type: 'close'
  event: TaskEvent
  finishedAt: string
  line: string
  task: RunningTask
}

export type TaskQueueEventAction =
  | StartQueueAction
  | OutputQueueAction
  | StoppingQueueAction
  | CloseQueueAction

export function fallbackWorkflowStageForCommand(command = ''): TaskWorkflowStage {
  if (command.includes('--plan-only')) return 'script'
  return command.includes('--shots-json') ? 'query' : 'script'
}

export function createRunningTaskFromEvent(
  event: TaskEvent,
  startedAt = new Date().toISOString(),
): RunningTask {
  return {
    pid: event.pid,
    command: event.command,
    runId: event.runId,
    runPath: event.runPath,
    startedAt,
    status: 'running',
  }
}

export function mergeRunningTaskEvent(current: RunningTask | null, event: TaskEvent): RunningTask {
  return {
    ...(current || {}),
    pid: event.pid || current?.pid,
    command: event.command || current?.command,
    runId: event.runId || current?.runId,
    runPath: event.runPath || current?.runPath,
    status: 'running',
  }
}

export function closeRunningTask(current: RunningTask | null, event: TaskEvent): RunningTask {
  return {
    ...(current || {}),
    pid: event.pid || current?.pid,
    command: event.command || current?.command,
    code: event.code,
    runId: event.runId || current?.runId,
    runPath: event.runPath || current?.runPath,
    status: 'done',
  }
}

export function resolveClosedWorkflowState({
  code,
  cancelled = false,
  eventWorkflowStage,
  eventWorkflowPlan,
  currentWorkflowStage,
  currentWorkflowPlan,
  currentWorkflowProgress,
}: {
  code?: number
  cancelled?: boolean
  eventWorkflowStage?: TaskWorkflowStage
  eventWorkflowPlan?: TaskWorkflowPlan
  currentWorkflowStage?: TaskWorkflowStage
  currentWorkflowPlan?: TaskWorkflowPlan
  currentWorkflowProgress?: TaskWorkflowProgress
}): TaskWorkflowEventState {
  const workflowStage = eventWorkflowStage || (code === 0 ? 'done' : currentWorkflowStage)
  const workflowPlan = eventWorkflowPlan || currentWorkflowPlan
  const workflowProgress: TaskWorkflowProgress | undefined = code === 0
    ? undefined
    : {
      ...(currentWorkflowProgress || {}),
      ...(workflowStage ? { stage: workflowStage } : {}),
      status: 'failed',
      ...(cancelled
        ? { phase: 'cancelled', label: '任务已停止' }
        : currentWorkflowProgress?.label
          ? {}
          : { label: '执行失败' }),
    }

  return { workflowStage, workflowPlan, workflowProgress }
}

export function reduceTaskQueueEvent(item: TaskQueueItem, action: TaskQueueEventAction): TaskQueueItem {
  switch (action.type) {
    case 'start':
      return {
        ...item,
        status: 'running',
        pid: action.event.pid,
        command: action.event.command || item.command,
        runId: action.event.runId || item.runId,
        runPath: action.event.runPath || item.runPath,
        workflowStage: action.workflowStage || item.workflowStage || action.fallbackWorkflowStage,
        workflowPlan: action.workflowPlan || item.workflowPlan,
        workflowProgress: action.workflowProgress,
        startedAt: item.startedAt || action.task.startedAt,
        logs: item.logs.concat(action.line),
      }
    case 'stopping':
      return {
        ...item,
        message: '正在停止当前任务',
        logs: item.logs.concat(action.line),
      }
    case 'output':
      return {
        ...item,
        ...(action.event.runId || action.event.runPath
          ? {
            pid: action.task.pid,
            command: action.task.command,
            runId: action.task.runId,
            runPath: action.task.runPath,
          }
          : {}),
        ...(action.event.scriptImport ? { scriptImport: action.event.scriptImport } : {}),
        logs: action.event.text ? item.logs.concat(action.event.text) : item.logs,
      }
    case 'close':
      return {
        ...item,
        status: item.pauseRequested ? 'paused' : action.event.code === 0 ? 'done' : 'failed',
        code: action.event.code,
        pid: action.task.pid,
        command: action.task.command,
        runId: action.task.runId,
        runPath: action.task.runPath,
        workflowStage: action.workflowStage,
        workflowPlan: action.workflowPlan,
        workflowProgress: action.workflowProgress,
        finishedAt: action.finishedAt,
        message: action.event.code === 0
          ? '任务已完成'
          : action.workflowProgress?.phase === 'cancelled'
            ? '任务已停止'
            : action.workflowStage === 'bgm'
              ? action.workflowProgress?.label || '背景音乐处理失败，请查看日志'
              : '任务执行失败，请查看日志',
        logs: item.logs.concat(action.line),
      }
  }
}
