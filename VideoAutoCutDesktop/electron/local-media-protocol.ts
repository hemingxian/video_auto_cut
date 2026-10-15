import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import type { Protocol } from 'electron'

const LOCAL_MEDIA_SCHEME = 'videoauto-media'

interface MediaByteRange {
  end: number
  start: number
}

function normalizePathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved
}

function isInsideDirectory(target: string, root: string): boolean {
  const relative = path.relative(normalizePathKey(root), normalizePathKey(target))
  return relative === '' || Boolean(
    relative
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative),
  )
}

function createLocalMediaUrl(filePath: string): string {
  const token = Buffer.from(path.resolve(filePath), 'utf8').toString('base64url')
  return `${LOCAL_MEDIA_SCHEME}://file/${token}`
}

function resolveLocalMediaPath(value: string, allowedRoot: string): string {
  const parsed = new URL(value)
  if (parsed.protocol !== `${LOCAL_MEDIA_SCHEME}:` || parsed.hostname !== 'file') {
    throw new Error('无效的本地媒体地址')
  }

  const token = parsed.pathname.replace(/^\/+/, '')
  if (!token || token.includes('/')) throw new Error('无效的本地媒体地址')
  const decoded = Buffer.from(token, 'base64url').toString('utf8')
  if (!decoded || decoded.includes('\0')) throw new Error('无效的本地媒体地址')

  const target = path.resolve(decoded)
  const root = path.resolve(allowedRoot)
  if (!isInsideDirectory(target, root)) throw new Error('本地媒体不在允许的工作目录中')
  return target
}

function parseMediaRange(value: string | null, size: number): MediaByteRange | null {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  if (!match || (!match[1] && !match[2]) || size <= 0) throw new Error('无效的视频分段请求')

  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new Error('无效的视频分段请求')
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }

  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= size
    || requestedEnd < start
  ) {
    throw new Error('无效的视频分段请求')
  }
  return { start, end: Math.min(requestedEnd, size - 1) }
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLocaleLowerCase()
  if (extension === '.mp4' || extension === '.m4v') return 'video/mp4'
  if (extension === '.mov') return 'video/quicktime'
  if (extension === '.webm') return 'video/webm'
  if (extension === '.mkv') return 'video/x-matroska'
  return 'application/octet-stream'
}

async function createLocalMediaResponse(request: Request, allowedRoot: string): Promise<Response> {
  let filePath: string
  try {
    filePath = resolveLocalMediaPath(request.url, allowedRoot)
  } catch {
    return new Response('Not found', { status: 404 })
  }

  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(filePath)
    if (!stat.isFile()) return new Response('Not found', { status: 404 })
  } catch {
    return new Response('Not found', { status: 404 })
  }

  let range: MediaByteRange | null
  try {
    range = parseMediaRange(request.headers.get('range'), stat.size)
  } catch {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${stat.size}` },
    })
  }

  const start = range?.start ?? 0
  const end = range?.end ?? Math.max(0, stat.size - 1)
  const contentLength = stat.size === 0 ? 0 : end - start + 1
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'Content-Length': String(contentLength),
    'Content-Type': contentTypeFor(filePath),
  })
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`)
  if (request.method === 'HEAD' || stat.size === 0) {
    return new Response(null, { status: range ? 206 : 200, headers })
  }

  const stream = fs.createReadStream(filePath, { start, end })
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: range ? 206 : 200,
    headers,
  })
}

function registerLocalMediaProtocol(protocol: Protocol, allowedRoot: string): void {
  protocol.handle(LOCAL_MEDIA_SCHEME, (request) => createLocalMediaResponse(request, allowedRoot))
}

export {
  LOCAL_MEDIA_SCHEME,
  createLocalMediaResponse,
  createLocalMediaUrl,
  parseMediaRange,
  registerLocalMediaProtocol,
  resolveLocalMediaPath,
}
