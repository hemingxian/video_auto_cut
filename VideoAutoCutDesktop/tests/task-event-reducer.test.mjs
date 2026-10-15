import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  closeRunningTask,
  createRunningTaskFromEvent,
  fallbackWorkflowStageForCommand,
  mergeRunningTaskEvent,
  reduceTaskQueueEvent,
  resolveClosedWorkflowState,
} from '../src/pages/start/taskEventReducer.ts'
import { extractWorkflowEvent } from '../electron/task-events.ts'
import {
  createSubscriptionQueueItem,
  runTaskEventSubscriptionScenario,
} from './task-event-subscription-harness.mjs'

const u6EventLine = (await readFile(new URL('./fixtures/u6-template-import-event.txt', import.meta.url), 'utf8')).trimEnd()
const legacyNonTemplateClose = JSON.parse(await readFile(new URL('./fixtures/non-template-close-legacy.json', import.meta.url), 'utf8'))

function queueItem(overrides = {}) {
  return {
    id: 'queue-1',
    mode: 'generate',
    title: 'demo.md',
    status: 'queued',
    createdAt: '2026-01-01T00:00:00.000Z',
    downloadNewMaterials: true,
    logs: ['existing\n'],
    ...overrides,
  }
}

test('a requested pause survives process exit, even if the process exits with zero', () => {
  for (const code of [0, 1]) {
    const paused = reduceTaskQueueEvent(queueItem({ status: 'running', pauseRequested: true, autoContinueToGenerate: false }), {
      type: 'close', event: { code }, task: {}, line: '', finishedAt: 'now',
    })
    assert.equal(paused.status, 'paused')
    assert.equal(paused.autoContinueToGenerate, false)
  }
})

test('start events create a running task and merge protocol state into its queue item', () => {
  const event = {
    type: 'start',
    pid: 42,
    command: 'engine --shots-json shots.json',
    runId: 'run-2',
    runPath: 'C:\\runs\\run-2',
  }
  const task = createRunningTaskFromEvent(event, '2026-01-02T00:00:00.000Z')
  assert.deepEqual(task, {
    pid: 42,
    command: event.command,
    runId: 'run-2',
    runPath: 'C:\\runs\\run-2',
    startedAt: '2026-01-02T00:00:00.000Z',
    status: 'running',
  })
  assert.equal(fallbackWorkflowStageForCommand(event.command), 'query')
  assert.equal(fallbackWorkflowStageForCommand('engine --plan-only'), 'script')

  const next = reduceTaskQueueEvent(queueItem(), {
    type: 'start',
    event,
    fallbackWorkflowStage: 'query',
    line: '>>> start\n',
    task,
    workflowPlan: ['script', 'plan', 'query', 'material', 'clip', 'compose'],
    workflowProgress: { stage: 'query', status: 'running' },
  })
  assert.equal(next.status, 'running')
  assert.equal(next.workflowStage, 'query')
  assert.equal(next.startedAt, task.startedAt)
  assert.deepEqual(next.logs, ['existing\n', '>>> start\n'])
})

test('output and stopping events preserve the existing queue merge semantics', () => {
  const currentTask = {
    pid: 10,
    command: 'old command',
    runId: 'old-run',
    runPath: 'C:\\old-run',
    status: 'running',
  }
  const textOnlyEvent = { type: 'stdout', text: 'progress\n', pid: 99, command: 'new command' }
  const textOnlyTask = mergeRunningTaskEvent(currentTask, textOnlyEvent)
  const textOnlyQueue = reduceTaskQueueEvent(queueItem({ pid: 10, command: 'old command' }), {
    type: 'output',
    event: textOnlyEvent,
    task: textOnlyTask,
  })
  assert.equal(textOnlyTask.pid, 99)
  assert.equal(textOnlyQueue.pid, 10)
  assert.equal(textOnlyQueue.command, 'old command')
  assert.deepEqual(textOnlyQueue.logs, ['existing\n', 'progress\n'])

  const identifiedEvent = { ...textOnlyEvent, runId: 'run-3', runPath: 'C:\\run-3' }
  const identifiedTask = mergeRunningTaskEvent(currentTask, identifiedEvent)
  const identifiedQueue = reduceTaskQueueEvent(textOnlyQueue, {
    type: 'output',
    event: identifiedEvent,
    task: identifiedTask,
  })
  assert.equal(identifiedQueue.pid, 99)
  assert.equal(identifiedQueue.command, 'new command')
  assert.equal(identifiedQueue.runId, 'run-3')

  const stopping = reduceTaskQueueEvent(identifiedQueue, { type: 'stopping', line: 'stopping\n' })
  assert.equal(stopping.message, '正在停止当前任务')
  assert.equal(stopping.logs.at(-1), 'stopping\n')
})

