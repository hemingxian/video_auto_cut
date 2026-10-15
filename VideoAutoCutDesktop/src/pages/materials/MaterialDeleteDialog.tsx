import { AlertTriangle, Cloud, FileVideo2, FolderClosed, ListChecks, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { CloseButton } from '../../components/common/CloseButton'
import type { MaterialDeletionImpact } from '../../types/videoauto'
import type { MaterialActionFolder } from './materialItemActionsModel'

export type MaterialDeleteRequest =
  | { kind: 'files'; paths: string[]; label: string }
  | { kind: 'folder'; folder: MaterialActionFolder; label: string }

const emptyImpact: MaterialDeletionImpact = {
  ok: false,
  materialCount: 0,
  folderCount: 0,
  localFileCount: 0,
  cloudCopyCount: 0,
  publicMaterialCount: 0,
  taskReferenceCount: 0,
  canDelete: false,
  blockers: [],
}

function immediateFolderImpact(request: Extract<MaterialDeleteRequest, { kind: 'folder' }>): MaterialDeletionImpact {
  const videoCount = Math.max(0, request.folder.videoCount || 0)
  const cloudFolder = request.folder.kind === 'cloud'
  return {
    ok: true,
    materialCount: videoCount,
    folderCount: Math.max(1, 1 + (request.folder.folderCount || 0)),
    localFileCount: cloudFolder ? 0 : videoCount,
    cloudCopyCount: cloudFolder ? videoCount : 0,
    publicMaterialCount: 0,
    taskReferenceCount: 0,
    canDelete: true,
    blockers: [],
  }
}

export function MaterialDeleteDialog({
  request,
  busy,
  onClose,
  onDelete,
}: {
  request: MaterialDeleteRequest
  busy: boolean
  onClose: () => void
  onDelete: () => Promise<boolean>
}) {
  const [impact, setImpact] = useState<MaterialDeletionImpact>(() => (
    request.kind === 'folder' ? immediateFolderImpact(request) : emptyImpact
  ))
  const [loading, setLoading] = useState(request.kind === 'files')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const pending = busy || submitting

  const loadImpact = useCallback(async () => {
    if (request.kind === 'folder') {
      setImpact(immediateFolderImpact(request))
      setLoading(false)
      setError('')
      return
    }
    setLoading(true)
    setError('')
    try {
      const result = await window.videoAutoCut.previewMaterialDeletion(
        { paths: request.paths },
      )
      setImpact(result)
      if (!result.ok) setError(result.message || '删除影响检查失败')
    } catch (loadError) {
      console.error('[VideoAutoCut] preview material deletion failed', loadError)
      setImpact(emptyImpact)
      setError('删除影响检查失败，请稍后重试。')
    } finally {
      setLoading(false)
    }
  }, [request])

  useEffect(() => {
    void loadImpact()
  }, [loadImpact])

  useEffect(() => {
    const closeFromKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onClose()
    }
    window.addEventListener('keydown', closeFromKey)
    return () => window.removeEventListener('keydown', closeFromKey)
  }, [onClose, pending])

  async function confirmDelete() {
    if (loading || pending || !impact.ok || !impact.canDelete) return
    setSubmitting(true)
    setError('')
    try {
      if (await onDelete()) onClose()
      else setError('删除未完成，请查看提示后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  const cloudFolderDelete = request.kind === 'folder' && request.folder.kind === 'cloud'
  const items = [
    { icon: FileVideo2, label: '素材记录', value: `${impact.materialCount} 个` },
    { icon: FolderClosed, label: '文件夹', value: `${impact.folderCount} 个` },
    { icon: Trash2, label: cloudFolderDelete ? '保留本地文件' : '本地文件', value: `${impact.localFileCount} 个` },
    { icon: Cloud, label: cloudFolderDelete ? '保留 COS 文件' : '云端副本', value: `${impact.cloudCopyCount} 个` },
    { icon: ListChecks, label: '任务引用', value: `${impact.taskReferenceCount} 个任务` },
  ]

  return createPortal(<div
    className="setup-overlay material-action-overlay"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose()
    }}
  >
    <section
      className="setup-dialog material-action-dialog material-delete-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-label="确认删除素材"
    >
      <div className="setup-head">
        <div>
          <AlertTriangle className="title-icon material-delete-title-icon" />
          <span>
            <strong>确认删除</strong>
            <em title={request.label}>{request.label}</em>
          </span>
        </div>
        <CloseButton disabled={pending} onClick={onClose} iconClassName="icon" />
      </div>

      <div className="setup-body material-action-body material-delete-body">
        {loading ? <div className="material-delete-loading">正在检查删除影响...</div> : <>
          <p className="material-delete-summary">{cloudFolderDelete
            ? '只删除云端目录关系和素材数据库记录；COS 中的真实视频文件不会被删除。'
            : '删除后，本地素材记录会移除；已同步的数据将进入云端删除队列。'}</p>
          <div className="material-delete-impact-grid">
            {items.map((item) => <div key={item.label}>
              <item.icon />
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>)}
          </div>
          {impact.taskReferenceCount > 0 ? <p className="material-delete-warning">
            有 {impact.taskReferenceCount} 个任务仍引用这些素材。删除后任务配置会保留，但再次生成前需要重新选择素材。
          </p> : null}
          {impact.blockers.map((blocker) => <p className="material-delete-blocker" key={blocker}>{blocker}</p>)}
          {error ? <p className="material-delete-blocker">{error}</p> : null}
        </>}
      </div>

      <div className="setup-footer material-action-footer">
        <button className="button" type="button" disabled={pending} onClick={onClose}>取消</button>
        <button
          className="button danger"
          type="button"
          disabled={loading || pending || !impact.ok || !impact.canDelete}
          onClick={() => void confirmDelete()}
        >{pending ? '正在删除' : '确认删除'}</button>
      </div>
    </section>
  </div>, document.body)
}
