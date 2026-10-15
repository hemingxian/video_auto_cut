import { CheckCircle2, FileVideo2, LoaderCircle, XCircle } from 'lucide-react'
import { createPortal } from 'react-dom'

import { CloseButton } from '../../components/common/CloseButton'
import { formatSize } from '../../lib/format'
import type { MaterialImportProgressState } from './types'

export function MaterialImportProgressDialog({
  progress,
  onCancel,
  onClose,
}: {
  progress: MaterialImportProgressState | null
  onCancel: () => void
  onClose: () => void
}) {
  if (!progress) return null
  const active = ['copying', 'verifying', 'canceling'].includes(progress.status)
  const percent = progress.totalBytes > 0
    ? Math.min(100, Math.round(progress.bytesProcessed / progress.totalBytes * 100))
    : 0
  const title = progress.status === 'completed'
    ? '素材导入完成'
    : progress.status === 'canceled'
      ? '素材导入已取消'
      : progress.status === 'canceling'
        ? '正在取消导入'
        : progress.status === 'verifying'
          ? '正在校验素材'
          : '正在导入素材'
  const StatusIcon = progress.status === 'completed'
    ? CheckCircle2
    : progress.status === 'canceled'
      ? XCircle
      : LoaderCircle

  return createPortal(<div className="setup-overlay material-action-overlay">
    <section className="setup-dialog material-action-dialog material-import-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="setup-head">
        <div>
          <StatusIcon className={active ? 'title-icon material-import-spinner' : 'title-icon'} />
          <span>
            <strong>{title}</strong>
            <em>{progress.totalFiles ? `${progress.imported} / ${progress.totalFiles} 个已完成` : '准备导入'}</em>
          </span>
        </div>
        {!active ? <CloseButton onClick={onClose} iconClassName="icon" /> : null}
      </div>

      <div className="setup-body material-action-body material-import-body">
        <div className="material-import-current-file">
          <FileVideo2 />
          <span>
            <strong>{progress.fileName || '正在准备文件'}</strong>
            <em>{progress.fileIndex > 0 ? `第 ${progress.fileIndex} / ${progress.totalFiles} 个` : '正在计算导入大小'}</em>
          </span>
        </div>
        <div className="material-import-progress-meta">
          <span>{formatSize(progress.bytesProcessed)} / {formatSize(progress.totalBytes)}</span>
          <span>{active && progress.speedBytesPerSecond > 0 ? `${formatSize(progress.speedBytesPerSecond)}/s` : `${percent}%`}</span>
        </div>
        <span className="material-import-progress-track" aria-label={`导入进度 ${percent}%`}>
          <i style={{ width: `${percent}%` }} />
        </span>
        {progress.failed > 0 ? <p className="material-import-message error">{progress.failed} 个文件导入失败。{progress.message}</p> : null}
        {progress.status === 'completed' && progress.imported > 0
          ? <p className="material-import-message">已成功导入 {progress.imported} 个素材，分析将在后台继续。</p>
          : null}
        {progress.status === 'canceled'
          ? <p className="material-import-message">已完成的素材会保留，当前未完成的临时文件已清理。</p>
          : null}
      </div>

      <div className="setup-footer material-action-footer">
        {active
          ? <button className="button danger" type="button" disabled={progress.status === 'canceling'} onClick={onCancel}>
              {progress.status === 'canceling' ? '正在取消' : '取消导入'}
            </button>
          : <button className="button primary" type="button" onClick={onClose}>完成</button>}
      </div>
    </section>
  </div>, document.body)
}
