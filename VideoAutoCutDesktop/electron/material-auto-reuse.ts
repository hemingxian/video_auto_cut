import { asRecord, numberValue, stringValue, type JsonRecord } from './types.js'
import type { SearchResult } from './materials-types.js'

const DEFAULT_AUTO_REUSE_THRESHOLD = 0.62
const DEFAULT_AUTO_REUSE_RESULTS = 8
const MAX_AUTO_REUSE_QUERY_LENGTH = 800

type MaterialSearchResponse = {
  ok?: unknown
  message?: unknown
  results?: unknown
}

type AutomaticMaterialDecision = {
  shotId: string
  status: 'reused' | 'fallback' | 'skipped' | 'blocked'
  strategy: 'library' | 'download' | 'manual'
  query: string
  reason: string
  materialId?: string
  materialName?: string
  score?: number
  fallbackSource?: string
}

type AutomaticMaterialResolution = {
  ok: boolean
  shots: JsonRecord[]
  decisions: AutomaticMaterialDecision[]
  matched: number
  fallback: number
  skipped: number
  blocked: number
  threshold: number
  message?: string
}

type MaterialSourceMode = 'library-only' | 'library-first' | 'pexels-only'

function materialSourceMode(options: JsonRecord): MaterialSourceMode {
  const mode = options.materialSourceMode
  if (mode === 'library-only' || mode === 'library-first' || mode === 'pexels-only') return mode
  return options.preferLocalMaterials === false ? 'pexels-only' : 'library-first'
}

function normalizedThreshold(value: unknown): number {
  const parsed = numberValue(value, DEFAULT_AUTO_REUSE_THRESHOLD)
  if (!Number.isFinite(parsed)) return DEFAULT_AUTO_REUSE_THRESHOLD
  return Math.max(-1, Math.min(1, parsed))
}

function reusableMaterialKey(item: SearchResult): string {
  return stringValue(item.materialId).trim()
    || stringValue(item.sourceSha256).trim()
    || stringValue(item.localPath || item.path).trim().toLocaleLowerCase()
}

function mergeSearchResults(groups: readonly SearchResult[][]): SearchResult[] {
  const merged = new Map<string, SearchResult>()
  for (const items of groups) {
    for (const item of items) {
      const key = reusableMaterialKey(item)
      if (!key) continue
      const previous = merged.get(key)
      if (!previous || numberValue(item.score, -1) > numberValue(previous.score, -1)) {
        merged.set(key, item)
      }
    }
  }
  return [...merged.values()].sort((first, second) => (
    numberValue(second.score, -1) - numberValue(first.score, -1)
    || numberValue(first.rank, Number.MAX_SAFE_INTEGER)
      - numberValue(second.rank, Number.MAX_SAFE_INTEGER)
  ))
}

function canReuseMaterial(item: SearchResult, threshold: number): boolean {
  const materialId = stringValue(item.materialId).trim()
  const score = numberValue(item.score, Number.NEGATIVE_INFINITY)
  if (!materialId || !Number.isFinite(score) || score < threshold) return false
  if (item.analysisStatus === 'failed') return false
  const localReady = item.localStatus === 'present' && Boolean(stringValue(item.localPath).trim())
  const cloudReady = item.cloudStatus === 'ready'
  return localReady || cloudReady
}

function selectReusableMaterial(
  results: readonly SearchResult[],
  thresholdValue: unknown = DEFAULT_AUTO_REUSE_THRESHOLD,
): SearchResult | null {
  const threshold = normalizedThreshold(thresholdValue)
  return results.find((item) => canReuseMaterial(item, threshold)) || null
}

function buildShotMaterialQuery(value: unknown): string {
  const shot = asRecord(value)
  const values = [
    shot.visual_query,
    shot.download_query,
    shot.title,
    shot.clip_requirements,
  ]
  const seen = new Set<string>()
  const parts: string[] = []
  for (const valuePart of values) {
    const text = stringValue(valuePart).replace(/\s+/g, ' ').trim()
    const key = text.toLocaleLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    parts.push(text)
  }
  return parts.join('；').slice(0, MAX_AUTO_REUSE_QUERY_LENGTH)
}

function searchResults(value: unknown): SearchResult[] {
  const response = asRecord(value)
  if (response.ok === false || !Array.isArray(response.results)) return []
  return response.results
    .filter((item): item is SearchResult => Boolean(item) && typeof item === 'object')
    .map((item) => item as SearchResult)
}

