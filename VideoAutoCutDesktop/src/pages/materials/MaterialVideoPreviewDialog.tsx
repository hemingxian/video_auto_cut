import { Film } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'

import { CloseButton } from '../../components/common/CloseButton'
import { basename } from '../../lib/path'
import { MaterialMediaPlayer } from './MaterialMediaPlayer'
import type { MaterialActionFile } from './materialItemActionsModel'

export function MaterialVideoPreviewDialog({
  file,
  onClose,
}: {
  file: MaterialActionFile | null
  onClose: () => void
}) {
  useEffect(() => {
    if (!file) return
    const closeFromKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeFromKey)
    return () => window.removeEventListener('keydown', closeFromKey)
  }, [file, onClose])

  if (!file) return null
  const name = basename(file.name, '未命名视频')

  return createPortal(<div
    className="setup-overlay material-video-preview-overlay"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}
  >
    <section
      className="setup-dialog material-video-preview-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={`预览视频：${name}`}
    >
      <div className="setup-head">
        <div>
          <Film className="title-icon" />
          <span>
            <strong>{name}</strong>
            <em>视频预览</em>
          </span>
        </div>
        <CloseButton onClick={onClose} iconClassName="icon" />
      </div>

      <div className="material-video-preview-stage">
        <MaterialMediaPlayer autoPlay focusOnMount key={file.url} src={file.url} title={name} />
      </div>

      <footer className="material-video-preview-shortcuts" aria-label="播放器快捷键">
        <span><kbd>空格</kbd>播放/暂停</span>
        <span><kbd>←</kbd><kbd>→</kbd>后退/前进 10 秒</span>
        <span><kbd>F</kbd>全屏</span>
        <span>双击画面进入全屏</span>
      </footer>
    </section>
  </div>, document.body)
}
