import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type ResumeMaterialItem = { material_id: string; asset_id: string; asset_version: number; source_sha256: string; local_path: string }
export type ResumeMaterialShot = { shot_id: string; materials: ResumeMaterialItem[] }
type KnownMaterial = { assetId: string; assetVersion: number; sourceSha256: string; localPath: string }
type ResumeOptions = { taskId: string; taskRevision: number; resumeRunPath?: string; shots: Array<Record<string, unknown>> }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const sha256Pattern = /^[a-f0-9]{64}$/i
const realPath = (file: string) => fs.realpathSync.native(file).replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')

function hashFile(file: string): string {
  const digest = createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytes: number
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, bytes))
  } finally { fs.closeSync(descriptor) }
  return digest.digest('hex')
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]))
  return value
}

function materialInput(shot: Record<string, unknown>): string {
  return JSON.stringify(stable({
    download_query: shot.download_query ?? null, visual_query: shot.visual_query ?? null,
    visual_mode: shot.visual_mode ?? null, clip_requirements: shot.clip_requirements ?? null,
    download_material: shot.download_material !== false, material_bindings: shot.material_bindings ?? [],
  }))
}

function boundSourceInput(shot: Record<string, unknown>): string {
  return JSON.stringify(stable([shot.download_material !== false, shot.material_bindings ?? []]))
}

// Called only in the main process. Renderer-supplied paths or frozen entries are never trusted.
export function verifiedResumeMaterialShots(dataRoot: string, input: ResumeOptions,
  knownMaterial: (id: string) => KnownMaterial | null): ResumeMaterialShot[] {
  if (!input.resumeRunPath) return []
  const boundary = realPath(dataRoot)
  const root = realPath(input.resumeRunPath)
  if (!inside(boundary, root)) throw new Error('继续任务目录与当前任务不一致')
  const read = (name: string) => {
    const file = realPath(path.join(root, name))
    if (!inside(root, file)) throw new Error('继续任务记录超出当前任务目录')
    return object(JSON.parse(fs.readFileSync(file, 'utf8')))
  }
  const plan = read('shots.json')
  if (Number(plan.task_revision) !== input.taskRevision) throw new Error('继续任务分镜版本已变化，请重新准备素材')
  let journal: Record<string, unknown>, frozen: Record<string, unknown>
  try { frozen = read('material_manifest.json') } catch {
    if (path.basename(root) !== input.taskId) throw new Error('继续任务目录缺少稳定任务归属记录')
    return []
  }
  if (frozen.schema_version !== 1) {
    if (path.basename(root) !== input.taskId) throw new Error('继续任务目录缺少稳定任务归属记录')
    return []
  }
  if (typeof frozen.run_id !== 'string' || !frozen.run_id.trim() || frozen.task_id !== input.taskId) {
    throw new Error('继续任务目录与当前任务不一致')
  }
  try { journal = read('incremental.json') } catch { return [] }
  if (journal.schema_version !== 1 || !Array.isArray(frozen.shots)) return []
  let previousMode: unknown
  try { previousMode = read('material-source-mode.json').material_source_mode } catch { return [] }
  if (!previousMode || previousMode !== plan.material_source_mode) return []
  const planShots = Array.isArray(plan.shots) ? plan.shots.map(object) : []
  if (new Set(planShots.map(shot => shot.shot_id)).size !== planShots.length
    || new Set(input.shots.map(shot => shot.shot_id)).size !== input.shots.length) throw new Error('继续任务包含重复分镜标识')
  const records = object(journal.records)
  const result: ResumeMaterialShot[] = []
  for (const shot of input.shots) {
    const id = String(shot.shot_id || '')
    const savedShot = planShots.find(value => value.shot_id === id)
    if (!id || !savedShot || materialInput(savedShot) !== materialInput(shot)) throw new Error('继续任务素材输入与已保存分镜不一致')
    const receipt = object(records[`download:${id}`])
    const baseline = object(receipt.output)
    if (!sha256Pattern.test(String(receipt.input_hash || '')) || baseline.shot_id !== id || boundSourceInput(baseline) !== boundSourceInput(shot)) continue
    const entries = frozen.shots.map(object).filter(value => value.shot_id === id)
    if (entries.length !== 1 || !Array.isArray(entries[0].materials)) continue
    const materials = entries[0].materials.map(object)
    if (shot.download_material !== false || !materials.length) continue
    // Every raw output must still match its receipt; a surviving unrelated clip is insufficient.
    try {
      const byHash = new Map<string, string>()
      const files = Object.entries(object(receipt.files))
      if (!files.length) continue
      for (const [file, expected] of files) {
        const actual = realPath(file)
        const stat = fs.statSync(actual)
        if (!inside(path.join(root, 'raw'), actual) || !stat.isFile() || stat.size === 0
          || !sha256Pattern.test(String(expected)) || hashFile(actual) !== expected) throw new Error('暂存素材校验失败')
        byHash.set(String(expected), actual)
      }
      const pinned = materials.map((item): ResumeMaterialItem => {
        const materialId = String(item.material_id || ''), assetId = String(item.asset_id || '')
        const version = Number(item.asset_version), hash = String(item.source_sha256 || '')
        const localPath = byHash.get(hash)
        const known = knownMaterial(materialId)
        if (!materialId || !assetId || !Number.isInteger(version) || version < 1 || !localPath || !known
          || known.assetId !== assetId || known.assetVersion !== version || known.sourceSha256 !== hash) throw new Error('冻结素材身份已变化')
        // A modified source is an explicit change, even if an earlier staged copy survives.
        if (fs.existsSync(known.localPath) && hashFile(known.localPath) !== hash) throw new Error('原素材内容已变化')
        return { material_id: materialId, asset_id: assetId, asset_version: version, source_sha256: hash, local_path: localPath }
      })
      if (new Set(pinned.map(item => item.material_id)).size !== pinned.length) continue
      result.push({ shot_id: id, materials: pinned })
    } catch { /* Missing, altered or unrelated receipts must go through normal source preparation. */ }
  }
  return result
}

export function sameFrozenMaterial(a: Pick<ResumeMaterialItem, 'material_id' | 'asset_id' | 'asset_version' | 'source_sha256'>,
  b: Pick<ResumeMaterialItem, 'material_id' | 'asset_id' | 'asset_version' | 'source_sha256'>): boolean {
  return a.material_id === b.material_id && a.asset_id === b.asset_id && a.asset_version === b.asset_version && a.source_sha256 === b.source_sha256
}
