import { app, BrowserWindow, dialog, shell, Menu, net, protocol } from 'electron'
import type { OpenDialogOptions } from 'electron'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { nativeTheme } from 'electron'
import { cleanConfiguredPath } from './utils.js'
import { createAccountService } from './account-service.js'
import { getOrCreateDeviceId } from './device-identity.js'
import { createAppUpdateService } from './app-update-service.js'
import { DEFAULT_MANIFEST_URL as RUNTIME_MANIFEST_DEFAULT_URL, ENGINE_EXE_NAME as RUNTIME_ENGINE_EXE_NAME, createRuntimeService, isRuntimeUsable, readCurrentRuntimeRoot } from './runtime-service.js'
import { getInitialWindowBounds, setWindowMode as applyWindowMode } from './window.js'
import { createMaterialsService } from './materials-service.js'
import { createAccountScopedMaterialStore } from './material-account-store.js'
import { createAccountSessions, materialAccountIdentity, type AccountSession } from './account-session.js'
import { IPC_EVENTS } from './ipc-channels.js'
import { createMaterialCloudService, downloadToFile, normalizeApiBase, uploadFileRangeWithFetch } from './material-cloud-service.js'
import { createMaterialAnalysisExporter } from './material-analysis-exporter.js'
import { createTaskService } from './task-service.js'
import { createVoiceService } from './voice-service.js'
import { createRemoteConfigService } from './remote-config-service.js'
import { createWorkspaceService, readEnvFile, resolveWorkspacePath } from './workspace-service.js'
import { registerIpcHandlers } from './ipc-handlers.js'
import { createRuntimePathState, prepareDevelopmentDependencies } from './runtime-paths.js'
import { LOCAL_MEDIA_SCHEME, registerLocalMediaProtocol } from './local-media-protocol.js'

const require = createRequire(import.meta.url)
const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const APP_NAME = 'VideoAutoCut Studio'
const APP_DATA_DIR_NAME = 'VideoAutoCut'
const INSTALL_USER_DATA_MARKER_FILE = 'vacut-user-data-root.txt'
const INSTALL_DATA_ROOT_REG_KEY = 'Software\\VideoAutoCut'
const INSTALL_DATA_ROOT_REG_VALUE = 'UserDataRoot'
protocol.registerSchemesAsPrivileged([{
  scheme: LOCAL_MEDIA_SCHEME,
  privileges: {
    secure: true,
    standard: true,
    stream: true,
    supportFetchAPI: true,
  },
}])
app.setName(APP_NAME)

function resolveLocalAppDataRoot() {
  return process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
}

function readInstallerUserDataMarker() {
  if (!app.isPackaged) return ''

  try {
    return fs.readFileSync(path.join(path.dirname(process.execPath), INSTALL_USER_DATA_MARKER_FILE), 'utf8')
  } catch {
    return ''
  }
}

function readRegistryString(root: 'HKCU' | 'HKLM', key: string, value: string) {
  try {
    const output = execFileSync('reg.exe', ['query', `${root}\\${key}`, '/v', value], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
      windowsHide: true,
    })
    const pattern = new RegExp(`^\\s*${value}\\s+REG_\\w+\\s+(.+)$`, 'im')
    return output.match(pattern)?.[1] || ''
  } catch {
    return ''
  }
}

function ensureUserDataRoot(root: string) {
  try {
    fs.mkdirSync(root, { recursive: true })
    return root
  } catch {
    return path.join(resolveLocalAppDataRoot(), APP_DATA_DIR_NAME)
  }
}

function resolveUserDataRoot() {
  const candidates = [
    process.env.VIDEOAUTO_USER_DATA_ROOT,
    readInstallerUserDataMarker(),
    readRegistryString('HKCU', INSTALL_DATA_ROOT_REG_KEY, INSTALL_DATA_ROOT_REG_VALUE),
    readRegistryString('HKLM', INSTALL_DATA_ROOT_REG_KEY, INSTALL_DATA_ROOT_REG_VALUE),
  ]

  for (const candidate of candidates) {
    const configured = cleanConfiguredPath(candidate)
    if (configured && path.isAbsolute(configured)) return ensureUserDataRoot(configured)
  }

  return ensureUserDataRoot(path.join(resolveLocalAppDataRoot(), APP_DATA_DIR_NAME))
}

