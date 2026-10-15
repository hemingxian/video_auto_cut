import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { DownloadCloud, Film, FolderOpen, MessageSquareText, Scissors, Search } from 'lucide-react'

import { CategoryTabs } from '../../components/common/CategoryTabs'
import { EmptyState } from '../../components/common/EmptyState'
import { openContainingFolder, openFilePath } from '../../components/common/fileActions'
import { previewVideoPause, previewVideoPlay } from '../../components/common/videoPreview'
import { cx } from '../../lib/className'
import { formatSize } from '../../lib/format'
import type { RunArtifact } from '../../types/videoauto'
import { shotText } from './shotPlan'
import type { ShotMaterialBoardModel, ShotMaterialRow } from './shotArtifacts'
import type { MaterialMode } from './types'

const MAX_VISIBLE_ARTIFACTS = 6
type ShotDetailTab = 'brief' | 'candidate' | 'clip' | 'unmatched'
type ArtifactVariant = 'candidate' | 'clip' | 'unmatched'

const artifactVariantLabels: Record<ArtifactVariant, string> = {
  candidate: '候选',
  clip: '剪辑',
  unmatched: '未关联',
}

type ShotMaterialBoardProps = {
  board: ShotMaterialBoardModel
  materialMode: MaterialMode
  message: string
}

function artifactPath(item: RunArtifact) {
  return (item.relativePath || item.name || '').replace(/\\/g, '/')
}

function cleanArtifactText(value: string) {
  return value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
}

function artifactTitle(item: RunArtifact) {
  const name = item.name || artifactPath(item).split('/').filter(Boolean).pop() || '视频片段'
  const stem = name.replace(/\.[^.]+$/, '')
  const finalMatch = stem.match(/^(\d{3,4})_final$/i)
  if (finalMatch) return `剪辑片段 ${finalMatch[1]}`

  return cleanArtifactText(stem.replace(/^match[_-]?(\d+)[_-]?/i, '匹配 $1 · '))
}

function artifactLocation(item: RunArtifact) {
  const parts = artifactPath(item).split('/').filter(Boolean)
  const parent = parts.length > 1 ? parts[parts.length - 2] : ''
  if (!parent || parent === '_indexed_h264') return ''

  return cleanArtifactText(parent.replace(/^shot[_-]?(\d+)[_-]?/i, '分镜 $1 · '))
}

function ArtifactItem({ item, variant }: { item: RunArtifact; variant: ArtifactVariant }) {
  const openVideo = () => openFilePath(item.path)
  const revealVideo = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    openContainingFolder(item.path)
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openVideo()
  }
  const title = artifactTitle(item)
  const location = artifactLocation(item)
  const sourceTitle = item.relativePath || item.name

  return <article className="shot-artifact-item is-clickable" role="button" tabIndex={0} onClick={openVideo} onKeyDown={handleKeyDown}>
    <div className="shot-artifact-preview">
      <video src={item.url} muted preload="metadata" onMouseEnter={previewVideoPlay} onMouseLeave={previewVideoPause} />
      <div className="video-card-top-actions">
        <button className="is-neutral" type="button" aria-label="打开所在目录" onClick={revealVideo}>
          <FolderOpen className="action-icon" />
        </button>
      </div>
      <div className="shot-artifact-overlay">
        <span>{artifactVariantLabels[variant]}</span>
        <em>{formatSize(item.size)}</em>
      </div>
    </div>
    <div className="shot-artifact-main">
      <strong title={sourceTitle}>{title}</strong>
      {location ? <span title={sourceTitle}>{location}</span> : null}
    </div>
  </article>
}

function ArtifactGrid({
  title,
  empty,
  items,
  variant,
}: {
  title: string
  empty: string
  items: RunArtifact[]
  variant: 'candidate' | 'clip'
}) {
  const visible = items.slice(0, MAX_VISIBLE_ARTIFACTS)
  const extraCount = items.length - visible.length

  return <section className="shot-artifact-grid-section">
    <div className="shot-artifact-grid-head">
      <span>{variant === 'candidate' ? <DownloadCloud className="icon" /> : <Scissors className="icon" />}{title}</span>
      <em>{items.length}</em>
    </div>
    {items.length
      ? <div className="shot-artifact-grid">
        {visible.map((item) => <ArtifactItem key={item.path} item={item} variant={variant} />)}
        {extraCount > 0 ? <div className="shot-artifact-more">还有 {extraCount} 个片段，可在任务目录查看</div> : null}
      </div>
      : <div className="shot-artifact-empty">{empty}</div>}
  </section>
}

function QueryLine({
  icon,
  label,
  text,
}: {
  icon: ReactNode
  label: string
  text: string
}) {
  if (!text) return null
  return <div className="shot-query-field">
    <div className="shot-query-field-head">
      {icon}
      <strong>{label}</strong>
    </div>
    <div className="shot-query-value"><span>{text}</span></div>
  </div>
}

function ShotRowButton({
  active,
  row,
  onClick,
}: {
  active: boolean
  row: ShotMaterialRow
  onClick: () => void
}) {
  const voice = shotText(row.shot.voice_text)

  return <button type="button" className={cx('shot-row-item', active && 'active')} onClick={onClick}>
    <span className="shot-row-index">{String(row.shotNo).padStart(2, '0')}</span>
    <span className="shot-row-main">
      <strong title={row.title}>{row.title}</strong>
      <em>{voice || row.downloadQuery || row.visualQuery || '等待分镜内容'}</em>
    </span>
    <span className="shot-row-meta">
      {row.timing ? <em>{row.timing}</em> : null}
      <span>{row.candidateArtifacts.length} 候选</span>
      <span>{row.clipArtifacts.length} 剪辑</span>
    </span>
  </button>
}

