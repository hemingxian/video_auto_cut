import type { VideoAutoCutApi, LocalTaskDraftRecord } from '../../types/videoauto-api'
import type { RunItem } from '../../types/videoauto'
import type { MaterialSourceMode, ShotPlanRoot } from './types'
import { normalizeShots } from './shotPlan.ts'

type ResumeApi = Pick<VideoAutoCutApi, 'readFile' | 'writeFile' | 'loadTaskDraft' | 'saveTaskDraft' | 'autoResolveShotMaterials' | 'prepareGenerationManifest'>

function record(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function embeddedRecords(text: string): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = []
  let start = -1, depth = 0, quoted = false, escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') { quoted = true; continue }
    if (character === '{') { if (depth === 0) start = index; depth += 1 }
    else if (character === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        try { values.push(record(text.slice(start, index + 1))) } catch { /* Ignore non-JSON signature fragments. */ }
        start = -1
      }
    }
  }
  return values
}

function taskMapping(value: Record<string, unknown>): string | undefined {
  if (value.schema_version !== 1) return undefined
  const mappedRun = typeof value.run_id === 'string' ? value.run_id.trim() : ''
  const taskId = typeof value.task_id === 'string' ? value.task_id.trim() : ''
  return mappedRun && taskId ? taskId : undefined
}

async function stableResumeTaskId(api: ResumeApi, run: Pick<RunItem, 'id' | 'path'>,
  checkpoint: Record<string, unknown>): Promise<string> {
  const candidates: Array<{ source: string; taskId: string }> = []
  const checkpointDirect = taskMapping(checkpoint)
  if (checkpointDirect) candidates.push({ source: 'checkpoint', taskId: checkpointDirect })
  if (typeof checkpoint.signature === 'string') {
    for (const value of embeddedRecords(checkpoint.signature)) {
      const taskId = taskMapping(value)
      if (taskId) candidates.push({ source: 'checkpoint signature', taskId })
    }
  }
  let manifestText = ''
  try { manifestText = await api.readFile(`${run.path}/material_manifest.json`) } catch {
    // Missing manifests are supported for older checkpoints; checkpoint evidence is preferred.
  }
  if (manifestText) {
    const manifest = record(manifestText)
    const taskId = taskMapping(manifest)
    if (!taskId) throw new Error('运行素材清单缺少匹配的 run_id/task_id')
    candidates.push({ source: 'material manifest', taskId })
  }
  const ids = new Set(candidates.map(candidate => candidate.taskId))
  if (ids.size > 1) throw new Error(`继续任务标识冲突：${candidates.map(value => `${value.source}=${value.taskId}`).join('，')}`)
  const taskId = candidates[0]?.taskId
  if (taskId) return taskId
  console.warn(`[VideoAutoCut] 继续任务缺少稳定 task_id，回退运行 ID：${run.id}`)
  return run.id
}

const MATERIAL_INPUT_KEYS = ['download_query', 'visual_query', 'visual_mode', 'clip_requirements', 'download_material', 'material_bindings'] as const

function materialInputs(value: Record<string, unknown>): string {
  function stable(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(stable)
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]))
    return input
  }
  return JSON.stringify(MATERIAL_INPUT_KEYS.map((key) => stable(value[key] ?? null)))
}

export async function prepareResumeGeneration(
  api: ResumeApi,
  run: Pick<RunItem, 'id' | 'path' | 'shotsPath'>,
  sourceMode: MaterialSourceMode,
  forcePrepare = false,
) {
  let checkpoint: Record<string, unknown> = {}
  try { checkpoint = record(await api.readFile(`${run.path}/checkpoint.json`)) } catch { /* Report missing/corrupt checkpoints with the recovery action below. */ }
  if (checkpoint.version !== 1 || typeof checkpoint.plan_hash !== 'string' || !/^[a-f0-9]{64}$/i.test(checkpoint.plan_hash)) {
    throw new Error('此任务没有可靠检查点，请选择重新生成全部')
  }
  const text = await api.readFile(run.shotsPath, 8 * 1024 * 1024)
  const root = record(text)
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, '0')).join('')
  let savedMode = root.material_source_mode
  try { savedMode = record(await api.readFile(`${run.path}/material-source-mode.json`)).material_source_mode || savedMode } catch { /* Older tasks may not have a separate mode record. */ }
  const changed = forcePrepare || hash !== checkpoint.plan_hash || Boolean(savedMode && savedMode !== sourceMode)
  if (!changed) return { changed, root, shots: normalizeShots(root.shots), materialManifestPath: `${run.path}/material_manifest.json`, draft: undefined as LocalTaskDraftRecord<ShotPlanRoot> | undefined }
  let journal: Record<string, unknown> = {}
  try { journal = record(await api.readFile(`${run.path}/incremental.json`)) } catch { /* Legacy checkpoints can only continue unchanged input. */ }
  if (journal.schema_version !== 1) throw new Error('此旧任务没有逐分镜记录，修改后请重新生成全部；新任务可保留未修改分镜的结果')
  const taskId = await stableResumeTaskId(api, run, checkpoint)

  const originalShots = normalizeShots(root.shots)
  const entries = journal.records && typeof journal.records === 'object' ? journal.records as Record<string, { output?: Record<string, unknown> }> : {}
  const pendingShots = originalShots.filter((shot) => {
    const baseline = entries[`download:${shot.shot_id}`]?.output
    if (savedMode !== sourceMode || !baseline || baseline.shot_id !== shot.shot_id) return true
    try { return materialInputs(shot) !== materialInputs(normalizeShots([baseline])[0]) } catch { return true }
  })
  const resolved = pendingShots.length ? await api.autoResolveShotMaterials({
    shots: pendingShots, fallbackSource: 'pexels', materialSourceMode: sourceMode, reuseUnchanged: true,
  }) : { ok: true, shots: [], message: '' }
  const replacements = new Map(normalizeShots(resolved.shots).map((shot) => [shot.shot_id, shot]))
  if (resolved.ok && pendingShots.some((shot) => !replacements.has(shot.shot_id))) throw new Error('素材准备返回的分镜不完整，请重新尝试继续任务')
  const shots = originalShots.map((shot) => replacements.get(shot.shot_id) || shot)
  const previousDraft = await api.loadTaskDraft(taskId)
  const rootRevision = Number.isSafeInteger(Number(root.task_revision)) && Number(root.task_revision) >= 0
    ? Number(root.task_revision) : 0
  if (previousDraft && previousDraft.revision < rootRevision) {
    throw new Error(`继续任务草稿版本落后：草稿 ${previousDraft.revision}，分镜 ${rootRevision}`)
  }
  const revision = previousDraft?.revision ?? 0
  const nextRevision = Math.max(rootRevision, revision) + 1
  const nextRoot = { ...root, schema_version: 2, material_source_mode: sourceMode, task_revision: nextRevision, shots }
  const draft = await api.saveTaskDraft({ taskId, schemaVersion: 2, expectedRevision: revision, snapshot: nextRoot })
  if (draft.revision < nextRevision) throw new Error(`继续任务草稿版本回退：保存后 ${draft.revision}，预期至少 ${nextRevision}`)
  nextRoot.task_revision = draft.revision
  await api.writeFile(run.shotsPath, JSON.stringify(nextRoot, null, 2))
  if (!resolved.ok) throw new Error(resolved.message || '修改分镜的素材尚未准备完成，请补充素材后继续')
  const prepared = await api.prepareGenerationManifest({ taskId, taskRevision: draft.revision, shots, resumeRunPath: run.path })
  return { changed, root: nextRoot, shots, materialManifestPath: prepared.manifestPath, draft }
}
