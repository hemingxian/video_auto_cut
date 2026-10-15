import { CircleX, CloudOff, FileUp, FileVideo, FolderClosed, FolderInput, FolderPlus, FolderUp, Globe2, HardDrive, Info, Pause, Pencil, Play, Trash2, Undo2 } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'

import { CloseButton } from '../../components/common/CloseButton'
import { cx } from '../../lib/className'
import {
  createMaterialDetails,
  getMaterialMenuPosition,
  materialMenuItemsFor,
  materialFileExtension,
  materialRenameValue,
  materialTargetKey,
  materialTargetName,
  validateMaterialRenameStem,
  type MaterialActionTarget,
  type MaterialMenuAction,
  type MaterialMenuRequest,
} from './materialItemActionsModel'

type MaterialDialog = {
  kind: 'details' | 'rename'
  target: MaterialActionTarget
}

const menuIcons = {
  details: Info,
  create_folder: FolderPlus,
  import_files: FileUp,
  import_folder: FolderUp,
  rename: Pencil,
  move: FolderInput,
  pause_upload: Pause,
  resume_upload: Play,
  cancel_upload: CircleX,
  sync_analysis: FileUp,
  restore_analysis: Undo2,
  publish: Globe2,
  withdraw_publication: Undo2,
  delete_local_copy: HardDrive,
  delete_cloud_copy: CloudOff,
  delete: Trash2,
} satisfies Record<MaterialMenuAction, typeof Info>

function MaterialContextMenu({
  request,
  busy,
  onChoose,
  onClose,
}: {
  request: MaterialMenuRequest
  busy: boolean
  onChoose: (action: MaterialMenuAction) => void
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const items = materialMenuItemsFor(request.target)
  const targetKey = materialTargetKey(request.target)
  const position = getMaterialMenuPosition(
    request.x,
    request.y,
    window.innerWidth,
    window.innerHeight,
    items.length,
  )

  useEffect(() => {
    itemRefs.current[0]?.focus()

    const closeFromPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const closeFromKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const close = () => onClose()

    window.addEventListener('mousedown', closeFromPointer)
    window.addEventListener('keydown', closeFromKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', closeFromPointer)
      window.removeEventListener('keydown', closeFromKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
    }
  }, [onClose, targetKey])

  useEffect(() => {
    itemRefs.current[activeIndex]?.focus()
  }, [activeIndex])

  function moveActive(step: number) {
    setActiveIndex((current) => (current + step + items.length) % items.length)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveActive(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(-1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(items.length - 1)
    }
  }

  return createPortal(<div
    ref={menuRef}
    className="material-context-menu"
    role="menu"
    aria-label={`${materialTargetName(request.target)}操作`}
    style={{ left: position.left, top: position.top }}
    onContextMenu={(event) => event.preventDefault()}
    onKeyDown={handleKeyDown}
  >
    {items.map((item, index) => {
      const Icon = menuIcons[item.action]
      const disabled = busy && item.action !== 'details'
      return <button
          key={item.action}
          ref={(element) => { itemRefs.current[index] = element }}
          type="button"
          role="menuitem"
          tabIndex={activeIndex === index ? 0 : -1}
          className={cx(
            'material-context-menu-item',
            activeIndex === index && 'keyboard-active',
          )}
          disabled={disabled}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => onChoose(item.action)}
        >
          <Icon />
          <span>{item.label}</span>
        </button>
    })}
  </div>, document.body)
}

function useCloseDialogByEscape(onClose: () => void, disabled = false) {
  useEffect(() => {
    const closeFromKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !disabled) onClose()
    }
    window.addEventListener('keydown', closeFromKey)
    return () => window.removeEventListener('keydown', closeFromKey)
  }, [disabled, onClose])
}

