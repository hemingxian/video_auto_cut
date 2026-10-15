import fs from 'node:fs'
import path from 'node:path'

type ArtifactReference = { path: string; shotId: string; stage: 'raw' | 'clips' }
const videoExtensions = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v'])
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

// Read current producer receipts instead of walking every superseded cache directory.
export function readIncrementalArtifacts(runPath: string): ArtifactReference[] | null {
  const file = path.join(runPath, 'incremental.json')
  if (!fs.existsSync(file)) return null
  try {
    const root = fs.realpathSync.native(runPath)
    const journal = object(JSON.parse(fs.readFileSync(file, 'utf8')))
    if (journal.schema_version !== 1) return []
    const plan = object(JSON.parse(fs.readFileSync(path.join(root, 'shots.json'), 'utf8')))
    const shots = Array.isArray(plan.shots) ? plan.shots.map(object) : []
    const activeIds = new Set(shots.map(shot => String(shot.shot_id || '')).filter(Boolean))
    const records = object(journal.records)
    const references: ArtifactReference[] = []
    const seen = new Set<string>()
    const add = (candidate: unknown, shotId: string, stage: ArtifactReference['stage']) => {
      if (typeof candidate !== 'string' || !activeIds.has(shotId)) return
      try {
        const actual = fs.realpathSync.native(candidate)
        const relative = path.relative(root, actual)
        const stat = fs.statSync(actual)
        if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
          || !stat.isFile() || stat.size === 0 || !videoExtensions.has(path.extname(actual).toLowerCase())) return
        if (!relative.toLowerCase().startsWith(`${stage}${path.sep}`)) return
        const key = `${stage}:${shotId}:${actual.toLowerCase()}`
        if (!seen.has(key)) { seen.add(key); references.push({ path: actual, shotId, stage }) }
      } catch { /* Missing output remains absent until the producer repairs its stage. */ }
    }
    for (const shotId of activeIds) {
      for (const candidate of Object.keys(object(object(records[`download:${shotId}`]).files))) add(candidate, shotId, 'raw')
    }
    const manifestPath = path.join(root, 'clips', 'clip_manifest.json')
    if (fs.existsSync(manifestPath)) {
      const manifest = object(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
      if (manifest.schema_version === 1 && manifest.run_id === path.basename(root)
        && Number(manifest.task_revision) === Number(plan.task_revision)) {
        for (const shot of Array.isArray(manifest.shots) ? manifest.shots.map(object) : []) {
          for (const candidate of Array.isArray(shot.paths) ? shot.paths : []) {
            if (typeof candidate === 'string' && !path.isAbsolute(candidate)) add(path.join(root, 'clips', candidate), String(shot.shot_id || ''), 'clips')
          }
        }
      }
    }
    return references
  } catch { return [] }
}
