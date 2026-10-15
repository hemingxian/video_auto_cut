import { CheckCircle2, History, RefreshCw, Terminal } from 'lucide-react'

import { EmptyState } from '../components/common/EmptyState'
import { FileActionButton } from '../components/common/FileActionButton'
import { LogDrawer } from '../components/common/LogDrawer'
import { PageLayout } from '../components/common/PageLayout'
import { Panel } from '../components/common/Panel'
import { cx } from '../lib/className'
import { formatDate } from '../lib/format'
import { RunArtifacts } from './runs/RunArtifacts'
import { useRunsPageState } from './runs/useRunsPageState'
import type { RunActivityTarget } from './runs/runHistoryModel'
import type { RunItem } from '../types/videoauto'
import './runs/runHistory.css'

export function RunsPage({ onRestore, busy = false, protectedTasks = [], onDeleted }: { onRestore?: (run: RunItem) => void; busy?: boolean; protectedTasks?: readonly RunActivityTarget[]; onDeleted?: (id: string) => void }) {
  const { chooseRun, chooseRecord, deleteArtifact, deleteRun, deletingArtifactPaths, deletingRunPaths, log, logOpen, openLog, refresh, runs, selected, selectedGroup, selectedInUse, setLogOpen } = useRunsPageState(protectedTasks)

  return <PageLayout
    className="runs-page"
    bodyClassName="no-scroll"
    title="历史任务"
  >
    <div className="content-grid runs-grid">
      <Panel className="run-list-panel">
        <div className="panel-title"><History className="title-icon" />任务记录</div>
        <div className="run-list">
          {runs.length === 0 ? <EmptyState title="暂无任务" description="生成视频后会出现在这里。" /> : null}
          {runs.map((group) => <button key={group.key} className={cx('run-item', selectedGroup?.key === group.key && 'active')} onClick={() => chooseRun(group)}>
            <strong>{group.latest.projectName || group.latest.id}</strong>
            <span>{formatDate(group.mtime)}</span>
            {group.records.length > 1 ? <span className="run-history-count">{group.records.length} 次记录</span> : null}
            {group.completed ? <span className="run-done-badge" aria-label="已完成"><CheckCircle2 className="action-icon" />已完成</span> : null}
          </button>)}
        </div>
      </Panel>

      <section className={cx('run-detail-panel', !selected && 'is-empty')}>
        {selected ? <>
          <div className="detail-header">
            <div>
              <h2>{selected.projectName || selected.id}</h2>
              {selectedGroup && selectedGroup.records.length > 1 ? <label className="run-history-selector">
                <span>过程记录</span>
                <select aria-label="过程记录" value={selected.path} onChange={(event) => chooseRecord(event.target.value)}>
                  {selectedGroup.records.map((run) => <option key={run.path} value={run.path}>{run.sourceRunId ? '继续生成' : '原始记录'}{run.finalVideo ? ' · 已完成' : ''} · {formatDate(run.mtime)} · {run.id}</option>)}
                </select>
              </label> : null}
              <p className="run-detail-path">{selected.path}</p>
            </div>
            <div className="button-row">
              {onRestore ? <button className="button" disabled={busy || !selected.shotsPath} title={!selected.shotsPath ? '该任务尚未生成分镜，请重新导入原脚本' : busy ? '请先暂停当前任务' : undefined} onClick={() => onRestore(selected)}>恢复到工作台</button> : null}
              <button className="button" disabled={selectedInUse || deletingRunPaths.has(selected.path)} title={selectedInUse ? '本次记录正在运行或准备生成，请先暂停该任务' : undefined} onClick={async () => {
                const id = await deleteRun()
                if (id) onDeleted?.(id)
              }}>{selectedGroup && selectedGroup.records.length > 1 ? '删除本次记录' : '删除任务'}</button>
              <button className="button" onClick={refresh}><RefreshCw className="button-icon" />刷新</button>
              <FileActionButton className="button" file={selected.path} kind="folder" label="目录" />
              {selected.finalVideo ? <FileActionButton className="button primary" file={selected.finalVideo} kind="play" label="播放视频" /> : null}
              {selected.logPath ? <button className="button" onClick={openLog}><Terminal className="button-icon" />查看日志</button> : null}
            </div>
          </div>
          <RunArtifacts artifacts={selected.artifacts || []} deletingPaths={deletingArtifactPaths} onDelete={deleteArtifact} />
        </> : <EmptyState title="请选择任务" description="从左侧选择一条任务记录查看详情。" />}
      </section>
    </div>

    <LogDrawer
      open={Boolean(selected?.logPath && logOpen)}
      title="运行日志"
      subtitle={selected?.id}
      filePath={selected?.logPath}
      log={log}
      onClose={() => setLogOpen(false)}
    />
  </PageLayout>
}