test('indexing logs reach the selected task without turning indexed files into selected clips', () => {
  const workflowProgress = { stage: 'clip', status: 'running', phase: 'indexing', current: 0, total: 1 }
  let item = queueItem({ status: 'running', workflowStage: 'clip', workflowProgress })
  for (const text of ['Indexing file 2/74: source.mp4\n', 'cache hit: reused analysis\n', '索引仍在处理：已运行 10 秒；当前文件完成 3/12（缓存 2）\n']) {
    item = reduceTaskQueueEvent(item, { type: 'output', event: { type: 'stdout', text }, task: {} })
  }
  assert.deepEqual(item.logs, ['existing\n', 'Indexing file 2/74: source.mp4\n', 'cache hit: reused analysis\n', '索引仍在处理：已运行 10 秒；当前文件完成 3/12（缓存 2）\n'])
  assert.deepEqual(item.workflowProgress, workflowProgress)
})

test('close events resolve successful and failed workflow snapshots deterministically', () => {
  assert.deepEqual(resolveClosedWorkflowState({
    code: 0,
    currentWorkflowStage: 'compose',
    currentWorkflowPlan: ['script', 'plan', 'compose'],
    currentWorkflowProgress: { stage: 'compose', status: 'running' },
  }), {
    workflowStage: 'done',
    workflowPlan: ['script', 'plan', 'compose'],
    workflowProgress: undefined,
  })

  const failedWorkflow = resolveClosedWorkflowState({
    code: 1,
    currentWorkflowStage: 'material',
    currentWorkflowProgress: { phase: 'downloading', current: 3, total: 10 },
  })
  assert.deepEqual(failedWorkflow.workflowProgress, {
    stage: 'material',
    status: 'failed',
    phase: 'downloading',
    current: 3,
    total: 10,
    label: '执行失败',
  })

  const event = { type: 'close', code: 1, pid: 42, runId: 'run-4' }
  const task = closeRunningTask({ command: 'engine', status: 'running' }, event)
  const closed = reduceTaskQueueEvent(queueItem({ status: 'running' }), {
    type: 'close',
    event,
    finishedAt: '2026-01-03T00:00:00.000Z',
    line: 'closed\n',
    task,
    ...failedWorkflow,
  })
  assert.equal(task.status, 'done')
  assert.equal(closed.status, 'failed')
  assert.equal(closed.finishedAt, '2026-01-03T00:00:00.000Z')
  assert.equal(closed.message, '任务执行失败，请查看日志')
  assert.equal(closed.logs.at(-1), 'closed\n')

  const failedBgmWorkflow = resolveClosedWorkflowState({
    code: 1,
    currentWorkflowStage: 'bgm',
    currentWorkflowPlan: ['script', 'plan', 'compose', 'bgm'],
    currentWorkflowProgress: {
      stage: 'bgm',
      status: 'failed',
      phase: 'unavailable',
      label: '未找到可用背景音乐，已保留原成片',
    },
  })
  const bgmClosed = reduceTaskQueueEvent(queueItem({ status: 'running' }), {
    type: 'close',
    event,
    finishedAt: '2026-01-03T00:00:00.000Z',
    line: 'closed\n',
    task,
    ...failedBgmWorkflow,
  })
  assert.equal(bgmClosed.workflowProgress?.phase, 'unavailable')
  assert.equal(bgmClosed.workflowProgress?.label, '未找到可用背景音乐，已保留原成片')
  assert.equal(bgmClosed.message, '未找到可用背景音乐，已保留原成片')

  const cancelledWorkflow = resolveClosedWorkflowState({
    code: 1,
    cancelled: true,
    currentWorkflowStage: 'bgm',
    currentWorkflowProgress: {
      stage: 'bgm',
      status: 'running',
      phase: 'downloading',
      label: '下载背景音乐',
    },
  })
  const cancelled = reduceTaskQueueEvent(queueItem({ status: 'running' }), {
    type: 'close',
    event,
    finishedAt: '2026-01-03T00:00:00.000Z',
    line: 'closed\n',
    task,
    ...cancelledWorkflow,
  })
  assert.equal(cancelled.workflowProgress?.phase, 'cancelled')
  assert.equal(cancelled.workflowProgress?.label, '任务已停止')
  assert.equal(cancelled.message, '任务已停止')
})

