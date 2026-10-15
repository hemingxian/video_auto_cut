import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { ZipFile } from 'yazl'

import { prepareRuntimeBase } from './runtime-release-base.js'
import { stageBundledFonts } from './bundled-fonts.js'
import { verifyTemplateRuntime } from './template-runtime.js'

interface PackageInfo {
  version?: string
}

interface RuntimeCurrentRecord {
  path?: string
  version?: string
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')
const desktopRoot = path.resolve(__dirname, '..')
const repoRuntimeRoot = path.join(repoRoot, 'VideoAutoCut')
const repoRuntimeConfigRoot = path.join(repoRuntimeRoot, 'config')
const rustPromptRoot = path.join(repoRoot, 'VideoAutoCutApp', 'prompts')
const rustReleaseEngine = path.join(repoRoot, 'VideoAutoCutApp', 'target', 'release', 'VideoAutoCutEngine.exe')
const runtimeStageRoot = path.join(os.tmpdir(), `VideoAutoCut-runtime-stage-${process.pid}`)
const stagedRuntimeRoot = path.join(runtimeStageRoot, 'VideoAutoCut')
const outDir = path.join(desktopRoot, 'runtime-release')
const packageJsonPath = path.join(desktopRoot, 'package.json')
const packageInfo = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageInfo
const version = process.argv[2] || process.env.VIDEOAUTO_RUNTIME_VERSION || packageInfo.version || '0.0.0'
const bucketBaseUrl = process.env.VIDEOAUTO_RUNTIME_BASE_URL || 'https://auto-cut-public-package-1453657051.cos.ap-chengdu.myqcloud.com/runtime'
const runtimeManifestUrl = process.env.VIDEOAUTO_RUNTIME_MANIFEST_URL || `${bucketBaseUrl.replace(/\/+$/, '')}/manifest.json`
const zipName = `VideoAutoCut-runtime-${version}.zip`
const zipPath = path.join(outDir, zipName)
const engineExeName = 'VideoAutoCutEngine.exe'

const excludedRelPrefixes = [
  'cookies',
  'temp',
  'video',
  'analysis-cache',
  'normalization-cache',
  'vector-db',
  '.sentrysearch',
  'config/app.env',
  'config/auth.json',
  'config/device.json',
  'voice_templates',
  'tools/material_gen/records',
  'tools/material_gen/remotion/node_modules/.cache',
  'tools/material_gen/hyperframes/node_modules/.cache',
  'sentrysearch/.venv/Lib/site-packages/imageio_ffmpeg/binaries',
]
const excludedFileNames = new Set(['.env', 'app.env', 'auth.json', 'device.json', 'downloaded.txt', 'VideoAuto_last_run.log'])
const excludedDirNames = new Set(['__pycache__', '.pytest_cache', 'tests', 'test'])

function clean(value: unknown): string {
  return String(value || '').trim().replace(/^["']|["']$/g, '')
}

function safeJsonRead<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch (_error) {
    return fallback
  }
}

function readEnvFile(file: string): Record<string, string> {
  try {
    if (!fs.existsSync(file)) return {}
    const env: Record<string, string> = {}
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const text = line.trim()
      if (!text || text.startsWith('#') || !text.includes('=')) continue
      const index = text.indexOf('=')
      env[text.slice(0, index).trim()] = clean(text.slice(index + 1))
    }
    return env
  } catch (_error) {
    return {}
  }
}

function findRuntimeRoot(baseDir: string): string {
  const candidates = [
    baseDir,
    path.join(baseDir, 'VideoAutoCut'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, engineExeName))) return candidate
  }
  return ''
}

function defaultRuntimeBaseDir(): string {
  return path.join(resolveDefaultDataRoot(), 'runtime')
}

function defaultUserDataRoot(): string {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'VideoAutoCut')
}

function resolveDefaultDataRoot(): string {
  const userDataRoot = defaultUserDataRoot()
  const env = readEnvFile(path.join(userDataRoot, 'config', 'app.env'))
  const configured = clean(process.env.VIDEOAUTO_DATA_ROOT || env.VIDEOAUTO_WORKSPACE_DIR || env.VIDEOAUTO_DATA_ROOT)
  return configured && path.isAbsolute(configured) ? configured : userDataRoot
}

function resolveInstalledRuntimeRoot(): string {
  const runtimeBaseDir = defaultRuntimeBaseDir()
  const currentPath = path.join(runtimeBaseDir, 'current.json')
  const current = safeJsonRead<RuntimeCurrentRecord | null>(currentPath, null)
  const configured = clean(current?.path)
  if (configured && findRuntimeRoot(configured)) return findRuntimeRoot(configured)

  const currentVersion = clean(current?.version)
  if (currentVersion) {
    const byVersion = findRuntimeRoot(path.join(runtimeBaseDir, currentVersion))
    if (byVersion) return byVersion
  }

  if (!fs.existsSync(runtimeBaseDir)) return ''
  const candidates = fs.readdirSync(runtimeBaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'downloads' && !entry.name.endsWith('.tmp'))
    .map((entry) => ({
      name: entry.name,
      root: findRuntimeRoot(path.join(runtimeBaseDir, entry.name)),
      mtime: fs.statSync(path.join(runtimeBaseDir, entry.name)).mtimeMs,
    }))
    .filter((entry) => entry.root)
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))

  return candidates[0]?.root || ''
}

