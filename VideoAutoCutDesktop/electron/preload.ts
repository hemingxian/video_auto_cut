import { contextBridge, ipcRenderer } from 'electron'
import { IPC_EVENTS, IPC_INVOKE } from './ipc-channels.js'
import type { MaterialEvent, VideoAutoCutApi } from '../src/types/videoauto-api.js'
import type { MaterialDirectoryListing, RuntimeState, TaskEvent, UpdateState } from '../src/types/videoauto.js'
import type { MaterialSelectionSummary } from '../src/types/videoauto/materials.js'

type InvokeChannel = typeof IPC_INVOKE[keyof typeof IPC_INVOKE]

function invoke(channel: InvokeChannel, ...args: unknown[]) {
  return ipcRenderer.invoke(channel, ...args)
}

function createInvoke(channel: InvokeChannel) {
  return (...args: unknown[]) => invoke(channel, ...args)
}

async function invokeWithErrorDetails<T>(channel: InvokeChannel, fallback: string, ...args: unknown[]): Promise<T> {
  const result = await invoke(channel, ...args) as {
    ok?: boolean
    value?: unknown
    error?: { name?: unknown; message?: unknown }
  }
  if (result?.ok) return result.value as T
  const error = new Error(String(result?.error?.message || fallback))
  error.name = String(result?.error?.name || 'Error')
  throw error
}

const browseMaterials = (...args: unknown[]) => invokeWithErrorDetails<MaterialDirectoryListing>(IPC_INVOKE.materialsBrowse, '读取素材库失败', ...args)
const summarizeMaterialSelection = (...args: unknown[]) => invokeWithErrorDetails<MaterialSelectionSummary>(IPC_INVOKE.materialsSelectionSummary, '范围统计失败', ...args)

