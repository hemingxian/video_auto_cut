import fs from 'node:fs'
import path from 'node:path'

import { asRecord } from './types.js'

type MaterialSourceMode = 'library-only' | 'library-first' | 'pexels-only'

const MATERIAL_SOURCE_MODE_FILE = 'material-source-mode.json'

function isMaterialSourceMode(value: unknown): value is MaterialSourceMode {
  return value === 'library-only' || value === 'library-first' || value === 'pexels-only'
}

function validateTaskMaterialMode(options: {
  materialSourceMode?: MaterialSourceMode
  planOnly?: boolean
  shotsJson?: string
  resumeRunPath?: string
  materialManifestPath?: string
}): void {
  const mode = options.materialSourceMode
  // Older callers and historical tasks keep their existing per-shot contract.
  if (mode === undefined) return
  if (!isMaterialSourceMode(mode)) throw new Error('不支持的素材来源模式，请重新选择后生成。')
  if (options.resumeRunPath) {
    const savedPath = path.join(options.resumeRunPath, MATERIAL_SOURCE_MODE_FILE)
    try {
      const saved = asRecord(JSON.parse(fs.readFileSync(savedPath, 'utf8')))
      if (!isMaterialSourceMode(saved.material_source_mode)) {
        throw new Error('原任务的素材来源记录无效，请重新生成全部。')
      }
      if (saved.material_source_mode !== mode) {
        let supportsEditedResume = false
        try {
          const journal = asRecord(JSON.parse(fs.readFileSync(path.join(options.resumeRunPath, 'incremental.json'), 'utf8')))
          const manifest = options.materialManifestPath
            ? asRecord(JSON.parse(fs.readFileSync(options.materialManifestPath, 'utf8'))) : {}
          supportsEditedResume = journal.schema_version === 1 && manifest.schema_version === 1
            && typeof manifest.run_id === 'string' && Number(manifest.task_revision) >= 1
            && path.resolve(options.materialManifestPath || '') !== path.resolve(options.resumeRunPath, 'material_manifest.json')
        } catch { /* Changed modes need both per-shot records and a freshly validated manifest. */ }
        if (!supportsEditedResume) throw new Error('素材来源模式已改变，不能继续原任务，请重新生成全部。')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (options.planOnly || mode === 'library-first') return
  const shotsPath = options.shotsJson || (options.resumeRunPath
    ? path.join(options.resumeRunPath, 'shots.json') : '')
  if (!shotsPath) throw new Error('素材来源尚未准备完成，请先整理分镜并重新准备素材。')
  let root: Record<string, unknown>
  try {
    root = asRecord(JSON.parse(fs.readFileSync(shotsPath, 'utf8')))
  } catch {
    throw new Error('无法读取本任务的分镜素材记录，请重新准备素材后生成。')
  }
  if (!Array.isArray(root.shots) || !root.shots.length) {
    throw new Error('本任务没有可校验的分镜，请重新准备素材后生成。')
  }
  const invalid = root.shots.flatMap((value, index) => {
    const shot = asRecord(value)
    const bindings = Array.isArray(shot.material_bindings) ? shot.material_bindings : []
    const valid = mode === 'library-only'
      ? shot.download_material === false && bindings.length > 0
      : shot.download_material !== false && bindings.length === 0
    return valid ? [] : [String(shot.title || shot.shot_id || `分镜 ${index + 1}`)]
  })
  if (invalid.length) {
    const label = mode === 'library-only' ? '仅素材库' : '仅 Pexels'
    throw new Error(`${label}模式下，${invalid.slice(0, 3).join('、')}${invalid.length > 3 ? `等 ${invalid.length} 个分镜` : ''}的素材设置不符合当前模式，请重新准备素材后生成。`)
  }
}

function writeTaskMaterialMode(runPath: string, mode: MaterialSourceMode): void {
  fs.writeFileSync(path.join(runPath, MATERIAL_SOURCE_MODE_FILE), `${JSON.stringify({
    schema_version: 1,
    material_source_mode: mode,
  }, null, 2)}\n`, 'utf8')
}

export { MATERIAL_SOURCE_MODE_FILE, validateTaskMaterialMode, writeTaskMaterialMode }
export type { MaterialSourceMode }
