import type {
  RestorableScriptField,
  ScriptSource,
  ShotDraft,
  ShotMaterialBinding,
  ShotPlanRoot,
  ShotScriptMeta,
  ShotScriptMetaField,
  ScriptFieldOrigin,
} from './types'

function createStableId(): string {
  return `shot_${crypto.randomUUID().replaceAll('-', '')}`
}

export function normalizeMaterialBindings(value: unknown): ShotMaterialBinding[] {
  if (!Array.isArray(value)) return []
  const bindings: ShotMaterialBinding[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (record.binding_type === 'material') {
      const materialId = String(record.material_id || '').trim()
      const key = `material:${materialId}`
      if (materialId && !seen.has(key)) {
        bindings.push({ binding_type: 'material', material_id: materialId })
        seen.add(key)
      }
    } else if (record.binding_type === 'folder') {
      const folderId = String(record.folder_id || '').trim()
      const key = `folder:${folderId}`
      if (folderId && !seen.has(key)) {
        bindings.push({
          binding_type: 'folder',
          folder_id: folderId,
          include_subfolders: record.include_subfolders === true,
        })
        seen.add(key)
      }
    }
  }
  return bindings
}

export function normalizeShots(value: unknown): ShotDraft[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item, index) => {
      const materialBindings = normalizeMaterialBindings(item.material_bindings)
      const downloadMaterial = item.download_material === undefined
        ? materialBindings.length === 0
        : item.download_material !== false
      if (downloadMaterial && materialBindings.length) {
        const shotLabel = String(item.shot_id || item.shot || index + 1)
        throw new Error(`分镜 ${shotLabel} 使用自动下载时不能保留素材绑定`)
      }
      return {
        ...item,
        shot_id: String(item.shot_id || '').trim() || createStableId(),
        download_material: downloadMaterial,
        material_bindings: materialBindings,
      }
    })
}

export function parseShotsJson(text: string): { root: ShotPlanRoot; topic: string; shots: ShotDraft[] } {
  if (!text.trim()) return { root: {}, topic: '', shots: [] }
  const data = JSON.parse(text) as unknown
  const root = data && typeof data === 'object' && !Array.isArray(data) ? data as ShotPlanRoot : {}
  return {
    root,
    topic: String(root.topic || ''),
    shots: normalizeShots(root.shots),
  }
}

export function shotText(value: unknown): string {
  if (value === undefined || value === null) return ''
  return String(value)
}

export function shotsWithoutMaterialSelection(shots: ShotDraft[]) {
  return shots.flatMap((shot, index) => (
    shot.download_material === false && shot.material_bindings.length === 0
      ? [{
          index,
          shotId: shot.shot_id,
          title: shotText(shot.title).trim() || `分镜 ${String(index + 1).padStart(2, '0')}`,
        }]
      : []
  ))
}

export function resetAutomaticMaterialResolution(shots: ShotDraft[]) {
  return shots.map((shot) => {
    if (shot.material_bindings.length && shot.material_resolution?.strategy !== 'library') return shot

    return {
      ...shot,
      download_material: true,
      material_bindings: [],
      material_resolution: undefined,
    }
  })
}

export function updateShotContent(shot: ShotDraft, field: string, value: string): ShotDraft {
  if (shot[field] === value) return shot
  const templateMeta = readScriptMeta(shot)
  if (field === 'voice_text' && templateMeta) {
    return confirmEditedBodyField(syncCaptionHint(
      { ...shot, voice_text: value, voiceover: Boolean(value.trim()) },
      shot.subtitle,
    ), field)
  }
  if (field === 'subtitle' && templateMeta) return confirmEditedBodyField(updateShotSubtitle(shot, value), field)
  if (field === 'card_content') {
    const next = { ...shot, card_content: value }
    if (nonEmptyLines(value) < 2) delete next.card_layout
    return templateMeta ? confirmEditedBodyField(next, field) : next
  }
  if (field === 'card_layout') {
    const next = { ...shot }
    if (value && nonEmptyLines(shot.card_content) >= 2) next.card_layout = value
    else delete next.card_layout
    return templateMeta ? confirmEditedBodyField(next, field) : next
  }
  const next = !['download_query', 'visual_query', 'visual_mode', 'clip_requirements'].includes(field)
    ? { ...shot, [field]: value }
    : { ...resetAutomaticMaterialResolution([shot])[0], [field]: value, query_optimized: false }
  const reviewField = field === 'download_query' ? 'search_keywords'
    : field === 'clip_requirements' ? 'material_requirements' : ''
  if (templateMeta && ['title'].includes(field)) return confirmEditedBodyField(next, field)
  return templateMeta && reviewField
    ? { ...next, script_meta: withConfirmedField({ ...templateMeta }, reviewField) }
    : next
}

