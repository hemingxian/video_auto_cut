import { Loader2 } from 'lucide-react'

import { cx } from '../../lib/className'

type LoadingSpinnerProps = {
  className?: string
}

export function LoadingSpinner({ className }: LoadingSpinnerProps) {
  return <Loader2 aria-hidden="true" className={cx('icon', 'is-spinning', className)} />
}
