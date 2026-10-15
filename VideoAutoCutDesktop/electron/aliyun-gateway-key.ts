type JsonRecord = Record<string, unknown>

interface HttpJsonOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
}

type RequestJson = (url: string, options?: HttpJsonOptions) => Promise<JsonRecord>

interface GatewayKeyRecord {
  id: number
  key: string
  name: string
  groupId: number
  status: string
  expiresAt: string
}

interface GatewayKeyResult {
  apiKey: string
  keyId: number
  groupId: number
}


function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function clean(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim()
}

function positiveInteger(value: unknown): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function responseData(value: unknown): unknown {
  const record = asRecord(value)
  return Object.prototype.hasOwnProperty.call(record, 'data') ? record.data : value
}

function responseItems(value: unknown): unknown[] {
  const data = responseData(value)
  if (Array.isArray(data)) return data
  const record = asRecord(data)
  if (Array.isArray(record.items)) return record.items
  if (Array.isArray(record.list)) return record.list
  return []
}

function normalizeKey(value: unknown): GatewayKeyRecord | null {
  const record = asRecord(value)
  const group = asRecord(record.group)
  const id = positiveInteger(record.id)
  const groupId = positiveInteger(record.group_id ?? record.groupId ?? group.id)
  const key = clean(record.key)
  if (!id || !key) return null
  return {
    id,
    key,
    name: clean(record.name),
    groupId,
    status: clean(record.status).toLowerCase(),
    expiresAt: clean(record.expires_at ?? record.expiresAt),
  }
}

function isUnexpired(expiresAt: string, nowMs: number): boolean {
  if (!expiresAt) return true
  const timestamp = Date.parse(expiresAt)
  return Number.isFinite(timestamp) && timestamp > nowMs
}

function selectActiveGatewayKey(
  response: unknown,
  nowMs = Date.now(),
): GatewayKeyRecord | null {
  return responseItems(response)
    .map(normalizeKey)
    .find((key): key is GatewayKeyRecord => Boolean(
      key
      && key.status === 'active'
      && isUnexpired(key.expiresAt, nowMs),
    )) || null
}

function forceGatewayBaseEnv(current: Record<string, string>, baseUrl: string): Record<string, string> {
  const root = baseUrl.trim().replace(/\/+$/, '')
  return root ? { ...current, DASHSCOPE_BASE_URL: root } : { ...current }
}

function gatewayRemoteEnv(result: GatewayKeyResult, baseUrl: string): Record<string, string> {
  return forceGatewayBaseEnv({
    DASHSCOPE_API_KEY: result.apiKey,
  }, baseUrl)
}

async function getGatewayKey({
  baseUrl,
  accessToken,
  requestJson,
}: {
  baseUrl: string
  accessToken: string
  requestJson: RequestJson
}): Promise<GatewayKeyResult> {
  const root = baseUrl.trim().replace(/\/+$/, '')
  const token = accessToken.trim()
  if (!root) throw new Error('GATEWAY_BASE_URL_MISSING')
  if (!token) throw new Error('SUB2API_TOKEN_MISSING')

  const headers = { Authorization: `Bearer ${token}` }
  const keysResponse = await requestJson(`${root}/api/v1/keys?status=active&page=1&page_size=1000`, {
    headers,
    timeoutMs: 15000,
  })
  const existing = selectActiveGatewayKey(keysResponse)
  if (!existing) throw new Error('GATEWAY_KEY_UNAVAILABLE')

  return {
    apiKey: existing.key,
    keyId: existing.id,
    groupId: existing.groupId,
  }
}

export {
  forceGatewayBaseEnv,
  gatewayRemoteEnv,
  getGatewayKey,
  responseItems,
  selectActiveGatewayKey,
  type GatewayKeyResult,
  type RequestJson,
}
