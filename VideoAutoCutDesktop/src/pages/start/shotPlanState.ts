import type { RunItem, RunningTask } from '../../types/videoauto'
import { parseShotsJson } from './shotPlan'
import type { PlanOrigin, ShotDraft, ShotPlanRoot } from './types'

export interface ShotPlanSnapshot {
  currentRun: RunItem | null
  planOrigin: PlanOrigin
  planRoot: ShotPlanRoot
  shotTopic: string
  shots: ShotDraft[]
  dirty: boolean
  message: string
}

export const INITIAL_SHOTS_MESSAGE = '点击“预览分镜”后，可以先查看并调整每一段内容；也可以直接生成视频。'
export const EMPTY_SHOTS_MESSAGE = '还没有分镜预览。可以先预览分镜，也可以直接生成视频。'
export const NO_VISIBLE_SHOTS_MESSAGE = '当前没有可展示的分镜。'

export function emptyShotPlanSnapshot(message = EMPTY_SHOTS_MESSAGE): ShotPlanSnapshot {
  return {
    currentRun: null,
    planOrigin: 'none',
    planRoot: {},
    shotTopic: '',
    shots: [],
    dirty: false,
    message,
  }
}

export async function loadShotPlanFromRun(run: RunItem | null, origin: PlanOrigin = 'current'): Promise<ShotPlanSnapshot> {
  if (!run?.shotsPath) return emptyShotPlanSnapshot(EMPTY_SHOTS_MESSAGE)

  try {
    const text = await window.videoAutoCut.readFile(run.shotsPath, 8 * 1024 * 1024)
    const parsed = parseShotsJson(text)
    return {
      currentRun: run,
      planOrigin: parsed.shots.length ? origin : 'none',
      planRoot: parsed.root,
      shotTopic: parsed.topic,
      shots: parsed.shots,
      dirty: false,
      message: parsed.shots.length ? '' : NO_VISIBLE_SHOTS_MESSAGE,
    }
  } catch (error) {
    return {
      ...emptyShotPlanSnapshot(`读取分镜失败：${String(error)}`),
      currentRun: run,
    }
  }
}

function samePath(left = '', right = '') {
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase()
}

function runMatchesTask(run: RunItem, task: RunningTask) {
  if (task.runPath && samePath(run.path, task.runPath)) return true
  if (task.runId && run.id === task.runId) return true
  return false
}

export async function loadLatestShotPlan(origin: PlanOrigin = 'current'): Promise<ShotPlanSnapshot> {
  const runs = await window.videoAutoCut.listRuns()
  return loadShotPlanFromRun(runs[0] || null, origin)
}

export async function loadTaskShotPlan(task: RunningTask | null | undefined, origin: PlanOrigin = 'current'): Promise<ShotPlanSnapshot> {
  if (!task) return loadLatestShotPlan(origin)
  if (!task.runPath && !task.runId) return emptyShotPlanSnapshot('当前任务正在启动，等待生成运行目录。')

  const runs = await window.videoAutoCut.listRuns()
  const run = runs.find((item) => runMatchesTask(item, task)) || null
  if (!run) return emptyShotPlanSnapshot('当前任务还没有生成可展示的分镜。')

  return loadShotPlanFromRun(run, origin)
}