app.setPath('userData', resolveUserDataRoot())


function resolveVideoAutoRoot() {
  if (process.env.VIDEOAUTO_ROOT) return process.env.VIDEOAUTO_ROOT
  const developmentRoot = path.resolve(__dirname, '..', '..', 'VideoAutoCut')
  const userDataRoot = app.getPath('userData')
  const dataRoot = resolveVideoAutoDataRoot()
  const runtimeBaseDir = path.join(dataRoot, 'runtime')
  const legacyRuntimeBaseDir = path.join(userDataRoot, 'runtime')
  const runtimeRoot = readCurrentRuntimeRoot({
    userDataRoot,
    runtimeBaseDir,
    runtimeCurrentPath: path.join(runtimeBaseDir, 'current.json'),
    legacyRuntimeBaseDirs: [legacyRuntimeBaseDir],
    legacyRuntimeCurrentPaths: [path.join(legacyRuntimeBaseDir, 'current.json')],
    engineExeName: RUNTIME_ENGINE_EXE_NAME,
  })
  if (!app.isPackaged && isRuntimeUsable(developmentRoot, RUNTIME_ENGINE_EXE_NAME)) {
    prepareDevelopmentDependencies(developmentRoot, runtimeRoot)
    return developmentRoot
  }
  if (runtimeRoot) return runtimeRoot
  const packagedRoot = path.join(process.resourcesPath, 'VideoAutoCut')
  if (app.isPackaged && fs.existsSync(packagedRoot)) return packagedRoot
  return developmentRoot
}

function resolveVideoAutoConfigRoot() {
  if (process.env.VIDEOAUTO_CONFIG_ROOT) return process.env.VIDEOAUTO_CONFIG_ROOT
  return path.join(app.getPath('userData'), 'config')
}

function resolveVideoAutoDataRoot() {
  const envPath = process.env.VIDEOAUTO_ENV_PATH || path.join(resolveVideoAutoConfigRoot(), 'app.env')
  const env = readEnvFile(envPath)
  return resolveWorkspacePath(process.env.VIDEOAUTO_DATA_ROOT || env.VIDEOAUTO_WORKSPACE_DIR || env.VIDEOAUTO_DATA_ROOT, app.getPath('userData'))
}

function resolveLegacyRoamingDataRoot() {
  const roamingRoot = process.env.APPDATA || app.getPath('appData')
  return path.join(roamingRoot, APP_NAME, 'workspace')
}


const VIDEOAUTO_USER_DATA_ROOT = app.getPath('userData')
const VIDEOAUTO_CONFIG_ROOT = resolveVideoAutoConfigRoot()
const ENV_PATH = process.env.VIDEOAUTO_ENV_PATH || path.join(VIDEOAUTO_CONFIG_ROOT, 'app.env')
const VIDEOAUTO_DATA_ROOT = resolveVideoAutoDataRoot()
const VIDEOAUTO_LEGACY_DATA_ROOT = resolveLegacyRoamingDataRoot()
const RUNS_DIR = path.join(VIDEOAUTO_DATA_ROOT, 'video', 'runs')
const DEFAULT_OUTPUT_DIR = path.join(VIDEOAUTO_DATA_ROOT, 'video', 'output')
const VOICE_TEMPLATES_DIR = path.join(VIDEOAUTO_DATA_ROOT, 'voice_templates')
const VOICE_REGISTRY_PATH = path.join(VOICE_TEMPLATES_DIR, 'voice_registry.json')
const MATERIALS_DIR = path.join(VIDEOAUTO_DATA_ROOT, 'video', 'materials')
const MATERIAL_DATABASE_PATH = path.join(VIDEOAUTO_DATA_ROOT, 'video', 'material-library.sqlite')
const MATERIAL_MANIFESTS_DIR = path.join(VIDEOAUTO_DATA_ROOT, 'video', 'material-manifests')
const AUTH_STATE_PATH = path.join(VIDEOAUTO_CONFIG_ROOT, 'auth.json')
const DEVICE_ID_PATH = path.join(VIDEOAUTO_CONFIG_ROOT, 'device.json')
const AUTH_LOGIN_BASE_URL = 'https://api.evstai.com'
const AUTH_AGENT_BASE_URL = cleanConfiguredPath(process.env.VIDEOAUTO_AGENT_BASE_URL) || 'https://agent.evstai.com'
const AUTH_REGISTER_URL = AUTH_AGENT_BASE_URL
const AUTH_RECHARGE_URL_ENV_KEYS = ['VIDEOAUTO_RECHARGE_URL', 'VIDEOAUTOCUT_RECHARGE_URL']
const AUTH_DEFAULT_RECHARGE_URL = 'https://api.evstai.com/api/v1/payment/orders'
const DEFAULT_MATERIAL_API_BASE_URL = 'https://material-upload.evstai.com'