async function resolveBaseRuntimeRoot(): Promise<string> {
  const explicit = clean(process.env.VIDEOAUTO_RUNTIME_BASE_ROOT)
  if (explicit) {
    const root = findRuntimeRoot(explicit)
    if (!root) {
      console.error(`VIDEOAUTO_RUNTIME_BASE_ROOT does not contain ${engineExeName}: ${explicit}`)
      process.exit(1)
    }
    return root
  }

  const installed = resolveInstalledRuntimeRoot()
  if (installed) return installed

  const repoRoot = findRuntimeRoot(repoRuntimeRoot)
  if (repoRoot) return repoRoot

  return await prepareRuntimeBase({
    cacheRoot: path.join(resolveDefaultDataRoot(), 'release-cache', 'runtime'),
    engineExeName,
    manifestUrl: runtimeManifestUrl,
  })
}

function relOf(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, '/')
}

function zipRelOf(file: string): string {
  const rel = relOf(stagedRuntimeRoot, file)
  return rel ? `VideoAutoCut/${rel}` : 'VideoAutoCut'
}

// `relPrefix`：`sourceRoot` 在运行包里的位置（如把仓库 `VideoAutoCut/tools` 拷进包内 `tools/` 时传 'tools'）。
// 2026-09-23 修：原来 `syncRepoScripts` 拷 tools/config/sentrysearch/prompts 时 rel 是相对子目录算的、
// 不带 `tools/` 前缀，`excludedRelPrefixes` 里的 `tools/material_gen/records`、两处
// `node_modules/.cache` 在这一步全部不生效（会先被拷进暂存目录）。zip 收文件时
// `collectRuntimeEntries` 按暂存根目录重新算 rel，这几条会在那一步被挡掉，所以此前的包内容
// 不受影响；这里改成两步用同一套口径，不再依赖第二道过滤兜底。
function shouldCopy(root: string, file: string, relPrefix = ''): boolean {
  const relative = relOf(root, file)
  if (!relative) return true
  const rel = relPrefix ? `${relPrefix}/${relative}` : relative

  const name = path.basename(file)
  if (excludedFileNames.has(name)) return false
  if (excludedDirNames.has(name)) return false
  if (rel.endsWith('.pyc') || rel.endsWith('.pyo')) return false
  return !excludedRelPrefixes.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))
}

function copyTree(sourceRoot: string, targetRoot: string, relPrefix = ''): void {
  function walk(source: string) {
    if (!shouldCopy(sourceRoot, source, relPrefix)) return

    const stat = fs.statSync(source)
    const target = path.join(targetRoot, relOf(sourceRoot, source))
    if (stat.isDirectory()) {
      fs.mkdirSync(target, { recursive: true })
      for (const entry of fs.readdirSync(source)) walk(path.join(source, entry))
      return
    }
    if (stat.isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
    }
  }

  walk(sourceRoot)
}

