import type { RunItem } from '../../types/videoauto'
import type { MaterialMode, TaskStage, TaskWorkflowPlan, TaskWorkflowProgress, TaskWorkflowStage, TaskWorkflowStep } from './types'

export type WorkflowStepId = TaskWorkflowStep
export type WorkflowStepStatus = 'pending' | 'active' | 'done' | 'failed'

export type WorkflowStep = {
  id: WorkflowStepId
  title: string
  detail: string
  meta?: string
  status: WorkflowStepStatus
}

export type TaskWorkflowState = {
  steps: WorkflowStep[]
  progress: number
  summary: string
  activeLabel: string
}

type BuildTaskWorkflowOptions = {
  running: boolean
  taskStage: TaskStage
  materialMode: MaterialMode
  hasVisiblePlan: boolean
  dirty: boolean
  currentRun?: RunItem | null
  workflowStage?: TaskWorkflowStage
  workflowPlan?: TaskWorkflowPlan
  workflowProgress?: TaskWorkflowProgress
  workflowFailed?: boolean
  hasVoiceContent: boolean
  hasProgressBarContent: boolean
  shotCount: number
  candidateCount: number
  clipCount: number
}

const RUNNING_PROGRESS_CAP = 92

function firstPendingIndex(doneFlags: boolean[]) {
  const index = doneFlags.findIndex((done) => !done)
  return index === -1 ? null : index
}

function workflowStepIndex(stageOrder: WorkflowStepId[], stage: WorkflowStepId) {
  const index = stageOrder.indexOf(stage)
  return index >= 0 ? index : null
}