const BODY_REVIEW_FIELDS = new Set(['title', 'voice_text', 'subtitle', 'card_content', 'card_layout'])

function confirmEditedBodyField(shot: ShotDraft, field: string): ShotDraft {
  const meta = readScriptMeta(shot)
  if (!meta || !BODY_REVIEW_FIELDS.has(field)) return shot
  const confirmedMeta = withConfirmedField({ ...meta }, field)
  return confirmedMeta === meta ? shot : { ...shot, script_meta: confirmedMeta }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined
  return [...value]
}

export function readScriptMeta(shot: ShotDraft): ShotScriptMeta | undefined {
  const meta = objectRecord(shot.script_meta)
  return meta ? meta as ShotScriptMeta : undefined
}

export function readShotScriptReview(shot: ShotDraft): NonNullable<ShotScriptMeta['review']> | undefined {
  const meta = readScriptMeta(shot)
  return objectRecord(meta?.review) as NonNullable<ShotScriptMeta['review']> | undefined
}

export function readScriptSource(root: ShotPlanRoot): ScriptSource | undefined {
  const source = objectRecord(root.script_source)
  if (!source || !['template', 'organized'].includes(String(source.route)) || typeof source.format !== 'string') return undefined
  const rawDictionaries = objectRecord(source.dictionaries)
  if (!rawDictionaries) return undefined
  const dictionaries: ScriptSource['dictionaries'] = {}
  for (const key of ['shot_size', 'camera_move', 'camera_angle', 'transition'] as ShotScriptMetaField[]) {
    const values = stringList(rawDictionaries[key])
    if (values) dictionaries[key] = values
  }
  return { ...source, route: source.route, format: source.format, dictionaries } as ScriptSource
}

export function readFieldOrigin(shot: ShotDraft): Partial<Record<string, ScriptFieldOrigin>> {
  const raw = objectRecord(readScriptMeta(shot)?.field_origin)
  if (!raw) return {}
  const result: Partial<Record<string, ScriptFieldOrigin>> = {}
  for (const [field, origin] of Object.entries(raw)) {
    if (origin === 'script' || origin === 'ai' || origin === 'default') result[field] = origin
  }
  return result
}

export function nonEmptyLines(value: unknown): number {
  return shotText(value).split(/\r?\n/).filter((line) => line.trim()).length
}

function updateShotSubtitle(shot: ShotDraft, value: string): ShotDraft {
  return syncCaptionHint({ ...shot, subtitle: value }, value)
}

function syncCaptionHint(shot: ShotDraft, subtitle: unknown): ShotDraft {
  const next: ShotDraft = { ...shot }
  const renderHints = objectRecord(shot.render_hints) || {}
  const comparableSubtitle = comparableCaptionValue(subtitle)
  const useSubtitle = Boolean(comparableSubtitle) && comparableSubtitle !== comparableCaptionValue(shot.voice_text)
  const nextHints = { ...renderHints }
  if (useSubtitle) nextHints.caption_source = 'subtitle'
  else delete nextHints.caption_source
  if (Object.keys(nextHints).length) next.render_hints = nextHints
  else delete next.render_hints
  return next
}