function copyIfExists(source: string, target: string): void {
  if (!fs.existsSync(source)) return
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

function removePath(target: string, recursive = true): void {
  fs.rmSync(target, {
    force: true,
    recursive,
    maxRetries: 8,
    retryDelay: 250,
  })
}

function tryRemovePath(target: string, recursive = true): void {
  try {
    removePath(target, recursive)
  } catch (error) {
    console.warn(`Warning: failed to remove temporary path ${target}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function syncRepoScripts(): void {
  stageBundledFonts(
    path.join(repoRuntimeRoot, 'fonts', 'noto-sans-cjk-sc'),
    path.join(stagedRuntimeRoot, 'fonts', 'noto-sans-cjk-sc'),
  )
  if (fs.existsSync(repoRuntimeConfigRoot)) {
    removePath(path.join(stagedRuntimeRoot, 'config'))
    copyTree(repoRuntimeConfigRoot, path.join(stagedRuntimeRoot, 'config'), 'config')
  }

  const repoToolsRoot = path.join(repoRuntimeRoot, 'tools')
  if (fs.existsSync(repoToolsRoot)) {
    removePath(path.join(stagedRuntimeRoot, 'tools', 'prompts'))
    copyTree(repoToolsRoot, path.join(stagedRuntimeRoot, 'tools'), 'tools')
  }

  const repoSentryRoot = path.join(repoRuntimeRoot, 'sentrysearch')
  if (fs.existsSync(repoSentryRoot)) {
    removePath(path.join(stagedRuntimeRoot, 'sentrysearch', 'sentrysearch'))
    copyTree(path.join(repoSentryRoot, 'sentrysearch'), path.join(stagedRuntimeRoot, 'sentrysearch', 'sentrysearch'), 'sentrysearch/sentrysearch')
    copyIfExists(path.join(repoSentryRoot, 'sentrysearch_entry.py'), path.join(stagedRuntimeRoot, 'sentrysearch', 'sentrysearch_entry.py'))
  }

  removePath(path.join(stagedRuntimeRoot, 'prompts'))
  if (fs.existsSync(rustPromptRoot)) copyTree(rustPromptRoot, path.join(stagedRuntimeRoot, 'prompts', 'rust'), 'prompts/rust')

  copyIfExists(rustReleaseEngine, path.join(stagedRuntimeRoot, engineExeName))
}

function assertStagedRuntime(): void {
  verifyTemplateRuntime(stagedRuntimeRoot)
  const enginePath = path.join(stagedRuntimeRoot, engineExeName)
  if (!fs.existsSync(enginePath)) {
    console.error(`Missing staged runtime engine: ${enginePath}`)
    console.error(`Build VideoAutoCutApp in release mode or provide a base runtime that contains ${engineExeName}.`)
    process.exit(1)
  }
  const result = spawnSync(enginePath, ['--help'], {
    cwd: stagedRuntimeRoot,
    encoding: 'utf8',
    shell: false,
  })
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`staged runtime engine exited with ${result.status ?? 'unknown'}`)
  }
  const help = `${result.stdout || ''}\n${result.stderr || ''}`
  const requiredArguments = ['--material-manifest', '--project-name']
  const missing = requiredArguments.filter((argument) => !help.includes(argument))
  if (missing.length) {
    throw new Error(`staged runtime is incompatible with this desktop: ${missing.join(', ')}`)
  }
}

function collectRuntimeEntries(root: string): { files: string[], emptyDirs: string[] } {
  const files: string[] = []
  const emptyDirs: string[] = []

  function walk(dir: string): boolean {
    if (!shouldCopy(root, dir)) return false

    let keptChildren = 0
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (!shouldCopy(root, file)) continue

      if (entry.isDirectory()) {
        if (walk(file)) keptChildren += 1
        continue
      }

      if (entry.isFile()) {
        files.push(file)
        keptChildren += 1
      }
    }

    const keepEmptyDir = keptChildren === 0 && dir !== root
    if (keepEmptyDir) emptyDirs.push(dir)
    return keptChildren > 0 || keepEmptyDir
  }

  walk(root)
  files.sort()
  emptyDirs.sort()
  return { files, emptyDirs }
}

async function writeRuntimeZip(files: string[], emptyDirs: string[]) {
  await new Promise<void>((resolve, reject) => {
    const zip = new ZipFile()
    const out = fs.createWriteStream(zipPath)
    let settled = false

    function finish(error?: unknown) {
      if (settled) return
      settled = true
      if (error) {
        reject(error)
        return
      }
      resolve()
    }

    out.on('close', () => finish())
    out.on('error', finish)
    zip.on('error', finish)
    zip.outputStream.pipe(out)

    zip.addEmptyDirectory('VideoAutoCut/')
    for (const dir of emptyDirs) {
      zip.addEmptyDirectory(`${zipRelOf(dir)}/`)
    }
    for (const file of files) {
      zip.addFile(file, zipRelOf(file))
    }
    zip.end()
  })
}

let completed = false

try {
  const baseRuntimeRoot = await resolveBaseRuntimeRoot()
  console.log(`base runtime: ${baseRuntimeRoot}`)
  console.log(`stage runtime: ${stagedRuntimeRoot}`)

  fs.mkdirSync(outDir, { recursive: true })
  removePath(zipPath, false)
  removePath(runtimeStageRoot)
  fs.mkdirSync(stagedRuntimeRoot, { recursive: true })

  copyTree(baseRuntimeRoot, stagedRuntimeRoot)
  syncRepoScripts()
  assertStagedRuntime()

  const { files, emptyDirs } = collectRuntimeEntries(stagedRuntimeRoot)
  console.log(`runtime files: ${files.length}, empty dirs: ${emptyDirs.length}`)

  await writeRuntimeZip(files, emptyDirs)

  const bytes = fs.readFileSync(zipPath)
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const manifest = {
    latest: version,
    versions: [{
      version,
      url: `${bucketBaseUrl.replace(/\/+$/, '')}/${zipName}`,
      sha256,
      size: bytes.length,
      notes: `VideoAutoCut runtime ${version}`,
    }],
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  completed = true
  console.log(`runtime zip: ${zipPath}`)
  console.log(`manifest: ${path.join(outDir, 'manifest.json')}`)
  console.log(`sha256: ${sha256}`)
} finally {
  tryRemovePath(runtimeStageRoot)
  if (!completed) tryRemovePath(zipPath, false)
}
