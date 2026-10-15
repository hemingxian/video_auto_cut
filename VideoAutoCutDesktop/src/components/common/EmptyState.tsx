import { Video } from 'lucide-react'

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="empty-state">
    <div className="empty-icon"><Video className="icon" /></div>
    <div className="empty-title">{title}</div>
    <div className="empty-desc">{description}</div>
  </div>
}
