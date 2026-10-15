import { cx } from '../../lib/className'

type ProgressBarSize = 'default' | 'compact' | 'slim'

type ProgressBarProps = {
  ariaLabel: string
  className?: string
  indeterminate?: boolean
  size?: ProgressBarSize
  value: number
}

function percentValue(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export function ProgressBar({
  ariaLabel,
  className,
  indeterminate = false,
  size = 'default',
  value,
}: ProgressBarProps) {
  const percent = percentValue(value)

  return <div
    className={cx('progress-bar', `is-${size}`, indeterminate && 'is-indeterminate', className)}
    role="progressbar"
    aria-label={ariaLabel}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={indeterminate ? undefined : percent}
  >
    <span style={indeterminate ? undefined : { width: `${percent}%` }} />
  </div>
}
