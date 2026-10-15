import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

import { IPC_EVENTS } from './ipc-channels.js'
import { commandText, spawnStreamingProcess, terminateProcessTree } from './process-runner.js'
import { TaskOutputDecoder, localPathWithoutNamespace, parseRunPath, type ExtractedTaskOutput } from './task-events.js'
import { validateTaskMaterialMode, writeTaskMaterialMode, type MaterialSourceMode } from './task-material-mode.js'
import { asRecord } from './types.js'
import { writeTaskHistory } from './task-history.js'
import { resolveTaskOutputFormat } from './task-output-format.js'
import type { IpcSender, MutableEnv } from './types.js'

interface TaskServiceOptions {
  getVideoAutoRoot: () => string
  getExePath: () => string
  createVideoAutoEnv: (extra?: MutableEnv) => NodeJS.ProcessEnv
  isRuntimeUsable: (root: string) => boolean
  send: IpcSender
  onDownloadedMaterials?: (
    runPath: string,
    options: { markIndexedReady: boolean; analyzeMissing: boolean },
  ) => Promise<unknown> | unknown
  onGenerationStatus?: (value: {
    runId: string
    status: 'running' | 'succeeded' | 'failed' | 'canceled'
    stage: string
    progress: number
    errorCode?: string
    errorMessage?: string
  }) => Promise<unknown> | unknown
  spawnProcess?: typeof spawnStreamingProcess
  readEngineHelp?: (exePath: string) => string
}

interface TaskStartOptions {
  aspectRatio?: string
  outputResolution?: string
  shotsJson?: string
  scriptPath?: string
  voiceScriptBodyPath?: string
  projectName?: string
  planOnly?: boolean
  source?: string
  materialSourceMode?: MaterialSourceMode
  downloadNewMaterials?: boolean
  resumeRunPath?: string
  restartAll?: boolean
  materialManifestPath?: string
}

type RunningTask = {
  child: ChildProcessWithoutNullStreams
  pid?: number
  command: string
  runId?: string
  runPath?: string
  shotsJson?: string
  startedAt: string
  source: string
  downloadNewMaterials: boolean
  downloadRegistrationStarted: boolean
  materialPostprocess: Promise<void>
  generationRunId?: string
  generationProgress: number
  workflowPlan: string[]
  stopRequested: boolean
}

const DEFAULT_WORKFLOW_PLAN = ['script', 'plan', 'query', 'voice', 'material', 'clip', 'compose', 'bgm']
const REQUIRED_GENERATION_ARGUMENTS = ['--material-manifest'] as const