function withConfirmedField(meta: ShotScriptMeta, field: string): ShotScriptMeta {
  const review = objectRecord(meta.review) as NonNullable<ShotScriptMeta['review']> | undefined
  const suggested = stringList(review?.ai_suggested) || []
  const confirmed = stringList(review?.confirmed) || []
  if (!review || !suggested.includes(field) || confirmed.includes(field)) return meta
  return {
    ...meta,
    review: { ...review, confirmed: [...confirmed, field] },
  }
}

function uniqueStrings(value: unknown): string[] {
  return Array.from(new Set(stringList(value) || []))
}

export function updateShotScriptMeta(shot: ShotDraft, field: ShotScriptMetaField, value: string): ShotDraft {
  const currentMeta = readScriptMeta(shot)
  if (!currentMeta) return shot
  let next = { ...shot }
  if (field === 'visual_description' && comparableScriptValue(currentMeta.visual_description) !== comparableScriptValue(value)) {
    next = {
      ...resetAutomaticMaterialResolution([shot])[0],
      visual_query: value || templateVisualQueryFallback(shot),
      query_optimized: false,
    }
  }
  const meta = withConfirmedField({ ...currentMeta, [field]: value }, field)
  if (!value) delete meta[field]
  next = { ...next, script_meta: meta }
  return next
}

export function confirmShotReview(shot: ShotDraft, fields: string[] | 'all'): ShotDraft {
  const meta = readScriptMeta(shot)
  const review = readShotScriptReview(shot)
  if (!meta || !review) return shot
  const requested = fields === 'all' ? uniqueStrings(review.ai_suggested) : fields.filter((field) => typeof field === 'string')
  const confirmed = Array.from(new Set([...uniqueStrings(review.confirmed), ...requested]))
  return { ...shot, script_meta: { ...meta, review: { ...review, confirmed } } }
}

export function warningReviewId(warning: { code?: string; field?: string }): string {
  return `${String(warning.code || '')}:${String(warning.field || '')}`
}

export function acknowledgeShotWarning(shot: ShotDraft, id: string): ShotDraft {
  const meta = readScriptMeta(shot)
  const review = readShotScriptReview(shot)
  if (!meta || !review || !id) return shot
  const acknowledged = Array.from(new Set([...(stringList(review.acknowledged) || []), id]))
  return { ...shot, script_meta: { ...meta, review: { ...review, acknowledged } } }
}

export function comparableScriptValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/\r\n?/g, '\n').trim()
}

// Python str.split() treats U+001C..U+001F and U+0085 as whitespace, but does
// not treat U+FEFF as whitespace. Keep this explicit so caption hints match the
// importer instead of relying on JavaScript's similar, but different, \s set.
function isPythonSplitWhitespace(character: string): boolean {
  const codePoint = character.codePointAt(0)!
  return (codePoint >= 0x09 && codePoint <= 0x0d)
    || (codePoint >= 0x1c && codePoint <= 0x20)
    || codePoint === 0x85
    || codePoint === 0xa0
    || codePoint === 0x1680
    || (codePoint >= 0x2000 && codePoint <= 0x200a)
    || codePoint === 0x2028
    || codePoint === 0x2029
    || codePoint === 0x202f
    || codePoint === 0x205f
    || codePoint === 0x3000
}

function comparableCaptionValue(value: unknown): string {
  const words: string[] = []
  let word = ''
  for (const character of shotText(value)) {
    if (isPythonSplitWhitespace(character)) {
      if (word) words.push(word)
      word = ''
    } else {
      word += character
    }
  }
  if (word) words.push(word)
  return words.join(' ')
}

function generatedTemplateTitle(shot: ShotDraft): string {
  return `分镜${shot.shot ?? ''}`
}

function templateVisualQueryFallback(shot: ShotDraft): string {
  const meta = readScriptMeta(shot)
  const scriptValues = objectRecord(meta?.script_values)
  const importedTitle = scriptValues
    ? originalScriptFieldValue(shot, 'title', scriptValues)
    : shot.title
  return shotText(meta?.search_keywords).trim()
    || shotText(importedTitle).trim()
    || generatedTemplateTitle(shot)
}