function MaterialDetailsDialog({
  target,
  onClose,
}: {
  target: MaterialActionTarget
  onClose: () => void
}) {
  useCloseDialogByEscape(onClose)
  const details = createMaterialDetails(target)
  const isFolder = target.type === 'folder'
  const title = isFolder ? '文件夹详情' : '素材详情'

  return createPortal(<div
    className="setup-overlay material-action-overlay"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}
  >
    <section className="setup-dialog material-action-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="setup-head">
        <div>
          <Info className="title-icon" />
          <span>
            <strong>{title}</strong>
            <em>{isFolder ? '文件夹信息' : '视频文件信息'}</em>
          </span>
        </div>
        <CloseButton onClick={onClose} iconClassName="icon" />
      </div>

      <div className="setup-body material-action-body">
        <dl className="material-detail-list">
          {details.map((item) => <div className="material-detail-row" key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>)}
        </dl>
      </div>

      <div className="setup-footer">
        <button className="button" type="button" onClick={onClose}>关闭</button>
      </div>
    </section>
  </div>, document.body)
}

function MaterialRenameDialog({
  target,
  busy,
  onClose,
  onRename,
}: {
  target: MaterialActionTarget
  busy: boolean
  onClose: () => void
  onRename: (target: MaterialActionTarget, name: string) => Promise<boolean>
}) {
  const [name, setName] = useState(() => materialRenameValue(target))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const pending = busy || saving
  const extension = target.type === 'file' ? materialFileExtension(target.file) : ''
  const TargetIcon = target.type === 'folder' ? FolderClosed : FileVideo
  const targetName = materialTargetName(target)
  const title = target.type === 'folder' ? '重命名文件夹' : '重命名素材'
  useCloseDialogByEscape(onClose, pending)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const validationError = validateMaterialRenameStem(name, target.type)
    setError(validationError)
    if (validationError || pending) return

    setSaving(true)
    try {
      if (await onRename(target, name.trim())) onClose()
    } finally {
      setSaving(false)
    }
  }

  return createPortal(<div
    className="setup-overlay material-action-overlay"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose()
    }}
  >
    <form
      className="setup-dialog material-action-dialog material-rename-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onSubmit={handleSubmit}
    >
      <div className="setup-head">
        <div>
          <Pencil className="title-icon" />
          <span>
            <strong>{title}</strong>
            <em>{target.type === 'file' ? '文件格式保持不变' : '文件夹内容保持不变'}</em>
          </span>
        </div>
        <CloseButton disabled={pending} onClick={onClose} iconClassName="icon" />
      </div>

      <div className="setup-body material-action-body">
        <div className="material-rename-file">
          <TargetIcon />
          <span>{targetName}</span>
        </div>
        <label className="material-rename-field">
          <span>新名称</span>
          <span className={cx('material-rename-control', error && 'invalid')}>
            <input
              autoFocus
              value={name}
              maxLength={180}
              disabled={pending}
              aria-invalid={Boolean(error)}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setName(event.target.value)
                if (error) setError('')
              }}
            />
            {extension ? <em>{extension}</em> : null}
          </span>
          {error ? <small className="material-rename-error">{error}</small> : null}
        </label>
      </div>

      <div className="setup-footer material-action-footer">
        <button className="button" type="button" disabled={pending} onClick={onClose}>取消</button>
        <button className="button primary" type="submit" disabled={pending || !name.trim()}>
          {pending ? '处理中' : '保存'}
        </button>
      </div>
    </form>
  </div>, document.body)
}

