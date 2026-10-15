import { VideoCard } from '../../components/common/VideoCard'
import { openFilePath } from '../../components/common/fileActions'
import { deleteAction } from '../../components/common/videoCardActions'
import type { GeneratedMaterialRecord } from '../../types/videoauto'
import { engineLabel } from './materialGeneration'

export function GeneratedMaterialCard({
  record,
  deleting,
  onDelete,
}: {
  record: GeneratedMaterialRecord
  deleting: boolean
  onDelete: () => void
}) {
  const videoUrl = `file://${record.output_path.replaceAll('\\', '/')}`

  return <VideoCard
    className="generated-material-card"
    videoUrl={videoUrl}
    filePath={record.output_path}
    badge={engineLabel(record.engine)}
    title={record.title || record.prompt}
    meta={<><span>AI 生成</span><span>{record.duration ? `${record.duration}s` : '自动时长'}</span></>}
    description={record.prompt || record.created_at}
    onClick={() => openFilePath(record.output_path)}
    topActions={[
      deleteAction(onDelete, deleting),
    ]}
  />
}
