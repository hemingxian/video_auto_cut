import { ipcMain, type BrowserWindow, type Dialog, type Shell } from 'electron'
import path from 'node:path'

import { IPC_INVOKE } from './ipc-channels.js'
import { asRecord, errorMessage } from './types.js'
import { isRunDeletionBlocked } from './task-history.js'
import { SCRIPT_EXTENSIONS, VOICE_TEMPLATE_EXTENSIONS, extensionsForDialog } from './file-extensions.js'
import { registerFileReadHandler } from './ipc-file-read.js'
import { createScriptRevealRegistry, registerTaskStartHandler } from './script-reveal.js'
import { readVoiceScriptSource, writeVoiceScriptBody } from './voice-script-body.js'

type InvokeChannel = typeof IPC_INVOKE[keyof typeof IPC_INVOKE]
type UnknownHandler = (...args: never[]) => unknown

function invokeUnary(handler: UnknownHandler, value: unknown): unknown {
  return handler(value as never)
}

function invokeBinary(handler: UnknownHandler, first: unknown, second: unknown): unknown {
  return handler(first as never, second as never)
}

interface AccountIpcService {
  publicAuthState: (state: unknown) => unknown
  readAuthState: () => unknown
  authCaptcha: () => unknown
  authLogin: UnknownHandler
  authRefresh: () => unknown
  clearAuthState: () => unknown
  authCreateRecharge: UnknownHandler
  authQueryRechargeStatus: UnknownHandler
  authOpenRegister: () => unknown
}

interface AppUpdateIpcService {
  configure: () => unknown
  check: UnknownHandler
  download: () => unknown
  install: () => unknown
}

interface MaterialsIpcService {
  list: () => unknown
  browseMaterials: UnknownHandler
  searchMaterialFolders: UnknownHandler
  getMaterialFolderDetails: UnknownHandler
  summarizeMaterialSelection: UnknownHandler
  createMaterialFolder: UnknownHandler
  renameMaterialFolder: UnknownHandler
  deleteMaterialFolder: UnknownHandler
  importMaterials: (
    window: BrowserWindow | null,
    options?: { folderId?: unknown; selection?: unknown },
  ) => unknown
  cancelMaterialImport: () => unknown
  analyzeMaterial: UnknownHandler
  semanticSearch: UnknownHandler
  autoResolveShotMaterials: UnknownHandler
  listGenerated: () => unknown
  deleteMaterial: (file?: unknown) => unknown
  deleteMaterials: UnknownHandler
  deleteLocalMaterialCopy: UnknownHandler
  previewMaterialDeletion: UnknownHandler
  renameMaterial: UnknownHandler
  moveMaterials: UnknownHandler
  moveMaterialFolder: UnknownHandler
  deleteGenerated: UnknownHandler
  generate: UnknownHandler
}

interface MaterialLocalStoreIpcService {
  loadTaskDraft: UnknownHandler
  saveTaskDraft: UnknownHandler
  prepareGenerationManifest: UnknownHandler
  effectiveScope: () => string
  getScopeDatabasePath: (scope?: string) => string
}

interface MaterialCloudIpcService {
  status: () => unknown
  queueUploads: UnknownHandler
  retryAnalysisTransfer: UnknownHandler
  controlUpload: UnknownHandler
  syncNow: () => unknown
  downloadMaterial: UnknownHandler
  queueCloudCopyDeletion: UnknownHandler
  listPublicMaterials: UnknownHandler
  addPublicMaterial: UnknownHandler
  reportPublicMaterial: UnknownHandler
  publishMaterial: UnknownHandler
  withdrawPublication: UnknownHandler
  resolveMaterialSelection: UnknownHandler
  prepareGenerationManifest: UnknownHandler
}

interface RuntimeIpcService {
  status: () => unknown
  check: UnknownHandler
  download: () => unknown
}

interface TaskIpcService {
  start: UnknownHandler
  status: () => unknown
  stop: UnknownHandler
}

interface VoiceIpcService {
  clone: UnknownHandler
  templates: () => unknown
  listRegistry: () => unknown
  importTemplate: (window: BrowserWindow | null) => unknown
}

interface WorkspaceIpcService {
  assertInsideWorkspace: (target: unknown, label?: string) => string
  readEnv: () => unknown
  readProgressTemplates: () => unknown
  writeEnv: UnknownHandler
  writeProgressTemplates: UnknownHandler
  listRuns: () => unknown
  listRunScriptPaths: () => unknown[]
  readTextFile: (file: unknown, max?: number) => unknown
  safeRemoveFile: (file: unknown) => boolean
  writeTextFile: (file: unknown, text: unknown) => unknown
}

