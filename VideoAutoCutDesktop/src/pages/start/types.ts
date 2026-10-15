export type MaterialMode = 'download' | 'library'
export type MaterialSourceMode = 'library-only' | 'library-first' | 'pexels-only'
import type { ScriptImportIssue, ScriptImportReport } from '../../types/videoauto/task'

export type TaskStage = 'idle' | 'plan' | 'generate'
export type TaskQueueMode = Exclude<TaskStage, 'idle'>
export type TaskWorkflowStage = 'script' | 'plan' | 'query' | 'voice' | 'material' | 'card' | 'clip' | 'compose' | 'bgm' | 'done'
export type TaskWorkflowStep = Exclude<TaskWorkflowStage, 'card' | 'done'>
export type TaskWorkflowPlan = TaskWorkflowStep[]
export type TaskWorkflowStatus = 'pending' | 'running' | 'completed' | 'failed'
export type TaskWorkflowProgress = {
  stage?: TaskWorkflowStage
  status?: TaskWorkflowStatus
  phase?: string
  current?: number
  total?: number
  label?: string
}
export type TaskQueueStatus = 'queued' | 'running' | 'done' | 'failed' | 'paused'
export type EditableShotField = 'title' | 'voice_text' | 'subtitle' | 'card_content' | 'card_layout' | 'download_query' | 'visual_query' | 'clip_requirements'
export type ShotScriptMetaField = 'visual_description' | 'shot_size' | 'camera_move' | 'camera_angle' | 'transition'
export type RestorableScriptField = 'title' | 'voice_text' | 'subtitle' | 'card_content' | 'card_layout' | ShotScriptMetaField
export type PlanOrigin = 'none' | 'current'

export type StartTaskOptions = {
  materialSourceMode?: MaterialSourceMode
  aspectRatio?: string
  outputResolution?: string
  scriptPath?: string
  voiceScriptBodyPath?: string
  projectName?: string
  source?: string
  downloadNewMaterials?: boolean
  planOnly?: boolean
  shotsJson?: string
  resumeRunPath?: string
  restartAll?: boolean
  materialManifestPath?: string
}

export type TaskQueueItem = {
  aspectRatio?: string
  outputResolution?: string
  pauseRequested?: boolean
  id: string
  mode: TaskQueueMode
  title: string
  status: TaskQueueStatus
  createdAt: string
  downloadNewMaterials: boolean
  autoContinueToGenerate?: boolean
  reviewWarningsConfirmed?: boolean
  preferLocalMaterials?: boolean
  materialSourceMode?: MaterialSourceMode
  scriptMaterialBindings?: ShotMaterialBinding[]
  scriptPath?: string
  voiceScriptBodyPath?: string
  voiceScript?: boolean
  voiceScriptTaskId?: string
  projectName?: string
  shotsJson?: string
  resumeRunPath?: string
  restartAll?: boolean
  materialManifestPath?: string
  source?: string
  pid?: number
  command?: string
  runId?: string
  runPath?: string
  workflowStage?: TaskWorkflowStage
  workflowPlan?: TaskWorkflowPlan
  workflowProgress?: TaskWorkflowProgress
  previewReady?: boolean
  startedAt?: string
  finishedAt?: string
  code?: number | null
  message?: string
  scriptImport?: ScriptImportReport
  logs: string[]
}

export type ShotMaterialBinding =
  | {
      binding_type: 'material'
      material_id: string
    }
  | {
      binding_type: 'folder'
      folder_id: string
      include_subfolders: boolean
    }

export type ShotMaterialResolution = {
  strategy?: 'library' | 'download' | 'manual'
  source_mode?: MaterialSourceMode
  query?: string
  score?: number
  threshold?: number
  material_id?: string
  material_name?: string
  reason?: string
  fallback_source?: string
  message?: string
}

export type ShotScriptReview = {
  status?: string
  status_lines?: string[]
  ai_suggested?: string[]
  confirmed?: string[]
  warnings?: ScriptImportIssue[]
  acknowledged?: string[]
  [key: string]: unknown
}

export type ShotScriptMeta = {
  v?: number
  segment?: string
  visual_description?: string
  shot_size?: string
  camera_move?: string
  camera_angle?: string
  transition?: string
  material_source?: string
  material_requirements?: string
  search_keywords?: string
  notes?: string
  card_hint?: string
  duration_raw?: string
  source?: Record<string, unknown>
  script_values?: Partial<Record<RestorableScriptField | 'card_hint', unknown>>
  authored?: { card_content?: unknown; [key: string]: unknown }
  review?: ShotScriptReview
  extra_columns?: Record<string, unknown>
  [key: string]: unknown
}

export type ScriptSource = {
  v?: number
  route: 'template' | 'organized'
  format: string
  carrier?: string
  file_name?: string
  project_info?: Record<string, unknown>
  dictionaries: Partial<Record<ShotScriptMetaField, string[]>>
  import_summary?: { shots?: number; warnings?: number; shots_with_ai_suggested?: number }
  [key: string]: unknown
}

export type ScriptFieldOrigin = 'script' | 'ai' | 'default'

export type ShotDraft = {
  shot_id: string
  shot?: number
  title?: string
  module_label?: string
  duration?: number
  time_range?: string
  voiceover?: boolean
  voice_text?: string
  subtitle?: string
  download_query?: string
  visual_query?: string
  clip_requirements?: string
  progress_text?: string
  highlight_rule?: string
  card_content?: string
  card_hint?: string
  // 上屏卡片版式（headline_sub / equal_lines），由脚本校验层按版式标签写入，桌面端只透传
  card_layout?: string
  script_meta?: ShotScriptMeta
  render_hints?: { caption_source?: 'subtitle'; [key: string]: unknown }
  download_material: boolean
  material_bindings: ShotMaterialBinding[]
  material_resolution?: ShotMaterialResolution
  [key: string]: unknown
}

export type ShotPlanRoot = Record<string, unknown>
