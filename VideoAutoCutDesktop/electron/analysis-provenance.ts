import { asRecord } from './types.js'

// Stable JSON is also used when comparing independently paginated cloud responses.
export function canonicalAnalysisJson(value: unknown): string {
  function normalize(item: unknown, depth = 0): unknown {
    if (depth > 12) throw new Error('分析参数嵌套层数过多')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) return item.map(child => normalize(child, depth + 1))
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, normalize(child, depth + 1)]))
    throw new Error('分析参数不是有效 JSON')
  }
  return JSON.stringify(normalize(value))
}

export function parseAnalysisProvenance(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined
  const encoded = canonicalAnalysisJson(value)
  if (Buffer.byteLength(encoded) > 1_048_576) throw new Error('分析参数数据过大')
  const record = asRecord(value)
  const identity = asRecord(record.source_identity)
  const profile = asRecord(record.analysis_profile)
  if (record.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(String(identity.source_sha256))
    || !Number.isSafeInteger(identity.source_size) || Number(identity.source_size) <= 0
    || profile.contract !== 'sentry-analysis-v1' || profile.backend !== 'qwen-cloud'
    || typeof record.duration !== 'number' || !Number.isFinite(record.duration) || record.duration <= 0
    || !Array.isArray(record.spans) || !Array.isArray(record.still_spans)) {
    throw new Error('分析结果的素材身份或分析参数无效')
  }
  for (const spans of [record.spans, record.still_spans]) {
    if (spans.length > 10_000 || spans.some(span => !Array.isArray(span) || span.length !== 2
      || span.some(n => typeof n !== 'number' || !Number.isFinite(n))
      || span[0] < 0 || span[1] <= span[0] || span[1] > Number(record.duration) + 0.01)) {
      throw new Error('分析结果的分段参数无效')
    }
  }
  return JSON.parse(encoded) as Record<string, unknown>
}
