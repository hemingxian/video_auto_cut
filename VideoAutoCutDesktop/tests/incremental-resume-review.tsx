import { createRoot } from 'react-dom/client'
import { useStartTaskController } from '../src/pages/start/useStartTaskController'
import type { RunItem, TaskEvent } from '../src/types/videoauto'
import '../src/style.css'

const run: RunItem = { id: 'run_original', path: 'C:/fixture/run_original', projectName: '局部续跑测试', mtime: 1,
  shotsPath: 'C:/fixture/run_original/shots.json', logPath: '', finalVideo: '', artifacts: [] }
const root = { schema_version: 2, task_revision: 1, material_source_mode: 'library-first', topic: 'Test', shots: [
  { shot_id: 'a', voice_text: 'Original first shot', query_optimized: true, download_material: true, material_bindings: [] },
  { shot_id: 'b', voice_text: 'Unchanged second shot', query_optimized: true, download_material: true, material_bindings: [] },
] }
const text = JSON.stringify(root)
const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('')
const files = new Map<string, string>([
  [run.shotsPath, text], [`${run.path}/checkpoint.json`, JSON.stringify({ version: 1, plan_hash: hash })],
  [`${run.path}/incremental.json`, '{"schema_version":1,"records":{}}'],
])
let draft: Record<string, unknown> = { taskId: run.id, revision: 1, snapshot: root, updatedAt: '2026-09-15T00:00:00Z' }
let listener: (event: TaskEvent) => void = () => {}
const calls: Array<Record<string, unknown>> = []
window.videoAutoCut = {
  taskStatus: async () => ({ running: false }),
  onTaskEvent: (handler: typeof listener) => { listener = handler; return () => {} },
  listRuns: async () => [run], readFile: async (path: string) => files.get(path) || '',
  writeFile: async (path: string, value: string) => { files.set(path, value) },
  loadTaskDraft: async () => draft,
  saveTaskDraft: async (input: { expectedRevision: number; snapshot: unknown }) => {
    if (input.expectedRevision !== draft.revision) throw new Error('revision mismatch')
    draft = { taskId: run.id, revision: input.expectedRevision + 1, snapshot: input.snapshot, updatedAt: new Date().toISOString() }
    return draft
  },
  autoResolveShotMaterials: async (input: { shots: unknown[]; reuseUnchanged: boolean }) => {
    calls.push({ operation: 'resolve', ...input }); return { ok: true, shots: input.shots, matched: 0, fallback: input.shots.length }
  },
  prepareGenerationManifest: async (input: Record<string, unknown>) => {
    calls.push({ operation: 'manifest', ...input }); return { manifestPath: 'C:/fixture/manifests/run_new_generation.json' }
  },
  startTask: async (options: Record<string, unknown>) => {
    calls.push({ operation: 'start', ...options })
    const event = { type: 'start', pid: 12, runId: run.id, runPath: run.path, command: 'engine --resume-run C:/fixture/run_original' } as TaskEvent
    listener(event)
    return { ok: true, ...event }
  },
} as unknown as typeof window.videoAutoCut

function Review() {
  const task = useStartTaskController()
  return <div style={{ padding: 24 }}>
    <button onClick={() => task.restoreRun(run)}>恢复中断任务</button>
    <button onClick={() => task.updateShotField(0, 'voice_text', 'Edited first shot')}>修改第一镜</button>
    <button onClick={() => task.saveShots()}>保存修改</button>
    <button onClick={() => task.generateVideo()} disabled={task.running}>继续生成</button>
    <button onClick={() => files.delete(`${run.path}/incremental.json`)}>模拟旧任务</button>
    <output aria-label="续跑测试状态">{JSON.stringify({ running: task.running, dirty: task.dirty, toast: task.toast, shots: task.shots, calls })}</output>
  </div>
}
createRoot(document.getElementById('root')!).render(<Review />)