export function MaterialItemActionLayer({
  request,
  deletingPaths,
  renamingPaths,
  cloudDeletingPaths,
  localDeletingPaths,
  uploadingPaths,
  publicationPendingPaths,
  onRequestClose,
  onCreateFolder,
  onImport,
  onDelete,
  onDeleteLocalCopy,
  onDeleteCloudCopy,
  onPublish,
  onWithdrawPublication,
  onControlUpload,
  onRetryAnalysisTransfer,
  onMove,
  onRename,
}: {
  request: MaterialMenuRequest | null
  deletingPaths: Set<string>
  renamingPaths: Set<string>
  cloudDeletingPaths: Set<string>
  localDeletingPaths: Set<string>
  uploadingPaths: Set<string>
  publicationPendingPaths: Set<string>
  onRequestClose: () => void
  onCreateFolder: (folder: Extract<MaterialActionTarget, { type: 'folder' }>['folder']) => void
  onImport: (
    folder: Extract<MaterialActionTarget, { type: 'folder' }>['folder'],
    selection: 'files' | 'folder',
  ) => void
  onDelete: (target: MaterialActionTarget) => void
  onDeleteLocalCopy: (target: MaterialActionTarget) => void
  onDeleteCloudCopy: (target: MaterialActionTarget) => void
  onPublish: (target: MaterialActionTarget) => void
  onWithdrawPublication: (target: MaterialActionTarget) => void
  onControlUpload: (target: MaterialActionTarget, action: 'pause' | 'resume' | 'cancel') => void
  onRetryAnalysisTransfer: (target: MaterialActionTarget, direction: 'upload' | 'download') => void
  onMove: (target: MaterialActionTarget) => void
  onRename: (target: MaterialActionTarget, name: string) => Promise<boolean>
}) {
  const [dialog, setDialog] = useState<MaterialDialog | null>(null)
  const requestKey = request ? materialTargetKey(request.target) : ''
  const dialogKey = dialog ? materialTargetKey(dialog.target) : ''
  const requestBusy = request
    ? deletingPaths.has(requestKey) || renamingPaths.has(requestKey)
      || cloudDeletingPaths.has(requestKey) || publicationPendingPaths.has(requestKey)
      || localDeletingPaths.has(requestKey)
      || uploadingPaths.has(requestKey)
    : false
  const dialogBusy = dialog
    ? deletingPaths.has(dialogKey) || renamingPaths.has(dialogKey)
      || cloudDeletingPaths.has(dialogKey) || publicationPendingPaths.has(dialogKey)
      || localDeletingPaths.has(dialogKey)
      || uploadingPaths.has(dialogKey)
    : false

  function choose(action: MaterialMenuAction) {
    if (!request) return
    const target = request.target
    onRequestClose()

    if (action === 'create_folder' && target.type === 'folder') {
      onCreateFolder(target.folder)
      return
    }
    if ((action === 'import_files' || action === 'import_folder') && target.type === 'folder') {
      onImport(target.folder, action === 'import_files' ? 'files' : 'folder')
      return
    }
    if (action === 'delete') {
      onDelete(target)
      return
    }
    if (action === 'delete_cloud_copy') {
      onDeleteCloudCopy(target)
      return
    }
    if (action === 'delete_local_copy') {
      onDeleteLocalCopy(target)
      return
    }
    if (action === 'publish') {
      onPublish(target)
      return
    }
    if (action === 'withdraw_publication') {
      onWithdrawPublication(target)
      return
    }
    if (action === 'pause_upload' || action === 'resume_upload' || action === 'cancel_upload') {
      onControlUpload(
        target,
        action === 'pause_upload' ? 'pause' : action === 'resume_upload' ? 'resume' : 'cancel',
      )
      return
    }
    if (action === 'move') {
      onMove(target)
      return
    }
    if (action === 'sync_analysis' || action === 'restore_analysis') {
      onRetryAnalysisTransfer(target, action === 'sync_analysis' ? 'upload' : 'download')
      return
    }
    if (action === 'details' || action === 'rename') setDialog({ kind: action, target })
  }

  return <>
    {request ? <MaterialContextMenu
      key={`${requestKey}:${request.x}:${request.y}`}
      request={request}
      busy={requestBusy}
      onChoose={choose}
      onClose={onRequestClose}
    /> : null}
    {dialog?.kind === 'details' ? <MaterialDetailsDialog
      target={dialog.target}
      onClose={() => setDialog(null)}
    /> : null}
    {dialog?.kind === 'rename' ? <MaterialRenameDialog
      target={dialog.target}
      busy={dialogBusy}
      onClose={() => setDialog(null)}
      onRename={onRename}
    /> : null}
  </>
}
