import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { App } from 'electron'
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'

import { IPC_EVENTS } from './ipc-channels.js'
import { asRecord, errorMessage, numberValue, type EnvReader, type IpcSender } from './types.js'
import { cleanConfiguredPath, firstConfiguredValue, parseBooleanEnvValue } from './utils.js'

const UPDATE_PLACEHOLDER_URL = 'https://example.com/videoautocut/updates/'
const UPDATE_FEED_ENV_KEYS = ['VIDEOAUTO_UPDATE_URL', 'VIDEOAUTOCUT_UPDATE_URL']
const UPDATE_AUTO_CHECK_KEYS = ['VIDEOAUTO_AUTO_UPDATE', 'VIDEOAUTOCUT_AUTO_UPDATE']
const UPDATE_FORCE_DEV_KEYS = ['VIDEOAUTO_UPDATE_FORCE_DEV', 'VIDEOAUTOCUT_UPDATE_FORCE_DEV']

type UpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'installing' | 'error' | 'disabled'
type UpdateFeedSource = 'runtime' | 'bundled' | 'placeholder' | 'missing'

interface SanitizedUpdateInfo {
  version: string
  releaseName: string
  releaseDate: string
  releaseNotes: string
}

interface UpdateProgress {
  percent: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}

interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  configured: boolean
  canCheck: boolean
  isPackaged: boolean
  feedUrl: string
  feedSource: UpdateFeedSource | ''
  available: boolean
  downloaded: boolean
  availableVersion: string
  message: string
  error: string
  progress: UpdateProgress | null
  updateInfo: SanitizedUpdateInfo | null
  lastCheckedAt: string
}

interface UpdateFeed {
  configured: boolean
  url: string
  source: UpdateFeedSource
}

interface AppUpdateServiceOptions {
  app: App
  autoUpdater: AppUpdater
  readEnv: EnvReader
  send: IpcSender
}

interface CheckOptions {
  silent?: boolean
}

function cleanUpdateUrl(value: unknown): string {
  const raw = cleanConfiguredPath(value)
  if (!raw) return ''

  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    const normalizedPath = fs.existsSync(raw) && fs.statSync(raw).isFile() ? path.dirname(raw) : raw
    return pathToFileURL(normalizedPath.endsWith(path.sep) ? normalizedPath : `${normalizedPath}${path.sep}`).href
  }

  try {
    const parsed = new URL(raw)
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) return ''
    if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
    return parsed.href
  } catch (_error) {
    return ''
  }
}

function normalizeComparableUpdateUrl(value: unknown): string {
  return cleanUpdateUrl(value).replace(/\/+$/, '').toLowerCase()
}

function isPlaceholderUpdateUrl(url: string): boolean {
  return normalizeComparableUpdateUrl(url) === normalizeComparableUpdateUrl(UPDATE_PLACEHOLDER_URL)
}

function isTruthyConfig(value: string): boolean {
  return parseBooleanEnvValue(value || undefined) === true
}

function sanitizeReleaseNotes(releaseNotes: unknown): string {
  if (typeof releaseNotes === 'string') return releaseNotes
  if (!Array.isArray(releaseNotes)) return ''

  return releaseNotes
    .map((item) => {
      if (typeof item === 'string') return item
      const record = asRecord(item)
      return String(record.note || record.content || '')
    })
    .filter(Boolean)
    .join('\n')
}

function sanitizeUpdateInfo(info: UpdateInfo | null | undefined): SanitizedUpdateInfo | null {
  if (!info) return null

  return {
    version: String(info.version || ''),
    releaseName: String(info.releaseName || ''),
    releaseDate: String(info.releaseDate || ''),
    releaseNotes: sanitizeReleaseNotes(info.releaseNotes),
  }
}

function normalizeProgress(progress: ProgressInfo | null | undefined): UpdateProgress | null {
  if (!progress) return null

  return {
    percent: numberValue(progress.percent, 0),
    transferred: numberValue(progress.transferred, 0),
    total: numberValue(progress.total, 0),
    bytesPerSecond: numberValue(progress.bytesPerSecond, 0),
  }
}