function createEventSubscription<T>(channel: string) {
  return (cb: (payload: T) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

const videoAutoCutApi = {
  appInfo: createInvoke(IPC_INVOKE.appInfo),
  setWindowMode: createInvoke(IPC_INVOKE.windowMode),
  runtimeStatus: createInvoke(IPC_INVOKE.runtimeStatus),
  checkRuntime: createInvoke(IPC_INVOKE.runtimeCheck),
  downloadRuntime: createInvoke(IPC_INVOKE.runtimeDownload),
  updateStatus: createInvoke(IPC_INVOKE.updateStatus),
  checkForUpdates: createInvoke(IPC_INVOKE.updateCheck),
  downloadUpdate: createInvoke(IPC_INVOKE.updateDownload),
  installUpdate: createInvoke(IPC_INVOKE.updateInstall),
  authStatus: createInvoke(IPC_INVOKE.authStatus),
  authCaptcha: createInvoke(IPC_INVOKE.authCaptcha),
  authLogin: createInvoke(IPC_INVOKE.authLogin),
  authRefresh: createInvoke(IPC_INVOKE.authRefresh),
  authLogout: createInvoke(IPC_INVOKE.authLogout),
  authRecharge: createInvoke(IPC_INVOKE.authRecharge),
  authRechargeStatus: createInvoke(IPC_INVOKE.authRechargeStatus),
  authOpenRegister: createInvoke(IPC_INVOKE.authOpenRegister),
  chooseScriptFiles: createInvoke(IPC_INVOKE.dialogScriptFiles),
  chooseAudio: createInvoke(IPC_INVOKE.dialogAudio),
  chooseFolder: createInvoke(IPC_INVOKE.dialogFolder),
  readEnv: createInvoke(IPC_INVOKE.envRead),
  writeEnv: createInvoke(IPC_INVOKE.envWrite),
  readProgressTemplates: createInvoke(IPC_INVOKE.progressTemplatesRead),
  writeProgressTemplates: createInvoke(IPC_INVOKE.progressTemplatesWrite),
  listRuns: createInvoke(IPC_INVOKE.runsList),
  deleteRun: createInvoke(IPC_INVOKE.runsDelete),
  readFile: createInvoke(IPC_INVOKE.fileRead),
  writeFile: createInvoke(IPC_INVOKE.fileWrite),
  openFile: createInvoke(IPC_INVOKE.fileOpen),
  deleteFile: createInvoke(IPC_INVOKE.fileDelete),
  openFolder: createInvoke(IPC_INVOKE.folderOpen),
  revealScript: createInvoke(IPC_INVOKE.scriptReveal),
  readVoiceScriptSource: createInvoke(IPC_INVOKE.scriptBodyRead),
  writeVoiceScriptBody: createInvoke(IPC_INVOKE.scriptBodyWrite),
  listMaterials: createInvoke(IPC_INVOKE.materialsList),
  browseMaterials,
  searchMaterialFolders: createInvoke(IPC_INVOKE.materialsFolderSearch),
  getMaterialFolderDetails: createInvoke(IPC_INVOKE.materialsFolderDetails),
  summarizeMaterialSelection,
  createMaterialFolder: createInvoke(IPC_INVOKE.materialsFolderCreate),
  renameMaterialFolder: createInvoke(IPC_INVOKE.materialsFolderRename),
  moveMaterialFolder: createInvoke(IPC_INVOKE.materialsFolderMove),
  deleteMaterialFolder: createInvoke(IPC_INVOKE.materialsFolderDelete),
  importMaterials: createInvoke(IPC_INVOKE.materialsImport),
  cancelMaterialImport: createInvoke(IPC_INVOKE.materialsImportCancel),
  analyzeMaterial: createInvoke(IPC_INVOKE.materialsAnalyze),
  semanticSearchMaterials: createInvoke(IPC_INVOKE.materialsSemanticSearch),
  autoResolveShotMaterials: createInvoke(IPC_INVOKE.materialsAutoResolve),
  listGeneratedMaterials: createInvoke(IPC_INVOKE.materialsGeneratedList),
  deleteMaterial: createInvoke(IPC_INVOKE.materialsDelete),
  previewMaterialDeletion: createInvoke(IPC_INVOKE.materialsDeletePreview),
  deleteMaterials: createInvoke(IPC_INVOKE.materialsDeleteBatch),
  deleteMaterialLocalCopy: createInvoke(IPC_INVOKE.materialsDeleteLocalCopy),
  renameMaterial: createInvoke(IPC_INVOKE.materialsRename),
  moveMaterials: createInvoke(IPC_INVOKE.materialsMove),
  deleteGeneratedMaterial: createInvoke(IPC_INVOKE.materialsGeneratedDelete),
  generateMaterial: createInvoke(IPC_INVOKE.materialsGenerate),
  materialCloudStatus: createInvoke(IPC_INVOKE.materialsCloudStatus),
  uploadMaterialsToCloud: createInvoke(IPC_INVOKE.materialsCloudUpload),
  controlMaterialCloudUpload: createInvoke(IPC_INVOKE.materialsCloudUploadControl),
  retryMaterialAnalysisTransfer: createInvoke(IPC_INVOKE.materialsCloudAnalysisRetry),
  syncMaterialCloud: createInvoke(IPC_INVOKE.materialsCloudSync),
  downloadMaterialFromCloud: createInvoke(IPC_INVOKE.materialsCloudDownload),
  deleteMaterialCloudCopy: createInvoke(IPC_INVOKE.materialsCloudDeleteCopy),
  listPublicMaterials: createInvoke(IPC_INVOKE.materialsPublicList),
  addPublicMaterial: createInvoke(IPC_INVOKE.materialsPublicAdd),
  reportPublicMaterial: createInvoke(IPC_INVOKE.materialsPublicReport),
  publishMaterial: createInvoke(IPC_INVOKE.materialsPublicPublish),
  withdrawMaterialPublication: createInvoke(IPC_INVOKE.materialsPublicWithdraw),
  resolveMaterialSelection: createInvoke(IPC_INVOKE.materialsCloudResolveSelection),
  loadTaskDraft: createInvoke(IPC_INVOKE.taskDraftLoad),
  saveTaskDraft: createInvoke(IPC_INVOKE.taskDraftSave),
  prepareGenerationManifest: createInvoke(IPC_INVOKE.generationManifestPrepare),
  taskStatus: createInvoke(IPC_INVOKE.taskStatus),
  startTask: createInvoke(IPC_INVOKE.taskStart),
  stopTask: createInvoke(IPC_INVOKE.taskStop),
  cloneVoice: createInvoke(IPC_INVOKE.voiceClone),
  listVoiceTemplates: createInvoke(IPC_INVOKE.voiceTemplates),
  importVoiceTemplates: createInvoke(IPC_INVOKE.voiceImportTemplate),
  listVoiceRegistry: createInvoke(IPC_INVOKE.voiceRegistry),
  onTaskEvent: createEventSubscription<TaskEvent>(IPC_EVENTS.task),
  onUpdateEvent: createEventSubscription<UpdateState>(IPC_EVENTS.update),
  onRuntimeEvent: createEventSubscription<RuntimeState>(IPC_EVENTS.runtime),
  onMaterialEvent: createEventSubscription<TaskEvent>(IPC_EVENTS.material),
  onMaterialLibraryEvent: createEventSubscription<MaterialEvent>(IPC_EVENTS.materialLibrary),
  onVoiceEvent: createEventSubscription<TaskEvent>(IPC_EVENTS.voice),
} satisfies VideoAutoCutApi

contextBridge.exposeInMainWorld('videoAutoCut', videoAutoCutApi)
