import type { ReactNode } from 'react'
import { cx } from '../../lib/className'
import { PageHeader } from './PageHeader'

export function PageLayout({ title, subtitle, action, children, className, bodyClassName }: {
  title: string
  subtitle?: string
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return <div className={cx('page-fixed', className)}>
    <PageHeader title={title} subtitle={subtitle} action={action} />
    <div className={cx('page-body', bodyClassName)}>{children}</div>
  </div>
}