function joinComposeParts(parts: string[]) {
  return parts.length ? `合成${parts.join('、')}和最终视频` : '合成最终视频'
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function stageProgressFraction(progress: TaskWorkflowProgress | undefined, activeStep?: Pick<WorkflowStep, 'id'>) {
  if (!activeStep || !progress || progress.stage !== activeStep.id) return 0.2
  if (progress.status === 'completed') return 1
  if (typeof progress.current !== 'number' || typeof progress.total !== 'number' || progress.total <= 0) return 0.2
  return Math.min(0.92, clamp01(progress.current / progress.total))
}

function phaseLabel(phase?: string) {
  if (phase === 'preparing') return '准备中'
  if (phase === 'searching') return '搜索候选'
  if (phase === 'reviewing') return '审核候选'
  if (phase === 'downloading') return '下载素材'
  if (phase === 'indexing') return '索引素材'
  if (phase === 'clipping') return '剪辑片段'
  if (phase === 'composing') return '合成成片'
  if (phase === 'mixing') return '混入音轨'
  if (phase === 'skipped') return '已跳过'
  return ''
}

function stageProgressLabel(progress: TaskWorkflowProgress | undefined, stepId: WorkflowStepId) {
  if (progress?.stage !== stepId) return undefined
  return progress.label || phaseLabel(progress.phase)
}

function buildProgress(stageOrder: WorkflowStepId[], activeStep: Pick<WorkflowStep, 'id'> | undefined, doneCount: number, workflowProgress: TaskWorkflowProgress | undefined, isWorkflowDone: boolean, running: boolean) {
  if (isWorkflowDone) return 100

  if (activeStep) {
    const index = workflowStepIndex(stageOrder, activeStep.id)
    if (index !== null) {
      const activeProgress = Math.round(((index + stageProgressFraction(workflowProgress, activeStep)) / stageOrder.length) * 100)
      return Math.min(running ? RUNNING_PROGRESS_CAP : 99, activeProgress)
    }
  }

  return Math.min(running ? RUNNING_PROGRESS_CAP : 99, Math.round((doneCount / stageOrder.length) * 100))
}

export function buildTaskWorkflow({
  running,
  taskStage,
  materialMode,
  hasVisiblePlan,
  dirty,
  currentRun,
  workflowStage,
  workflowPlan,
  workflowProgress,
  workflowFailed,
  hasVoiceContent,
  hasProgressBarContent,
  shotCount,
  candidateCount,
  clipCount,
}: BuildTaskWorkflowOptions): TaskWorkflowState {
  const hasFinalVideo = Boolean(currentRun?.finalVideo) && !workflowFailed
  const isWorkflowDone = !workflowFailed && hasFinalVideo
  const hasCandidates = candidateCount > 0
  const hasClips = clipCount > 0
  const expectedClipCount = Math.max(1, shotCount)
  const hasEnoughClips = clipCount >= expectedClipCount
  const showVoiceStep = hasVoiceContent || workflowStage === 'voice' || Boolean(workflowPlan?.includes('voice'))
  const showBgmStep = workflowStage === 'bgm' || Boolean(workflowPlan?.includes('bgm'))
  const fallbackStageOrder: WorkflowStepId[] = [
    'script',
    'plan',
    'query',
    'material',
    ...(showVoiceStep ? ['voice' as const] : []),
    'clip',
    'compose',
    ...(showBgmStep ? ['bgm' as const] : []),
  ]
  const visibleWorkflowPlan = workflowPlan?.filter((stage) => String(stage) !== 'card')
  const planOnlyWorkflow = Boolean(
    visibleWorkflowPlan?.length
    && visibleWorkflowPlan.every((stage) => stage === 'script' || stage === 'plan'),
  )
  const stageOrder = planOnlyWorkflow
    ? [...visibleWorkflowPlan!, ...fallbackStageOrder.filter((stage) => !visibleWorkflowPlan!.includes(stage))]
    : visibleWorkflowPlan?.length ? visibleWorkflowPlan : fallbackStageOrder
  const composeParts = [
    '剪辑片段',
    ...(showVoiceStep ? ['口播', '字幕'] : []),
    ...(hasProgressBarContent ? ['进度条'] : []),
  ]
  const planDetail = showVoiceStep
    ? '生成口播、画面要求和每段时长'
    : '生成画面要求、素材需求和每段时长'
  const materialTitle = materialMode === 'download' ? '下载素材' : '准备已有素材'
  const materialDetail = materialMode === 'download'
    ? '从所选素材来源下载所需候选视频'
    : '从已有素材库和向量索引中找候选片段'
  const materialMeta = materialMode === 'download'
    ? `${candidateCount} 个候选片段`
    : hasCandidates ? `${candidateCount} 个候选片段` : '使用已有素材'

  const stepDefinitions: Record<WorkflowStepId, Omit<WorkflowStep, 'status'>> = {
    script: {
      id: 'script',
      title: '读取脚本',
      detail: '解析脚本文档，并建立本次任务目录',
      meta: currentRun?.id || undefined,
    },
    plan: {
      id: 'plan',
      title: '整理分镜',
      detail: planDetail,
      meta: hasVisiblePlan ? '分镜可编辑' : undefined,
    },
    query: {
      id: 'query',
      title: '优化搜索词',
      detail: '把画面需求压缩成可检索的素材关键词',
      meta: dirty ? '有未保存修改' : undefined,
    },
    voice: {
      id: 'voice',
      title: '口播字幕',
      detail: '生成口播音频，并准备字幕时间轴',
      meta: stageProgressLabel(workflowProgress, 'voice'),
    },
    material: {
      id: 'material',
      title: materialTitle,
      detail: materialDetail,
      meta: materialMeta,
    },
    clip: {
      id: 'clip',
      title: '剪辑片段',
      detail: '按分镜要求截取可用镜头',
      meta: `${clipCount} 个剪辑片段`,
    },
    compose: {
      id: 'compose',
      title: '合成成片',
      detail: joinComposeParts(composeParts),
      meta: !running && hasFinalVideo ? '成片已生成' : undefined,
    },
    bgm: {
      id: 'bgm',
      title: '背景音乐',
      detail: '搜索可商用音乐，记录授权并混入成片',
      meta: stageProgressLabel(workflowProgress, 'bgm'),
    },
  }
  const baseSteps = stageOrder.map((id) => stepDefinitions[id])
  const doneByStep: Record<WorkflowStepId, boolean> = {
    script: isWorkflowDone || hasVisiblePlan || hasCandidates || hasClips,
    plan: isWorkflowDone || hasVisiblePlan || hasCandidates || hasClips,
    query: isWorkflowDone || hasCandidates || hasClips,
    voice: isWorkflowDone || hasCandidates || hasClips,
    material: isWorkflowDone || hasCandidates || hasClips || (materialMode === 'library' && hasClips),
    clip: isWorkflowDone || hasEnoughClips,
    compose: isWorkflowDone,
    bgm: isWorkflowDone,
  }
  const visibleWorkflowStage = workflowStage === 'card' ? undefined : workflowStage
  const explicitStageIndex = visibleWorkflowStage && visibleWorkflowStage !== 'done'
    ? workflowStepIndex(stageOrder, visibleWorkflowStage)
    : null
  const protocolStatus = workflowProgress && workflowProgress.stage === workflowStage ? workflowProgress.status : undefined
  const protocolStageCompleted = protocolStatus === 'completed'
  const protocolStageFailed = protocolStatus === 'failed'
  const failedIndex = (workflowFailed || protocolStageFailed) && explicitStageIndex !== null ? explicitStageIndex : null
  const canInferDoneFromArtifacts = !running
  const doneFlags = baseSteps.map((step, index) => {
    const inferredDone = canInferDoneFromArtifacts ? doneByStep[step.id] : isWorkflowDone
    const protocolDone = explicitStageIndex !== null && (index < explicitStageIndex || (index === explicitStageIndex && protocolStageCompleted))
    return inferredDone || protocolDone
  })
  let activeIndex = running && failedIndex === null && !protocolStageCompleted ? explicitStageIndex : null

  if (running && taskStage === 'plan') {
    const planIndex = workflowStepIndex(stageOrder, 'plan') ?? 1
    activeIndex = activeIndex ?? (hasVisiblePlan ? null : firstPendingIndex(doneFlags.slice(0, planIndex + 1)) ?? planIndex)
  }
  if (running && taskStage === 'generate' && activeIndex === null && explicitStageIndex === null && workflowStage !== 'done') {
    if (isWorkflowDone) activeIndex = null
    else activeIndex = workflowStepIndex(stageOrder, showVoiceStep ? 'voice' : 'material') ?? firstPendingIndex(doneFlags)
  }

  const steps = baseSteps.map((step, index): WorkflowStep => {
    const status: WorkflowStepStatus = failedIndex === index
      ? 'failed'
      : doneFlags[index] || (activeIndex !== null && index < activeIndex)
      ? 'done'
      : activeIndex === index
        ? 'active'
        : 'pending'
    return { ...step, status }
  })

  const doneCount = steps.filter((step) => step.status === 'done').length
  const activeStep = steps.find((step) => step.status === 'active')
  const lastWorkflowStep = explicitStageIndex !== null ? baseSteps[explicitStageIndex] : undefined
  const failedStep = failedIndex !== null ? baseSteps[failedIndex] : undefined
  const progress = failedStep
    ? buildProgress(stageOrder, failedStep, doneCount, workflowProgress, false, running)
    : buildProgress(stageOrder, activeStep, doneCount, workflowProgress, isWorkflowDone, running)
  const activeLabel = activeStep?.title || (isWorkflowDone ? '任务完成' : '待开始')
  const activeProgressLabel = activeStep ? stageProgressLabel(workflowProgress, activeStep.id) : ''
  const summary = !running && workflowProgress?.phase === 'cancelled'
    ? '任务已暂停，可编辑后继续'
    : failedStep
    ? `${failedStep.title}失败`
    : running && activeStep
    ? `正在处理：${activeProgressLabel ? `${activeLabel} · ${activeProgressLabel}` : activeLabel}`
    : isWorkflowDone
      ? '成片已生成'
      : protocolStageCompleted && lastWorkflowStep
        ? `${lastWorkflowStep.title}已完成`
      : lastWorkflowStep && (workflowStage !== 'plan' || !hasVisiblePlan)
        ? `${lastWorkflowStep.title}未完成`
      : hasClips
        ? '剪辑片段已生成'
        : hasCandidates
          ? '候选素材已下载'
          : hasVisiblePlan
            ? '分镜方案已就绪，下一步生成视频'
            : '等待开始任务'

  return { steps, progress, summary, activeLabel }
}
