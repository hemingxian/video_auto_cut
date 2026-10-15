import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'

import { IPC_EVENTS } from './ipc-channels.js'
import { extractZipWithProgress } from './runtime-archive.js'
import {
  replaceDirectoryAtomically,
  resolveRuntimeVersionDirectory,
  validateRuntimeVersion,
  writeFileAtomically,
} from './runtime-install.js'
import { asRecord, errorMessage, numberValue, type IpcSender, type JsonRecord } from './types.js'
import { cleanConfiguredPath, ensureDir, safeJsonRead } from './utils.js'

const DEFAULT_MANIFEST_URL = 'https://auto-cut-public-package-1453657051.cos.ap-chengdu.myqcloud.com/runtime/manifest.json'
const MANIFEST_ENV_KEYS = ['VIDEOAUTO_RUNTIME_MANIFEST_URL', 'VIDEOAUTOCUT_RUNTIME_MANIFEST_URL']
const ENGINE_EXE_NAME = 'VideoAutoCutEngine.exe'

type RuntimeStatus = 'ready' | 'missing' | 'checking' | 'available' | 'error' | 'downloading' | 'verifying' | 'extracting'

interface RuntimeProgress {
  percent: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}

interface RuntimeState {
  status: RuntimeStatus
  ready: boolean
  localVersion: string
  latestVersion: string
  runtimeRoot: string
  manifestUrl: string
  url: string
  sha256: string
  size: number
  notes: string
  message: string
  error: string
  progress: RuntimeProgress | null
  updatedAt: string
}

interface RuntimeManifest {
  version: string
  url: string
  sha256: string
  size: number
  notes: string
  raw: unknown
}

interface RuntimeCurrentRecord {
  version?: string
  path?: string
  manifestUrl?: string
  url?: string
  sha256?: string
  installedAt?: string
}

interface RuntimeServiceOptions {
  userDataRoot: string
  configRoot: string
  runtimeBaseDir: string
  runtimeCurrentPath: string
  runtimeDownloadDir: string
  engineExeName?: string
  initialRuntimeRoot?: string
  readEnvFile: (file: string) => Record<string, string>
  send: IpcSender
  onRuntimeRootChanged?: (root: string) => void
  ensureDataLayout?: () => void
}

interface RuntimeCheckOptions {
  silent?: boolean
}

interface DownloadResult {
  sha256: string
  size: number
}

function findRuntimeRoot(baseDir: string, engineExeName = ENGINE_EXE_NAME): string {
  const candidates = [
    baseDir,
    path.join(baseDir, 'VideoAutoCut'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, engineExeName))) return candidate
  }
  return ''
}

function readCurrentRuntimeRoot({
  userDataRoot,
  runtimeBaseDir,
  runtimeCurrentPath,
  legacyRuntimeBaseDirs = [],
  legacyRuntimeCurrentPaths = [],
  engineExeName = ENGINE_EXE_NAME,
}: {
  userDataRoot: string
  runtimeBaseDir: string
  runtimeCurrentPath?: string
  legacyRuntimeBaseDirs?: string[]
  legacyRuntimeCurrentPaths?: string[]
  engineExeName?: string
}): string {
  const currentPaths = [
    runtimeCurrentPath || path.join(userDataRoot, 'runtime', 'current.json'),
    ...legacyRuntimeCurrentPaths,
  ]
  const runtimeBaseDirs = [runtimeBaseDir, ...legacyRuntimeBaseDirs]

  for (const currentPath of currentPaths) {
    const record = safeJsonRead<RuntimeCurrentRecord | null>(currentPath, null)
    const configured = cleanConfiguredPath(record?.path)
    if (configured && fs.existsSync(path.join(configured, engineExeName))) return configured

    const version = cleanConfiguredPath(record?.version)
    if (!version) continue

    for (const baseDir of runtimeBaseDirs) {
      const root = findRuntimeRoot(path.join(baseDir, version), engineExeName)
      if (root) return root
    }
  }

  return ''
}