function UnmatchedArtifacts({ title, items }: { title: string; items: RunArtifact[] }) {
  if (!items.length) return null
  const visible = items.slice(0, 8)

  return <section className="shot-unmatched-artifacts">
    <div className="shot-unmatched-head">
      <strong>{title}</strong>
      <span>{items.length} 个</span>
    </div>
    <div className="shot-unmatched-list">
      {visible.map((item) => <ArtifactItem key={item.path} item={item} variant="unmatched" />)}
    </div>
    {items.length > visible.length ? <div className="shot-artifact-more">还有 {items.length - visible.length} 个未展开</div> : null}
  </section>
}

function ShotDetail({
  board,
  materialMode,
  row,
}: {
  board: ShotMaterialBoardModel
  materialMode: MaterialMode
  row: ShotMaterialRow
}) {
  const [activeTab, setActiveTab] = useState<ShotDetailTab>('brief')
  const materialEmpty = materialMode === 'download' ? '等待下载候选素材' : '等待素材库匹配'
  const voice = shotText(row.shot.voice_text)
  const unmatchedCount = board.unmatchedCandidates.length + board.unmatchedClips.length
  const tabs: Array<{ id: ShotDetailTab; label: string; count?: number }> = [
    { id: 'brief', label: '分镜内容' },
    { id: 'candidate', label: '候选片段', count: row.candidateArtifacts.length },
    { id: 'clip', label: '剪辑片段', count: row.clipArtifacts.length },
    { id: 'unmatched', label: '未关联', count: unmatchedCount },
  ]

  return <div className="shot-detail-pane">
    <div className="shot-detail-head">
      <div>
        <span className="shot-detail-index">{String(row.shotNo).padStart(2, '0')}</span>
        <div>
          <strong title={row.title}>{row.title}</strong>
          {row.timing ? <span>{row.timing}</span> : null}
        </div>
      </div>
      <div className="shot-material-counts">
        <span>{row.candidateArtifacts.length} 候选</span>
        <span>{row.clipArtifacts.length} 剪辑</span>
      </div>
    </div>

    <CategoryTabs className="shot-detail-tabs" items={tabs} active={activeTab} onChange={setActiveTab} />

    <div className={cx('shot-detail-tab-content', activeTab === 'brief' && 'is-brief')}>
      {activeTab === 'brief' ? <div className="shot-query-grid">
        <QueryLine icon={<MessageSquareText className="icon" />} label="口播文案" text={voice} />
        <QueryLine icon={<Search className="icon" />} label="素材搜索词" text={row.downloadQuery} />
        <QueryLine icon={<Film className="icon" />} label="画面要求" text={row.visualQuery} />
        <QueryLine icon={<Scissors className="icon" />} label="剪辑要求" text={row.requirements} />
        {!voice && !row.downloadQuery && !row.visualQuery && !row.requirements ? <div className="shot-detail-empty">暂无分镜内容</div> : null}
      </div> : null}

      {activeTab === 'candidate' ? <ArtifactGrid title="候选片段" empty={materialEmpty} items={row.candidateArtifacts} variant="candidate" /> : null}

      {activeTab === 'clip' ? <ArtifactGrid title="剪辑片段" empty="等待剪辑输出" items={row.clipArtifacts} variant="clip" /> : null}

      {activeTab === 'unmatched' ? <div className="shot-unmatched-grid">
        {unmatchedCount ? <>
          <UnmatchedArtifacts title="未关联候选片段" items={board.unmatchedCandidates} />
          <UnmatchedArtifacts title="未关联剪辑片段" items={board.unmatchedClips} />
        </> : <div className="shot-detail-empty">暂无未关联片段</div>}
      </div> : null}
    </div>
  </div>
}

export function ShotMaterialBoard({ board, materialMode, message }: ShotMaterialBoardProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const safeSelectedIndex = Math.min(selectedIndex, Math.max(0, board.rows.length - 1))
  const selectedRow = board.rows[safeSelectedIndex]

  if (!board.rows.length) {
    return <EmptyState
      title="暂无分镜"
      description={message || '预览分镜或生成视频后，会在这里逐行显示分镜和对应素材。'}
    />
  }

  return <div className="shot-workspace">
    <aside className="shot-row-panel">
      <div className="shot-material-summary">
        <div><strong>{board.rows.length}</strong><span>分镜</span></div>
        <div><strong>{board.boundShotCount}</strong><span>已绑定素材的分镜</span></div>
        <div><strong>{board.candidateCount}</strong><span>下载候选片段</span></div>
        <div><strong>{board.clipCount}</strong><span>剪辑片段</span></div>
      </div>
      <div className="shot-row-list">
        {board.rows.map((row, index) => <ShotRowButton
          key={`${row.shotNo}-${index}`}
          active={safeSelectedIndex === index}
          row={row}
          onClick={() => setSelectedIndex(index)}
        />)}
      </div>
    </aside>

    {selectedRow ? <ShotDetail board={board} materialMode={materialMode} row={selectedRow} /> : null}
  </div>
}
