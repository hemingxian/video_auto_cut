import type { ReactNode } from 'react'
import { cx } from '../../lib/className'

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('panel', className)}>{children}</section>
}