function isRuntimeUsable(root: unknown, engineExeName = ENGINE_EXE_NAME): boolean {
  const runtimeRoot = cleanConfiguredPath(root)
  return Boolean(runtimeRoot && fs.existsSync(path.join(runtimeRoot, engineExeName)))
}

function isPathInside(parent: string, candidate: string): boolean {
  const parentPath = path.resolve(parent)
  const candidatePath = path.resolve(candidate)
  const relative = path.relative(parentPath, candidatePath)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function removeRuntimePath(target: string, parent: string): boolean {
  if (!isPathInside(parent, target)) return false
  fs.rmSync(target, { recursive: true, force: true })
  return true
}

function cleanupOldRuntimeVersions({
  runtimeBaseDir,
  runtimeDownloadDir,
  activeVersion,
  activeRoot,
  engineExeName = ENGINE_EXE_NAME,
}: {
  runtimeBaseDir: string
  runtimeDownloadDir: string
  activeVersion: string
  activeRoot: string
  engineExeName?: string
}): void {
  const base = path.resolve(runtimeBaseDir)
  if (!fs.existsSync(base)) return

  const activeVersionDir = path.resolve(runtimeBaseDir, activeVersion)
  const activeRuntimeRoot = path.resolve(activeRoot)
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'downloads') continue

    const entryPath = path.resolve(base, entry.name)
    if (entryPath === activeVersionDir) continue
    if (entryPath === activeRuntimeRoot || isPathInside(entryPath, activeRuntimeRoot)) continue

    const looksLikeRuntime = Boolean(
      findRuntimeRoot(entryPath, engineExeName)
      || entry.name.endsWith('.tmp')
      || /^\d+(?:\.\d+){1,3}(?:[-_][\w.-]+)?$/.test(entry.name)
      || /^v\d+(?:\.\d+){1,3}(?:[-_][\w.-]+)?$/i.test(entry.name),
    )
    if (!looksLikeRuntime) continue

    try {
      if (removeRuntimePath(entryPath, base)) console.info(`[runtime] removed old runtime: ${entryPath}`)
    } catch (error) {
      console.warn(`[runtime] failed to remove old runtime ${entryPath}: ${errorMessage(error)}`)
    }
  }

  const downloads = path.resolve(runtimeDownloadDir)
  if (!fs.existsSync(downloads) || !isPathInside(base, downloads)) return
  for (const entry of fs.readdirSync(downloads, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (!/^VideoAutoCut-runtime-.+\.zip$/i.test(entry.name)) continue
    const entryPath = path.resolve(downloads, entry.name)
    try {
      if (removeRuntimePath(entryPath, downloads)) console.info(`[runtime] removed runtime package: ${entryPath}`)
    } catch (error) {
      console.warn(`[runtime] failed to remove runtime package ${entryPath}: ${errorMessage(error)}`)
    }
  }
}

function normalizeRuntimeManifest(value: unknown): RuntimeManifest {
  const manifest = asRecord(value)
  const latest = cleanConfiguredPath(manifest.latest || manifest.version)
  const versions = Array.isArray(manifest.versions) ? manifest.versions.map(asRecord) : []
  let item: JsonRecord = manifest

  if (versions.length && latest) {
    item = versions.find((entry) => cleanConfiguredPath(entry.version) === latest) || versions[0]
  }

  const version = cleanConfiguredPath(item.version || latest)
  const url = cleanConfiguredPath(item.url || item.downloadUrl)
  if (!version) throw new Error('runtime manifest 缺少 version/latest')
  if (!url) throw new Error('runtime manifest 缺少 url')
  validateRuntimeVersion(version)

  return {
    version,
    url,
    sha256: cleanConfiguredPath(item.sha256 || item.hash).toLowerCase(),
    size: Math.max(0, numberValue(item.size, 0)),
    notes: String(item.notes || item.releaseNotes || manifest.notes || ''),
    raw: value,
  }
}

