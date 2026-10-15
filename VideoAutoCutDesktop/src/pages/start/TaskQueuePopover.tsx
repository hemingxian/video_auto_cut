import { useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, Clock3, FileSpreadsheet, ListChecks, Square } from 'lucide-react'

import { LoadingSpinner } from '../../components/common/LoadingSpinner'
import { revealScript } from '../../components/common/fileActions'
import { cx } from '../../lib/className'
import type { TaskQueueItem } from './types'

type TaskQueuePopoverProps = {
  items: TaskQueueItem[]
  selectedId: string | null
  running: boolean
  onSelect: (id: string) => void
  onStop: () => void
  paused: boolean
  onPauseAll: () => void
  onContinue: () => void
  onResume: (id: string) => void
  onRemove: (id: string) => void
}

function statusLabel(item: TaskQueueItem) {
  if (item.status === 'paused') return '已暂停'
  if (item.status === 'queued') return '排队'
  if (item.mode === 'plan' && item.previewReady) return '分镜已就绪'
  if (item.status === 'running') return item.mode === 'plan' ? '整理中' : '生成中'
  if (item.status === 'failed') return '失败'
  return '完成'
}

function statusIcon(item: TaskQueueItem) {
  if (item.status === 'queued') return <Clock3 className="icon" />
  if (item.mode === 'plan' && item.previewReady) return <CheckCircle2 className="icon" />
  if (item.status === 'running') return <LoadingSpinner />
  if (item.status === 'failed') return <AlertCircle className="icon" />
  return <CheckCircle2 className="icon" />
}

export function TaskQueuePopover({ items, selectedId, running, onSelect, onStop, paused, onPauseAll, onContinue, onResume, onRemove }: TaskQueuePopoverProps) {
  const [open, setOpen] = useState(false)
  const counts = useMemo(() => ({
    queued: items.filter((item) => item.status === 'queued').length,
    running: items.filter((item) => item.status === 'running').length,
    failed: items.filter((item) => item.status === 'failed').length,
  }), [items])
  const summary = paused ? '队列已暂停' : counts.running
    ? '正在处理'
    : counts.queued
      ? `${counts.queued} 个排队`
      : items.length
        ? counts.failed ? `${counts.failed} 个失败` : '队列空闲'
        : '未添加任务'

  return <div className="task-queue-widget">
    <button className={cx('task-queue-trigger', open && 'is-open')} type="button" onClick={() => setOpen((value) => !value)}>
      <ListChecks className="button-icon" />
      <span>任务队列</span>
      <em>{items.length ? `${items.length} 个` : summary}</em>
      <ChevronDown className="button-icon task-queue-chevron" />
    </button>

    {open ? <>
      <button className="task-queue-popover-scrim" type="button" aria-label="关闭任务队列" onClick={() => setOpen(false)} />
      <section className="task-queue-popover" aria-label="任务队列">
        <div className="task-queue-head">
          <div>
            <strong>任务队列</strong>
            <span>{summary}</span>
          </div>
          {running ? <button className="text-button danger" type="button" onClick={onStop}>
            <Square className="button-icon" />暂停当前
          </button> : null}
          <button className="text-button" type="button" onClick={paused ? onContinue : onPauseAll}>
            {paused ? '继续队列' : '暂停全部'}
          </button>
        </div>

        <div className="task-queue-body">
          {items.length ? items.map((item) => <div key={item.id}>
          <button
            key={item.id}
            className={cx(
              'task-queue-row',
              `is-${item.status}`,
              item.mode === 'plan' && item.previewReady && 'is-preview-ready',
              selectedId === item.id && 'is-selected',
            )}
            type="button"
            onClick={() => onSelect(item.id)}
          >
            <span className="task-queue-status">{statusIcon(item)}</span>
            <span className="task-queue-main">
              <strong>{item.title}</strong>
              <span>{item.mode === 'plan' ? '预览分镜' : '生成视频'}{item.voiceScript ? ' · 口播稿' : ''} · {statusLabel(item)}</span>
            </span>
            <FileSpreadsheet className="task-queue-file-icon" />
          </button>
          {item.status === 'failed' && item.scriptImport?.blocked.length ? <div className="script-import-blocked-panel">
            <strong>{item.title}：导入被拦下，{item.scriptImport.blocked.length} 处{item.voiceScript ? '口播正文不一致' : '需在 Excel 里处理'}</strong>
            <ul>{item.scriptImport.blocked.map((issue, index) => <li key={`${issue.code}:${issue.cell || ''}:${index}`}>
              {issue.shot ? `第 ${issue.shot} 镜 · ` : ''}{issue.cell ? `${issue.cell} · ` : ''}{issue.column ? `${issue.column} · ` : ''}{issue.message}
              {issue.action ? ` -> ${issue.action}` : ''}
            </li>)}</ul>
            <span>{item.voiceScript ? '请重新选择脚本并核对口播正文，再点“预览分镜”。' : '改好后保存 Excel，再点“预览分镜”。'}</span>
            <button className="text-button" type="button" disabled={!item.scriptPath} onClick={() => revealScript(item.scriptPath || '')}>打开所在文件夹</button>
          </div> : null}
          {item.status !== 'running' ? <div className="button-row">
            {item.status === 'paused' || item.status === 'failed' ? <button className="text-button" disabled={running} onClick={() => onResume(item.id)}>继续执行</button> : null}
            <button className="text-button" onClick={() => onRemove(item.id)}>移出队列</button>
          </div> : null}
          </div>) : <div className="task-queue-empty">
            <span>还没有排队任务</span>
          </div>}
        </div>
      </section>
    </> : null}
  </div>
}