function readEngineHelp(exePath: string): string {
  const result = spawnSync(exePath, ['--help'], { encoding: 'utf8', shell: false })
  if (result.error || result.status !== 0) return ''
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

function generationRunIdFromManifest(filePath = ''): string {
  const name = path.basename(filePath.replaceAll('\\', '/')).replace(/\.json$/i, '')
  return /^run_[A-Za-z0-9_-]{5,92}$/.test(name) ? name : ''
}

function generationProgress(
  stage: string,
  progress: { status?: string; current?: number; total?: number } | undefined,
  workflowPlan: string[],
): number {
  const plan = workflowPlan.length ? workflowPlan : DEFAULT_WORKFLOW_PLAN
  const index = plan.indexOf(stage)
  if (index < 0) return 0
  let ratio = progress?.status === 'completed' ? 1 : 0
  if (
    typeof progress?.current === 'number'
    && typeof progress.total === 'number'
    && progress.total > 0
  ) {
    ratio = Math.max(ratio, Math.max(0, Math.min(1, progress.current / progress.total)))
  }
  return Math.min(99, Number((((index + ratio) / plan.length) * 99).toFixed(2)))
}

function createTaskService(options: TaskServiceOptions) {
  const getVideoAutoRoot = options.getVideoAutoRoot
  const getExePath = options.getExePath
  const createVideoAutoEnv = options.createVideoAutoEnv
  const isRuntimeUsable = options.isRuntimeUsable
  const send = options.send
  const spawnProcess = options.spawnProcess || spawnStreamingProcess
  const engineHelp = options.readEngineHelp || readEngineHelp

  let runningTask: RunningTask | null = null

  function reportGenerationStatus(
    task: RunningTask,
    value: Omit<Parameters<NonNullable<TaskServiceOptions['onGenerationStatus']>>[0], 'runId'>,
  ): void {
    if (!task.generationRunId || !options.onGenerationStatus) return
    try {
      void Promise.resolve(options.onGenerationStatus({
        runId: task.generationRunId,
        ...value,
      })).catch((error) => {
        console.error('[VideoAutoCut] generation status reporting failed', error)
      })
    } catch (error) {
      console.error('[VideoAutoCut] generation status reporting failed', error)
    }
  }

  function tracksDownloadedMaterials(task: RunningTask): boolean {
    return task.downloadNewMaterials
  }

  function enqueueDownloadedMaterials(
    task: RunningTask,
    processOptions: { markIndexedReady: boolean; analyzeMissing: boolean },
  ): void {
    if (!tracksDownloadedMaterials(task) || !task.runPath || !options.onDownloadedMaterials) return
    task.materialPostprocess = task.materialPostprocess
      .then(async () => {
        await options.onDownloadedMaterials?.(task.runPath || '', processOptions)
      })
      .catch((error) => {
        console.error('[VideoAutoCut] downloaded material post-processing failed', error)
      })
  }

  function status() {
    return {
      running: Boolean(runningTask),
      pid: runningTask?.pid,
      command: runningTask?.command || '',
      runId: runningTask?.runId,
      runPath: runningTask?.runPath,
      shotsJson: runningTask?.shotsJson,
      startedAt: runningTask?.startedAt || '',
    }
  }

  async function start(runOptions: TaskStartOptions = {}) {
    if (runOptions.resumeRunPath) {
      runOptions.resumeRunPath = localPathWithoutNamespace(runOptions.resumeRunPath)
      runOptions.shotsJson = path.join(runOptions.resumeRunPath, 'shots.json')
    }
    const root = getVideoAutoRoot()
    const exePath = getExePath()
    if (!isRuntimeUsable(root)) return { ok: false, message: '运行环境未安装，请先下载运行环境' }
    if (runningTask) return { ok: false, message: '已有任务在进行中', ...status() }

    const help = engineHelp(exePath)
    if (runOptions.aspectRatio && !['4:3', '3:4', '9:16', '16:9'].includes(runOptions.aspectRatio)) {
      return { ok: false, message: '不支持的成片比例' }
    }
    if (runOptions.aspectRatio && !help.includes('--aspect-ratio')) {
      return { ok: false, message: '当前引擎不支持设置成片比例，请先更新视频生成引擎' }
    }
    try {
      const format = resolveTaskOutputFormat(runOptions)
      if (format.outputResolution !== '1080p' && !help.includes('--output-resolution')) {
        return { ok: false, message: '当前引擎不支持该输出分辨率，请先更新视频生成引擎' }
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    if (runOptions.materialManifestPath) {
      const missing = REQUIRED_GENERATION_ARGUMENTS.filter((argument) => !help.includes(argument))
      if (missing.length) {
        return {
          ok: false,
          message: '当前视频生成运行环境版本过旧，请先在“关于与更新”中更新运行环境',
        }
      }
    }

    if ((runOptions.resumeRunPath && !help.includes('--resume-run')) || (runOptions.restartAll && !help.includes('--restart-all'))) {
      return { ok: false, message: '当前生成引擎不支持断点续跑，请先更新运行环境' }
    }
    if (runOptions.voiceScriptBodyPath) {
      if (!fs.existsSync(runOptions.voiceScriptBodyPath)) {
        return { ok: false, message: '口播正文文件已不存在，请重新选择脚本' }
      }
      if (!help.includes('--voice-script-body')) {
        return { ok: false, message: '当前生成引擎不支持口播稿模式，请先更新运行环境' }
      }
    }
    try {
      validateTaskMaterialMode(runOptions)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    const source = runOptions.materialSourceMode ? 'pexels' : runOptions.source
    const args: string[] = []
    if (runOptions.aspectRatio) args.push('--aspect-ratio', runOptions.aspectRatio)
    if (runOptions.outputResolution && help.includes('--output-resolution')) args.push('--output-resolution', runOptions.outputResolution)
    if (runOptions.resumeRunPath) args.push('--resume-run', runOptions.resumeRunPath)
    if (runOptions.restartAll) args.push('--restart-all')
    if (runOptions.shotsJson) args.push('--shots-json', runOptions.shotsJson)
    else if (runOptions.scriptPath) args.push('--script-file', runOptions.scriptPath)
    if (runOptions.voiceScriptBodyPath) args.push('--voice-script-body', runOptions.voiceScriptBodyPath)
    if (runOptions.projectName && help.includes('--project-name')) {
      args.push('--project-name', runOptions.projectName)
    }
    if (runOptions.planOnly) args.push('--plan-only')
    if (source) args.push('--source', source)
    if (runOptions.materialManifestPath) {
      args.push('--material-manifest', runOptions.materialManifestPath)
    }

    const env: MutableEnv = {}

    const currentCommand = commandText(exePath, args)
    const startedAt = new Date().toISOString()
    const outputDecoders = {
      stdout: new TaskOutputDecoder(),
      stderr: new TaskOutputDecoder(),
    }
    const recordedMaterialModePaths = new Set<string>()
    const recordedHistoryPaths = new Set<string>()

    const forwardTaskOutput = (
      channel: string,
      event: Record<string, unknown>,
      extracted: ExtractedTaskOutput,
    ) => {
      const outputRun = parseRunPath(extracted.text)

      if (runningTask && outputRun) {
        runningTask.runId = outputRun.runId
        runningTask.runPath = outputRun.runPath
        if (!recordedHistoryPaths.has(outputRun.runPath)) {
          recordedHistoryPaths.add(outputRun.runPath)
          try {
            writeTaskHistory(outputRun.runPath, runOptions.shotsJson)
          } catch (error) {
            send(channel, {
              type: 'stderr',
              text: `[警告] 无法关联本次历史记录：${error instanceof Error ? error.message : String(error)}\n`,
              runId: outputRun.runId,
              runPath: outputRun.runPath,
            })
          }
        }
        if (runOptions.materialSourceMode && !recordedMaterialModePaths.has(outputRun.runPath)) {
          recordedMaterialModePaths.add(outputRun.runPath)
          try {
            writeTaskMaterialMode(outputRun.runPath, runOptions.materialSourceMode)
          } catch (error) {
            send(channel, {
              type: 'stderr',
              text: `[警告] 无法保存本任务的素材来源模式，历史任务恢复时可能需要重新选择：${error instanceof Error ? error.message : String(error)}\n`,
              runId: outputRun.runId,
              runPath: outputRun.runPath,
            })
          }
        }
      }

      send(channel, {
        ...event,
        text: extracted.text,
        ...(extracted.workflowStage ? { workflowStage: extracted.workflowStage } : {}),
        ...(extracted.workflowProgress ? { workflowProgress: extracted.workflowProgress } : {}),
        ...(extracted.workflowPlan ? { workflowPlan: extracted.workflowPlan } : {}),
        ...(extracted.scriptImport ? { scriptImport: extracted.scriptImport } : {}),
        runId: runningTask?.runId || outputRun?.runId,
        runPath: runningTask?.runPath || outputRun?.runPath,
      })
      const task = runningTask
      const progress = extracted.workflowProgress
      if (task?.generationRunId) {
        if (extracted.workflowPlan?.length) task.workflowPlan = extracted.workflowPlan
        const stage = progress?.stage || extracted.workflowStage
        if (stage) {
          task.generationProgress = Math.max(
            task.generationProgress,
            generationProgress(stage, progress, task.workflowPlan),
          )
          reportGenerationStatus(task, {
            status: 'running',
            stage,
            progress: task.generationProgress,
          })
        }
      }
      if (task && tracksDownloadedMaterials(task) && progress?.stage === 'clip') {
        if (!task.downloadRegistrationStarted) {
          task.downloadRegistrationStarted = true
          enqueueDownloadedMaterials(task, { markIndexedReady: false, analyzeMissing: false })
        }
        if (progress.phase === 'completed_item') {
          enqueueDownloadedMaterials(task, { markIndexedReady: true, analyzeMissing: false })
        }
      }
    }

    const sendTaskEvent: IpcSender = (channel, payload) => {
      const event = asRecord(payload)
      const eventType = typeof event.type === 'string' ? event.type : ''
      if ((eventType === 'stdout' || eventType === 'stderr') && typeof event.text === 'string') {
        const extracted = outputDecoders[eventType].push(event.text)
        if (extracted) forwardTaskOutput(channel, event, extracted)
        return
      }

      if (eventType === 'close') {
        for (const streamType of ['stdout', 'stderr'] as const) {
          const extracted = outputDecoders[streamType].flush()
          if (!extracted) continue
          forwardTaskOutput(channel, {
            type: streamType,
            pid: event.pid,
            command: event.command,
          }, extracted)
        }
      }
      send(channel, event)
    }
    const child = spawnProcess({
      channel: IPC_EVENTS.task,
      command: exePath,
      args,
      cwd: root,
      env: createVideoAutoEnv(env),
      onClose: (code) => {
        const completedTask = runningTask
        if (completedTask) {
          enqueueDownloadedMaterials(completedTask, {
            markIndexedReady: code === 0,
            analyzeMissing: true,
          })
          const canceled = completedTask.stopRequested
          const succeeded = code === 0 && !canceled
          reportGenerationStatus(completedTask, {
            status: canceled ? 'canceled' : succeeded ? 'succeeded' : 'failed',
            stage: canceled ? 'canceled' : succeeded ? 'done' : 'failed',
            progress: succeeded ? 100 : completedTask.generationProgress,
            ...(!canceled && !succeeded ? {
              errorCode: `PROCESS_EXIT_${code ?? 'UNKNOWN'}`,
              errorMessage: `本地生成进程退出（代码 ${code ?? '未知'}）`,
            } : {}),
          })
        }
        runningTask = null
      },
      send: sendTaskEvent,
    })

    runningTask = {
      child,
      runId: runOptions.resumeRunPath ? path.basename(runOptions.resumeRunPath) : generationRunIdFromManifest(runOptions.materialManifestPath) || undefined,
      runPath: runOptions.resumeRunPath,
      shotsJson: runOptions.shotsJson,
      pid: child.pid,
      command: currentCommand,
      startedAt,
      source: String(source || ''),
      downloadNewMaterials: runOptions.downloadNewMaterials !== false,
      downloadRegistrationStarted: false,
      materialPostprocess: Promise.resolve(),
      generationRunId: generationRunIdFromManifest(runOptions.materialManifestPath),
      generationProgress: 0,
      workflowPlan: [],
      stopRequested: false,
    }

    reportGenerationStatus(runningTask, {
      status: 'running',
      stage: 'starting',
      progress: 0,
    })

    return { ok: true, ...status() }
  }

  async function stop() {
    if (!runningTask) return { ok: false, message: '没有运行中的任务', ...status() }

    runningTask.stopRequested = true

    send(IPC_EVENTS.task, {
      type: 'stopping',
      pid: runningTask.pid,
      command: runningTask.command,
      runId: runningTask.runId,
      runPath: runningTask.runPath,
    })
    await terminateProcessTree(runningTask.child)
    return { ok: true, ...status() }
  }

  return {
    start,
    status,
    stop,
  }
}

export {
  createTaskService,
}