async function resolveAutomaticShotMaterials(
  optionsValue: unknown,
  search: (query: string, options: { results: number; threshold: number; noTrim: boolean }) => Promise<MaterialSearchResponse>,
): Promise<AutomaticMaterialResolution> {
  const options = asRecord(optionsValue)
  const shots = Array.isArray(options.shots) ? options.shots.map(asRecord) : []
  const threshold = normalizedThreshold(options.threshold)
  const resultCount = Math.max(1, Math.min(20, numberValue(options.results, DEFAULT_AUTO_REUSE_RESULTS)))
  const sourceMode = materialSourceMode(options)
  const fallbackSource = 'pexels'
  const resolvedShots: JsonRecord[] = []
  const decisions: AutomaticMaterialDecision[] = []
  const blockedMessages: string[] = []

  function resolveMiss(shot: JsonRecord, index: number, query: string, reason: string, failureMessage = '') {
    const shotId = stringValue(shot.shot_id).trim() || `shot_${index + 1}`
    const blocked = sourceMode === 'library-only'
    const strategy = blocked ? 'library' : 'download'
    if (blocked) {
      const title = stringValue(shot.title).trim() || shotId
      const explanation = reason === 'empty_query'
        ? '缺少可用于检索的画面描述'
        : reason === 'search_unavailable'
          ? `素材库检索失败${failureMessage ? `：${failureMessage}` : ''}`
          : `素材库中没有达到匹配阈值 ${threshold} 的可用素材`
      blockedMessages.push(`分镜 ${index + 1}「${title}」：${explanation}；当前仅使用素材库，不能从 Pexels 下载，请绑定可用素材或修改素材来源。`)
    }
    resolvedShots.push({
      ...shot,
      ...(!blocked ? { source: fallbackSource } : {}),
      download_material: !blocked,
      material_bindings: [],
      material_resolution: {
        strategy,
        source_mode: sourceMode,
        query,
        threshold,
        reason,
        ...(!blocked ? { fallback_source: fallbackSource } : {}),
        ...(failureMessage ? { message: failureMessage } : {}),
      },
    })
    decisions.push({
      shotId,
      status: blocked ? 'blocked' : 'fallback',
      strategy,
      query,
      reason,
      ...(!blocked ? { fallbackSource } : {}),
    })
  }

  for (const [index, originalShot] of shots.entries()) {
    if (sourceMode === 'pexels-only') {
      resolveMiss(originalShot, index, buildShotMaterialQuery(originalShot), 'pexels_only')
      continue
    }
    const previous = asRecord(originalShot.material_resolution)
    if (options.reuseUnchanged === true
      && previous.strategy === 'library' && previous.query === buildShotMaterialQuery(originalShot)
      && Array.isArray(originalShot.material_bindings) && originalShot.material_bindings.length > 0) {
      resolvedShots.push(originalShot)
      decisions.push({ shotId: stringValue(originalShot.shot_id), status: 'reused', strategy: 'library', query: stringValue(previous.query), reason: 'unchanged_resolution', materialId: stringValue(previous.material_id) })
      continue
    }
    const wasAutomaticallyBound = asRecord(originalShot.material_resolution).strategy === 'library'
    const shot = wasAutomaticallyBound
      ? { ...originalShot, download_material: true, material_bindings: [] }
      : originalShot
    const shotId = stringValue(shot.shot_id).trim() || `shot_${index + 1}`
    const bindings = Array.isArray(shot.material_bindings) ? shot.material_bindings : []
    if (bindings.length > 0) {
      resolvedShots.push({
        ...shot,
        download_material: false,
        material_resolution: { strategy: 'manual', source_mode: sourceMode, reason: 'manual_selection' },
      })
      decisions.push({
        shotId,
        status: 'skipped',
        strategy: 'manual',
        query: '',
        reason: 'manual_selection',
      })
      continue
    }

    const query = buildShotMaterialQuery(shot)
    if (!query) {
      resolveMiss(shot, index, query, 'empty_query')
      continue
    }

    let response: MaterialSearchResponse
    try {
      response = await search(query, {
        results: resultCount,
        threshold: -1,
        noTrim: true,
      })
    } catch (error) {
      response = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        results: [],
      }
    }
    const match = selectReusableMaterial(searchResults(response), threshold)
    if (match) {
      const materialId = stringValue(match.materialId).trim()
      const score = numberValue(match.score)
      resolvedShots.push({
        ...shot,
        download_material: false,
        material_bindings: [{ binding_type: 'material', material_id: materialId }],
        material_resolution: {
          strategy: 'library',
          source_mode: sourceMode,
          query,
          score,
          threshold,
          material_id: materialId,
          material_name: stringValue(match.name),
        },
      })
      decisions.push({
        shotId,
        status: 'reused',
        strategy: 'library',
        query,
        reason: 'threshold_match',
        materialId,
        materialName: stringValue(match.name),
        score,
      })
      continue
    }

    const failureMessage = response.ok === false ? stringValue(response.message).trim() : ''
    const reason = response.ok === false ? 'search_unavailable' : 'below_threshold'
    resolveMiss(shot, index, query, reason, failureMessage)
  }

  return {
    ok: blockedMessages.length === 0,
    shots: resolvedShots,
    decisions,
    matched: decisions.filter((item) => item.status === 'reused').length,
    fallback: decisions.filter((item) => item.status === 'fallback').length,
    skipped: decisions.filter((item) => item.status === 'skipped').length,
    blocked: blockedMessages.length,
    threshold,
    ...(blockedMessages.length > 0 ? { message: blockedMessages.join('\n') } : {}),
  }
}

export {
  DEFAULT_AUTO_REUSE_RESULTS,
  DEFAULT_AUTO_REUSE_THRESHOLD,
  buildShotMaterialQuery,
  mergeSearchResults,
  normalizedThreshold,
  resolveAutomaticShotMaterials,
  selectReusableMaterial,
}
export type {
  AutomaticMaterialDecision,
  AutomaticMaterialResolution,
  MaterialSearchResponse,
}
