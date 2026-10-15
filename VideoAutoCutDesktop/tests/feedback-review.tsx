import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useStartTaskController } from '../src/pages/start/useStartTaskController'
import { TaskQueuePopover } from '../src/pages/start/TaskQueuePopover'
import '../src/style.css'

// Isolated browser regression fixture. All engine, file and account operations are in memory.
let starts = 0
let active: Record<string, unknown> | null = null
let listener = (_event: Record<string, unknown>) => {}
const runs: any[] = []
const files = new Map<string, string>()
const drafts = new Map<string, any>()
const plan = () => ({ schema_version: 2, task_revision: 0, topic: '测试脚本', shots: [
  { shot_id: 'shot_a', title: '第一个分镜', voice_text: 'Original English sentence.', visual_query: 'robot', query_optimized: true, download_material: true, material_bindings: [] },
  { shot_id: 'shot_b', title: '第二个分镜', voice_text: 'Next conveyor.', visual_query: 'conveyor', query_optimized: true, download_material: true, material_bindings: [] },
] })
window.videoAutoCut = {
  taskStatus: async () => ({ running: false }),
  onTaskEvent: (callback: typeof listener) => { listener = callback; return () => { listener = () => {} } },
  listRuns: async () => runs,
  readFile: async (file: string) => files.get(file) || '',
  writeFile: async (file: string, value: string) => { files.set(file, value) },
  loadTaskDraft: async (id: string) => drafts.get(id) || null,
  saveTaskDraft: async (input: any) => {
    const revision = drafts.get(input.taskId)?.revision || 0
    if (input.expectedRevision !== revision) throw new Error('revision conflict')
    const draft = { ...input, revision: revision + 1, updatedAt: new Date().toISOString() }
    drafts.set(input.taskId, draft)
    return draft
  },
  autoResolveShotMaterials: async ({ shots }: any) => ({ shots, matched: 0, fallback: shots.length }),
  prepareGenerationManifest: async () => ({ manifestPath: 'C:/fixture/manifest.json' }),
  startTask: async (options: any) => {
    starts++
    const id = `run_${starts}`
    const runPath = `C:/fixture/${id}`
    const command = `"engine" ${options.planOnly ? '"--plan-only"' : ''} "--script-file" "test.xlsx"`
    const record = { id, projectName: '测试脚本', path: runPath, shotsPath: `${runPath}/shots.json`, finalVideo: '', logPath: '', artifacts: [], mtime: Date.now() }
    files.set(record.shotsPath, options.shotsJson ? files.get(options.shotsJson)! : JSON.stringify(plan()))
    runs.unshift(record)
    active = { pid: starts, command, runId: id, runPath }
    listener({ type: 'start', ...active })
    return { ok: true, ...active }
  },
  stopTask: async () => {
    listener({ type: 'stopping', ...active })
    listener({ type: 'close', ...active, code: 1 })
    active = null
    return { ok: true }
  },
} as any

function Review() {
  const task = useStartTaskController()
  const [, refresh] = useState(0)
  return <div style={{ padding: 28 }}>
    <h1>任务管理回归测试（内存模拟）</h1>
    <div className="button-row">
      <button onClick={() => task.updateScriptPaths(['C:/fixture/test.xlsx'])}>添加测试脚本</button>
      <button onClick={task.generateVideo} disabled={!task.canGenerate}>开始生成</button>
      <button onClick={() => { listener({ type: 'output', ...active, text: '已生成分镜' }); listener({ type: 'close', ...active, code: 0 }); active = null; refresh((n) => n + 1) }}>完成当前步骤</button>
      <button onClick={task.pauseQueue}>暂停全部</button>
      <button onClick={task.continueQueue}>继续队列</button>
      <button onClick={() => task.updateShotField(0, 'voice_text', 'Edited English sentence.')}>修改第一镜</button>
      <button onClick={() => task.saveShots()}>保存草稿</button>
      <button onClick={() => task.restoreRun(runs[0])}>恢复历史草稿</button>
    </div>
    <TaskQueuePopover items={task.queueItems} selectedId={task.selectedQueueId} running={task.running}
      onSelect={task.selectQueueItem} onStop={task.pauseCurrentTask} paused={task.queuePaused}
      onPauseAll={task.pauseQueue} onContinue={task.continueQueue} onResume={task.resumeQueueItem} onRemove={task.removeQueueItem} />
    <pre aria-label="测试状态">{JSON.stringify({ starts, running: task.running, paused: task.queuePaused, status: task.taskStatusLabel,
      items: task.queueItems.map(({ id, status, mode }) => ({ id, status, mode })), shots: task.shots, toast: task.toast }, null, 2)}</pre>
  </div>
}
createRoot(document.getElementById('root')!).render(<Review />)
