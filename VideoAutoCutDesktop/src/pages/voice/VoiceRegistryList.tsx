import { CheckCircle2 } from 'lucide-react'
import { EmptyState } from '../../components/common/EmptyState'
import { FileActionButton } from '../../components/common/FileActionButton'
import { cx } from '../../lib/className'
import type { VoiceRegistryItem } from '../../types/videoauto'

export function VoiceRegistryList({
  voices,
  currentVoiceId,
  onApply,
}: {
  voices: VoiceRegistryItem[]
  currentVoiceId: string
  onApply: (voiceId: string) => void
}) {
  return <div className="voice-id-list">
    {voices.length === 0 ? <EmptyState title="暂无音色 ID" description="创建音色成功后，会在这里显示声音模板和 voice_id 的对应关系。" /> : null}
    {voices.map((item) => {
      const isCurrent = item.voice_id === currentVoiceId
      return <article key={item.voice_id} className={cx('voice-id-card', isCurrent && 'current')}>
        <div className="voice-id-main">
          <strong title={item.voice_id}>{item.voice_id}</strong>
          <span title={item.template_path || item.template_name}>{item.template_name || '声音模板'}</span>
          <small>{item.target_model || '默认模型'} · {item.created_at || '未记录时间'}</small>
        </div>
        <div className="voice-id-actions">
          {isCurrent ? <span className="voice-current-badge"><CheckCircle2 className="action-icon" />当前使用</span> : <button onClick={() => onApply(item.voice_id)}>设为当前</button>}
          {item.template_path ? <FileActionButton file={item.template_path} kind="play" /> : null}
        </div>
      </article>
    })}
  </div>
}
