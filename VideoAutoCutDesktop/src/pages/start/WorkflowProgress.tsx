import {
  CheckCircle2,
  Circle,
  DownloadCloud,
  FileSpreadsheet,
  Film,
  ListChecks,
  Music,
  Scissors,
  Search,
  Volume2,
  CircleX,
  type LucideIcon,
} from 'lucide-react'

import { LoadingSpinner } from '../../components/common/LoadingSpinner'
import { ProgressBar } from '../../components/common/ProgressBar'
import { cx } from '../../lib/className'
import type { RunItem } from '../../types/videoauto'
import type { ShotMaterialBoardModel } from './shotArtifacts'
import { buildTaskWorkflow, type WorkflowStep, type WorkflowStepId } from './taskWorkflow'
import type { MaterialMode, TaskStage, TaskWorkflowPlan, TaskWorkflowProgress, TaskWorkflowStage } from './types'

type WorkflowProgressProps = {
  running: boolean
  taskStage: TaskStage
  materialMode: MaterialMode
  hasVisiblePlan: boolean
  dirty: boolean
  workflowStage?: TaskWorkflowStage
  workflowPlan?: TaskWorkflowPlan
  workflowProgress?: TaskWorkflowProgress
  workflowFailed?: boolean
  hasVoiceContent: boolean
  hasProgressBarContent: boolean
  activeTaskLabel?: string
  currentRun?: RunItem | null
  materialBoard: ShotMaterialBoardModel
}

const workflowStepIcon: Record<WorkflowStepId, LucideIcon> = {
  script: FileSpreadsheet,
  plan: ListChecks,
  query: Search,
  voice: Volume2,
  material: DownloadCloud,
  clip: Scissors,
  compose: Film,
  bgm: Music,
}

function StepGlyph({ id }: { id: WorkflowStepId }) {
  const Icon = workflowStepIcon[id]
  return <Icon aria-hidden="true" className="icon" />
}

function StatusGlyph({ status }: Pick<WorkflowStep, 'status'>) {
  if (status === 'failed') return <CircleX className="icon" />
  if (status === 'done') return <CheckCircle2 className="icon" />
  if (status === 'active') return <LoadingSpinner />
  return <Circle className="icon" />
}

function WorkflowStepCard({ index, step }: { index: number; step: WorkflowStep }) {
  return <article className={cx('workflow-step', `is-${step.status}`)}>
    <div className="workflow-step-index">{String(index + 1).padStart(2, '0')}</div>
    <div className="workflow-step-glyph"><StepGlyph id={step.id} /></div>
    <div className="workflow-step-copy">
      <strong>{step.title}</strong>
      <span>{step.detail}</span>
      {step.meta ? <em>{step.meta}</em> : null}
    </div>
    <div className="workflow-step-status" title={step.status}>
      <StatusGlyph status={step.status} />
    </div>
  </article>
}

export function WorkflowProgress({
  running,
  taskStage,
  materialMode,
  hasVisiblePlan,
  dirty,
  workflowStage,
  workflowPlan,
  workflowProgress,
  workflowFailed,
  hasVoiceContent,
  hasProgressBarContent,
  activeTaskLabel,
  currentRun,
  materialBoard,
}: WorkflowProgressProps) {
  const workflow = buildTaskWorkflow({
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
    shotCount: materialBoard.rows.length,
    candidateCount: materialBoard.candidateCount,
    clipCount: materialBoard.clipCount,
  })
  const progressLabel = activeTaskLabel || currentRun?.id

  return <div className="workflow-progress">
    <div className="workflow-progress-head">
      <strong>{workflow.summary}</strong>
      <span>{progressLabel ? `${progressLabel} · ${workflow.progress}%` : `${workflow.progress}%`}</span>
    </div>
    <ProgressBar ariaLabel="当前流程进度" size="slim" value={workflow.progress} />
    <div className="workflow-steps">
      {workflow.steps.map((step, index) => <WorkflowStepCard key={step.id} index={index} step={step} />)}
    </div>
  </div>
}
