import fs from 'node:fs'
import path from 'node:path'
import { asRecord } from './types.js'

export type TaskOutputFormat = { aspectRatio: string; outputResolution: string; width: number; height: number }

const OUTPUT_SIZES: Record<string, Record<string, [number, number]>> = {
  '16:9': { '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160] },
  '9:16': { '1080p': [1080, 1920], '4k': [2160, 3840] },
  '4:3': { '1080p': [1440, 1080] },
  '3:4': { '1080p': [1080, 1440] },
}

export function taskOutputFormat(aspectRatio: string, outputResolution = '1080p'): TaskOutputFormat {
  const size = OUTPUT_SIZES[aspectRatio]?.[outputResolution]
  if (!size) throw new Error('不支持的成片比例与分辨率组合')
  return { aspectRatio, outputResolution, width: size[0], height: size[1] }
}

export function readTaskOutputFormat(runPath: string): TaskOutputFormat | undefined {
  const file = path.join(runPath, 'output-format.json')
  if (!fs.existsSync(file)) return undefined
  const value = asRecord(JSON.parse(fs.readFileSync(file, 'utf8')))
  const format = taskOutputFormat(String(value.aspect_ratio), value.resolution === undefined ? '1080p' : String(value.resolution))
  if ((value.width !== undefined && value.width !== format.width) || (value.height !== undefined && value.height !== format.height)) {
    throw new Error('任务尺寸记录与分辨率不一致，请重新生成全部')
  }
  return format
}

export function resolveTaskOutputFormat(options: {
  aspectRatio?: string; outputResolution?: string; shotsJson?: string; resumeRunPath?: string;
}): TaskOutputFormat {
  const source = options.resumeRunPath || (options.shotsJson ? path.dirname(options.shotsJson) : '')
  const saved = source ? readTaskOutputFormat(source) : undefined
  const format = taskOutputFormat(options.aspectRatio || saved?.aspectRatio || '16:9', options.outputResolution || saved?.outputResolution || '1080p')
  if (options.resumeRunPath && (format.aspectRatio !== (saved?.aspectRatio || '16:9') || format.outputResolution !== (saved?.outputResolution || '1080p'))) {
    throw new Error('断点续跑不能改变成片比例或分辨率，请重新生成全部')
  }
  return format
}