test('queue reducer preserves launch identity and gives explicit protocol state precedence', () => {
  const event = { type: 'start', pid: 77, command: 'engine --shots-json shots.json' }
  const task = createRunningTaskFromEvent(event, 'new-start-time')
  const started = reduceTaskQueueEvent(queueItem({
    startedAt: 'existing-start-time',
    workflowStage: 'script',
  }), {
    type: 'start',
    event,
    fallbackWorkflowStage: 'query',
    workflowStage: 'voice',
    workflowProgress: { stage: 'voice', status: 'running' },
    line: 'started\n',
    task,
  })
  assert.equal(started.startedAt, 'existing-start-time')
  assert.equal(started.workflowStage, 'voice')

  const workflow = resolveClosedWorkflowState({ code: 0, currentWorkflowStage: 'voice' })
  const closed = reduceTaskQueueEvent(started, {
    type: 'close',
    event: { type: 'close', code: 0 },
    finishedAt: 'finish-time',
    line: 'done\n',
    task: closeRunningTask(task, { type: 'close', code: 0 }),
    ...workflow,
  })
  assert.equal(closed.status, 'done')
  assert.equal(closed.workflowStage, 'done')
  assert.equal(closed.workflowProgress, undefined)
  assert.equal(closed.message, '任务已完成')
})

test('U6 output report survives an immediately following close after a stale ref overwrite', async () => {
  const decoded = extractWorkflowEvent(`${u6EventLine}\n`)
  assert.equal(decoded.scriptImport?.blocked.length, 2)
  assert.equal(decoded.scriptImport?.warnings.length, 53)

  const closed = await runTaskEventSubscriptionScenario({
    outputEvent: {
      type: 'stdout',
      pid: 4100,
      command: 'python normalize_script.py --plan-only',
      ...decoded,
    },
  })

  assert.deepEqual(closed.scriptImport, decoded.scriptImport)
})

test('non-template close remains field-for-field equal to the captured legacy hook result', async () => {
  const closed = await runTaskEventSubscriptionScenario({
    outputEvent: {
      type: 'stdout',
      text: '普通非模板输出\n',
      pid: 4100,
      command: 'python normalize_script.py --plan-only',
    },
  })
  closed.finishedAt = '<normalized>'
  assert.deepEqual(Object.keys(closed).sort(), legacyNonTemplateClose.ownKeys)
  assert.deepEqual(Object.keys(closed).filter((key) => closed[key] === undefined).sort(), legacyNonTemplateClose.undefinedKeys)
  assert.deepEqual(JSON.parse(JSON.stringify(closed)), legacyNonTemplateClose.values)
})

test('a closed U6 report does not leak into the next non-template task', async () => {
  const decoded = extractWorkflowEvent(`${u6EventLine}\n`)
  const followupQueueItem = createSubscriptionQueueItem({
    id: 'queue-non-template',
    title: 'ordinary.md',
    scriptPath: 'D:\\fixtures\\ordinary.md',
    pid: 4200,
  })
  const lifecycle = await runTaskEventSubscriptionScenario({
    outputEvent: {
      type: 'stdout',
      pid: 4100,
      command: 'python normalize_script.py --plan-only',
      ...decoded,
    },
    followupQueueItem,
  })

  assert.deepEqual(lifecycle.firstClosed.scriptImport, decoded.scriptImport)
  assert.equal(Object.hasOwn(lifecycle.followupClosed, 'scriptImport'), false)
})
