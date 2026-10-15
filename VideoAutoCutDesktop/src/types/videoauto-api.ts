import type {
  AuthCaptchaResult,
  AuthResult,
  AuthState,
  AutomaticMaterialResolution,
  DeleteMaterialResult,
  EnvMap,
  FileItem,
  GeneratedMaterialRecord,
  GenerateMaterialResult,
  DeleteMaterialsBatchResult,
  MaterialDirectoryListing,
  MaterialFolderNode,
  MaterialSelectionSummary,
  MaterialFolderOperationResult,
  MaterialFolderSearchResult,
  MaterialLibrary,
  MaterialDeletionImpact,
  MoveMaterialsResult,
  ProgressTemplateRecord,
  RechargeResult,
  RechargeStatusResult,
  RenameMaterialResult,
  RunItem,
  RuntimeState,
  SemanticSearchResponse,
  TaskEvent,
  TaskStartResult,
  TaskStatus,
  UpdateActionResult,
  UpdateState,
  VoiceRegistryItem,
} from './videoauto'
import type { MaterialSourceMode } from '../pages/start/types'

export interface AppInfoResult {
  videoAutoRoot: string
  userDataRoot: string
  configDir: string
  dataRoot: string
  exePath: string
  envPath: string
  runsDir: string
  defaultOutputDir: string
  outputDir: string
  materialsDir: string
  version: string
  runtime: RuntimeState
}

export interface LocalTaskDraftRecord<T = unknown> {
  taskId: string
  schemaVersion: number
  revision: number
  snapshot: T
  saveStatus: 'saved'
  updatedAt: string
}

export interface GenerationManifestResult {
  manifestPath: string
  manifest: {
    schema_version: 1
    run_id: string
    task_id: string
    task_revision: number
    resolved_at: string
    shots: Array<{
      shot_id: string
      materials: Array<{
        material_id: string
        asset_id: string
        asset_version: number
        source_sha256: string
        local_path: string
      }>
    }>
  }
}

export interface MaterialEvent {
  type: string
  path?: string
  status?: string
  message?: string
  [key: string]: unknown
}

export interface MaterialCloudStatus {
  progress?: { phase: string; completed: number; total: number }
  configured: boolean
  authenticated: boolean
  online: boolean
  syncing: boolean
  pendingOperations: number
  failedOperations: number
  conflicts: number
  lastSyncAt?: string
  lastError?: string
}

export interface MaterialCloudQueueResult {
  queued: number
  skipped: number
  status: MaterialCloudStatus
}

export interface MaterialCloudUploadControlResult {
  ok: boolean
  action?: 'pause' | 'resume' | 'cancel'
  message?: string
  status: MaterialCloudStatus
}

export interface PublicMaterialItem {
  publication_id: string
  display_name: string
  mime_type: string
  file_size_bytes: number
  analysis_status: 'ready' | 'pending'
  published_at: string
  can_report: boolean
  report_status?: 'pending' | 'reviewing' | null
}

