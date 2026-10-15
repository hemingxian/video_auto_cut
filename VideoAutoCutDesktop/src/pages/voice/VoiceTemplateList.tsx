import { FileAudio } from 'lucide-react'
import { EmptyState } from '../../components/common/EmptyState'
import { FileActionButton } from '../../components/common/FileActionButton'
import { cx } from '../../lib/className'
import { formatDate, formatSize } from '../../lib/format'
import type { FileItem } from '../../types/videoauto'

export function VoiceTemplateList({
  templates,
  selectedPath,
  onSelect,
}: {
  templates: FileItem[]
  selectedPath: string
  onSelect: (path: string) => void
}) {
  return <div className="template-list voice-template-list">
    {templates.length === 0 ? <EmptyState title="暂无声音模板" description="点击“添加音频”，选择 mp3 / wav / m4a 文件后即可创建音色。" /> : null}
    {templates.map((item) => <div key={item.path} className={cx('template-item voice-template-row', selectedPath === item.path && 'active')}>
      <button className="voice-template-select" onClick={() => onSelect(item.path)}>
        <FileAudio className="template-icon" />
        <span>
          <strong>{item.name}</strong>
          <small>{formatSize(item.size)} · {formatDate(item.mtime)}</small>
        </span>
      </button>
      <FileActionButton className="voice-play-button" file={item.path} kind="play" title="播放声音模板" />
    </div>)}
  </div>
}
