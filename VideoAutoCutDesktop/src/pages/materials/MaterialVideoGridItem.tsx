import { FileVideo, Play } from 'lucide-react'

import { basename } from '../../lib/path'
import type { FileItem } from '../../types/videoauto'
import type { RequestMaterialActions } from './materialItemActionsModel'
import { useLazyVideoPreview } from './useLazyVideoPreview'
import { formatVideoDuration } from './videoPreviewModel'

export function MaterialVideoGridItem({
  item,
  onPreview,
  onRequestActions,
}: {
  item: FileItem
  onPreview: (item: FileItem) => void
  onRequestActions?: RequestMaterialActions
}) {
  const name = basename(item.name, '未命名视频')
  const {
    activated,
    duration: durationSeconds,
    frameReady,
    handleError,
    handleLoadedMetadata,
    hostRef,
    loadFailed,
    setFrameReady,
    videoRef,
  } = useLazyVideoPreview()
  const duration = formatVideoDuration(durationSeconds)

  return <div
    className="material-icon-item is-video"
    ref={hostRef}
    onContextMenu={(event) => {
      event.preventDefault()
      onRequestActions?.({ type: 'file', file: item }, event.clientX, event.clientY)
    }}
  >
    <button
      className="material-icon-main"
      type="button"
      aria-haspopup={onRequestActions ? 'menu' : undefined}
      onClick={() => onPreview(item)}
      onKeyDown={(event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        onRequestActions?.({ type: 'file', file: item }, rect.left + 12, rect.top + 12)
      }}
    >
      <span className="material-icon-visual material-video-preview">
        {activated && !loadFailed ? <video
          ref={videoRef}
          className={frameReady ? 'is-ready' : ''}
          src={item.url}
          muted
          playsInline
          preload="metadata"
          onError={handleError}
          onLoadedData={() => setFrameReady(true)}
          onLoadedMetadata={handleLoadedMetadata}
          onSeeked={() => setFrameReady(true)}
        /> : null}
        {!frameReady || loadFailed ? <FileVideo className="material-browser-icon video" /> : null}
        {!loadFailed ? <span className="material-preview-toggle" aria-hidden="true"><Play /></span> : null}
        {duration ? <span className="material-preview-duration">{duration}</span> : null}
      </span>
      <span className="material-icon-name">{name}</span>
    </button>
  </div>
}
