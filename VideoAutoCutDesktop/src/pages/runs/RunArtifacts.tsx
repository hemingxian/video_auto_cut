import { File, FileAudio, FileText, Image } from 'lucide-react'
import { useMemo, useState } from 'react'
import { CategoryTabs } from '../../components/common/CategoryTabs'
import { EmptyState } from '../../components/common/EmptyState'
import { FileActionButton } from '../../components/common/FileActionButton'
import { openFilePath } from '../../components/common/fileActions'
import { VideoCard } from '../../components/common/VideoCard'
import { deleteAction } from '../../components/common/videoCardActions'
import { formatDate, formatSize } from '../../lib/format'
import type { RunArtifact } from '../../types/videoauto'
import type { ArtifactGroup, ArtifactKind } from './artifacts'
import { groupArtifacts } from './artifacts'

function ArtifactKindIcon({ kind }: { kind: string }) {
  if (kind === '音频') return <FileAudio className="icon" />
  if (kind === '字幕' || kind === '数据') return <FileText className="icon" />
  if (kind === '图片') return <Image className="icon" />
  return <File className="icon" />
}

export function RunArtifacts({
  artifacts,
  deletingPaths,
  onDelete,
}: {
  artifacts: RunArtifact[]
  deletingPaths: Set<string>
  onDelete: (item: RunArtifact) => void
}) {
  const [activeKind, setActiveKind] = useState<ArtifactKind>('全部')
  const { visible, groupList } = useMemo(() => groupArtifacts(artifacts), [artifacts])
  const total = visible.length
  const tabs: Array<{ kind: ArtifactKind; count: number }> = [
    { kind: '全部', count: total },
    ...groupList.map((group) => ({ kind: group.kind, count: group.items.length })),
  ]
  const displayedGroups = activeKind === '全部'
    ? groupList.filter((group) => group.items.length > 0)
    : groupList.filter((group) => group.kind === activeKind)

  return <section className="run-artifacts categorized">
    <div className="run-artifacts-head">
      <strong>产出文件</strong>
      <span>{total} 个</span>
    </div>
    <CategoryTabs
      className="run-artifact-tabs"
      items={tabs.map((tab) => ({ id: tab.kind, label: tab.kind, count: tab.count }))}
      active={activeKind}
      onChange={setActiveKind}
    />
    {total === 0 ? <div className="run-artifacts-empty">暂无可展示文件</div> : <div className="run-artifact-groups">
      {displayedGroups.length === 0 ? <EmptyState title="没有这类文件" description="当前任务没有产出该分类文件。" /> : null}
      {displayedGroups.map((group) => <ArtifactGroupView
        deletingPaths={deletingPaths}
        group={group}
        key={group.kind}
        onDelete={onDelete}
        showTitle={activeKind === '全部'}
      />)}
    </div>}
  </section>
}

function ArtifactGroupView({
  deletingPaths,
  group,
  onDelete,
  showTitle,
}: {
  deletingPaths: Set<string>
  group: ArtifactGroup
  onDelete: (item: RunArtifact) => void
  showTitle: boolean
}) {
  if (group.items.length === 0) return null

  return <section className="artifact-group">
    {showTitle ? <div className="artifact-group-title">
      <span>{group.kind}</span>
      <em>{group.items.length}</em>
    </div> : null}
    {group.kind === '视频' || group.kind === '成片' ? <div className="artifact-video-grid">
      {group.items.map((item) => <ArtifactVideoCard
        deleting={deletingPaths.has(item.path)}
        item={item}
        key={item.path}
        onDelete={onDelete}
      />)}
    </div> : <div className="run-artifact-list flat">
      {group.items.map((item) => <ArtifactListItem key={item.path} item={item} />)}
    </div>}
  </section>
}

function ArtifactVideoCard({
  deleting,
  item,
  onDelete,
}: {
  deleting: boolean
  item: RunArtifact
  onDelete: (item: RunArtifact) => void
}) {
  return <VideoCard
    badge={item.relativePath?.startsWith('output') ? '最终视频' : '视频'}
    className="artifact-video-card"
    filePath={item.path}
    meta={<><span>{formatSize(item.size)}</span><span>{formatDate(item.mtime)}</span></>}
    onClick={() => openFilePath(item.path)}
    title={item.relativePath || item.name}
    topActions={[deleteAction(() => onDelete(item), deleting)]}
    videoUrl={item.url}
  />
}

function ArtifactListItem({ item }: { item: RunArtifact }) {
  return <article className="run-artifact-item">
    <div className="artifact-icon"><ArtifactKindIcon kind={item.kind} /></div>
    <div className="artifact-main">
      <strong aria-label={item.relativePath || item.name}>{item.relativePath || item.name}</strong>
      <span>{item.kind} · {formatSize(item.size)} · {formatDate(item.mtime)}</span>
    </div>
    <div className="artifact-actions">
      <FileActionButton file={item.path} kind="open" />
      <FileActionButton file={item.path} kind="folder" />
    </div>
  </article>
}
