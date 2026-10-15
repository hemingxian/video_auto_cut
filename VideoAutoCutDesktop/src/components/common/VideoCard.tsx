import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'

import { openContainingFolder } from './fileActions'
import { previewVideoPause, previewVideoPlay } from './videoPreview'

export type VideoCardAction = {
  label: string
  icon?: ReactNode
  className?: string
  disabled?: boolean
  onClick: () => void
}

export type VideoCardProps = {
  videoUrl?: string
  filePath?: string
  badge?: string
  title: string
  meta?: ReactNode
  description?: string
  placeholder?: string
  className?: string
  onClick?: () => void
  onContextMenu?: (x: number, y: number) => void
  showOpenFolderAction?: boolean
  topActions?: VideoCardAction[]
}

export function VideoCard({
  videoUrl,
  filePath,
  badge,
  title,
  meta,
  description,
  placeholder = '未定位本地视频',
  className = '',
  onClick,
  onContextMenu,
  showOpenFolderAction = true,
  topActions,
}: VideoCardProps) {
  const resolvedTopActions: VideoCardAction[] = [
    ...(filePath && showOpenFolderAction ? [{
      label: '打开所在目录',
      icon: <FolderOpen className="action-icon" />,
      className: 'is-neutral',
      onClick: () => openContainingFolder(filePath),
    }] : []),
    ...(topActions || []),
  ]
  const clickable = Boolean(onClick)
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return
    if (onContextMenu && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      onContextMenu(rect.left + 12, rect.top + 12)
      return
    }
    if (!onClick || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onClick()
  }
  const stopCardClick = (event: MouseEvent) => event.stopPropagation()

  return <article
    className={`material-card video-card ${clickable ? 'is-clickable' : ''} ${className}`.trim()}
    role={clickable ? 'button' : undefined}
    tabIndex={clickable ? 0 : undefined}
    aria-haspopup={onContextMenu ? 'menu' : undefined}
    onClick={onClick}
    onContextMenu={onContextMenu ? (event) => {
      event.preventDefault()
      onContextMenu(event.clientX, event.clientY)
    } : undefined}
    onKeyDown={handleKeyDown}
  >
    <div className="video-thumb">
      {videoUrl ? <video src={videoUrl} muted preload="metadata" onMouseEnter={previewVideoPlay} onMouseLeave={previewVideoPause} /> : <div className="semantic-thumb-placeholder">{placeholder}</div>}
      {badge ? <span className="type-badge">{badge}</span> : null}
      {resolvedTopActions.length ? <div className="video-card-top-actions">
        {resolvedTopActions.map((action) => <button key={action.label} className={action.className} type="button" aria-label={action.label} disabled={action.disabled} onClick={(event) => { stopCardClick(event); action.onClick() }}>{action.icon}</button>)}
      </div> : null}
    </div>
    <div className="material-body">
      <h3 title={title}>{title}</h3>
      {meta ? <div className="material-meta">{meta}</div> : null}
      {description ? <div className="material-group" title={description}>{description}</div> : null}
    </div>
  </article>
}
