import { FolderPlus } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { CloseButton } from '../../components/common/CloseButton'
import { cx } from '../../lib/className'
import { validateMaterialRenameStem } from './materialItemActionsModel'

export function MaterialFolderCreateDialog({
  parentName,
  busy,
  onClose,
  onCreate,
  parents,
}: {
  parentName: string
  busy: boolean
  onClose: () => void
  onCreate: (name: string, parentId?: string) => Promise<boolean>
  parents?: Array<{ id: string; name: string }>
}) {
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState(parents?.[0]?.id || '')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const pending = busy || submitting

  useEffect(() => {
    const closeFromKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onClose()
    }
    window.addEventListener('keydown', closeFromKey)
    return () => window.removeEventListener('keydown', closeFromKey)
  }, [onClose, pending])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const validationError = validateMaterialRenameStem(name, 'folder')
    setError(validationError)
    if (validationError || pending) return

    setSubmitting(true)
    try {
      if (await onCreate(name.trim(), parentId)) onClose()
    } finally {
      setSubmitting(false)
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
      aria-label="新建文件夹"
      onSubmit={handleSubmit}
    >
      <div className="setup-head">
        <div>
          <FolderPlus className="title-icon" />
          <span>
            <strong>新建文件夹</strong>
            <em>创建到「{parentName}」</em>
          </span>
        </div>
        <CloseButton disabled={pending} onClick={onClose} iconClassName="icon" />
      </div>

      <div className="setup-body material-action-body">
        {parents?.length ? <label className="material-rename-field">
          <span>保存位置</span>
          <select value={parentId} disabled={pending} onChange={(event) => setParentId(event.target.value)}>
            {parents.map((parent) => <option key={parent.id} value={parent.id}>{parent.name}</option>)}
          </select>
        </label> : null}
        <label className="material-rename-field">
          <span>文件夹名称</span>
          <span className={cx('material-rename-control', error && 'invalid')}>
            <input
              autoFocus
              value={name}
              maxLength={180}
              disabled={pending}
              aria-invalid={Boolean(error)}
              placeholder="请输入文件夹名称"
              onChange={(event) => {
                setName(event.target.value)
                if (error) setError('')
              }}
            />
          </span>
          {error ? <small className="material-rename-error">{error}</small> : null}
        </label>
      </div>

      <div className="setup-footer material-action-footer">
        <button className="button" type="button" disabled={pending} onClick={onClose}>取消</button>
        <button className="button primary" type="submit" disabled={pending || !name.trim()}>
          {pending ? '创建中' : '创建'}
        </button>
      </div>
    </form>
  </div>, document.body)
}
