import { ChevronRight, FolderClosed, FolderInput } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { CloseButton } from '../../components/common/CloseButton'
import { cx } from '../../lib/className'
import { basename } from '../../lib/path'
import type { MaterialDirectoryKind, MaterialDirectoryListing } from '../../types/videoauto'

export function MaterialMoveDialog({
  blockedFolderId,
  count,
  label,
  destinationKind,
  destinationStorageScope,
  sourceFolderId,
  busy,
  onClose,
  onMove,
}: {
  blockedFolderId?: string
  count: number
  label: string
  destinationKind: Extract<MaterialDirectoryKind, 'user' | 'cloud'>
  destinationStorageScope?: 'user' | 'downloads'
  sourceFolderId: string
  busy: boolean
  onClose: () => void
  onMove: (destinationFolderId: string) => Promise<boolean>
}) {
  const [listing, setListing] = useState<MaterialDirectoryListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const pending = busy || submitting

  const loadFolder = useCallback(async (folderId?: string) => {
    setLoading(true)
    setError('')
    try {
      const next = await window.videoAutoCut.browseMaterials(folderId ? { folderId } : undefined)
      if (!folderId) {
        const destinationRoot = next.folders.find((folder) => (
          folder.kind === destinationKind && folder.canCreate
        ))
        if (!destinationRoot) throw new Error('没有找到可用的素材文件夹')
        setListing(await window.videoAutoCut.browseMaterials({ folderId: destinationRoot.id }))
      } else {
        setListing(next)
      }
    } catch (loadError) {
      console.error('[VideoAutoCut] load move destination failed', loadError)
      setError(loadError instanceof Error ? loadError.message : '读取目标文件夹失败')
    } finally {
      setLoading(false)
    }
  }, [destinationKind])

  useEffect(() => {
    void loadFolder()
  }, [loadFolder])

  useEffect(() => {
    const closeFromKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onClose()
    }
    window.addEventListener('keydown', closeFromKey)
    return () => window.removeEventListener('keydown', closeFromKey)
  }, [onClose, pending])

  async function submitMove() {
    if (!listing || pending || listing.current.id === sourceFolderId) return
    setSubmitting(true)
    setError('')
    try {
      if (await onMove(listing.current.id)) onClose()
      else setError('移动失败，请检查目标文件夹后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  const writableFolders = listing?.folders.filter((folder) => (
    folder.kind === destinationKind
    && folder.canCreate
    && (!destinationStorageScope || folder.storageScope === destinationStorageScope)
  )) || []
  const canSubmit = Boolean(
    listing?.current.kind === destinationKind
    && listing.current.canCreate
    && (!destinationStorageScope || listing.current.storageScope === destinationStorageScope)
    && listing.current.id !== sourceFolderId,
  )

  return createPortal(<div
    className="setup-overlay material-action-overlay"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose()
    }}
  >
    <section
      className="setup-dialog material-action-dialog material-move-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="移动素材"
    >
      <div className="setup-head">
        <div>
          <FolderInput className="title-icon" />
          <span>
            <strong>{count > 1 ? `移动 ${count} 个素材` : '移动到文件夹'}</strong>
            <em title={label}>{label}</em>
          </span>
        </div>
        <CloseButton disabled={pending} onClick={onClose} iconClassName="icon" />
      </div>

      <div className="setup-body material-action-body material-move-body">
        {listing ? <nav className="material-move-breadcrumbs" aria-label="目标文件夹路径">
          {listing.breadcrumbs.slice(1).map((item, index, items) => <span key={item.id}>
            {index ? <ChevronRight /> : null}
            <button
              type="button"
              disabled={pending || index === items.length - 1}
              onClick={() => void loadFolder(item.id)}
            >{basename(item.name, '素材文件夹')}</button>
          </span>)}
        </nav> : null}

        <div className={cx('material-move-folder-list', loading && 'is-loading')}>
          {loading ? <span className="material-move-status">正在读取文件夹...</span> : null}
          {!loading && error && !listing ? <span className="material-move-status error">{error}</span> : null}
          {!loading && listing && !writableFolders.length
            ? <span className="material-move-status">当前文件夹没有子文件夹</span>
            : null}
          {!loading ? writableFolders.map((folder) => {
            const blocked = folder.id === blockedFolderId
            return <button
              className="material-move-folder-row"
              key={folder.id}
              type="button"
              disabled={pending || blocked}
              title={blocked ? '不能移动到自身或其子文件夹' : undefined}
              onClick={() => void loadFolder(folder.id)}
            >
              <FolderClosed />
              <span>{basename(folder.name, '未命名文件夹')}</span>
              <ChevronRight />
            </button>
          }) : null}
        </div>
        {error && listing ? <p className="material-move-error">{error}</p> : null}
        {listing?.current.id === sourceFolderId
          ? <p className="material-move-hint">素材已经在当前文件夹中，请选择其他目标文件夹。</p>
          : null}
      </div>

      <div className="setup-footer material-action-footer">
        <button className="button" type="button" disabled={pending} onClick={onClose}>取消</button>
        <button className="button primary" type="button" disabled={!canSubmit || pending} onClick={() => void submitMove()}>
          {pending ? '正在移动' : '移动到此文件夹'}
        </button>
      </div>
    </section>
  </div>, document.body)
}
