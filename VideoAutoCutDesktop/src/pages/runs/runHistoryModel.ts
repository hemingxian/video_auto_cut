import type { RunItem } from '../../types/videoauto'

export type RunHistoryGroup = {
  key: string
  records: RunItem[]
  latest: RunItem
  mtime: number
  completed: boolean
}

export type RunActivityTarget = {
  runId?: string
  runPath?: string
  shotsJson?: string
}

function pathKey(value = ''): string {
  return value.replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase()
}

export function isRunInUse(run: RunItem, targets: readonly RunActivityTarget[]): boolean {
  return targets.some((target) => {
    if (target.shotsJson && run.shotsPath && pathKey(target.shotsJson) === pathKey(run.shotsPath)) return true
    if (target.runPath) return pathKey(target.runPath) === pathKey(run.path)
    return Boolean(target.runId && target.runId === run.id)
  })
}

export function groupRunHistory(runs: RunItem[]): RunHistoryGroup[] {
  const byId = new Map<string, RunItem[]>()
  for (const run of runs) byId.set(run.id, [...(byId.get(run.id) || []), run])
  const parent = (run: RunItem) => {
    if (!run.sourceRunId || byId.get(run.id)?.length !== 1) return undefined
    const matches = byId.get(run.sourceRunId)
    return matches?.length === 1 ? matches[0] : undefined
  }
  const rootFor = (run: RunItem): RunItem => {
    let current = run
    const visited = new Set<RunItem>()
    while (parent(current)) {
      if (visited.has(current)) return run // Corrupt cycles remain separate records.
      visited.add(current)
      current = parent(current)!
    }
    return current
  }
  const groups = new Map<RunItem, RunItem[]>()
  for (const run of runs) {
    const root = rootFor(run)
    groups.set(root, [...(groups.get(root) || []), run])
  }
  return Array.from(groups, ([root, records]) => {
    records.sort((left, right) => right.mtime - left.mtime)
    const sourceIds = new Set(records.map((run) => run.sourceRunId).filter(Boolean))
    // A preview can have a newer directory timestamp after editing. Prefer the
    // latest actual continuation, including failed attempts that need restoring.
    const latest = records.find((run) => !sourceIds.has(run.id)) || records[0]
    return {
      key: root.path,
      records,
      latest,
      mtime: Math.max(...records.map((run) => run.mtime)),
      completed: records.some((run) => Boolean(run.finalVideo)),
    }
  }).sort((left, right) => right.mtime - left.mtime)
}
