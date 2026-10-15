import fs from 'node:fs'
import path from 'node:path'
import { readIncrementalArtifacts } from './incremental-artifacts.js'

import { asRecord, stringValue, type FileEntry, type MutableEnv, type RunArtifact, type RunRecord } from './types.js'
import { ensureDir } from './utils.js'
import { createFileEntry } from './file-entry.js'
import { associateRunHistory } from './task-history.js'
import { readTaskOutputFormat } from './task-output-format.js'
import {
  AUDIO_EXTENSIONS,
  DATA_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MP4_EXTENSIONS,
  RUN_ARTIFACT_EXTENSIONS,
  SUBTITLE_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from './file-extensions.js'
import {
  GATEWAY_CREDENTIAL_ENV_KEYS,
  REMOTE_MANAGED_ENV_KEYS,
  REMOTE_SECRET_ENV_KEYS,
  coerceRemoteEnv,
  filterWritableEnvUpdates,
} from './managed-config.js'

interface WorkspaceServiceOptions {
  appName: string
  userDataRoot: string
  configRoot: string
  dataRoot: string
  legacyDataRoot: string
  envPath: string
  runsDir: string
  defaultOutputDir: string
  materialsDir: string
  voiceTemplatesDir: string
  runtimeManifestDefaultUrl: string
  getVideoAutoRoot: () => string
}

function resolveRuntimeManagedEnv(fileEnv: unknown, accountEnv: unknown): Record<string, string> {
  const accountManagedEnv = coerceRemoteEnv(accountEnv)
  const managedEnv = {
    ...coerceRemoteEnv(fileEnv),
    ...accountManagedEnv,
  }

  for (const key of GATEWAY_CREDENTIAL_ENV_KEYS) {
    delete managedEnv[key]
    if (accountManagedEnv[key]) managedEnv[key] = accountManagedEnv[key]
  }
  return managedEnv
}

type EnvUpdates = Record<string, string | number | boolean | null | undefined>
type ProgressTemplateRecord = {
  key: string
  label: string
  tone: string
  settings: Record<string, string>
  createdAt?: string
  updatedAt?: string
}

const REMOTE_SECRET_ENV_KEY_SET = new Set<string>(REMOTE_SECRET_ENV_KEYS)
const REMOTE_MANAGED_ENV_KEY_SET = new Set<string>(REMOTE_MANAGED_ENV_KEYS)
const PROGRESS_TEMPLATE_SETTING_KEYS = new Set([
  'PROGRESS_HIGHLIGHT_COLOR',
  'PROGRESS_DARK_COLOR',
  'PROGRESS_SEPARATOR_COLOR',
  'PROGRESS_TEXT_COLOR',
  'PROGRESS_ACTIVE_TEXT_COLOR',
  'PROGRESS_BAR_HEIGHT',
  'PROGRESS_BOTTOM_MARGIN',
  'PROGRESS_FONT_SIZE',
])

function cleanTemplateText(value: unknown, maxLength: number): string {
  return stringValue(value).replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function cleanProgressTemplate(value: unknown): ProgressTemplateRecord | null {
  const item = asRecord(value)
  const key = cleanTemplateText(item.key, 80).toLowerCase()
  if (!/^user-[a-z0-9][a-z0-9_-]{2,72}$/.test(key)) return null

  const label = cleanTemplateText(item.label, 32)
  if (!label) return null

  const rawSettings = asRecord(item.settings)
  const settings: Record<string, string> = {}
  for (const [settingKey, settingValue] of Object.entries(rawSettings)) {
    if (!PROGRESS_TEMPLATE_SETTING_KEYS.has(settingKey)) continue
    settings[settingKey] = stringValue(settingValue).trim().slice(0, 64)
  }

  if (!Object.keys(settings).length) return null

  return {
    key,
    label,
    tone: cleanTemplateText(item.tone, 40) || '自定义模板',
    settings,
    createdAt: cleanTemplateText(item.createdAt, 40) || undefined,
    updatedAt: cleanTemplateText(item.updatedAt, 40) || undefined,
  }
}

function cleanProgressTemplates(value: unknown): ProgressTemplateRecord[] {
  const raw = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const templates: ProgressTemplateRecord[] = []

  for (const item of raw) {
    const cleaned = cleanProgressTemplate(item)
    if (!cleaned || seen.has(cleaned.key)) continue
    seen.add(cleaned.key)
    templates.push(cleaned)
  }

  return templates
}

function parseEnvValue(rawValue: string): string {
  const value = rawValue.trim()
  if (value.length < 2) return value

  const quote = value[0]
  if (quote !== value[value.length - 1] || (quote !== '"' && quote !== "'")) return value

  if (quote === '"') {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === 'string') return parsed
    } catch {
      return value.slice(1, -1)
    }
  }

  return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
}