const RUNTIME_BASE_DIR = path.join(VIDEOAUTO_DATA_ROOT, 'runtime')
const RUNTIME_CURRENT_PATH = path.join(RUNTIME_BASE_DIR, 'current.json')
const RUNTIME_DOWNLOAD_DIR = path.join(RUNTIME_BASE_DIR, 'downloads')
const runtimePaths = createRuntimePathState({
  initialRoot: resolveVideoAutoRoot(),
  engineExeName: RUNTIME_ENGINE_EXE_NAME,
})

let mainWindow: BrowserWindow | null = null
function send(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function showOpenDialog(parentWindow: BrowserWindow | null, options: OpenDialogOptions) {
  return parentWindow ? dialog.showOpenDialog(parentWindow, options) : dialog.showOpenDialog(options)
}

const workspaceService = createWorkspaceService({
  appName: APP_NAME,
  userDataRoot: VIDEOAUTO_USER_DATA_ROOT,
  configRoot: VIDEOAUTO_CONFIG_ROOT,
  dataRoot: VIDEOAUTO_DATA_ROOT,
  legacyDataRoot: VIDEOAUTO_LEGACY_DATA_ROOT,
  envPath: ENV_PATH,
  runsDir: RUNS_DIR,
  defaultOutputDir: DEFAULT_OUTPUT_DIR,
  materialsDir: MATERIALS_DIR,
  voiceTemplatesDir: VOICE_TEMPLATES_DIR,
  runtimeManifestDefaultUrl: RUNTIME_MANIFEST_DEFAULT_URL,
  getVideoAutoRoot: () => runtimePaths.videoAutoRoot,
})

function materialApiBase(): string {
  const env = { ...workspaceService.readRemoteEnv(), ...process.env }
  return normalizeApiBase(env.VIDEOAUTO_MATERIAL_API_BASE_URL || env.VIDEOAUTOCUT_MATERIAL_API_BASE_URL)
    || normalizeApiBase(DEFAULT_MATERIAL_API_BASE_URL)
}

const materialLocalStore = createAccountScopedMaterialStore({
  dataRoot: VIDEOAUTO_DATA_ROOT,
  materialsDir: MATERIALS_DIR,
  runsDir: RUNS_DIR,
  databasePath: MATERIAL_DATABASE_PATH,
  manifestsDir: MATERIAL_MANIFESTS_DIR,
}, () => materialAccountIdentity(accountService.readAuthState(), materialApiBase()))

let notifyAccountChange = () => {}

const accountService = createAccountService({
  authStatePath: AUTH_STATE_PATH,
  agentBaseUrl: AUTH_AGENT_BASE_URL,
  sub2ApiBaseUrl: AUTH_LOGIN_BASE_URL,
  registerUrl: AUTH_REGISTER_URL,
  rechargeUrlEnvKeys: AUTH_RECHARGE_URL_ENV_KEYS,
  defaultRechargeUrl: AUTH_DEFAULT_RECHARGE_URL,
  readEnv: workspaceService.readEnv,
  setRemoteEnv: workspaceService.setRemoteEnv,
  clearRemoteEnv: workspaceService.clearRemoteEnv,
  openExternal: (url) => shell.openExternal(url),
  onAuthStateChanged: () => notifyAccountChange(),
})

const accountSessions = createAccountSessions(
  () => materialAccountIdentity(accountService.readAuthState(), materialApiBase()), materialLocalStore,
)

function readAccountEnv(): Record<string, string> {
  return { ...workspaceService.readEnv(), VIDEOAUTO_MATERIAL_AUTO_BACKUP_IMPORTS:
    materialLocalStore.getCloudState('auto_backup_imports') || 'false' }
}

const materialAnalysisExporter = createMaterialAnalysisExporter({
  dataRoot: VIDEOAUTO_DATA_ROOT,
  getSentrySearchPaths: () => ({
    exe: runtimePaths.sentrySearchExe,
    python: runtimePaths.sentrySearchPython,
    entry: runtimePaths.sentrySearchEntry,
  }),
  createVideoAutoEnv: workspaceService.createVideoAutoEnv,
})

function cloudForSession(session: AccountSession) {
  const auth = accountService.readAuthState()
  const platformEnv = { ...workspaceService.readRemoteEnv(), VIDEOAUTO_MATERIAL_API_BASE_URL: materialApiBase() }
  const request: typeof fetch = (input, init) => session.fetch(
    (target, requestInit) => net.fetch(target as string | Request, requestInit), input, init,
  )
  const service = createMaterialCloudService({
  deviceId: getOrCreateDeviceId(DEVICE_ID_PATH),
  readAuthState: () => !session.identity ? {} : session.active() ? accountService.readAuthState() : auth,
  isSessionActive: session.active,
  transferAbortSignal: session.signal,
  readEnv: readAccountEnv,
  readPlatformEnv: () => platformEnv,
  defaultApiBaseUrl: DEFAULT_MATERIAL_API_BASE_URL,
  send: (channel, payload) => session.send(send, channel, payload),
  store: session.bindStore(materialLocalStore),
  exportAnalysisResult: (file) => session.run(() => materialAnalysisExporter.exportForFile(file, session.signal)),
  importAnalysisResult: (file, value) => session.run(() => materialAnalysisExporter.importForFile(file, value, session.signal)),
  requestLocalAnalysis: (paths) => {
    if (!session.active()) return
    void session.run(() => session.get(materialsForSession).analyzeMaterialsForBackup(paths))
      .catch((error) => {
        if (session.active()) console.error('[VideoAutoCut] prepare local analysis for backup failed', error)
      }).finally(() => {
        if (session.active()) service.wakeQueue()
      })
  },
  request,
  downloadFile: (...args) => session.track(downloadToFile(...args)),
  uploadFile: (authorization, filePath, start, end) => uploadFileRangeWithFetch(
    request,
    authorization,
    filePath,
    start,
    end,
  ),
  })
  session.onDispose(service.stop)
  return service
}
const materialCloudService = accountSessions.proxy(cloudForSession)

const remoteConfigService = createRemoteConfigService({
  readEnv: workspaceService.readEnv,
  writeRemoteEnv: workspaceService.writeRemoteEnv,
  defaultsPath: path.join(__dirname, 'remote-config-defaults.json'),
})

const runtimeService = createRuntimeService({
  userDataRoot: VIDEOAUTO_USER_DATA_ROOT,
  configRoot: VIDEOAUTO_CONFIG_ROOT,
  runtimeBaseDir: RUNTIME_BASE_DIR,
  runtimeCurrentPath: RUNTIME_CURRENT_PATH,
  runtimeDownloadDir: RUNTIME_DOWNLOAD_DIR,
  engineExeName: RUNTIME_ENGINE_EXE_NAME,
  initialRuntimeRoot: runtimePaths.videoAutoRoot,
  readEnvFile,
  send,
  onRuntimeRootChanged: runtimePaths.update,
  ensureDataLayout: workspaceService.ensureDataLayout,
})

const appUpdateService = createAppUpdateService({
  app,
  autoUpdater,
  readEnv: workspaceService.readEnv,
  send,
})

function materialsForSession(session: AccountSession) {
  const cloud = session.get(cloudForSession)
  const service = createMaterialsService({
  dataRoot: VIDEOAUTO_DATA_ROOT,
  materialsDir: MATERIALS_DIR,
  runsDir: RUNS_DIR,
  generatedRecordsPath: path.join(VIDEOAUTO_DATA_ROOT, 'tools', 'material_gen', 'records', 'generated_materials.json'),
  getVideoAutoRoot: () => runtimePaths.videoAutoRoot,
  getPythonPath: () => runtimePaths.pythonPath,
  getSentrySearchPaths: () => ({
    exe: runtimePaths.sentrySearchExe,
    python: runtimePaths.sentrySearchPython,
    entry: runtimePaths.sentrySearchEntry,
  }),
  listRuns: workspaceService.listRuns,
  createVideoAutoEnv: (extra) => session.run(() => workspaceService.createVideoAutoEnv(extra)),
  assertInsideWorkspace: workspaceService.assertInsideWorkspace,
  resolveExistingOrParent: workspaceService.resolveExistingOrParent,
  isInsideDir: workspaceService.isInsideDir,
  safeRemoveFile: workspaceService.safeRemoveFile,
  safeRemoveDirectory: workspaceService.safeRemoveDirectory,
  samePath: workspaceService.samePath,
  isRuntimeUsable: (root: string) => runtimeService.isUsable(root),
  showOpenDialog,
  send: (channel, payload) => session.send(send, channel, payload),
  identityStore: session.bindStore(materialLocalStore),
  cloudSemanticSearch: (query, searchOptions) => {
    session.assertActive()
    const status = cloud.status()
    if (!status.configured || !status.authenticated) return Promise.resolve(null)
    return cloud.semanticSearch({ query, ...searchOptions })
  },
  ensureCloudMaterialAvailable: (materialId) => (
    session.run(() => cloud.downloadMaterial({ materialId }))
  ),
  onMaterialsImported: (files) => {
    if (!session.active()) return
    const env = readAccountEnv()
    if (env.VIDEOAUTO_MATERIAL_AUTO_BACKUP_IMPORTS?.trim() !== 'true') return
    cloud.queueUploads({ paths: files.map((file) => file.path), automatic: true })
  },
  onDownloadedMaterials: (files) => {
    if (session.active()) cloud.queueUploads({ paths: files.map((file) => file.path), automatic: true })
  },
  analysisAbortSignal: session.signal,
  onMaterialAnalysisReady: () => {
    if (session.active()) cloud.wakeQueue()
  },
  hasExistingAnalysis: (file, signal) => materialAnalysisExporter.hasForFile(file, signal || session.signal),
  onMaterialFolderCreated: (folderId) => {
    if (session.active()) cloud.queueFolderSync({ folderId })
  },
  onMaterialFolderDeleted: () => {
    if (session.active()) void cloud.processQueue()
  },
  })
  session.onDispose(service.stopMaterialWork)
  return service
}
const materialsService = accountSessions.proxy(materialsForSession)

function tasksForSession(session: AccountSession) {
  const cloud = session.get(cloudForSession)
  const materials = session.get(materialsForSession)
  const service = createTaskService({
  getVideoAutoRoot: () => runtimePaths.videoAutoRoot,
  getExePath: () => runtimePaths.exePath,
  createVideoAutoEnv: workspaceService.createVideoAutoEnv,
  isRuntimeUsable: (root: string) => runtimeService.isUsable(root),
  send: (channel, payload) => session.send(send, channel, payload),
  onDownloadedMaterials: (runPath, processOptions) => (
    session.active() ? session.run(() => materials.processDownloadedMaterials(runPath, processOptions)) : undefined
  ),
  onGenerationStatus: (value) => session.active() ? session.run(() => cloud.queueGenerationStatus(value)) : undefined,
  })
  session.onDispose(service.stop)
  return { ...service, async start(options: Parameters<typeof service.start>[0]) {
    await session.waitForPrevious()
    return session.run(() => service.start(options))
  } }
}
const taskService = accountSessions.proxy(tasksForSession)

const resumedMaterialSessions = new WeakSet<AccountSession>()
function resumeMaterialWork(session: AccountSession): void {
  if (!session.identity || resumedMaterialSessions.has(session)) return
  resumedMaterialSessions.add(session)
  void session.waitForPrevious()
    .then(() => session.run(() => session.get(materialsForSession).resumePendingMaterialWork()))
    .catch((error) => {
      resumedMaterialSessions.delete(session)
      if (session.active()) console.error('[VideoAutoCut] resume pending material work failed', error)
    })
}

notifyAccountChange = () => {
  const session = accountSessions.refresh()
  if (app.isReady()) {
    try {
      materialCloudService.start()
      resumeMaterialWork(session)
    }
    catch (error) {
      // Authentication has already succeeded; a local cache error must not turn it into a failed login.
      console.error('[VideoAutoCut] account material initialization failed', error)
      send(IPC_EVENTS.materialLibrary, { type: 'cloud-sync-failed', message: '登录成功，但素材目录初始化失败，请重新进入素材库重试' })
    }
  }
}

const voiceService = createVoiceService({
  templatesDir: VOICE_TEMPLATES_DIR,
  registryPath: VOICE_REGISTRY_PATH,
  getVideoAutoRoot: () => runtimePaths.videoAutoRoot,
  getPythonPath: () => runtimePaths.pythonPath,
  createVideoAutoEnv: workspaceService.createVideoAutoEnv,
  isRuntimeUsable: (root: string) => runtimeService.isUsable(root),
  listFilesSafe: workspaceService.listFilesSafe,
  showOpenDialog,
  send,
})

function createWindow(): void {
  Menu.setApplicationMenu(null)
  nativeTheme.themeSource = 'dark'
  const initialAuth = accountService.publicAuthState(accountService.readAuthState())
  const initialBounds = getInitialWindowBounds(initialAuth.loggedIn)
  mainWindow = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    minWidth: initialBounds.minWidth,
    minHeight: initialBounds.minHeight,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) mainWindow.loadURL(devUrl)
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

function setWindowMode(mode = 'main') {
  return applyWindowMode(mainWindow, mode)
}

function getAppInfo() {
  return {
    videoAutoRoot: runtimePaths.videoAutoRoot,
    userDataRoot: VIDEOAUTO_USER_DATA_ROOT,
    configDir: VIDEOAUTO_CONFIG_ROOT,
    dataRoot: VIDEOAUTO_DATA_ROOT,
    exePath: runtimePaths.exePath,
    envPath: ENV_PATH,
    runsDir: RUNS_DIR,
    defaultOutputDir: DEFAULT_OUTPUT_DIR,
    outputDir: workspaceService.getOutputDir(),
    materialsDir: MATERIALS_DIR,
    version: app.getVersion(),
    runtime: runtimeService.getState(),
  }
}

app.whenReady().then(() => {
  workspaceService.ensureDataLayout()
  registerLocalMediaProtocol(protocol, VIDEOAUTO_DATA_ROOT)
  accountService.syncRemoteConfigFromState()
  appUpdateService.setup()
  createWindow()
  materialCloudService.start()
  resumeMaterialWork(accountSessions.refresh())
  appUpdateService.queueStartupCheck()

  void remoteConfigService.syncOnce().then(() => {
    accountService.syncRemoteConfigFromState()
    void materialCloudService.syncNow()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

registerIpcHandlers({
  accountService,
  appUpdateService,
  dialog,
  getAppInfo,
  getMainWindow: () => mainWindow,
  materialLocalStore,
  materialCloudService,
  materialsService,
  runtimeService,
  setWindowMode,
  shell,
  taskService,
  voiceService,
  workspaceService: {
    ...workspaceService,
    readEnv: readAccountEnv,
    writeEnv: (updates: Parameters<typeof workspaceService.writeEnv>[0]) => {
      const next = { ...updates }
      if (Object.hasOwn(next, 'VIDEOAUTO_MATERIAL_AUTO_BACKUP_IMPORTS')) {
        materialLocalStore.setCloudState('auto_backup_imports',
          String(next.VIDEOAUTO_MATERIAL_AUTO_BACKUP_IMPORTS) === 'true' ? 'true' : 'false')
        delete next.VIDEOAUTO_MATERIAL_AUTO_BACKUP_IMPORTS
      }
      workspaceService.writeEnv(next)
      return readAccountEnv()
    },
  },
})

app.once('before-quit', (event) => {
  event.preventDefault()
  void accountSessions.close().finally(() => {
    materialLocalStore.close()
    app.quit()
  })
})
