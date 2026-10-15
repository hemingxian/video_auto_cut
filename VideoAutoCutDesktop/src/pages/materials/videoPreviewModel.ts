export function videoPreviewSeekTime(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.min(0.08, Math.max(0, duration - 0.01))
}

export function formatVideoDuration(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return ''

  const totalSeconds = Math.floor(duration)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const minuteText = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  const secondText = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${minuteText}:${secondText}` : `${minuteText}:${secondText}`
}