function formatEnvAssignment(key: string, rawValue: unknown): string {
  const value = String(rawValue ?? '')
  const serialized = !value || /^[A-Za-z0-9_./:@%+,&?=-]+$/.test(value)
    ? value
    : JSON.stringify(value)
  return `${key}=${serialized}`
}

function readEnvFile(file: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (!fs.existsSync(file)) return result

  const text = fs.readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#') || !line.includes('=')) continue
    const idx = line.indexOf('=')
    const key = line.slice(0, idx).trim()
    const value = parseEnvValue(line.slice(idx + 1))
    result[key] = value
  }

  return result
}

function resolveWorkspacePath(value: unknown, userDataRoot: string): string {
  const configured = String(value || '').trim().replace(/^["']|["']$/g, '')
  if (!configured) return path.join(userDataRoot, 'workspace')
  return path.isAbsolute(configured) ? configured : path.join(userDataRoot, configured)
}

function createWorkspaceService(options: WorkspaceServiceOptions) {
  const {
    appName,
    userDataRoot,
    configRoot,
    dataRoot,
    legacyDataRoot,
    envPath,
    runsDir,
    defaultOutputDir,
    materialsDir,
    voiceTemplatesDir,
    runtimeManifestDefaultUrl,
    getVideoAutoRoot,
  } = options
  let remoteEnv: Record<string, string> = {}
  const userProgressTemplatesPath = path.join(configRoot, 'progress-templates.user.json')

  function getOutputDir(): string {
    return defaultOutputDir
  }

  function copyPathIfMissing(src: string, dest: string): void {
    if (!fs.existsSync(src) || fs.existsSync(dest)) return

    ensureDir(path.dirname(dest))
    const stat = fs.statSync(src)
    if (stat.isDirectory()) fs.cpSync(src, dest, { recursive: true })
    else fs.copyFileSync(src, dest)
  }

  function copyFirstExistingPathIfMissing(sources: string[], dest: string): void {
    for (const src of sources) {
      copyPathIfMissing(src, dest)
      if (fs.existsSync(dest)) return
    }
  }

  function ensureEnvDefaults(defaults: Record<string, string>): void {
    if (!fs.existsSync(envPath)) return

    const current = readEnvFile(envPath)
    const missing = Object.entries(defaults).filter(([key]) => !Object.prototype.hasOwnProperty.call(current, key))
    if (!missing.length) return

    const text = fs.readFileSync(envPath, 'utf8').replace(/\s+$/, '')
    const appended = missing.map(([key, value]) => formatEnvAssignment(key, value))
    fs.writeFileSync(envPath, `${[text, ...appended].filter(Boolean).join('\n')}\n`, 'utf8')
  }

  function ensureDataLayout(): void {
    const videoAutoRoot = getVideoAutoRoot()
    ensureDir(dataRoot)
    ensureDir(configRoot)

    copyFirstExistingPathIfMissing([
      path.join(dataRoot, '.env'),
      path.join(legacyDataRoot, '.env'),
      path.join(videoAutoRoot, '.env'),
      path.join(videoAutoRoot, '.env.example'),
    ], envPath)

    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, [
        'DASHSCOPE_EMBEDDING_MODEL=qwen3-vl-embedding',
        'DASHSCOPE_TEXT_MODEL=qwen-plus',
        'DASHSCOPE_SCRIPT_MODEL=qwen-long',
        'DASHSCOPE_SCRIPT_TIMEOUT=600',
        'DASHSCOPE_BASE_URL=',
        'DASHSCOPE_OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        'SOURCE=pexels',
        'DOWNLOADS_PER_SHOT=2',
        'CLIPS_PER_SHOT=1',
        'RESULTS_PER_SHOT=10',
        'CHUNK_DURATION=30',
        'VOICEOVER=true',
        'SUBTITLES=true',
        'SUBTITLE_FONT="Microsoft YaHei"',
        'SUBTITLE_FONT_SIZE=68',
        'SUBTITLE_Y=850',
        'SUBTITLE_LINE_MAX_CHARS=22',
        'SUBTITLE_PRIMARY_COLOUR=#FFFFFF',
        'SUBTITLE_SECONDARY_COLOUR=#FFFFFF',
        'SUBTITLE_OUTLINE_COLOUR=#121212',
        'SUBTITLE_BACK_COLOUR=&H96000000&',
        'SUBTITLE_BOLD=1',
        'SUBTITLE_OUTLINE=4',
        'SUBTITLE_SHADOW=1',
        'PROGRESS_BAR=true',
        'PROGRESS_TEMPLATE=classic',
        'BGM_ENABLED=true',
        'BGM_SOURCE=auto',
        'BGM_VOLUME=0.16',
        'BGM_MIN_DURATION=15',
        'BGM_MAX_DURATION=300',
        'BGM_ACQUIRE_TIMEOUT_SECONDS=180',
        'BGM_SEARCH_TIMEOUT_SECONDS=75',
        'BGM_HTTP_TIMEOUT_SECONDS=20',
        'BGM_HTTP_ATTEMPTS=2',
        'BGM_DOWNLOAD_TIMEOUT_SECONDS=120',
        'BGM_DOWNLOAD_ITEM_TIMEOUT_SECONDS=45',
        'JAMENDO_CLIENT_ID=',
        'OPENVERSE_CLIENT_ID=',
        'OPENVERSE_CLIENT_SECRET=',
        'DASHSCOPE_TTS_MODEL=cosyvoice-v3-flash',
        'DASHSCOPE_TTS_VOICE=longanyang',
        'DASHSCOPE_TTS_FORMAT=mp3',
        'DASHSCOPE_TTS_SAMPLE_RATE=24000',
        'VIDEOAUTO_REMOTE_CONFIG_URL=',
        'VIDEOAUTO_REMOTE_CONFIG_SECRET=',
        'VIDEOAUTO_MATERIAL_AUTO_BACKUP_IMPORTS=false',
        `VIDEOAUTO_RUNTIME_MANIFEST_URL=${runtimeManifestDefaultUrl}`,
        '',
      ].join('\n'), 'utf8')
    }
    ensureEnvDefaults({
      VIDEOAUTO_REMOTE_CONFIG_URL: '',
      VIDEOAUTO_REMOTE_CONFIG_SECRET: '',
      VIDEOAUTO_MATERIAL_AUTO_BACKUP_IMPORTS: 'false',
      VIDEOAUTO_TEMPLATE_PACKAGING: 'false',
      VIDEOAUTO_PACKAGING_SCRIPT_ONLY: 'true',
      SUBTITLE_AI_SAFE_AREA: 'false',
      SUBTITLE_FONT: 'Microsoft YaHei',
      SUBTITLE_FONT_SIZE: '68',
      SUBTITLE_Y: '850',
      SUBTITLE_LINE_MAX_CHARS: '22',
      SUBTITLE_PRIMARY_COLOUR: '#FFFFFF',
      SUBTITLE_SECONDARY_COLOUR: '#FFFFFF',
      SUBTITLE_OUTLINE_COLOUR: '#121212',
      SUBTITLE_BACK_COLOUR: '&H96000000&',
      SUBTITLE_BOLD: '1',
      SUBTITLE_OUTLINE: '4',
      SUBTITLE_SHADOW: '1',
      BGM_ACQUIRE_TIMEOUT_SECONDS: '180',
      BGM_SEARCH_TIMEOUT_SECONDS: '75',
      BGM_HTTP_TIMEOUT_SECONDS: '20',
      BGM_HTTP_ATTEMPTS: '2',
      BGM_DOWNLOAD_TIMEOUT_SECONDS: '120',
      BGM_DOWNLOAD_ITEM_TIMEOUT_SECONDS: '45',
    })

    copyFirstExistingPathIfMissing([
      path.join(legacyDataRoot, 'downloaded.txt'),
      path.join(videoAutoRoot, 'downloaded.txt'),
    ], path.join(dataRoot, 'downloaded.txt'))
    copyFirstExistingPathIfMissing([
      path.join(legacyDataRoot, 'voice_templates'),
      path.join(videoAutoRoot, 'voice_templates'),
    ], voiceTemplatesDir)
    copyFirstExistingPathIfMissing([
      path.join(legacyDataRoot, 'video', 'materials'),
      path.join(videoAutoRoot, 'video', 'materials'),
    ], materialsDir)
    copyFirstExistingPathIfMissing([
      path.join(legacyDataRoot, 'video', 'runs'),
      path.join(videoAutoRoot, 'video', 'runs'),
    ], runsDir)
    copyFirstExistingPathIfMissing([
      path.join(legacyDataRoot, 'video', 'output'),
      path.join(videoAutoRoot, 'video', 'output'),
    ], getOutputDir())
    copyFirstExistingPathIfMissing([
      path.join(legacyDataRoot, 'tools', 'material_gen', 'records'),
      path.join(videoAutoRoot, 'tools', 'material_gen', 'records'),
    ], path.join(dataRoot, 'tools', 'material_gen', 'records'))

    ;[
      runsDir,
      getOutputDir(),
      materialsDir,
      voiceTemplatesDir,
      path.join(dataRoot, 'temp'),
      path.join(dataRoot, 'tools', 'material_gen', 'records'),
    ].forEach(ensureDir)
  }

  function readEnv(): Record<string, string> {
    return {
      ...readEnvFile(envPath),
      ...remoteEnv,
    }
  }

  function readRemoteEnv(): Record<string, string> {
    return { ...remoteEnv }
  }

  function writeEnv(updates: EnvUpdates): Record<string, string> {
    const writableUpdates = filterWritableEnvUpdates(updates) as EnvUpdates
    const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/) : []
    const used = new Set<string>()
    const next = lines.flatMap((line) => {
      const match = line.match(/^\s*([^#=]+)\s*=/)
      if (!match) return [line]

      const key = match[1].trim()
      if (REMOTE_SECRET_ENV_KEY_SET.has(key)) return [line]
      if (Object.prototype.hasOwnProperty.call(writableUpdates, key)) {
        used.add(key)
        return [formatEnvAssignment(key, writableUpdates[key])]
      }
      return [line]
    })

    for (const [key, value] of Object.entries(writableUpdates)) {
      if (!used.has(key)) next.push(formatEnvAssignment(key, value))
    }

    ensureDir(path.dirname(envPath))
    fs.writeFileSync(envPath, `${next.join('\n').replace(/\n+$/, '')}\n`, 'utf8')

    const savedEnv = readEnv()
    ensureDir(resolveWorkspacePath(savedEnv.VIDEOAUTO_WORKSPACE_DIR || savedEnv.VIDEOAUTO_DATA_ROOT, userDataRoot))
    ensureDir(getOutputDir())
    return savedEnv
  }

  function readProgressTemplates(): ProgressTemplateRecord[] {
    if (!fs.existsSync(userProgressTemplatesPath)) return []

    const text = fs.readFileSync(userProgressTemplatesPath, 'utf8')
    try {
      return cleanProgressTemplates(JSON.parse(text))
    } catch {
      return []
    }
  }

  function writeProgressTemplates(value: unknown): ProgressTemplateRecord[] {
    const templates = cleanProgressTemplates(value)
    ensureDir(path.dirname(userProgressTemplatesPath))
    fs.writeFileSync(userProgressTemplatesPath, `${JSON.stringify(templates, null, 2)}\n`, 'utf8')
    return templates
  }

  function writeRemoteEnv(updates: Record<string, unknown>): Record<string, string> {
    const next = coerceRemoteEnv(updates)
    if (!Object.keys(next).length) return readEnv()

    const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/) : []
    const used = new Set<string>()
    const saved = lines.map((line) => {
      const match = line.match(/^\s*([^#=]+)\s*=/)
      if (!match) return line

      const key = match[1].trim()
      if (!REMOTE_MANAGED_ENV_KEY_SET.has(key)) return line
      if (!Object.prototype.hasOwnProperty.call(next, key)) return line

      used.add(key)
      return formatEnvAssignment(key, next[key])
    })

    for (const key of REMOTE_MANAGED_ENV_KEYS) {
      if (Object.prototype.hasOwnProperty.call(next, key) && !used.has(key)) {
        saved.push(formatEnvAssignment(key, next[key]))
      }
    }

    ensureDir(path.dirname(envPath))
    fs.writeFileSync(envPath, `${saved.join('\n').replace(/\n+$/, '')}\n`, 'utf8')
    remoteEnv = { ...remoteEnv, ...next }
    return readEnv()
  }

  function createVideoAutoEnv(extra: MutableEnv = {}): NodeJS.ProcessEnv {
    const videoAutoRoot = getVideoAutoRoot()
    const fileEnv = readEnvFile(envPath)
    const baseEnv = { ...process.env, ...fileEnv, ...extra }
    const managedEnv = resolveRuntimeManagedEnv(fileEnv, remoteEnv)
    const env: MutableEnv = { ...baseEnv, ...managedEnv }
    for (const key of GATEWAY_CREDENTIAL_ENV_KEYS) {
      if (!managedEnv[key]) delete env[key]
    }
    const binDirs = [
      path.join(videoAutoRoot, 'ffmpeg', 'bin'),
      path.join(videoAutoRoot, 'node-runtime'),
    ].filter((dir) => fs.existsSync(dir))

    return {
      ...env,
      SUBTITLE_BOLD: '1',
      VIDEOAUTO_REQUIRE_REMOTE_CONFIG: 'true',
      VIDEOAUTO_REMOTE_CONFIG_KEYS: Object.keys(managedEnv).join(','),
      VIDEOAUTO_ROOT: videoAutoRoot,
      VIDEOAUTO_RUNTIME_ROOT: videoAutoRoot,
      VIDEOAUTO_DATA_ROOT: dataRoot,
      VIDEOAUTO_WORKSPACE_DIR: dataRoot,
      VIDEOAUTO_CONFIG_ROOT: configRoot,
      VIDEOAUTO_ENV_PATH: envPath,
      VIDEOAUTO_OUTPUT_DIR: env.VIDEOAUTO_OUTPUT_DIR || getOutputDir(),
      VIDEOAUTO_TEMP_DIR: env.VIDEOAUTO_TEMP_DIR || path.join(dataRoot, 'temp'),
      VIDEOAUTO_NO_PAUSE: 'true',
      PATH: [...binDirs, env.PATH || ''].filter(Boolean).join(path.delimiter),
    }
  }

  function listFilesSafe(dir: string, exts: string[] | null = null, limit = 200, maxDepth = 2, excludedRoots: string[] = []): FileEntry[] {
    if (!fs.existsSync(dir)) return []

    const files: FileEntry[] = []
    const walk = (base: string, depth = 0): void => {
      if (depth > maxDepth || files.length >= limit) return

      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        const filePath = path.join(base, entry.name)
        if (entry.isDirectory()) {
          if (depth === 0 && excludedRoots.includes(entry.name)) continue
          walk(filePath, depth + 1)
          continue
        }

        const ext = path.extname(entry.name).toLowerCase()
        if (exts && !exts.includes(ext)) continue

        files.push(createFileEntry(filePath))
        if (files.length >= limit) break
      }
    }

    walk(dir)
    return files.sort((a, b) => b.mtime - a.mtime)
  }

  function resolveExistingOrParent(target: unknown): string {
    let current = path.resolve(String(target || ''))
    while (current && !fs.existsSync(current)) {
      const next = path.dirname(current)
      if (next === current) break
      current = next
    }
    return fs.existsSync(current) ? fs.realpathSync.native(current) : path.resolve(String(target || ''))
  }

  function isInsideDir(target: unknown, base: string): boolean {
    const resolvedTarget = path.resolve(String(target || ''))
    const resolvedBase = fs.existsSync(base) ? fs.realpathSync.native(base) : path.resolve(base)
    const relative = path.relative(resolvedBase, resolvedTarget)
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  }

  function assertInsideWorkspace(target: unknown, label = '路径'): string {
    const resolved = path.resolve(String(target || ''))
    const existing = resolveExistingOrParent(resolved)
    if (!isInsideDir(existing, dataRoot)) throw new Error(`${label}不在工作区内，已拒绝删除`)
    return resolved
  }

  function safeRemoveFile(file: unknown): boolean {
    const target = assertInsideWorkspace(file, '文件')
    const ext = path.extname(target).toLowerCase()
    if (!VIDEO_EXTENSIONS.includes(ext)) throw new Error('只允许删除视频素材文件')
    if (!fs.existsSync(target)) return false

    const stat = fs.statSync(target)
    if (!stat.isFile()) throw new Error('目标不是文件')
    fs.unlinkSync(target)
    return true
  }

  function safeRemoveDirectory(dir: unknown): boolean {
    const target = assertInsideWorkspace(dir, '目录')
    if (!fs.existsSync(target)) return false

    const stat = fs.statSync(target)
    if (!stat.isDirectory()) throw new Error('目标不是目录')
    fs.rmSync(target, { recursive: true, force: true })
    return true
  }

  function samePath(a: unknown, b: unknown): boolean {
    return path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase()
  }

  function classifyArtifact(file: FileEntry): string {
    const ext = path.extname(file.name).toLowerCase()
    const normalizedPath = file.path.toLowerCase()
    if (VIDEO_EXTENSIONS.includes(ext)) return '视频'
    if (AUDIO_EXTENSIONS.includes(ext)) return '音频'
    if (SUBTITLE_EXTENSIONS.includes(ext)) return '字幕'
    if (DATA_EXTENSIONS.includes(ext)) return '数据'
    if (normalizedPath.includes('image') || IMAGE_EXTENSIONS.includes(ext)) return '图片'
    return '其他'
  }

  function cleanProjectName(value: unknown, fallback: string): string {
    const raw = stringValue(value).trim().replace(/^["']|["']$/g, '')
    const name = raw ? path.basename(raw, path.extname(raw)) : ''
    return name.replace(/\s+/g, ' ').trim() || fallback
  }

  function readRunProjectName(logPath: string, fallback: string): string {
    if (!fs.existsSync(logPath)) return fallback
    let descriptor: number | undefined
    let text: string
    try {
      const stat = fs.lstatSync(logPath)
      if (!stat.isFile() || stat.isSymbolicLink()) return fallback
      descriptor = fs.openSync(logPath, 'r')
      const buffer = Buffer.alloc(Math.min(stat.size, 120000))
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0)
      text = buffer.subarray(0, bytes).toString('utf8')
    } catch {
      return fallback
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
    const patterns = [
      /脚本文档:\s*(.+)$/m,
      />>> 任务\s+(.+?)\s+"/m,
      /--script-file"\s+"([^"]+)"/m,
      /--script-file\s+("?)([^"\r\n]+)\1/m,
    ]

    for (const pattern of patterns) {
      const match = text.match(pattern)
      const value = match?.[2] || match?.[1]
      const projectName = cleanProjectName(value, '')
      if (projectName) return projectName
    }

    return fallback
  }

  function readRunScriptPath(logPath: string): string {
    if (!fs.existsSync(logPath)) return ''
    let descriptor: number | undefined
    try {
      const stat = fs.lstatSync(logPath)
      if (!stat.isFile() || stat.isSymbolicLink()) return ''
      descriptor = fs.openSync(logPath, 'r')
      const buffer = Buffer.alloc(Math.min(stat.size, 120000))
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0)
      const text = buffer.subarray(0, bytes).toString('utf8')
      const value = text.match(/^脚本文档:[\t ]*(.+)$/m)?.[1]?.trim() || ''
      if (!value || !path.isAbsolute(value)) return ''
      return value
    } catch {
      return ''
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
  }

  function listRunArtifacts(dir: string): RunArtifact[] {
    const current = readIncrementalArtifacts(dir)
    const files = listFilesSafe(dir, RUN_ARTIFACT_EXTENSIONS, 1200, 5, current ? ['raw', 'clips', 'incremental-work'] : []).map((file) => ({
      ...file,
      kind: classifyArtifact(file),
      relativePath: path.relative(dir, file.path),
    }))
    return files.concat((current || []).map(reference => {
      const file = createFileEntry(reference.path)
      return { ...file, kind: classifyArtifact(file), relativePath: path.relative(dir, file.path), shotId: reference.shotId }
    }))
  }

  function listTaskCandidateArtifacts(dir: string): RunArtifact[] {
    if (!dir || !fs.existsSync(dir)) return []
    const isStoryboardDirectory = path.basename(dir) === '分镜视频'
    const relativeRoot = isStoryboardDirectory ? '分镜视频' : 'raw'
    return listFilesSafe(dir, VIDEO_EXTENSIONS, 1200, isStoryboardDirectory ? 1 : 0).map((file) => ({
      ...file,
      kind: classifyArtifact(file),
      relativePath: path.join(relativeRoot, path.relative(dir, file.path)),
    }))
  }

  function readRecordedFinalVideo(runDir: string): FileEntry | null {
    const manifestPath = path.join(runDir, 'final_video.json')
    if (!fs.existsSync(manifestPath)) return null
    try {
      const record = asRecord(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
      const recordedPath = stringValue(record.path).trim()
      if (!recordedPath) return null
      const finalPath = fs.realpathSync.native(path.resolve(recordedPath))
      if (
        !isInsideDir(finalPath, runsDir)
        || !fs.existsSync(finalPath)
        || !fs.statSync(finalPath).isFile()
        || !MP4_EXTENSIONS.includes(path.extname(finalPath).toLowerCase())
      ) return null
      return createFileEntry(finalPath)
    } catch {
      return null
    }
  }

  function listRuns(): RunRecord[] {
    if (!fs.existsSync(runsDir)) return []

    const runDirectories: Array<{ id: string; dir: string; fallbackName: string; candidateDir?: string }> = []
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const directDirectory = path.join(runsDir, entry.name)
      if (entry.name.toLocaleLowerCase() === '.videoautocut') {
        for (const dateEntry of fs.readdirSync(directDirectory, { withFileTypes: true })) {
          if (!dateEntry.isDirectory() || dateEntry.isSymbolicLink() || !/^\d{8}$/.test(dateEntry.name)) continue
          const dateWorkRoot = path.join(directDirectory, dateEntry.name)
          for (const taskEntry of fs.readdirSync(dateWorkRoot, { withFileTypes: true })) {
            if (!taskEntry.isDirectory() || taskEntry.isSymbolicLink()) continue
            const taskWorkRoot = path.join(dateWorkRoot, taskEntry.name)
            for (const runEntry of fs.readdirSync(taskWorkRoot, { withFileTypes: true })) {
              if (!runEntry.isDirectory() || runEntry.isSymbolicLink()) continue
              runDirectories.push({
                id: runEntry.name,
                dir: path.join(taskWorkRoot, runEntry.name),
                fallbackName: taskEntry.name,
                candidateDir: path.join(runsDir, dateEntry.name, taskEntry.name),
              })
            }
          }
        }
        continue
      }
      if (fs.existsSync(path.join(directDirectory, 'run.log'))) {
        runDirectories.push({ id: entry.name, dir: directDirectory, fallbackName: entry.name })
        continue
      }
      if (!/^\d{8}$/.test(entry.name)) continue
      for (const taskEntry of fs.readdirSync(directDirectory, { withFileTypes: true })) {
        if (!taskEntry.isDirectory() || taskEntry.isSymbolicLink()) continue
        const projectDirectory = path.join(directDirectory, taskEntry.name)
        const hiddenRoot = path.join(projectDirectory, '.videoautocut')
        const workRoot = fs.existsSync(path.join(hiddenRoot, 'runs'))
          ? path.join(hiddenRoot, 'runs')
          : hiddenRoot
        if (!fs.existsSync(workRoot)) continue
        for (const runEntry of fs.readdirSync(workRoot, { withFileTypes: true })) {
          if (!runEntry.isDirectory() || runEntry.isSymbolicLink()) continue
          runDirectories.push({
            id: runEntry.name,
            dir: path.join(workRoot, runEntry.name),
            fallbackName: taskEntry.name,
            candidateDir: fs.existsSync(path.join(projectDirectory, '分镜视频'))
              ? path.join(projectDirectory, '分镜视频')
              : projectDirectory,
          })
        }
      }
    }

    return associateRunHistory(runDirectories
      .map(({ id, dir, fallbackName, candidateDir = '' }) => {
        const log = path.join(dir, 'run.log')
        const shots = path.join(dir, 'shots.json')
        const stat = fs.statSync(dir)
        let outputFormat
        try { outputFormat = readTaskOutputFormat(dir) } catch { /* Keep damaged old records available for inspection. */ }
        const outputDir = getOutputDir()
        const legacyFinalCandidates = fs.existsSync(outputDir)
          ? listFilesSafe(outputDir, MP4_EXTENSIONS, 500).filter((file) => file.name.includes(id))
          : []
        const recordedFinalVideo = readRecordedFinalVideo(dir)
        const finalCandidates = recordedFinalVideo
          ? [recordedFinalVideo]
          : legacyFinalCandidates
        const runArtifacts = listRunArtifacts(dir)
        const candidateArtifacts = fs.existsSync(path.join(dir, 'incremental.json')) ? [] : listTaskCandidateArtifacts(candidateDir)
        const outputArtifacts: RunArtifact[] = finalCandidates.map((file) => ({
          ...file,
          kind: classifyArtifact(file),
          relativePath: path.join('output', file.name),
        }))
        const seenArtifactPaths = new Set<string>()
        const artifacts = [...outputArtifacts, ...runArtifacts, ...candidateArtifacts]
          .filter((file) => {
            const key = file.path.toLowerCase()
            if (seenArtifactPaths.has(key)) return false
            seenArtifactPaths.add(key)
            return true
          })
          .sort((a, b) => b.mtime - a.mtime)

        return {
          id,
          ...(outputFormat ? { outputFormat } : {}),
          projectName: readRunProjectName(log, fallbackName),
          path: dir,
          mtime: stat.mtimeMs,
          logPath: fs.existsSync(log) ? log : '',
          shotsPath: fs.existsSync(shots) ? shots : '',
          incrementalPath: fs.existsSync(path.join(dir, 'incremental.json')) ? path.join(dir, 'incremental.json') : undefined,
          shotsModifiedAt: fs.existsSync(shots) ? fs.statSync(shots).mtimeMs : undefined,
          finalVideo: finalCandidates[0]?.path || '',
          artifacts,
        }
      })
      .sort((a, b) => b.mtime - a.mtime))
  }

  function listRunScriptPaths(): string[] {
    return Array.from(new Set(listRuns()
      .map((run) => readRunScriptPath(run.logPath))
      .filter(Boolean)))
  }

  function readTextFile(file: unknown, max = 200000): string {
    const target = String(file || '')
    if (!target) return ''

    const safeTarget = assertInsideWorkspace(target, '文件')
    if (!fs.existsSync(safeTarget)) return ''

    const buffer = fs.readFileSync(safeTarget)
    if (buffer.length <= max) return buffer.toString('utf8')
    return buffer.slice(buffer.length - max).toString('utf8')
  }

  function writeTextFile(file: unknown, text: unknown): boolean {
    const target = String(file || '')
    if (!target) return false

    const safeTarget = assertInsideWorkspace(target, '文件')
    ensureDir(path.dirname(safeTarget))
    fs.writeFileSync(safeTarget, String(text || ''), 'utf8')
    return true
  }

  function setRemoteEnv(updates: Record<string, unknown>): Record<string, string> {
    const next = coerceRemoteEnv(updates)
    remoteEnv = { ...remoteEnv, ...next }
    return readEnv()
  }

  function clearRemoteEnv(): Record<string, string> {
    remoteEnv = {}
    return readEnv()
  }

  return {
    appName,
    assertInsideWorkspace,
    clearRemoteEnv,
    createVideoAutoEnv,
    ensureDataLayout,
    getOutputDir,
    isInsideDir,
    listFilesSafe,
    listRuns,
    listRunScriptPaths,
    readEnv,
    readRemoteEnv,
    readProgressTemplates,
    readTextFile,
    resolveExistingOrParent,
    safeRemoveDirectory,
    safeRemoveFile,
    samePath,
    setRemoteEnv,
    writeRemoteEnv,
    writeEnv,
    writeProgressTemplates,
    writeTextFile,
  }
}

export {
  createWorkspaceService,
  formatEnvAssignment,
  readEnvFile,
  resolveRuntimeManagedEnv,
  resolveWorkspacePath,
}
