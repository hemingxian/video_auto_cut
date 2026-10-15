import { Trash2 } from 'lucide-react'
import type { VideoCardAction } from './VideoCard'

export function deleteAction(onClick: () => void, disabled = false): VideoCardAction {
  return { label: '删除', icon: <Trash2 className="action-icon" />, disabled, onClick }
}
