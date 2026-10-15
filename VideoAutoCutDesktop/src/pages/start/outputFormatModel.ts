export type OutputResolution = '720p' | '1080p' | '4k'

const OUTPUT_SIZES: Record<string, Partial<Record<OutputResolution, readonly [number, number]>>> = {
  '16:9': { '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160] },
  '9:16': { '1080p': [1080, 1920], '4k': [2160, 3840] },
  '4:3': { '1080p': [1440, 1080] },
  '3:4': { '1080p': [1080, 1440] },
}

export function outputResolutions(aspectRatio: string): OutputResolution[] {
  return Object.keys(OUTPUT_SIZES[aspectRatio] || OUTPUT_SIZES['16:9']) as OutputResolution[]
}

export function normalizeOutputResolution(aspectRatio: string, resolution?: string): OutputResolution {
  return outputResolutions(aspectRatio).includes(resolution as OutputResolution) ? resolution as OutputResolution : '1080p'
}

export function outputSizeLabel(aspectRatio: string, resolution?: string): string {
  const [width, height] = (OUTPUT_SIZES[aspectRatio] || OUTPUT_SIZES['16:9'])[normalizeOutputResolution(aspectRatio, resolution)]!
  return `${width} × ${height}`
}
