import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RunsPage } from '../src/pages/RunsPage'
import type { RunItem } from '../src/types/videoauto'
import '../src/style.css'

// Isolated review fixture: all task, file and deletion operations stay in memory.
function record(id: string, mtime: number, sourceRunId?: string): RunItem {
  return { id, projectName: '同名脚本', path: `C:/fixture/${id}`, shotsPath: `C:/fixture/${id}/shots.json`,
    logPath: `C:/fixture/${id}/run.log`, mtime, finalVideo: '', artifacts: [], sourceRunId }
}
let records = [record('preview', 9), record('generated', 3, 'preview'), record('independent', 1)]
const operations: string[] = []
window.confirm = (message) => { operations.push(message); return true }
window.videoAutoCut = {
  listRuns: async () => records,
  deleteRun: async (id: string) => { records = records.filter((run) => run.id !== id); operations.push(`deleted:${id}`); return { ok: true } },
  readFile: async (file: string) => `log:${file}`,
  openFolder: async () => {}, openFile: async () => {},
} as unknown as typeof window.videoAutoCut

function Review() {
  const [activity, setActivity] = useState<'running' | 'preparing' | 'idle'>('running')
  const [restored, setRestored] = useState('')
  const [, redraw] = useState(0)
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <div className="button-row" style={{ padding: 12 }}>
      <button onClick={() => setActivity('running')}>模拟生成中</button>
      <button onClick={() => setActivity('preparing')}>模拟素材准备</button>
      <button onClick={() => setActivity('idle')}>模拟暂停</button>
      <output aria-label="测试状态">{JSON.stringify({ activity, restored, operations })}</output>
    </div>
    <RunsPage busy={activity !== 'idle'}
      protectedTasks={activity === 'running' ? [{ runId: 'generated', runPath: 'C:/fixture/generated', shotsJson: 'C:/fixture/preview/shots.json' }]
        : activity === 'preparing' ? [{ runId: 'preview', runPath: 'C:/fixture/preview' }] : []}
      onRestore={(run) => setRestored(run.id)} onDeleted={() => redraw((value) => value + 1)} />
  </div>
}
createRoot(document.getElementById('root')!).render(<Review />)