interface IpcHandlerRegistry {
  accountService: AccountIpcService
  appUpdateService: AppUpdateIpcService
  dialog: Dialog
  getAppInfo: () => unknown
  getMainWindow: () => BrowserWindow | null
  materialLocalStore: MaterialLocalStoreIpcService
  materialCloudService: MaterialCloudIpcService
  materialsService: MaterialsIpcService
  runtimeService: RuntimeIpcService
  setWindowMode: (mode?: string) => unknown
  shell: Shell
  taskService: TaskIpcService
  voiceService: VoiceIpcService
  workspaceService: WorkspaceIpcService
}

function registerIpcHandlers({
  accountService,
  appUpdateService,
  dialog,
  getAppInfo,
  getMainWindow,
  materialLocalStore,
  materialCloudService,
  materialsService,
  runtimeService,
  setWindowMode,
  shell,
  taskService,
  voiceService,
  workspaceService,
}: IpcHandlerRegistry): void {
  const handle = (channel: InvokeChannel, listener: Parameters<typeof ipcMain.handle>[1]) => {
    ipcMain.handle(channel, listener)
  }
  const handleQuery = (channel: InvokeChannel, action: () => unknown) => {
    handle(channel, () => action())
  }
  const handleUnaryCommand = (channel: InvokeChannel, action: UnknownHandler) => {
    handle(channel, (_event, options = {}) => invokeUnary(action, options))
  }
  const showOpenDialog = (options: Electron.OpenDialogOptions) => {
    const window = getMainWindow()
    return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options)
  }
  const openWorkspacePath = async (target: unknown, label: string) => {
    if (!target) return true
    const safeTarget = workspaceService.assertInsideWorkspace(target, label)
    const openError = await shell.openPath(safeTarget)
    if (openError) throw new Error(openError)
    return true
  }
  const scriptRevealRegistry = createScriptRevealRegistry({
    shell,
    currentScope: materialLocalStore.effectiveScope,
    registryFile: (scope) => path.join(path.dirname(materialLocalStore.getScopeDatabasePath(scope)), 'script-reveal.json'),
    historicalScripts: workspaceService.listRunScriptPaths,
  })

  handle(IPC_INVOKE.windowMode, (_event, mode = 'main') => setWindowMode(String(mode || 'main')))
  handleQuery(IPC_INVOKE.appInfo, getAppInfo)

  handleQuery(IPC_INVOKE.runtimeStatus, () => runtimeService.status())
  handleUnaryCommand(IPC_INVOKE.runtimeCheck, runtimeService.check)
  handleQuery(IPC_INVOKE.runtimeDownload, () => runtimeService.download())

  handleQuery(IPC_INVOKE.updateStatus, () => appUpdateService.configure())
  handleUnaryCommand(IPC_INVOKE.updateCheck, appUpdateService.check)
  handleQuery(IPC_INVOKE.updateDownload, () => appUpdateService.download())
  handleQuery(IPC_INVOKE.updateInstall, () => appUpdateService.install())

  handleQuery(IPC_INVOKE.authStatus, () => accountService.publicAuthState(accountService.readAuthState()))
  handleQuery(IPC_INVOKE.authCaptcha, () => accountService.authCaptcha())
  handleUnaryCommand(IPC_INVOKE.authLogin, async (value: unknown) => {
    const result = await invokeUnary(accountService.authLogin, value)
    if (asRecord(result).ok === true) {
      // Login must not wait for a large library, but must start its catalog sync.
      void Promise.resolve().then(() => materialCloudService.syncNow()).catch((error) => {
        console.error('[VideoAutoCut] post-login material sync failed', error)
      })
    }
    return result
  })
  handleQuery(IPC_INVOKE.authRefresh, () => accountService.authRefresh())
  handleQuery(IPC_INVOKE.authLogout, () => accountService.clearAuthState())
  handleUnaryCommand(IPC_INVOKE.authRecharge, accountService.authCreateRecharge)
  handleUnaryCommand(IPC_INVOKE.authRechargeStatus, accountService.authQueryRechargeStatus)
  handleQuery(IPC_INVOKE.authOpenRegister, () => accountService.authOpenRegister())

  handle(IPC_INVOKE.dialogScriptFiles, async () => {
    const result = await showOpenDialog({
      title: '选择脚本文件',
      filters: [{ name: '脚本文件', extensions: extensionsForDialog(SCRIPT_EXTENSIONS) }],
      properties: ['openFile', 'multiSelections'],
    })
    return result.canceled ? [] : result.filePaths
  })

  handle(IPC_INVOKE.dialogAudio, async () => {
    const result = await showOpenDialog({
      title: '选择声音样本',
      filters: [{ name: 'Audio', extensions: extensionsForDialog(VOICE_TEMPLATE_EXTENSIONS) }],
      properties: ['openFile'],
    })
    return result.canceled ? '' : result.filePaths[0]
  })

  handle(IPC_INVOKE.dialogFolder, async (_event, value = {}) => {
    const options = asRecord(value)
    const result = await showOpenDialog({
      title: String(options.title || '选择文件夹'),
      defaultPath: options.defaultPath ? String(options.defaultPath) : undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? '' : result.filePaths[0]
  })

  handleQuery(IPC_INVOKE.envRead, () => workspaceService.readEnv())
  handleUnaryCommand(IPC_INVOKE.envWrite, workspaceService.writeEnv)
  handleQuery(IPC_INVOKE.progressTemplatesRead, () => workspaceService.readProgressTemplates())
  handleUnaryCommand(IPC_INVOKE.progressTemplatesWrite, workspaceService.writeProgressTemplates)
  handleQuery(IPC_INVOKE.runsList, () => workspaceService.listRuns())
  handle(IPC_INVOKE.runsDelete, async (_event, id) => {
    const runs = workspaceService.listRuns() as Array<{ id: string; path: string; shotsPath: string }>
    const matches = runs.filter((item) => item.id === id)
    if (matches.length !== 1) return { ok: false, message: '任务不存在或标识重复，请刷新列表' }
    const run = matches[0]!
    const active = asRecord(taskService.status())
    if (isRunDeletionBlocked(run, active)) {
      return { ok: false, message: '请先暂停任务，再删除' }
    }
    try {
      const target = workspaceService.assertInsideWorkspace(run.path, '任务目录')
      await shell.trashItem(target)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  registerFileReadHandler(handle, workspaceService.readTextFile)
  handle(IPC_INVOKE.fileWrite, (_event, file, text) => workspaceService.writeTextFile(file, text))
  handle(IPC_INVOKE.fileOpen, (_event, file) => openWorkspacePath(file, '文件'))
  handle(IPC_INVOKE.fileDelete, (_event, file) => {
    try {
      const removedFile = workspaceService.safeRemoveFile(file)
      return { ok: true, removedFile }
    } catch (error) {
      return { ok: false, message: errorMessage(error), removedFile: false }
    }
  })
  handle(IPC_INVOKE.folderOpen, (_event, folder) => openWorkspacePath(folder, '目录'))
  handle(IPC_INVOKE.scriptReveal, (_event, file) => scriptRevealRegistry.reveal(file))
  handle(IPC_INVOKE.scriptBodyRead, (_event, file) => readVoiceScriptSource(file))
  handle(IPC_INVOKE.scriptBodyWrite, (_event, source, body, taskId) => {
    const info = asRecord(getAppInfo())
    return writeVoiceScriptBody(info.dataRoot, source, body, taskId)
  })

  handleQuery(IPC_INVOKE.materialsList, () => materialsService.list())
  handle(IPC_INVOKE.materialsBrowse, async (_event, value = {}) => {
    try {
      return { ok: true, value: await invokeUnary(materialsService.browseMaterials, value) }
    } catch (error) {
      console.error('[VideoAutoCut] materials:browse failed', error)
      return {
        ok: false,
        error: {
          name: error instanceof Error && error.name ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  })
  handleUnaryCommand(IPC_INVOKE.materialsFolderSearch, materialsService.searchMaterialFolders)
  handleUnaryCommand(IPC_INVOKE.materialsFolderDetails, materialsService.getMaterialFolderDetails)
  handle(IPC_INVOKE.materialsSelectionSummary, async (_event, value = {}) => {
    try {
      return { ok: true, value: await invokeUnary(materialsService.summarizeMaterialSelection, value) }
    } catch (error) {
      console.error('[VideoAutoCut] materials:selection-summary failed', error)
      return {
        ok: false,
        error: {
          name: error instanceof Error && error.name ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  })
  handleUnaryCommand(IPC_INVOKE.materialsFolderCreate, materialsService.createMaterialFolder)
  handle(IPC_INVOKE.materialsFolderRename, async (_event, value = {}) => {
    try {
      return await invokeUnary(materialsService.renameMaterialFolder, value)
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })
  handleUnaryCommand(IPC_INVOKE.materialsFolderMove, materialsService.moveMaterialFolder)
  handle(IPC_INVOKE.materialsFolderDelete, async (_event, value = {}) => {
    try {
      return await invokeUnary(materialsService.deleteMaterialFolder, value)
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })
  handle(IPC_INVOKE.materialsImport, (_event, value = {}) => (
    materialsService.importMaterials(getMainWindow(), value)
  ))
  handleQuery(IPC_INVOKE.materialsImportCancel, materialsService.cancelMaterialImport)
  handle(IPC_INVOKE.materialsSemanticSearch, (_event, value = {}) => {
    const options = asRecord(value)
    return invokeBinary(materialsService.semanticSearch, options.query, options)
  })
  handleUnaryCommand(IPC_INVOKE.materialsAutoResolve, materialsService.autoResolveShotMaterials)
  handleQuery(IPC_INVOKE.materialsGeneratedList, () => materialsService.listGenerated())
  handle(IPC_INVOKE.materialsDelete, async (_event, value = {}) => {
    const options = asRecord(value)
    try {
      return await materialsService.deleteMaterial(options.path || options.file)
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })
  handleUnaryCommand(IPC_INVOKE.materialsDeletePreview, materialsService.previewMaterialDeletion)
  handleUnaryCommand(IPC_INVOKE.materialsDeleteBatch, materialsService.deleteMaterials)
  handleUnaryCommand(IPC_INVOKE.materialsDeleteLocalCopy, materialsService.deleteLocalMaterialCopy)
  handle(IPC_INVOKE.materialsRename, async (_event, value = {}) => {
    try {
      return await invokeUnary(materialsService.renameMaterial, value)
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })
  handleUnaryCommand(IPC_INVOKE.materialsMove, materialsService.moveMaterials)
  handleUnaryCommand(IPC_INVOKE.materialsAnalyze, materialsService.analyzeMaterial)
  handle(IPC_INVOKE.materialsGeneratedDelete, async (_event, options = {}) => {
    try {
      return await invokeUnary(materialsService.deleteGenerated, options)
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })
  handleUnaryCommand(IPC_INVOKE.materialsGenerate, materialsService.generate)
  handleQuery(IPC_INVOKE.materialsCloudStatus, materialCloudService.status)
  handleUnaryCommand(IPC_INVOKE.materialsCloudUpload, materialCloudService.queueUploads)
  handleUnaryCommand(IPC_INVOKE.materialsCloudUploadControl, materialCloudService.controlUpload)
  handleUnaryCommand(IPC_INVOKE.materialsCloudAnalysisRetry, materialCloudService.retryAnalysisTransfer)
  handleQuery(IPC_INVOKE.materialsCloudSync, materialCloudService.syncNow)
  handleUnaryCommand(IPC_INVOKE.materialsCloudDownload, materialCloudService.downloadMaterial)
  handleUnaryCommand(
    IPC_INVOKE.materialsCloudDeleteCopy,
    materialCloudService.queueCloudCopyDeletion,
  )
  handleUnaryCommand(IPC_INVOKE.materialsPublicList, materialCloudService.listPublicMaterials)
  handleUnaryCommand(IPC_INVOKE.materialsPublicAdd, materialCloudService.addPublicMaterial)
  handleUnaryCommand(IPC_INVOKE.materialsPublicReport, materialCloudService.reportPublicMaterial)
  handleUnaryCommand(IPC_INVOKE.materialsPublicPublish, materialCloudService.publishMaterial)
  handleUnaryCommand(IPC_INVOKE.materialsPublicWithdraw, materialCloudService.withdrawPublication)
  handleUnaryCommand(
    IPC_INVOKE.materialsCloudResolveSelection,
    materialCloudService.resolveMaterialSelection,
  )

  handle(IPC_INVOKE.taskDraftLoad, (_event, taskId) => (
    invokeUnary(materialLocalStore.loadTaskDraft, taskId)
  ))
  handleUnaryCommand(IPC_INVOKE.taskDraftSave, materialLocalStore.saveTaskDraft)
  handleUnaryCommand(
    IPC_INVOKE.generationManifestPrepare,
    materialCloudService.prepareGenerationManifest,
  )
  handleQuery(IPC_INVOKE.taskStatus, () => taskService.status())
  registerTaskStartHandler(handle, (options) => invokeUnary(taskService.start, options), scriptRevealRegistry)
  handleUnaryCommand(IPC_INVOKE.taskStop, taskService.stop)

  handleUnaryCommand(IPC_INVOKE.voiceClone, voiceService.clone)
  handleQuery(IPC_INVOKE.voiceTemplates, () => voiceService.templates())
  handleQuery(IPC_INVOKE.voiceRegistry, () => voiceService.listRegistry())
  handleQuery(IPC_INVOKE.voiceImportTemplate, () => voiceService.importTemplate(getMainWindow()))
}

export {
  registerIpcHandlers,
}
