import { asRecord, errorMessage, stringValue, type JsonRecord } from './types.js'

interface HttpJsonOptions {
  method?: string
  headers?: HeadersInit
  body?: unknown
  timeoutMs?: number
}

interface ResponseBody {
  contentType: string
  json?: JsonRecord | null
  text?: string
  buffer: Buffer
}

function assertFetchAvailable() {
  if (typeof fetch !== 'function') throw new Error('当前 Electron 运行环境不支持 fetch')
}

async function httpJson(url: string, options: HttpJsonOptions = {}): Promise<JsonRecord> {
  assertFetchAvailable()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000)

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'zh-CN',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })
    const text = await response.text()
    let data: JsonRecord = {}
    try {
      data = text ? asRecord(JSON.parse(text)) : {}
    } catch (_error) {
      data = { message: text }
    }
    if (!response.ok) {
      const message = stringValue(data.message || data.reason || data.error || text || `HTTP ${response.status}`)
      const err = new Error(message) as Error & { status?: number; data?: unknown }
      err.status = response.status
      err.data = data
      throw err
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

async function readResponseBody(response: Response): Promise<ResponseBody> {
  const contentType = response.headers.get('content-type') || ''
  const buffer = Buffer.from(await response.arrayBuffer())
  if (contentType.includes('application/json')) {
    const text = buffer.toString('utf8')
    try {
      return { contentType, json: text ? asRecord(JSON.parse(text)) : null, text, buffer }
    } catch (error) {
      return { contentType, json: { message: errorMessage(error), raw: text }, text, buffer }
    }
  }
  return { contentType, buffer }
}

export {
  httpJson,
  readResponseBody,
}
