import { formatSize } from './format'

export interface ProgressLike {
  percent?: number | null
  transferred?: number | null
  total?: number | null
  bytesPerSecond?: number | null
}

export function clampPercent(value: unknown) {
  const percent = Number(value || 0)
  if (!Number.isFinite(percent)) return 0
  return Math.max(0, Math.min(100, percent))
}

export function formatPercent(value: unknown) {
  return `${clampPercent(value).toFixed(1)}%`
}

export function hasProgressPercent(progress?: ProgressLike | null) {
  if (typeof progress?.percent !== 'number' || !Number.isFinite(progress.percent)) return false
  return true
}

export function progressPercent(progress?: ProgressLike | null) {
  return clampPercent(progress?.percent)
}

export function formatProgressText(progress?: ProgressLike | null) {
  if (!progress) return ''

  const parts = [formatPercent(progress.percent)]
  if (progress.transferred && progress.total) parts.push(`${formatSize(progress.transferred)} / ${formatSize(progress.total)}`)
  if (progress.bytesPerSecond) parts.push(`${formatSize(progress.bytesPerSecond)}/s`)
  return parts.join(' · ')
}