function originalScriptFieldValue(
  shot: ShotDraft,
  field: RestorableScriptField,
  scriptValues: Record<string, unknown>,
): unknown {
  const value = scriptValues[field]
  return field === 'title' && (value === null || value === undefined)
    ? generatedTemplateTitle(shot)
    : value
}

export function currentScriptFieldValue(shot: ShotDraft, field: RestorableScriptField): unknown {
  if (['visual_description', 'shot_size', 'camera_move', 'camera_angle', 'transition'].includes(field)) {
    return readScriptMeta(shot)?.[field]
  }
  return shot[field]
}

export function isScriptFieldModified(shot: ShotDraft, field: RestorableScriptField): boolean {
  const meta = readScriptMeta(shot)
  const scriptValues = objectRecord(meta?.script_values)
  if (!meta || !scriptValues) return false
  return comparableScriptValue(currentScriptFieldValue(shot, field))
    !== comparableScriptValue(originalScriptFieldValue(shot, field, scriptValues))
}

export function restoreScriptValue(shot: ShotDraft, field: RestorableScriptField): ShotDraft {
  const meta = readScriptMeta(shot)
  const scriptValues = objectRecord(meta?.script_values)
  if (!meta || !scriptValues) return shot
  const value = shotText(originalScriptFieldValue(shot, field, scriptValues))
  if (['visual_description', 'shot_size', 'camera_move', 'camera_angle', 'transition'].includes(field)) {
    return updateShotScriptMeta(shot, field as ShotScriptMetaField, value)
  }
  return updateShotContent(shot, field, value)
}

export function pendingReviewCount(shot: ShotDraft): number {
  const review = readShotScriptReview(shot)
  if (!review) return 0
  const confirmed = new Set(stringList(review.confirmed) || [])
  const acknowledged = new Set(stringList(review.acknowledged) || [])
  const suggestions = uniqueStrings(review.ai_suggested).filter((field) => !confirmed.has(field)).length
  const warnings = (Array.isArray(review.warnings) ? review.warnings : [])
    .map(objectRecord)
    .filter((warning): warning is Record<string, unknown> => Boolean(
      warning && typeof warning.code === 'string' && warning.code && typeof warning.message === 'string' && warning.message,
    ))
    .filter((warning) => warning.code !== 'ai_suggested' && !acknowledged.has(warningReviewId(warning))).length
  return suggestions + warnings
}

export function pendingReviewTotal(shots: ShotDraft[]): number {
  return shots.reduce((total, shot) => total + pendingReviewCount(shot), 0)
}

export function pendingBodyReviewShots(shots: ShotDraft[]): Array<{ index: number; shot: number; fields: string[] }> {
  return shots.flatMap((shot, index) => {
    const review = readShotScriptReview(shot)
    const confirmed = new Set(stringList(review?.confirmed) || [])
    const fields = uniqueStrings(review?.ai_suggested).filter((field) => BODY_REVIEW_FIELDS.has(field) && !confirmed.has(field))
    return fields.length ? [{ index, shot: typeof shot.shot === 'number' ? shot.shot : index + 1, fields }] : []
  })
}

export function pendingBodyReviewMessage(pending: Array<{ shot: number }>): string {
  return `还有 ${pending.length} 镜正文未确认：第 ${pending.map((item) => item.shot).join('、')} 镜。已跳到第一处。`
}

export function bodyReviewGate(shots: ShotDraft[]) {
  const pending = pendingBodyReviewShots(shots)
  return pending.length ? { blocked: true as const, pending, firstIndex: pending[0].index, message: pendingBodyReviewMessage(pending) }
    : { blocked: false as const, pending: [], firstIndex: -1, message: '' }
}

export function derivedReviewStatus(shot: ShotDraft): 'none' | 'pending' | 'confirmed' {
  if (!readShotScriptReview(shot)) return 'none'
  return pendingReviewCount(shot) > 0 ? 'pending' : 'confirmed'
}
