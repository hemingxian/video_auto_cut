export function engineLabel(engine: string) {
  if (engine === 'manim') return 'Manim'
  if (engine === 'remotion') return 'Remotion'
  if (engine === 'hyperframes') return 'HyperFrames'
  return '自动选择'
}
