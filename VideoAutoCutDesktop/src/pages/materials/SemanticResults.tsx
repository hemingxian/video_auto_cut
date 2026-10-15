import { EmptyState } from '../../components/common/EmptyState'
import { VideoCard } from '../../components/common/VideoCard'
import { formatSize } from '../../lib/format'
import { basename } from '../../lib/path'
import type { MaterialCardItem } from '../../types/app'
import type { SemanticSearchResult } from '../../types/videoauto'
import { findSemanticLocalVideo } from './materialCards'
import type {
  RequestMaterialActions,
  RequestMaterialPreview,
} from './materialItemActionsModel'
import type { ResolvedSemanticVideo } from './types'

export function SemanticResults({
  results,
  loading,
  message,
  allCards,
  onPreview,
  onRequestActions,
}: {
  results: SemanticSearchResult[]
  loading: boolean
  message: string
  allCards: MaterialCardItem[]
  onPreview: RequestMaterialPreview
  onRequestActions: RequestMaterialActions
}) {
  if (loading) return <div className="loading-line">正在查询向量数据库...</div>
  if (message && results.length === 0) return <EmptyState title="语义搜索没有结果" description={message} />
  if (results.length === 0) return <EmptyState title="等待语义搜索" description="语义搜索只负责查找已入库的视频素材，不会剪辑视频。" />

  return <div className="semantic-video-grid">
    {results.map((item) => {
      const video = findSemanticLocalVideo(item, allCards)
      return <SemanticVideoCard
        key={`${item.rank}-${item.text}`}
        item={item}
        video={video}
        onPreview={onPreview}
        onRequestActions={onRequestActions}
      />
    })}
  </div>
}

function SemanticVideoCard({
  item,
  video,
  onPreview,
  onRequestActions,
}: {
  item: SemanticSearchResult
  video: ResolvedSemanticVideo | null
  onPreview: RequestMaterialPreview
  onRequestActions: RequestMaterialActions
}) {
  const score = Number.isFinite(item.score) ? item.score.toFixed(2) : String(item.score || '-')

  return <VideoCard
    className="semantic-video-card"
    videoUrl={video?.url}
    filePath={video?.path}
    badge={`#${item.rank} · ${score}`}
    title={basename(video?.name || item.name, '未命名视频')}
    placeholder="未定位本地视频"
    meta={<>
      {video ? <span>{video.size ? formatSize(video.size) : '本地视频'}</span> : <span>向量结果</span>}
      <span>{item.start && item.end ? `${item.start} - ${item.end}` : '完整视频'}</span>
    </>}
    onClick={video ? () => onPreview(video) : undefined}
    showOpenFolderAction={false}
    onContextMenu={video ? (x, y) => onRequestActions({ type: 'file', file: video }, x, y) : undefined}
  />
}