export interface VideoAutoCutApi {
  deleteRun(id: string): Promise<{ ok: boolean; message?: string }>
  appInfo(): Promise<AppInfoResult>
  setWindowMode(mode: 'auth' | 'main'): Promise<{ ok: boolean; mode?: string }>
  runtimeStatus(): Promise<RuntimeState>
  checkRuntime(options?: { silent?: boolean }): Promise<RuntimeState>
  downloadRuntime(): Promise<RuntimeState>
  updateStatus(): Promise<UpdateState>
  checkForUpdates(options?: { silent?: boolean }): Promise<UpdateActionResult>
  downloadUpdate(): Promise<UpdateActionResult>
  installUpdate(): Promise<UpdateActionResult>
  authStatus(): Promise<AuthState>
  authCaptcha(): Promise<AuthCaptchaResult>
  authLogin(options: { identifier?: string; email?: string; password: string; captchaToken?: string; captchaCode?: string; externalEmail?: string; turnstileToken?: string }): Promise<AuthResult>
  authRefresh(): Promise<AuthResult>
  authLogout(): Promise<AuthState>
  authRecharge(options: { amount: number; outTradeNo?: string }): Promise<RechargeResult>
  authRechargeStatus(options: { outTradeNo: string }): Promise<RechargeStatusResult>
  authOpenRegister(): Promise<{ ok: boolean; message?: string }>
  chooseScriptFiles(): Promise<string[]>
  chooseAudio(): Promise<string>
  chooseFolder(options?: { title?: string; defaultPath?: string }): Promise<string>
  readEnv(): Promise<EnvMap>
  writeEnv(updates: EnvMap): Promise<EnvMap>
  readProgressTemplates(): Promise<ProgressTemplateRecord[]>
  writeProgressTemplates(templates: ProgressTemplateRecord[]): Promise<ProgressTemplateRecord[]>
  listRuns(): Promise<RunItem[]>
  readFile(file: string, maxBytes?: number): Promise<string>
  writeFile(file: string, text: string): Promise<boolean>
  openFile(file: string): Promise<boolean>
  deleteFile(file: string): Promise<{ ok: boolean; removedFile?: boolean; message?: string }>
  openFolder(folder: string): Promise<boolean>
  revealScript(file: string): Promise<boolean>
  readVoiceScriptSource(file: string): Promise<string>
  writeVoiceScriptBody(source: string, body: string, taskId: string): Promise<string>
  listMaterials(): Promise<MaterialLibrary>
  browseMaterials(options?: { folderId?: string }): Promise<MaterialDirectoryListing>
  searchMaterialFolders(options: { query: string; limit?: number }): Promise<MaterialFolderSearchResult[]>
  getMaterialFolderDetails(options: { folderId: string }): Promise<MaterialFolderNode>
  summarizeMaterialSelection(options: {
    bindings: Array<
      { binding_type: 'material'; material_id: string }
      | { binding_type: 'folder'; folder_id: string; include_subfolders: boolean }
    >
  }): Promise<MaterialSelectionSummary>
  createMaterialFolder(options: { parentFolderId: string; name: string }): Promise<MaterialFolderOperationResult>
  renameMaterialFolder(options: { folderId: string; name: string }): Promise<MaterialFolderOperationResult>
  moveMaterialFolder(options: { folderId: string; destinationFolderId: string }): Promise<MoveMaterialsResult>
  deleteMaterialFolder(options: { folderId: string }): Promise<MaterialFolderOperationResult>
  importMaterials(options?: {
    folderId?: string
    selection?: 'files' | 'folder'
  }): Promise<FileItem[]>
  cancelMaterialImport(): Promise<{ ok: boolean; message?: string; sessionId?: string }>
  analyzeMaterial(options: { path: string; materialId?: string }): Promise<{ ok: boolean; message?: string }>
  semanticSearchMaterials(options: { query: string; results?: number; threshold?: number; noTrim?: boolean }): Promise<SemanticSearchResponse>
  autoResolveShotMaterials(options: {
    reuseUnchanged?: boolean
    preferLocalMaterials?: boolean
    materialSourceMode?: MaterialSourceMode
    shots: Array<Record<string, unknown>>
    source?: string
    fallbackSource?: string
    threshold?: number
    results?: number
  }): Promise<AutomaticMaterialResolution>
  listGeneratedMaterials(): Promise<GeneratedMaterialRecord[]>
  deleteMaterial(options: { path: string }): Promise<DeleteMaterialResult>
  previewMaterialDeletion(options: { paths?: string[]; folderIds?: string[] }): Promise<MaterialDeletionImpact>
  deleteMaterials(options: { paths: string[] }): Promise<DeleteMaterialsBatchResult>
  deleteMaterialLocalCopy(options: { materialId: string }): Promise<DeleteMaterialResult>
  renameMaterial(options: { path: string; name: string }): Promise<RenameMaterialResult>
  moveMaterials(options: {
    paths: string[]
    sourceFolderId: string
    destinationFolderId: string
  }): Promise<MoveMaterialsResult>
  deleteGeneratedMaterial(options: { id?: string; outputPath?: string }): Promise<DeleteMaterialResult>
  generateMaterial(options: { prompt: string; engine?: string; reuseThreshold?: number }): Promise<GenerateMaterialResult>
  materialCloudStatus(): Promise<MaterialCloudStatus>
  retryMaterialAnalysisTransfer(options: { materialId: string; direction: 'upload' | 'download' }): Promise<{ ok: boolean; queued?: boolean; message?: string }>
  uploadMaterialsToCloud(options: { paths: string[] }): Promise<MaterialCloudQueueResult>
  controlMaterialCloudUpload(options: {
    materialId: string
    action: 'pause' | 'resume' | 'cancel'
  }): Promise<MaterialCloudUploadControlResult>
  syncMaterialCloud(): Promise<MaterialCloudStatus>
  downloadMaterialFromCloud(options: { materialId: string }): Promise<{ ok: boolean; message?: string; path?: string }>
  deleteMaterialCloudCopy(options: { materialId: string }): Promise<{
    ok: boolean
    queued: boolean
    message?: string
    status: MaterialCloudStatus
  }>
  listPublicMaterials(options?: { keyword?: string; limit?: number }): Promise<{
    ok: boolean
    items: PublicMaterialItem[]
    message?: string
    hasMore?: boolean
    nextCursor?: string
  }>
  addPublicMaterial(options: { publicationId: string; folderId: string }): Promise<{
    ok: boolean
    message?: string
    material_id?: string
    created?: boolean
  }>
  reportPublicMaterial(options: {
    publicationId: string
    category: 'copyright' | 'privacy' | 'harmful' | 'other'
    description: string
  }): Promise<{
    ok: boolean
    message?: string
    report_id?: string
    status?: 'pending' | 'reviewing'
    created?: boolean
  }>
  publishMaterial(options: { materialId: string }): Promise<{ ok: boolean; message?: string }>
  withdrawMaterialPublication(options: { materialId: string; reason?: string }): Promise<{
    ok: boolean
    message?: string
  }>
  resolveMaterialSelection(options: { materialIds: string[] }): Promise<{
    ok: boolean
    message?: string
    unavailable?: Array<{ material_id?: string; reason?: string }>
  }>
  loadTaskDraft<T = unknown>(taskId: string): Promise<LocalTaskDraftRecord<T> | null>
  saveTaskDraft<T = unknown>(options: {
    taskId: string
    schemaVersion: number
    expectedRevision?: number
    snapshot: T
  }): Promise<LocalTaskDraftRecord<T>>
  prepareGenerationManifest(options: {
    taskId: string
    taskRevision: number
    resumeRunPath?: string
    shots: Array<{
      shot_id?: unknown
      download_material?: unknown
      material_bindings?: unknown
    }>
  }): Promise<GenerationManifestResult>
  taskStatus(): Promise<TaskStatus>
  startTask(options: { aspectRatio?: string; outputResolution?: string; materialSourceMode?: MaterialSourceMode; resumeRunPath?: string; restartAll?: boolean; scriptPath?: string; voiceScriptBodyPath?: string; projectName?: string; source?: string; downloadNewMaterials?: boolean; planOnly?: boolean; shotsJson?: string; materialManifestPath?: string }): Promise<TaskStartResult>
  stopTask(): Promise<{ ok: boolean; message?: string } & Partial<TaskStatus>>
  cloneVoice(options: { file?: string; prefix?: string }): Promise<{ ok: boolean; pid?: number }>
  listVoiceTemplates(): Promise<FileItem[]>
  importVoiceTemplates(): Promise<FileItem[]>
  listVoiceRegistry(): Promise<VoiceRegistryItem[]>
  onTaskEvent(cb: (event: TaskEvent) => void): () => void
  onRuntimeEvent(cb: (event: RuntimeState) => void): () => void
  onUpdateEvent(cb: (event: UpdateState) => void): () => void
  onMaterialEvent(cb: (event: TaskEvent) => void): () => void
  onMaterialLibraryEvent(cb: (event: MaterialEvent) => void): () => void
  onVoiceEvent(cb: (event: TaskEvent) => void): () => void
}