function requestJsonText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https
    const req = client.get(url, { headers: { 'Cache-Control': 'no-cache' } }, (res) => {
      const statusCode = res.statusCode ?? 0
      if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
        res.resume()
        requestJsonText(new URL(res.headers.location, url).toString()).then(resolve, reject)
        return
      }

      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`HTTP ${statusCode}: ${body.slice(0, 300)}`))
          return
        }
        resolve(body)
      })
    })

    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('请求 runtime manifest 超时')))
  })
}

function createRuntimeService(options: RuntimeServiceOptions) {
  const {
    configRoot,
    runtimeBaseDir,
    runtimeCurrentPath,
    runtimeDownloadDir,
    readEnvFile,
    send,
  } = options
  const engineExeName = options.engineExeName || ENGINE_EXE_NAME
  const onRuntimeRootChanged = options.onRuntimeRootChanged || (() => undefined)
  const ensureDataLayout = options.ensureDataLayout || (() => undefined)

  let runtimeRoot = cleanConfiguredPath(options.initialRuntimeRoot)
  let currentRuntimeTask: Promise<RuntimeState> | null = null
  let runtimeState = createInitialRuntimeState()

  function getRuntimeManifestUrl(): string {
    const env = readEnvFile(process.env.VIDEOAUTO_ENV_PATH || path.join(configRoot, 'app.env'))
    for (const key of MANIFEST_ENV_KEYS) {
      const value = cleanConfiguredPath(process.env[key] || env[key])
      if (value) return value
    }
    return DEFAULT_MANIFEST_URL
  }

  function readCurrentRuntimeRecord(): RuntimeCurrentRecord | null {
    return safeJsonRead<RuntimeCurrentRecord | null>(runtimeCurrentPath, null)
  }

  function getRoot(): string {
    return runtimeRoot
  }

  function setRoot(root: unknown): string {
    runtimeRoot = cleanConfiguredPath(root)
    onRuntimeRootChanged(runtimeRoot)
    return runtimeRoot
  }

  function getState(): RuntimeState {
    return runtimeState
  }

  function usable(root = runtimeRoot): boolean {
    return isRuntimeUsable(root, engineExeName)
  }

  function createInitialRuntimeState(): RuntimeState {
    const record = readCurrentRuntimeRecord()
    const ready = usable(runtimeRoot)

    return {
      status: ready ? 'ready' : 'missing',
      ready,
      localVersion: cleanConfiguredPath(record?.version),
      latestVersion: '',
      runtimeRoot: ready ? runtimeRoot : '',
      manifestUrl: getRuntimeManifestUrl(),
      url: '',
      sha256: '',
      size: 0,
      notes: '',
      message: ready ? '运行环境已就绪' : '运行环境未安装',
      error: '',
      progress: null,
      updatedAt: new Date().toISOString(),
    }
  }

  function setState(patch: Partial<RuntimeState>): RuntimeState {
    runtimeState = {
      ...runtimeState,
      ...patch,
      ready: patch.ready ?? runtimeState.ready,
      updatedAt: new Date().toISOString(),
    }
    send(IPC_EVENTS.runtime, runtimeState)
    return runtimeState
  }

  async function fetchRuntimeManifest(): Promise<RuntimeManifest> {
    const manifestUrl = getRuntimeManifestUrl()
    const text = await requestJsonText(manifestUrl)
    const manifest = normalizeRuntimeManifest(JSON.parse(text))

    setState({
      manifestUrl,
      latestVersion: manifest.version,
      url: manifest.url,
      sha256: manifest.sha256,
      size: manifest.size,
      notes: manifest.notes,
      error: '',
    })

    return manifest
  }

  async function check(options: RuntimeCheckOptions = {}): Promise<RuntimeState> {
    const localRecord = readCurrentRuntimeRecord()
    const ready = usable(runtimeRoot)
    const localVersion = cleanConfiguredPath(localRecord?.version)

    setState({
      status: options.silent ? runtimeState.status : 'checking',
      ready,
      localVersion,
      runtimeRoot: ready ? runtimeRoot : '',
      manifestUrl: getRuntimeManifestUrl(),
      message: '正在检查运行环境版本...',
      error: '',
    })

    try {
      const manifest = await fetchRuntimeManifest()
      const needsInstall = !ready
      const localSha256 = cleanConfiguredPath(localRecord?.sha256).toLowerCase()
      const manifestSha256 = cleanConfiguredPath(manifest.sha256).toLowerCase()
      const needsUpdate = ready && (
        localVersion !== manifest.version
        || Boolean(manifestSha256 && localSha256 !== manifestSha256)
      )

      return setState({
        status: needsInstall || needsUpdate ? 'available' : 'ready',
        ready,
        message: needsInstall
          ? `需要安装运行环境 ${manifest.version}`
          : needsUpdate
            ? `发现运行环境 ${manifest.version}`
            : '运行环境已是最新版本',
        error: '',
      })
    } catch (error) {
      if (ready) {
        return setState({
          status: 'ready',
          ready: true,
          message: '运行环境已就绪，检查更新失败，可继续使用',
          error: errorMessage(error),
        })
      }

      return setState({
        status: 'error',
        ready: false,
        message: '运行环境未安装，且检查下载清单失败',
        error: errorMessage(error),
      })
    }
  }

  function downloadFile(url: string, outputPath: string, expectedSha256 = ''): Promise<DownloadResult> {
    return new Promise((resolve, reject) => {
      ensureDir(path.dirname(outputPath))
      const hash = crypto.createHash('sha256')
      const file = fs.createWriteStream(outputPath)
      const startedAt = Date.now()
      const client = url.startsWith('http://') ? http : https

      const req = client.get(url, (res) => {
        const statusCode = res.statusCode ?? 0
        if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
          file.close(() => fs.rmSync(outputPath, { force: true }))
          res.resume()
          downloadFile(new URL(res.headers.location, url).toString(), outputPath, expectedSha256).then(resolve, reject)
          return
        }

        if (statusCode < 200 || statusCode >= 300) {
          file.close(() => fs.rmSync(outputPath, { force: true }))
          reject(new Error(`下载 runtime 失败 HTTP ${statusCode}`))
          return
        }

        const total = Number(res.headers['content-length'] || 0)
        let transferred = 0
        res.on('data', (chunk: Buffer) => {
          transferred += chunk.length
          hash.update(chunk)
          const elapsed = Math.max(1, (Date.now() - startedAt) / 1000)
          setState({
            status: 'downloading',
            progress: {
              percent: total ? transferred / total * 100 : 0,
              transferred,
              total,
              bytesPerSecond: transferred / elapsed,
            },
          })
        })
        res.pipe(file)

        file.on('finish', () => {
          file.close(() => {
            setState({
              status: 'verifying',
              message: '正在校验安装包...',
              progress: { percent: 100, transferred, total: transferred },
            })
            const digest = hash.digest('hex')
            if (expectedSha256 && digest.toLowerCase() !== expectedSha256.toLowerCase()) {
              fs.rmSync(outputPath, { force: true })
              reject(new Error(`runtime sha256 校验失败: ${digest}`))
              return
            }
            resolve({ sha256: digest, size: transferred })
          })
        })
      })

      req.on('error', (error) => {
        file.close(() => fs.rmSync(outputPath, { force: true }))
        reject(error)
      })
    })
  }

  async function extractRuntimeZip(zipPath: string, version: string): Promise<string> {
    const dest = resolveRuntimeVersionDirectory(runtimeBaseDir, version)
    const tmp = `${dest}.tmp`
    const backup = `${dest}.backup`

    fs.rmSync(tmp, { recursive: true, force: true })
    ensureDir(tmp)
    setState({
      status: 'extracting',
      message: '正在安装运行环境...',
      progress: { percent: 0 },
    })

    try {
      await extractZipWithProgress(zipPath, tmp, (progress) => {
        setState({
          status: 'extracting',
          message: '正在安装运行环境...',
          progress,
        })
      })

      const root = findRuntimeRoot(tmp, engineExeName)
      if (!root) throw new Error(`runtime zip 解压后没有找到 ${engineExeName}`)

      replaceDirectoryAtomically({
        targetDirectory: dest,
        stagingDirectory: tmp,
        backupDirectory: backup,
        validate: (directory) => {
          if (!findRuntimeRoot(directory, engineExeName)) {
            throw new Error(`runtime 安装失败：没有找到 ${engineExeName}`)
          }
        },
      })

      const finalRoot = findRuntimeRoot(dest, engineExeName)
      if (!finalRoot) throw new Error(`runtime 安装失败：没有找到 ${engineExeName}`)
      return finalRoot
    } catch (error) {
      fs.rmSync(tmp, { recursive: true, force: true })
      throw error
    }
  }

  async function download(): Promise<RuntimeState> {
    if (currentRuntimeTask) return currentRuntimeTask

    currentRuntimeTask = (async () => {
      try {
        const manifest = await fetchRuntimeManifest()
        const zipPath = path.join(runtimeDownloadDir, `VideoAutoCut-runtime-${manifest.version}.zip`)
        setState({
          status: 'downloading',
          message: `正在下载运行环境 ${manifest.version}...`,
          error: '',
          progress: { percent: 0, transferred: 0, total: manifest.size },
        })
        await downloadFile(manifest.url, zipPath, manifest.sha256)
        const nextRoot = await extractRuntimeZip(zipPath, manifest.version)
        const record: RuntimeCurrentRecord = {
          version: manifest.version,
          path: nextRoot,
          manifestUrl: getRuntimeManifestUrl(),
          url: manifest.url,
          sha256: manifest.sha256,
          installedAt: new Date().toISOString(),
        }

        ensureDir(path.dirname(runtimeCurrentPath))
        writeFileAtomically(runtimeCurrentPath, JSON.stringify(record, null, 2))
        setRoot(nextRoot)
        ensureDataLayout()
        setState({
          status: 'extracting',
          message: '正在清理旧版本...',
          progress: { percent: 100 },
        })
        cleanupOldRuntimeVersions({
          runtimeBaseDir,
          runtimeDownloadDir,
          activeVersion: manifest.version,
          activeRoot: nextRoot,
          engineExeName,
        })

        return setState({
          status: 'ready',
          ready: true,
          localVersion: manifest.version,
          latestVersion: manifest.version,
          runtimeRoot: nextRoot,
          message: '运行环境已安装完成',
          error: '',
          progress: null,
        })
      } catch (error) {
        return setState({
          status: 'error',
          ready: usable(runtimeRoot),
          runtimeRoot: usable(runtimeRoot) ? runtimeRoot : '',
          message: '运行环境下载或安装失败',
          error: errorMessage(error),
          progress: null,
        })
      } finally {
        currentRuntimeTask = null
      }
    })()

    return currentRuntimeTask
  }

  function status(): RuntimeState {
    const record = readCurrentRuntimeRecord()
    const ready = usable(runtimeRoot)
    const preserveStatus = ['downloading', 'verifying', 'extracting', 'available'].includes(runtimeState.status)

    return setState({
      status: ready ? (preserveStatus ? runtimeState.status : 'ready') : runtimeState.status,
      ready,
      localVersion: cleanConfiguredPath(record?.version),
      runtimeRoot: ready ? runtimeRoot : '',
      manifestUrl: getRuntimeManifestUrl(),
    })
  }

  return {
    check,
    download,
    getManifestUrl: getRuntimeManifestUrl,
    getRoot,
    getState,
    isUsable: usable,
    readCurrentRecord: readCurrentRuntimeRecord,
    setRoot,
    status,
  }
}

export {
  DEFAULT_MANIFEST_URL,
  ENGINE_EXE_NAME,
  createRuntimeService,
  findRuntimeRoot,
  isRuntimeUsable,
  readCurrentRuntimeRoot,
}