function createAppUpdateService({ app, autoUpdater, readEnv, send }: AppUpdateServiceOptions) {
  let updateState = createInitialUpdateState()
  let autoUpdaterReady = false
  let startupUpdateTimer: NodeJS.Timeout | null = null
  let updateInstallTimer: NodeJS.Timeout | null = null
  let installingUpdate = false

  function createInitialUpdateState(): UpdateState {
    return {
      status: 'idle',
      currentVersion: app.getVersion(),
      configured: false,
      canCheck: false,
      isPackaged: app.isPackaged,
      feedUrl: '',
      feedSource: '',
      available: false,
      downloaded: false,
      availableVersion: '',
      message: '',
      error: '',
      progress: null,
      updateInfo: null,
      lastCheckedAt: '',
    }
  }

  function emitUpdateState(patch: Partial<UpdateState> = {}): UpdateState {
    updateState = {
      ...updateState,
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      ...patch,
    }
    send(IPC_EVENTS.update, updateState)
    return updateState
  }

  function readBundledUpdateUrl(): string {
    if (!app.isPackaged) return ''

    const configPath = path.join(process.resourcesPath, 'app-update.yml')
    if (!fs.existsSync(configPath)) return ''

    try {
      const text = fs.readFileSync(configPath, 'utf8')
      const match = text.match(/^\s*url\s*:\s*(.+?)\s*$/m)
      return match ? cleanUpdateUrl(match[1]) : ''
    } catch (_error) {
      return ''
    }
  }

  function isAutoUpdateEnabled(): boolean {
    const env = readEnv()
    const value = firstConfiguredValue(UPDATE_AUTO_CHECK_KEYS, env)
    return parseBooleanEnvValue(value || undefined) !== false
  }

  function isDevUpdateForced(): boolean {
    const env = readEnv()
    return isTruthyConfig(firstConfiguredValue(UPDATE_FORCE_DEV_KEYS, env))
  }

  function resolveUpdateFeed(): UpdateFeed {
    const env = readEnv()
    const runtimeUrl = cleanUpdateUrl(firstConfiguredValue(UPDATE_FEED_ENV_KEYS, env))
    if (runtimeUrl) return { configured: true, url: runtimeUrl, source: 'runtime' }

    const bundledUrl = readBundledUpdateUrl()
    if (bundledUrl && !isPlaceholderUpdateUrl(bundledUrl)) {
      return { configured: true, url: bundledUrl, source: 'bundled' }
    }

    return { configured: false, url: '', source: bundledUrl ? 'placeholder' : 'missing' }
  }

  function configure(): UpdateState {
    setup()
    const feed = resolveUpdateFeed()
    const forceDev = isDevUpdateForced()

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.forceDevUpdateConfig = forceDev

    if (feed.configured) {
      autoUpdater.setFeedURL({ provider: 'generic', url: feed.url })
    }

    return emitUpdateState({
      configured: feed.configured,
      canCheck: feed.configured && (app.isPackaged || forceDev),
      feedUrl: feed.url,
      feedSource: feed.source,
    })
  }

  function setup(): void {
    if (autoUpdaterReady) return
    autoUpdaterReady = true

    autoUpdater.on('checking-for-update', () => {
      emitUpdateState({
        status: 'checking',
        message: '正在检查更新...',
        error: '',
        progress: null,
        lastCheckedAt: new Date().toISOString(),
      })
    })

    autoUpdater.on('update-available', (info) => {
      emitUpdateState({
        status: 'available',
        available: true,
        downloaded: false,
        availableVersion: String(info.version || ''),
        message: `发现新版本 ${info.version || ''}`,
        error: '',
        progress: null,
        updateInfo: sanitizeUpdateInfo(info),
      })
    })

    autoUpdater.on('update-not-available', (info) => {
      emitUpdateState({
        status: 'not-available',
        available: false,
        downloaded: false,
        availableVersion: String(info.version || ''),
        message: '当前已是最新版本',
        error: '',
        progress: null,
        updateInfo: sanitizeUpdateInfo(info),
      })
    })

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, numberValue(progress.percent, 0)))
      emitUpdateState({
        status: 'downloading',
        message: `正在下载更新 ${percent.toFixed(1)}%`,
        error: '',
        progress: normalizeProgress(progress),
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      emitUpdateState({
        status: 'installing',
        available: true,
        downloaded: true,
        availableVersion: String(info.version || updateState.availableVersion || ''),
        message: '更新已下载，正在安装并重启...',
        error: '',
        progress: { percent: 100 },
        updateInfo: sanitizeUpdateInfo(info) || updateState.updateInfo,
      })
      scheduleInstallUpdate()
    })

    autoUpdater.on('update-cancelled', (info) => {
      emitUpdateState({
        status: 'available',
        downloaded: false,
        message: '更新下载已取消',
        error: '',
        updateInfo: sanitizeUpdateInfo(info) || updateState.updateInfo,
      })
    })

    autoUpdater.on('error', (error) => {
      emitUpdateState({
        status: 'error',
        message: '检查或下载更新失败',
        error: errorMessage(error),
      })
    })
  }

  async function check(options: CheckOptions = {}) {
    const state = configure()
    if (!isAutoUpdateEnabled()) {
      return {
        ok: false,
        status: emitUpdateState({ status: 'disabled', message: '软件自动检查更新已禁用', error: '' }),
      }
    }
    if (!state.configured) {
      return {
        ok: false,
        status: emitUpdateState({ status: 'idle', message: '未配置更新地址', error: '' }),
      }
    }
    if (!state.canCheck) {
      return {
        ok: false,
        status: emitUpdateState({ status: 'idle', message: '开发环境默认不检查更新，请打包后测试。', error: '' }),
      }
    }

    try {
      emitUpdateState({
        status: 'checking',
        message: options.silent ? '后台检查更新...' : '正在检查更新...',
        error: '',
      })
      const result = await autoUpdater.checkForUpdates()
      if (!result) {
        return {
          ok: false,
          status: emitUpdateState({ status: 'idle', message: '当前环境无法检查更新', error: '' }),
        }
      }
      return { ok: true, status: updateState }
    } catch (error) {
      return {
        ok: false,
        status: emitUpdateState({
          status: 'error',
          message: '检查更新失败',
          error: errorMessage(error),
        }),
      }
    }
  }

  async function download() {
    const state = configure()
    if (!state.canCheck) return { ok: false, status: updateState }
    if (!updateState.available && updateState.status !== 'available') {
      return { ok: false, status: emitUpdateState({ message: '没有可下载的新版本' }) }
    }

    try {
      emitUpdateState({
        status: 'downloading',
        message: '开始下载更新...',
        error: '',
        progress: { percent: 0 },
      })
      await autoUpdater.downloadUpdate()
      return { ok: true, status: updateState }
    } catch (error) {
      return {
        ok: false,
        status: emitUpdateState({
          status: 'error',
          message: '下载更新失败',
          error: errorMessage(error),
        }),
      }
    }
  }

  function install() {
    if (!updateState.downloaded) {
      return { ok: false, status: emitUpdateState({ message: '更新尚未下载完成' }) }
    }
    installDownloadedUpdate()
    return { ok: true, status: updateState }
  }

  function scheduleInstallUpdate(): void {
    if (updateInstallTimer || installingUpdate) return

    updateInstallTimer = setTimeout(() => {
      updateInstallTimer = null
      installDownloadedUpdate()
    }, 1200)
  }

  function installDownloadedUpdate(): void {
    if (updateInstallTimer) {
      clearTimeout(updateInstallTimer)
      updateInstallTimer = null
    }
    if (installingUpdate) return

    installingUpdate = true
    autoUpdater.quitAndInstall(true, true)
  }

  function queueStartupCheck(): void {
    if (startupUpdateTimer || !isAutoUpdateEnabled()) return

    const state = configure()
    if (!state.canCheck) return

    startupUpdateTimer = setTimeout(() => {
      check({ silent: true }).catch((): undefined => undefined)
    }, 5000)
  }

  function getState(): UpdateState {
    return updateState
  }

  return {
    check,
    configure,
    download,
    getState,
    install,
    queueStartupCheck,
    setup,
  }
}

export {
  createAppUpdateService,
}
