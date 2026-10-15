import { cx } from '../../lib/className'

export function StatusPill({ running, label }: { running: boolean; label?: string }) {
  return <span className={cx('status-pill', running ? 'is-running' : 'is-idle')}>{label || (running ? '处理中' : '待开始')}</span>
}