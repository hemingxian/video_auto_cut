export type SubtitlePictureMode = 'full' | 'letterbox'

// This preview uses a 1920 × 1080 sample canvas. Keep the anchor and spacing
// rules aligned with render_segment.subtitle_picture_position.
export function subtitlePreviewLayout({
  fontSize,
  progressHeight,
  progressEnabled,
  pictureMode = 'full',
}: {
  fontSize: number
  progressHeight: number
  progressEnabled: boolean
  pictureMode?: SubtitlePictureMode
}) {
  const canvasHeight = 1080
  const pictureTop = pictureMode === 'letterbox' ? 220 : 0
  const pictureHeight = pictureMode === 'letterbox' ? 640 : canvasHeight
  const pictureBottom = pictureTop + pictureHeight
  const lineGap = Math.max(72, Math.floor(fontSize * 1.18))
  const requiredSpace = lineGap + Math.floor(fontSize * 1.4) + 8
  const useBlackSpace = canvasHeight - pictureBottom - 5 >= requiredSpace
  const barHeight = progressEnabled ? Math.min(progressHeight, pictureHeight) : 0
  const anchor = useBlackSpace ? 'top' : 'bottom'
  const y = useBlackSpace ? pictureBottom + 5 : pictureBottom - barHeight - 5
  return {
    anchor,
    lineY: anchor === 'top' ? [y, y + lineGap] : [y - lineGap, y],
    pictureTop,
    pictureHeight,
    progressBottom: canvasHeight - pictureBottom,
    progressHeight: barHeight,
  }
}
