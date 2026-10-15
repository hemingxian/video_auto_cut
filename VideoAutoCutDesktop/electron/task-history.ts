import fs from 'node:fs'
import path from 'node:path'

import { asRecord, type RunRecord } from './types.js'

const TASK_HISTORY_FILE = 'run_history.json'

function readRecord(file: string): Record<string, unknown> {
  try {
    if (fs.statSync(file).size > 16 * 1024 * 1024) return {}
    return asRecord(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return {}
  }
}

function realPathKey(file: string): string {
  try {
    const resolved = fs.realpathSync.native(file)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  } catch {
    return ''
  }
}

export function writeTaskHistory(runPath: string, sourceShotsPath?: string): void {
  if (!sourceShotsPath) return
  const source = realPathKey(sourceShotsPath)
  if (!source || source === realPathKey(path.join(runPath, 'shots.json'))) return
  const target = path.join(runPath, TASK_HISTORY_FILE)
  // Resuming an existing run must not replace its original relationship.
  if (fs.existsSync(target)) return
  fs.writeFileSync(target, `${JSON.stringify({
    schema_version: 1,
    run_id: path.basename(runPath),
    source_shots_path: fs.realpathSync.native(sourceShotsPath),
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
}

export function associateRunHistory(runs: RunRecord[]): RunRecord[] {
  const byId = new Map<string, RunRecord[]>()
  const byShots = new Map<string, RunRecord[]>()
  for (const run of runs) {
    byId.set(run.id, [...(byId.get(run.id) || []), run])
    const shotsKey = run.shotsPath ? realPathKey(run.shotsPath) : ''
    if (shotsKey) byShots.set(shotsKey, [...(byShots.get(shotsKey) || []), run])
  }
  return runs.map((run) => {
    if (byId.get(run.id)?.length !== 1) return run
    const history = readRecord(path.join(run.path, TASK_HISTORY_FILE))
    const manifest = readRecord(path.join(run.path, 'material_manifest.json'))
    const hasRecordedSource = history.schema_version === 1 && history.run_id === run.id
      && typeof history.source_shots_path === 'string'
    const historySource = hasRecordedSource ? byShots.get(realPathKey(history.source_shots_path as string)) : undefined
    const manifestSource = manifest.schema_version === 1 && manifest.run_id === run.id
      && typeof manifest.task_id === 'string' ? byId.get(manifest.task_id) : undefined
    if (hasRecordedSource && !historySource) return run
    if (historySource && manifestSource
      && (historySource.length !== 1 || manifestSource.length !== 1 || historySource[0] !== manifestSource[0])) return run
    const sources = historySource || manifestSource
    const source = sources?.length === 1 ? sources[0] : undefined
    return source && source !== run && source.shotsPath && byId.get(source.id)?.length === 1
      ? { ...run, sourceRunId: source.id } : run
  })
}

export function isRunDeletionBlocked(
  run: Pick<RunRecord, 'id' | 'path' | 'shotsPath'>,
  active: { running?: unknown; runId?: unknown; runPath?: unknown; shotsJson?: unknown },
): boolean {
  if (!active.running) return false
  const runKey = realPathKey(run.path)
  const activeKey = typeof active.runPath === 'string' ? realPathKey(active.runPath) : ''
  const sourceKey = typeof active.shotsJson === 'string' ? realPathKey(active.shotsJson) : ''
  if (sourceKey && run.shotsPath && sourceKey === realPathKey(run.shotsPath)) return true
  if (runKey && activeKey) return runKey === activeKey
  return Boolean(active.runId && active.runId === run.id)
}
