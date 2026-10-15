import type { ReactNode } from 'react'

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  const label = subtitle ? `${title} - ${subtitle}` : title
  if (!action) return null
  return <header className="page-header page-header-actions-only" aria-label={label}>
    <div className="page-action">{action}</div>
  </header>
}
