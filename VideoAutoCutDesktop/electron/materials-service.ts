import fs from 'node:fs'
import path from 'node:path'

import { localPathWithoutNamespace } from './task-events.js'
import { readIncrementalArtifacts } from './incremental-artifacts.js'
import { randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { BrowserWindow, OpenDialogOptions } from 'electron'

import { recordAnalysisFailure } from './material-analysis-diagnostics.js'
import { sentryFilePath, sentryProcessEnv } from './sentry-path.js'
import { IPC_EVENTS } from './ipc-channels.js'
import { errorMessage, numberValue, type FileEntry, type IpcSender, type MutableEnv, type RunRecord } from './types.js'
import { ensureDir } from './utils.js'
import { commandText, runCapture as captureProcess, spawnStreamingProcess, terminateProcessTree } from './process-runner.js'
import { createGeneratedMaterialStore } from './generated-material-store.js'
import { createMaterialDirectoryBrowser } from './material-directory.js'
import type { MaterialIdentityStore } from './material-local-store.js'
import { createMaterialFileOperations } from './material-file-operations.js'
import { copyFilesIntoDirectory, createFileEntry } from './file-entry.js'
import { VIDEO_EXTENSIONS, extensionsForDialog } from './file-extensions.js'
import {
  DEFAULT_AUTO_REUSE_RESULTS,
  DEFAULT_AUTO_REUSE_THRESHOLD,
  mergeSearchResults,
  normalizedThreshold,
  resolveAutomaticShotMaterials,
  selectReusableMaterial,
} from './material-auto-reuse.js'
import {
  type CreateMaterialFolderOptions,
  type DeleteGeneratedOptions,
  type DeleteLocalMaterialCopyOptions,
  type DeleteMaterialsBatchResult,
  type DeleteMaterialsOptions,
  type DeleteResult,
  type GenerateMaterialOptions,
  type ImportMaterialsOptions,
  type MaterialFolderOperationResult,
  type MaterialFolderOptions,
  type MaterialDeletionImpact,
  type MoveMaterialFolderOptions,
  type MoveMaterialsOptions,
  type MoveMaterialsResult,
  type PreparedMaterialFolderOperation,
  type PreviewMaterialDeletionOptions,
  type RenameMaterialFolderOptions,
  type RenameMaterialOptions,
  type RenameResult,
  type RunMaterialGroup,
  type SearchOptions,
  type SearchResult,
  type SentrySearchPaths,
  type VectorIndexResult,
} from './materials-types.js'

interface MaterialsServiceOptions {
  dataRoot: string
  materialsDir: string
  runsDir: string
  generatedRecordsPath: string
  getVideoAutoRoot: () => string
  getPythonPath: () => string
  getSentrySearchPaths: () => SentrySearchPaths
  listRuns: () => RunRecord[]
  createVideoAutoEnv: (extra?: MutableEnv) => NodeJS.ProcessEnv
  assertInsideWorkspace: (target: unknown, label?: string) => string
  resolveExistingOrParent: (target: unknown) => string
  isInsideDir: (target: unknown, base: string) => boolean
  safeRemoveFile: (file: unknown) => boolean
  safeRemoveDirectory: (dir: unknown) => boolean
  samePath: (a: unknown, b: unknown) => boolean
  isRuntimeUsable: (root: string) => boolean
  showOpenDialog: (parentWindow: BrowserWindow | null, options: OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
  send: IpcSender
  identityStore?: MaterialIdentityStore
  cloudSemanticSearch?: (query: string, options: SearchOptions) => Promise<unknown>
  ensureCloudMaterialAvailable?: (materialId: string) => Promise<unknown>
  onMaterialsImported?: (files: FileEntry[]) => unknown
  onDownloadedMaterials?: (files: FileEntry[]) => unknown
  hasExistingAnalysis?: (filePath: string, signal?: AbortSignal) => Promise<boolean>
  analysisAbortSignal?: AbortSignal
  onMaterialAnalysisReady?: (file: FileEntry) => unknown
  onMaterialFolderCreated?: (folderId: string) => unknown
  onMaterialFolderDeleted?: () => unknown
}

const INDEX_DIRECTORY_NAME = '_indexed_h264'
const GENERATED_DIRECTORY_NAME = 'generated'
const CLOUD_CACHE_DIRECTORY_NAME = 'cloud'
const TASK_WORK_DIRECTORY_NAME = '.videoautocut'
const STORYBOARD_MATERIAL_DIRECTORY_NAME = '分镜视频'
const DELETION_STAGING_DIRECTORY_NAME = '.deleting'
const MAX_SCANNED_MATERIAL_DIRECTORIES = 10_000
const MAX_IMPORTED_MATERIAL_FILES = 50_000
const SKIPPED_IMPORT_DIRECTORY_NAMES = new Set([
  '$recycle.bin',
  'system volume information',
  INDEX_DIRECTORY_NAME,
  '.staging',
])

type MaterialImportSelection = 'files' | 'folder'

interface FolderImportFile {
  path: string
  name: string
  size: number
  relativeDirectory: string
}

interface FolderImportScan {
  rootName: string
  directories: string[]
  files: FolderImportFile[]
}

interface PreparedMaterialImportFile {
  path: string
  name: string
  size: number
  destinationDirectory: string
  folderId: string
}

function normalizePathForMatch(value: unknown): string {
  return path.resolve(localPathWithoutNamespace(value)).toLocaleLowerCase()
}

function isIndexedMaterialCopy(file: Pick<FileEntry, 'path'>): boolean {
  return String(file.path || '')
    .split(/[\\/]+/)
    .some((part) => part.toLocaleLowerCase() === INDEX_DIRECTORY_NAME)
}

function listOriginalMaterialFiles(files: readonly FileEntry[]): FileEntry[] {
  return files.filter((file) => !isIndexedMaterialCopy(file))
}

function isInsideDirectory(target: string, boundary: string): boolean {
  const relative = path.relative(boundary, target)
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function materialImportSelection(value: unknown): MaterialImportSelection {
  return value === 'folder' ? 'folder' : 'files'
}

function skipImportedDirectory(name: string): boolean {
  const normalized = name.toLocaleLowerCase()
  return name.startsWith('.') || SKIPPED_IMPORT_DIRECTORY_NAMES.has(normalized)
}

async function scanFolderForMaterialImport(
  selectedDirectory: string,
  materialsDir: string,
): Promise<FolderImportScan> {
  const selected = path.resolve(selectedDirectory)
  const selectedStat = await fs.promises.lstat(selected)
  if (!selectedStat.isDirectory() || selectedStat.isSymbolicLink()) {
    throw new Error('所选路径不是可导入的文件夹')
  }

  const root = await fs.promises.realpath(selected)
  const managedMaterials = fs.existsSync(materialsDir)
    ? await fs.promises.realpath(materialsDir)
    : path.resolve(materialsDir)
  if (
    isInsideDirectory(root, managedMaterials)
    || isInsideDirectory(managedMaterials, root)
  ) {
    throw new Error('所选文件夹与素材库工作目录重叠，无需重复导入')
  }

  const pending: Array<{ directory: string; relativeDirectory: string }> = [{
    directory: root,
    relativeDirectory: '',
  }]
  const visited = new Set<string>()
  const directories: string[] = []
  const files: FolderImportFile[] = []

  while (pending.length > 0) {
    if (visited.size >= MAX_SCANNED_MATERIAL_DIRECTORIES) {
      throw new Error(`所选文件夹超过 ${MAX_SCANNED_MATERIAL_DIRECTORIES} 个子目录，已停止导入`)
    }
    const current = pending.pop()
    if (!current) break
    const currentKey = normalizePathForMatch(current.directory)
    if (visited.has(currentKey)) continue
    visited.add(currentKey)

    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current.directory, { withFileTypes: true })
    } catch (error) {
      throw new Error(
        `无法读取文件夹“${path.basename(current.directory)}”：${errorMessage(error)}`,
        { cause: error },
      )
    }
    entries.sort((first, second) => first.name.localeCompare(second.name, 'zh-CN', {
      numeric: true,
      sensitivity: 'base',
    }))

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const candidate = path.join(current.directory, entry.name)
      let candidateStat: fs.Stats
      let realCandidate: string
      try {
        candidateStat = await fs.promises.lstat(candidate)
        if (candidateStat.isSymbolicLink()) continue
        realCandidate = await fs.promises.realpath(candidate)
      } catch {
        continue
      }
      if (!isInsideDirectory(realCandidate, root)) continue

      if (candidateStat.isDirectory()) {
        if (skipImportedDirectory(entry.name)) continue
        const relativeDirectory = current.relativeDirectory
          ? path.join(current.relativeDirectory, entry.name)
          : entry.name
        directories.push(relativeDirectory)
        pending.push({ directory: realCandidate, relativeDirectory })
        continue
      }

      if (
        !candidateStat.isFile()
        || entry.name.startsWith('.')
        || !VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLocaleLowerCase())
      ) {
        continue
      }
      if (files.length >= MAX_IMPORTED_MATERIAL_FILES) {
        throw new Error(`所选文件夹超过 ${MAX_IMPORTED_MATERIAL_FILES} 个视频，已停止导入`)
      }
      files.push({
        path: realCandidate,
        name: entry.name,
        size: candidateStat.size,
        relativeDirectory: current.relativeDirectory,
      })
    }
  }

  files.sort((first, second) => first.path.localeCompare(second.path, 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  }))
  return {
    rootName: path.basename(root),
    directories,
    files,
  }
}

function listVisibleMaterialFiles(
  directory: string,
  limit: number,
  excludeGeneratedRoot = false,
): FileEntry[] {
  if (!fs.existsSync(directory) || limit <= 0) return []

  let boundary: string
  try {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return []
    boundary = fs.realpathSync(directory)
  } catch {
    return []
  }

  const files: FileEntry[] = []
  const pending: Array<{ directory: string; depth: number }> = [{
    directory: boundary,
    depth: 0,
  }]
  let scannedDirectories = 0

  while (
    pending.length > 0
    && files.length < limit
    && scannedDirectories < MAX_SCANNED_MATERIAL_DIRECTORIES
  ) {
    const current = pending.pop()
    if (!current) break
    scannedDirectories += 1

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const normalizedName = entry.name.toLocaleLowerCase()
      const candidate = path.join(current.directory, entry.name)

      if (entry.isDirectory()) {
        if (
          normalizedName === INDEX_DIRECTORY_NAME
          || normalizedName === TASK_WORK_DIRECTORY_NAME
          || (excludeGeneratedRoot
            && current.depth === 0
            && [GENERATED_DIRECTORY_NAME, CLOUD_CACHE_DIRECTORY_NAME].includes(normalizedName))
        ) {
          continue
        }

        try {
          const stat = fs.lstatSync(candidate)
          if (!stat.isDirectory() || stat.isSymbolicLink()) continue
          const realCandidate = fs.realpathSync(candidate)
          if (isInsideDirectory(realCandidate, boundary)) {
            pending.push({ directory: realCandidate, depth: current.depth + 1 })
          }
        } catch {
          // Ignore entries that disappear or become unsafe while scanning.
        }
        continue
      }

      if (
        !entry.isFile()
        || !VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLocaleLowerCase())
      ) {
        continue
      }

      try {
        const stat = fs.lstatSync(candidate)
        if (!stat.isFile() || stat.isSymbolicLink()) continue
        const realCandidate = fs.realpathSync(candidate)
        if (!isInsideDirectory(realCandidate, boundary)) continue
        files.push(createFileEntry(realCandidate))
      } catch {
        // Ignore entries that disappear or become unsafe while scanning.
      }

      if (files.length >= limit) break
    }
  }

  return files.sort((first, second) => second.mtime - first.mtime
    || first.path.localeCompare(second.path, 'zh-CN', {
      numeric: true,
      sensitivity: 'base',
    }))
}

function indexedMaterialSource(pathValue: unknown) {
  const sourcePath = String(pathValue || '').trim()
  const indexedDirectory = path.dirname(sourcePath)
  if (path.basename(indexedDirectory).toLocaleLowerCase() !== INDEX_DIRECTORY_NAME) return null

  const match = path.basename(sourcePath).match(/^(\d{3})[_-](.+)$/)
  return {
    shotDirectory: path.dirname(indexedDirectory),
    sequence: match ? Number(match[1]) : 0,
    sourceName: match?.[2] || path.basename(sourcePath),
  }
}

function findOriginalMaterialFile(
  result: Pick<SearchResult, 'name' | 'path'>,
  candidates: readonly FileEntry[],
): FileEntry | undefined {
  const exactFile = result.path
    ? candidates.find(file => normalizePathForMatch(file.path) === normalizePathForMatch(result.path))
    : undefined
  if (exactFile) return exactFile
  const indexedSource = indexedMaterialSource(result.path)
  if (indexedSource) {
    const shotFiles = candidates
      .filter((file) => normalizePathForMatch(path.dirname(file.path))
        === normalizePathForMatch(indexedSource.shotDirectory))
      .sort((first, second) => first.path.localeCompare(second.path))

    const sourceStem = path.parse(indexedSource.sourceName).name.toLocaleLowerCase()
    const namedFile = shotFiles.find((file) => path.parse(file.name).name.toLocaleLowerCase() === sourceStem)
    if (namedFile) return namedFile

    const sequencedFile = shotFiles[indexedSource.sequence - 1]
    if (sequencedFile) return sequencedFile
  }

  const name = String(result.name || path.basename(result.path || '')).toLocaleLowerCase()
  const sourcePath = String(result.path || '').toLocaleLowerCase()
  return candidates.find((file) => {
    const fileName = file.name.toLocaleLowerCase()
    const filePath = file.path.toLocaleLowerCase()
    const fileStem = path.parse(file.name).name.toLocaleLowerCase()
    return fileName === name
      || filePath === sourcePath
      || sourcePath.includes(fileName)
      || sourcePath.includes(fileStem)
      || filePath.includes(name)
  })
}

function createMaterialsService(options: MaterialsServiceOptions) {
  const {
    getVideoAutoRoot,
    getPythonPath,
    getSentrySearchPaths,
    dataRoot,
    materialsDir,
    runsDir,
    generatedRecordsPath,
    listRuns,
    createVideoAutoEnv,
    assertInsideWorkspace,
    resolveExistingOrParent,
    isInsideDir,
    safeRemoveFile,
    safeRemoveDirectory,
    samePath,
    isRuntimeUsable,
    showOpenDialog,
    send,
    identityStore,
    cloudSemanticSearch,
    ensureCloudMaterialAvailable,
    onMaterialsImported,
    onDownloadedMaterials,
    hasExistingAnalysis,
    onMaterialFolderCreated,
    onMaterialFolderDeleted,
  } = options

  const generatedStore = createGeneratedMaterialStore({
    dataRoot,
    generatedRecordsPath,
    isInsideDir,
    safeRemoveDirectory,
    samePath,
  })
  const generatedMaterialsDir = path.join(materialsDir, GENERATED_DIRECTORY_NAME)
  const downloadedMaterialDirectory = (runPath: string) => {
    if (fs.existsSync(path.join(runPath, 'incremental.json'))) return path.join(runPath, 'raw')
    const segments = path.relative(runsDir, runPath).split(path.sep)
    if (
      segments[0]?.toLocaleLowerCase() === TASK_WORK_DIRECTORY_NAME
      && /^\d{8}$/.test(segments[1] || '')
      && segments[2]
    ) {
      return path.join(runsDir, segments[1], segments[2])
    }
    const workIndex = segments.findIndex((segment) => (
      segment.toLocaleLowerCase() === TASK_WORK_DIRECTORY_NAME
    ))
    if (workIndex >= 2) {
      const projectDirectory = path.join(runsDir, ...segments.slice(0, workIndex))
      const storyboardDirectory = path.join(projectDirectory, STORYBOARD_MATERIAL_DIRECTORY_NAME)
      return fs.existsSync(storyboardDirectory) ? storyboardDirectory : projectDirectory
    }
    return path.join(runPath, 'raw')
  }
  const isDownloadedRawPath = (target: string) => {
    if (!isInsideDir(target, runsDir)) return false
    const segments = path.relative(runsDir, target).split(path.sep)
    const isLegacyRaw = segments.length >= 3 && segments[1]?.toLocaleLowerCase() === 'raw'
    const workIndex = segments.findIndex(segment => segment.toLocaleLowerCase() === TASK_WORK_DIRECTORY_NAME)
    const incrementalRun = workIndex >= 2 && segments[workIndex + 1] === 'runs'
      && segments[workIndex + 3] === 'raw'
      && fs.existsSync(path.join(runsDir, ...segments.slice(0, workIndex + 3), 'incremental.json'))
    const isDatedTaskMaterial = /^\d{8}$/.test(segments[0] || '') && (
      segments.length === 3
      || (segments.length === 4 && segments[2]?.toLocaleLowerCase() === INDEX_DIRECTORY_NAME)
      || (
        segments.length >= 5
        && segments[2] === STORYBOARD_MATERIAL_DIRECTORY_NAME
        && !segments.some((segment) => segment.toLocaleLowerCase() === TASK_WORK_DIRECTORY_NAME)
        && !segments.some((segment) => segment.toLocaleLowerCase() === INDEX_DIRECTORY_NAME)
      )
      || (segments.length === 4 && segments[2]?.endsWith('最终视频'))
    )
    return isLegacyRaw || isDatedTaskMaterial || incrementalRun
  }
  const downloadedFilesFor = (runPath: string, limit: number) => {
    const current = readIncrementalArtifacts(runPath)
    return current ? current.filter(reference => reference.stage === 'raw').slice(0, limit).map(reference => createFileEntry(reference.path))
      : listVisibleMaterialFiles(downloadedMaterialDirectory(runPath), limit)
  }
  const assertMaterialPath = (target: unknown, label = '素材文件') => {
    const resolved = assertInsideWorkspace(target, label)
    const isUserMaterial = isInsideDir(resolved, materialsDir)
      && !isInsideDir(resolved, generatedMaterialsDir)
    if (!isUserMaterial && !isDownloadedRawPath(resolved)) {
      throw new Error('目标不在素材目录内')
    }
    return resolved
  }
  const materialFileOperations = createMaterialFileOperations({
    assertInsideWorkspace: assertMaterialPath,
    samePath,
  })
  const directoryBrowser = createMaterialDirectoryBrowser({
    materialsDir,
    runsDir,
    identityStore,
  })

  const abandonedDeletionDirectories = [materialsDir, runsDir].flatMap((boundary) => {
    const stagingRoot = path.join(boundary, DELETION_STAGING_DIRECTORY_NAME)
    try {
      return fs.readdirSync(stagingRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => path.join(stagingRoot, entry.name))
    } catch {
      return []
    }
  })
  setImmediate(() => {
    for (const directory of abandonedDeletionDirectories) {
      void fs.promises.rm(directory, { recursive: true, force: true }).catch((error) => {
        console.error('[VideoAutoCut] clean abandoned material deletion staging failed', error)
      })
    }
  })

  let currentMaterialTask: ChildProcessWithoutNullStreams | null = null
  let currentImport: { sessionId: string; controller: AbortController; completed: Promise<void> } | null = null
  let materialWorkStopped = false
  const materialWorkController = new AbortController()
  const captures = new Set<Promise<unknown>>()
  type AnalysisOutcome = { ok: boolean; message?: string }
  let analysisTail: Promise<unknown> = Promise.resolve()
  const analysisJobs = new Map<string, { path: string; promise: Promise<AnalysisOutcome> }>()
  const abortMaterialWork = () => { void stopMaterialWork() }
  options.analysisAbortSignal?.addEventListener('abort', abortMaterialWork, { once: true })
  if (options.analysisAbortSignal?.aborted) abortMaterialWork()

  function runCapture(command: string, args: string[], cwd: string) {
    if (materialWorkStopped) return Promise.resolve({ code: null, stdout: '', stderr: '素材后台任务已暂停' })
    const pending = captureProcess(command, args, {
      cwd, env: sentryProcessEnv(createVideoAutoEnv()), signal: materialWorkController.signal,
    })
    captures.add(pending)
    void pending.then(() => captures.delete(pending), () => captures.delete(pending))
    return pending
  }

  function parseSentrySearchOutput(text: unknown): SearchResult[] {
    const results: SearchResult[] = []
    const lines = String(text || '').split(/\r?\n/)
    const pattern = /^\s*#(\d+)\s+\[([^\]]+)\]\s+(.+?)(?:\s+@\s+([\d:.]+)\s*-\s*([\d:.]+))?\s*$/

    for (const line of lines) {
      const match = line.match(pattern)
      if (!match) continue

      const source = match[3].trim()
      results.push({
        rank: Number(match[1]),
        score: Number(match[2]),
        name: path.basename(source),
        path: source,
        start: match[4] || '',
        end: match[5] || '',
        text: line.trim(),
      })
    }

    return results
  }

  function listRunMaterialFiles(run: RunRecord, limit = 500): RunMaterialGroup {
    return {
      runId: run.id,
      projectName: run.projectName || run.id,
      raw: downloadedFilesFor(run.path, limit),
    }
  }

  function listRunMaterialGroups(fileLimit: number): RunMaterialGroup[] {
    return listRuns().map((run) => listRunMaterialFiles(run, fileLimit))
  }

  function flattenRunMaterialGroups(groups: RunMaterialGroup[]): FileEntry[] {
    return groups.flatMap((group) => group.raw)
  }

  function listUserMaterialFiles(limit: number): FileEntry[] {
    return listVisibleMaterialFiles(materialsDir, limit, true)
  }

  function listSearchCandidateFiles(): FileEntry[] {
    return [
      ...listUserMaterialFiles(1000),
      ...flattenRunMaterialGroups(listRunMaterialGroups(500)),
      // Cloud cache bytes are not a device-wide local library. Include only
      // downloads represented in this account's material database.
      ...(identityStore?.listCloudFiles?.() || []).filter(file => (
        file.localStatus === 'present' && fs.existsSync(file.path)
      )),
    ]
  }

  function findMaterialFileForSearchResult(result: SearchResult, candidates: FileEntry[]): string {
    return findOriginalMaterialFile(result, candidates)?.path || ''
  }

  function enrichSearchResult(item: SearchResult, candidates: FileEntry[]): SearchResult {
    const localPath = findMaterialFileForSearchResult(item, candidates)
    if (!localPath || !fs.existsSync(localPath)) return { ...item, localPath: '' }

    const cachedCloudFile = isInsideDir(localPath, path.join(materialsDir, CLOUD_CACHE_DIRECTORY_NAME))
      ? candidates.find(file => samePath(file.path, localPath))
      : undefined
    const file = cachedCloudFile || identityStore?.describeKnownFile(createFileEntry(localPath))
      || createFileEntry(localPath)
    return {
      ...item,
      localPath,
      localUrl: file.url,
      localSize: file.size,
      localMtime: file.mtime,
      materialId: file.materialId,
      assetId: file.assetId,
      assetVersion: file.assetVersion,
      sourceSha256: file.sourceSha256,
      localStatus: file.localStatus,
      analysisStatus: file.analysisStatus,
      analysisError: file.analysisError,
      cloudStatus: file.cloudStatus,
    }
  }

  function enrichSearchResults(results: SearchResult[]): SearchResult[] {
    const candidates = listSearchCandidateFiles()
    const cloudCache = path.join(materialsDir, CLOUD_CACHE_DIRECTORY_NAME)
    const ownedCloudCandidates = candidates.filter(file => file.materialId && isInsideDir(file.path, cloudCache))
    return results.filter(item => {
      const resultPath = path.resolve(localPathWithoutNamespace(item.path))
      if (!isInsideDir(resultPath, cloudCache)) return true
      const original = findOriginalMaterialFile(item, ownedCloudCandidates)
      if (!original) return false
      const indexedSource = indexedMaterialSource(resultPath)
      // A same-named file belonging to another account is not a match for a
      // cached index row. Require its exact path (or original indexed directory).
      return indexedSource
        ? samePath(path.dirname(original.path), indexedSource.shotDirectory)
        : samePath(original.path, resultPath)
    }).map((item) => enrichSearchResult(item, candidates))
  }

  function createSentryCommand(action: 'index' | 'search' | 'remove', args: string[]) {
    const paths = getSentrySearchPaths()

    if (fs.existsSync(paths.exe)) {
      return { command: paths.exe, args: [action, ...args] }
    }

    if (fs.existsSync(paths.python) && fs.existsSync(paths.entry)) {
      return { command: paths.python, args: [sentryFilePath(paths.entry), action, ...args] }
    }

    return null
  }

  function notifyAnalysisReady(file: FileEntry): void {
    if (materialWorkStopped) return
    try {
      const pending = options.onMaterialAnalysisReady?.(file)
      if (pending && typeof (pending as Promise<unknown>).then === 'function') {
        void Promise.resolve(pending).catch(error => console.error('[VideoAutoCut] wake material backup queue failed', error))
      }
    } catch (error) {
      console.error('[VideoAutoCut] wake material backup queue failed', error)
    }
  }

  async function analyzeOneMaterial(file: FileEntry): Promise<AnalysisOutcome> {
    if (materialWorkStopped) return { ok: false, message: '素材分析已暂停，下次打开后可继续' }
    let markedAnalyzing = false
    const startedAt = new Date().toISOString()
    let sentry: ReturnType<typeof createSentryCommand> = null
    try {
      const known = file.materialId
        ? identityStore?.getMaterialCloudFileById?.(file.materialId)
        : identityStore?.getMaterialCloudFileByPath?.(file.path)
      // A database ready flag or an H264 file is not proof that complete vectors
      // exist. Verify reusable analysis before deciding to skip model work.
      const existing = hasExistingAnalysis
        ? await hasExistingAnalysis(file.path, materialWorkController.signal)
        : (known?.analysisStatus || file.analysisStatus) === 'ready'
      if (materialWorkStopped) return { ok: false, message: '素材分析已暂停，下次打开后可继续' }
      if (existing) {
        identityStore?.setAnalysisStatusForFile(file.path, 'ready')
        notifyAnalysisReady(file)
        return { ok: true }
      }
      if (known?.cloudStatus === 'ready' && known.cloudAnalysisStatus === 'ready') {
        // Cloud analysis is authoritative. Restore its index, never silently re-run the model.
        try {
          await ensureCloudMaterialAvailable?.(known.materialId)
        } catch {
          // Download/restore manages its own retry queue; retain the valid cloud result.
        }
        const restored = identityStore?.getMaterialCloudFileById(known.materialId)
        if (materialWorkStopped) return { ok: false, message: '素材分析已暂停，下次打开后可继续' }
        const ready = restored?.analysisStatus === 'ready'
        if (ready) notifyAnalysisReady(file)
        return { ok: ready }
      }
      sentry = createSentryCommand('index', [
        sentryFilePath(file.path),
        '--backend',
        'qwen-cloud',
      ])
      if (!sentry) {
        const message = recordAnalysisFailure(dataRoot, { source: file.path, startedAt, command: '', args: [], code: null, stdout: '', stderr: JSON.stringify(getSentrySearchPaths()), runtimeMissing: true })
        identityStore?.setAnalysisStatusForFile(file.path, 'failed', message)
        send(IPC_EVENTS.materialLibrary, {
          type: 'analysis-status',
          path: file.path,
          status: 'failed',
          message,
        })
        return { ok: false, message }
      }

      markedAnalyzing = true
      identityStore?.setAnalysisStatusForFile(file.path, 'analyzing')
      send(IPC_EVENTS.materialLibrary, {
        type: 'analysis-status',
        path: file.path,
        status: 'analyzing',
      })
      const result = await runCapture(sentry.command, sentry.args, dataRoot)
      if (materialWorkStopped) return { ok: false, message: '素材分析已暂停，下次打开后可继续' }
      const verified = result.code === 0 && (!hasExistingAnalysis
        || await hasExistingAnalysis(file.path, materialWorkController.signal))
      if (materialWorkStopped) return { ok: false, message: '素材分析已暂停，下次打开后可继续' }
      const status = verified ? 'ready' : 'failed'
      const message = status === 'failed'
        ? recordAnalysisFailure(dataRoot, { source: file.path, startedAt, command: sentry.command, args: sentry.args, ...result,
          ...(result.code === 0 ? { stderr: '素材索引进程已结束，但没有找到完整有效的分析结果' } : {}) })
        : ''
      identityStore?.setAnalysisStatusForFile(file.path, status, message)
      send(IPC_EVENTS.materialLibrary, {
        type: 'analysis-status',
        path: file.path,
        status,
        message,
      })
      if (verified) notifyAnalysisReady(file)
      return { ok: verified, message }
    } catch (error) {
      if (materialWorkStopped) return { ok: false, message: '素材分析已暂停，下次打开后可继续' }
      const message = recordAnalysisFailure(dataRoot, { source: file.path, startedAt,
        command: sentry?.command || '', args: sentry?.args || [], code: null, stdout: '', stderr: errorMessage(error) })
      identityStore?.setAnalysisStatusForFile(file.path, 'failed', message)
      send(IPC_EVENTS.materialLibrary, { type: 'analysis-status', path: file.path, status: 'failed', message })
      return { ok: false, message }
    } finally {
      if (markedAnalyzing && materialWorkStopped) {
        identityStore?.setAnalysisStatusForFile(file.path, 'pending')
      }
    }
  }

  function scheduleMaterialAnalysis(file: FileEntry): Promise<AnalysisOutcome> {
    if (materialWorkStopped) return Promise.resolve({ ok: false, message: '素材分析已暂停，下次打开后可继续' })
    const key = file.assetId ? `${file.assetId}:${file.assetVersion || 1}` : normalizePathForMatch(file.path)
    const current = analysisJobs.get(key)
    if (current) {
      // Identical content at another path may still need its searchable alias
      // mounted. It joins the first analysis and then reuses the verified cache.
      return samePath(current.path, file.path) ? current.promise
        : current.promise.then(result => result.ok ? scheduleMaterialAnalysis(file) : result)
    }
    const promise: Promise<AnalysisOutcome> = analysisTail.then(() => analyzeOneMaterial(file)).finally(() => {
      if (analysisJobs.get(key)?.promise === promise) analysisJobs.delete(key)
    })
    analysisJobs.set(key, { path: file.path, promise })
    analysisTail = promise.catch(() => undefined)
    return promise
  }

  async function analyzeImportedMaterials(files: FileEntry[], onFailure?: (message: string) => void): Promise<boolean> {
    const results = await Promise.all(files.map(file => scheduleMaterialAnalysis(file)))
    for (const result of results) if (result.message) onFailure?.(result.message)
    return results.every(result => result.ok)
  }

  async function analyzeMaterialsForBackup(paths: string[]): Promise<void> {
    if (materialWorkStopped) return
    const files: FileEntry[] = []
    for (const candidate of new Set(paths)) {
      let target = ''
      try {
        target = assertInsideWorkspace(candidate, '待备份素材')
        if (!fs.existsSync(target)) throw new Error('本地素材文件不存在，请重新导入素材后重试备份')
        if (!fs.statSync(target).isFile()) throw new Error('待备份素材不是视频文件，请重新选择素材')
        const file = createFileEntry(target)
        files.push(identityStore?.describeKnownFile(file) || file)
      } catch (error) {
        const message = errorMessage(error, '素材文件不可分析')
        if (target) identityStore?.setAnalysisStatusForFile(target, 'failed', message)
        send(IPC_EVENTS.materialLibrary, { type: 'analysis-status', path: target || candidate, status: 'failed', message })
      }
    }
    await analyzeImportedMaterials(files)
  }

  async function stopMaterialWork(): Promise<void> {
    materialWorkStopped = true
    materialWorkController.abort()
    options.analysisAbortSignal?.removeEventListener('abort', abortMaterialWork)
    const importCompleted = currentImport?.completed || Promise.resolve()
    cancelMaterialImport()
    const generated = currentMaterialTask ? terminateProcessTree(currentMaterialTask) : Promise.resolve()
    await Promise.allSettled([analysisTail, importCompleted, generated, ...captures])
  }

  async function analyzeMaterial(value: unknown) {
    const options = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
    let file: FileEntry
    try {
      const materialId = String(options.materialId || '').trim()
      const known = materialId
        ? identityStore?.getMaterialCloudFileById(materialId)
        : identityStore?.getMaterialCloudFileByPath(String(options.path || options.file || ''))
      let candidate = known?.localPath || options.path || options.file
      if (known && (!candidate || !fs.existsSync(String(candidate)))) {
        if (known.cloudStatus !== 'ready' || !ensureCloudMaterialAvailable) {
          return { ok: false, message: '本地素材文件不存在，且云端副本尚不可下载，请重新导入素材或等待上传完成' }
        }
        const download = await ensureCloudMaterialAvailable(known.materialId) as { ok?: boolean; message?: string; path?: string }
        if (!download?.ok) return { ok: false, message: download?.message || '云端素材下载失败，未开始分析' }
        candidate = identityStore?.getMaterialCloudFileById(known.materialId)?.localPath || download.path
      }
      const target = assertMaterialPath(candidate, '素材文件')
      if (!fs.existsSync(target)) return { ok: false, message: '本地素材文件不存在，请先从云端下载或重新导入素材' }
      file = identityStore?.describeKnownFile(createFileEntry(target)) || createFileEntry(target)
    } catch (error) {
      return { ok: false, message: errorMessage(error, '素材文件不可分析') }
    }
    let failureMessage = ''
    const ok = await analyzeImportedMaterials([file], (message) => { failureMessage = message })
    return {
      ok,
      message: ok ? '' : file.cloudAnalysisStatus === 'ready'
        ? '云端已有分析结果，本地索引尚未恢复完成，请稍后重试，无需重复分析'
        : failureMessage || '素材分析尚未完成，请查看当前状态后重试',
    }
  }

  async function processDownloadedMaterials(
    runPathValue: unknown,
    processOptions: {
      markIndexedReady?: boolean
      verifyIndexedAnalysis?: boolean
      analyzeMissing?: boolean
    } = {},
  ) {
    const runPath = path.resolve(String(runPathValue || ''))
    let realRunPath: string
    try {
      realRunPath = fs.realpathSync(runPath)
      const realRunsDir = fs.realpathSync(runsDir)
      if (!isInsideDir(realRunPath, realRunsDir) || samePath(realRunPath, realRunsDir)) {
        throw new Error('任务运行目录无效')
      }
    } catch (error) {
      return { ok: false, files: [] as FileEntry[], ready: 0, pending: 0, message: errorMessage(error) }
    }

    const files = downloadedFilesFor(realRunPath, 10_000)
      .map((file) => identityStore?.describeKnownFile(file) || file)
    if (!files.length) return { ok: true, files, ready: 0, pending: 0, message: '' }

    try {
      onDownloadedMaterials?.(files)
    } catch (error) {
      console.error('[VideoAutoCut] queue downloaded material cloud backup failed', error)
    }

    let ready = 0
    const missing: FileEntry[] = []
    for (const file of files) {
      if (file.analysisStatus === 'ready') {
        ready += 1
        continue
      }
      const indexed = processOptions.markIndexedReady
        && materialFileOperations.findIndexedCopies(file.path).length > 0
      const indexedReady = indexed && await hasExistingAnalysis?.(file.path, materialWorkController.signal) === true
      if (indexedReady) {
        identityStore?.setAnalysisStatusForFile(file.path, 'ready')
        file.analysisStatus = 'ready'
        ready += 1
      } else if (
        processOptions.analyzeMissing
        && (file.analysisStatus === 'pending' || file.analysisStatus === 'analyzing')
      ) {
        missing.push(file)
      }
    }
    if (missing.length) {
      await analyzeImportedMaterials(missing)
      const refreshedReady = missing.filter((file) => (
        identityStore?.describeKnownFile(createFileEntry(file.path)).analysisStatus === 'ready'
      )).length
      ready += refreshedReady
    }
    return {
      ok: ready === files.length,
      files,
      ready,
      pending: Math.max(0, files.length - ready),
      message: ready === files.length ? '' : '部分下载素材仍在等待分析',
    }
  }

  async function resumePendingMaterialWork() {
    if (materialWorkStopped) return
    if (!currentImport) {
      const stagingRoot = path.resolve(materialsDir, '.staging')
      if (fs.existsSync(stagingRoot)) {
        for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
          const candidate = path.resolve(stagingRoot, entry.name)
          if (!isInsideDir(candidate, stagingRoot) || samePath(candidate, stagingRoot)) continue
          fs.rmSync(candidate, { recursive: entry.isDirectory(), force: true })
        }
      }
      ensureDir(stagingRoot)
    }
    for (const run of listRuns()) {
      if (materialWorkStopped) return
      await processDownloadedMaterials(run.path, {
        markIndexedReady: true,
        verifyIndexedAnalysis: true,
        analyzeMissing: true,
      })
    }
    if (materialWorkStopped) return
    const userFiles = listUserMaterialFiles(10_000)
      .map((file) => identityStore?.describeKnownFile(file) || file)
    try {
      onMaterialsImported?.(userFiles)
    } catch (error) {
      console.error('[VideoAutoCut] resume imported material cloud backup failed', error)
    }
    const pendingUserFiles = userFiles
      .filter((file) => file.analysisStatus === 'pending' || file.analysisStatus === 'analyzing')
    if (pendingUserFiles.length) await analyzeImportedMaterials(pendingUserFiles)
  }

  async function localSemanticSearch(query: unknown, searchOptions: SearchOptions = {}) {
    const q = String(query || '').trim()
    if (!q) return { ok: false, message: '请输入语义搜索内容', results: [] as SearchResult[], raw: '' }
    const root = getVideoAutoRoot()
    if (!isRuntimeUsable(root)) {
      return { ok: false, message: '运行环境未安装，请先下载运行环境', results: [] as SearchResult[], raw: '' }
    }

    const sentry = createSentryCommand('search', [q])
    if (!sentry) {
      return { ok: false, message: '没有找到 sentrysearch.exe 或 sentrysearch Python 环境', results: [] as SearchResult[], raw: '' }
    }

    const args = [...sentry.args]
    const resultCount = numberValue(searchOptions.results, 0)
    if (resultCount > 0) args.push('--results', String(resultCount))
    args.push('--threshold', searchOptions.threshold !== undefined ? String(searchOptions.threshold) : '0.0')
    if (searchOptions.noTrim !== false) args.push('--no-trim')

    const result = await runCapture(sentry.command, args, dataRoot)
    const raw = [result.stdout, result.stderr].filter(Boolean).join('\n')

    return {
      ok: result.code === 0,
      code: result.code,
      command: commandText(sentry.command, args),
      message: result.code === 0 ? '' : (result.stderr || result.stdout || '语义搜索失败'),
      results: enrichSearchResults(parseSentrySearchOutput(raw)),
      raw,
    }
  }

  async function semanticSearch(query: unknown, searchOptions: SearchOptions = {}) {
    const q = String(query || '').trim()
    if (!q) return { ok: false, message: '请输入语义搜索内容', results: [] as SearchResult[], raw: '' }
    if (cloudSemanticSearch) {
      try {
        const cloudResult = await cloudSemanticSearch(q, searchOptions)
        if (cloudResult && typeof cloudResult === 'object' && !Array.isArray(cloudResult)) {
          return cloudResult
        }
      } catch (error) {
        console.warn('[VideoAutoCut] cloud semantic search unavailable; using local index', {
          message: errorMessage(error),
        })
      }
    }
    return localSemanticSearch(q, searchOptions)
  }

  async function searchAllMaterialSources(
    query: string,
    searchOptions: SearchOptions = {},
  ) {
    const searches: Array<Promise<unknown>> = [localSemanticSearch(query, searchOptions)]
    if (cloudSemanticSearch) searches.push(cloudSemanticSearch(query, searchOptions))
    const settled = await Promise.allSettled(searches)
    const successful = settled.flatMap((result) => {
      if (result.status !== 'fulfilled' || !result.value || typeof result.value !== 'object') return []
      const response = result.value as { ok?: unknown; results?: unknown }
      if (response.ok === false || !Array.isArray(response.results)) return []
      return [response.results as SearchResult[]]
    })
    const results = mergeSearchResults(successful)
    const failures = settled.flatMap((result) => result.status === 'rejected'
      ? [errorMessage(result.reason)]
      : [])
    return {
      ok: successful.length > 0,
      message: successful.length > 0 ? '' : failures[0] || '素材库检索暂时不可用',
      results,
      raw: '',
    }
  }

  function configuredAutoReuseThreshold(value?: unknown): number {
    if (value !== undefined && value !== null && String(value).trim()) {
      return normalizedThreshold(value)
    }
    const env = createVideoAutoEnv()
    return normalizedThreshold(
      env.MATERIAL_AUTO_REUSE_MIN_SCORE || DEFAULT_AUTO_REUSE_THRESHOLD,
    )
  }

  async function autoResolveShotMaterials(value: unknown) {
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
    return resolveAutomaticShotMaterials({
      ...record,
      threshold: configuredAutoReuseThreshold(record.threshold),
    }, async (query, options) => {
      const threshold = configuredAutoReuseThreshold(record.threshold)
      const local = await localSemanticSearch(query, options).catch((error) => ({ ok: false, message: errorMessage(error), results: [] as SearchResult[] }))
      const localMatch = selectReusableMaterial(local.results.filter((item) => (
        item.localStatus === 'present' && Boolean(item.localPath) && fs.existsSync(String(item.localPath))
      )), threshold)
      if (localMatch) return { ok: true, results: [localMatch] }
      if (!cloudSemanticSearch) return local
      const cloud = await cloudSemanticSearch(query, options) as { ok?: boolean; message?: string; results?: SearchResult[] } | null
      if (!cloud || cloud.ok === false) return cloud || local
      let downloadError = ''
      for (const candidate of mergeSearchResults([cloud.results || []])) {
        if (!selectReusableMaterial([candidate], threshold)) continue
        const materialId = String(candidate.materialId || '')
        let known = identityStore?.getMaterialCloudFileById(materialId)
        if (!known || known.localStatus !== 'present' || !fs.existsSync(known.localPath)
          || (known.cloudAnalysisStatus === 'ready' && known.analysisStatus !== 'ready')) {
          if (!ensureCloudMaterialAvailable) { downloadError = '云端素材下载服务不可用'; continue }
          try {
            const downloaded = await ensureCloudMaterialAvailable(materialId) as { ok?: boolean; message?: string }
            if (!downloaded?.ok) { downloadError = downloaded?.message || '云端素材下载失败'; continue }
            known = identityStore?.getMaterialCloudFileById(materialId)
          } catch (error) { downloadError = errorMessage(error, '云端素材下载失败'); continue }
        }
        if (known?.localStatus !== 'present' || !fs.existsSync(known.localPath)) {
          downloadError = '云端素材下载后不可用'
          continue
        }
        if (known.cloudAnalysisStatus === 'ready' && known.analysisStatus !== 'ready') {
          downloadError = '云端分析索引尚未恢复完成，请稍后重试'
          continue
        }
        return { ok: true, results: [{ ...candidate, localPath: known.localPath, localStatus: 'present' as const }] }
      }
      return { ok: !downloadError, message: downloadError, results: [] }
    })
  }

  async function findReusableMaterial(prompt: string, thresholdValue?: unknown) {
    const threshold = configuredAutoReuseThreshold(thresholdValue)
    const response = await searchAllMaterialSources(prompt, {
      results: DEFAULT_AUTO_REUSE_RESULTS,
      threshold: -1,
      noTrim: true,
    })
    const selected = selectReusableMaterial(response.results, threshold)
    if (!selected) return { selected: null, threshold, message: response.message }

    const materialId = String(selected.materialId || '').trim()
    const selectedLocalPath = String(selected.localPath || '').trim()
    const selectedLocallyAvailable = selected.localStatus === 'present'
      && Boolean(selectedLocalPath)
      && fs.existsSync(selectedLocalPath)
    if (!selectedLocallyAvailable && materialId && ensureCloudMaterialAvailable) {
      try {
        const download = await ensureCloudMaterialAvailable(materialId)
        const downloadResult = download && typeof download === 'object' && !Array.isArray(download)
          ? download as { ok?: unknown; message?: unknown }
          : {}
        if (downloadResult.ok !== true) {
          return {
            selected: null,
            threshold,
            message: String(downloadResult.message || '云端素材下载失败'),
          }
        }
        const refreshed = identityStore?.getMaterialCloudFileById(materialId)
        if (refreshed?.localStatus !== 'present' || !fs.existsSync(refreshed.localPath)) {
          return { selected: null, threshold, message: '云端素材下载后不可用' }
        }
        const localFile = identityStore?.describeKnownFile(createFileEntry(refreshed.localPath))
        return {
          selected: {
            ...selected,
            localPath: refreshed.localPath,
            localUrl: localFile?.url || '',
            localSize: refreshed.sourceSize,
            localStatus: refreshed.localStatus,
          },
          threshold,
          message: '',
        }
      } catch (error) {
        return { selected: null, threshold, message: errorMessage(error, '云端素材下载失败') }
      }
    }
    if (!selectedLocallyAvailable) {
      return { selected: null, threshold, message: '匹配素材当前设备不可用' }
    }
    return { selected, threshold, message: '' }
  }

  async function removeMaterialsFromVectorIndex(files: readonly unknown[]): Promise<VectorIndexResult> {
    const patterns: string[] = []
    const appendPattern = (candidate: string) => {
      if (!patterns.some((item) => samePath(item, candidate))) patterns.push(candidate)
    }

    for (const file of files) {
      const value = String(file || '').trim()
      if (!value) continue

      const target = path.resolve(value)
      appendPattern(target)
      try {
        if (fs.existsSync(target)) appendPattern(fs.realpathSync(target))
      } catch (_error) {
        // Keep the resolved path; index removal should still be attempted.
      }
    }

    if (patterns.length === 0) {
      return { ok: true, skipped: true, removedChunks: 0, message: '没有需要清理索引的素材' }
    }

    const sentry = createSentryCommand('remove', patterns)
    if (!sentry) {
      return { ok: true, skipped: true, removedChunks: 0, message: '未找到 sentrysearch，已跳过向量索引清理' }
    }

    const result = await runCapture(sentry.command, sentry.args, dataRoot)
    const raw = [result.stdout, result.stderr].filter(Boolean).join('\n')
    const totalMatch = raw.match(/Total:\s*removed\s+(\d+)\s+chunks?/i)
    const removedChunks = totalMatch
      ? Number(totalMatch[1] || 0)
      : Array.from(raw.matchAll(/^Removed\s+(\d+)\s+chunks?/gim))
        .reduce((sum, match) => sum + Number(match[1] || 0), 0)

    return {
      ok: result.code === 0,
      skipped: false,
      removedChunks,
      command: commandText(sentry.command, sentry.args),
      message: result.code === 0 ? raw.trim() : (result.stderr || result.stdout || '向量索引清理失败'),
      raw,
    }
  }

  function removeMaterialFromVectorIndex(file: unknown): Promise<VectorIndexResult> {
    return removeMaterialsFromVectorIndex([file])
  }

  function removeGeneratedRecordsForOutputPaths(outputPaths: readonly unknown[]) {
    const generated = generatedStore.removeGeneratedRecordsByOutputPaths(outputPaths)
    return generated.removed.map((record) => ({
      id: record.id,
      ...generatedStore.removeGeneratedRecordFiles(record),
    }))
  }

  async function deleteMaterial(file: unknown): Promise<DeleteResult> {
    const target = assertMaterialPath(file, '素材文件')
    const identity = identityStore?.getMaterialCloudFileByPath(target)
    if (identity) {
      const impact = identityStore?.getDeletionImpact([identity.materialId], [])
      if (impact && !impact.canDelete) {
        return { ok: false, message: impact.blockers.join('；') || '该素材当前不可删除' }
      }
    }
    const indexedCopies = materialFileOperations.findIndexedCopies(target)
    const index = await removeMaterialsFromVectorIndex([target, ...indexedCopies])
    if (!index.ok) return { ok: false, message: index.message || '向量索引清理失败', index }

    const removedFile = safeRemoveFile(target)
    if (removedFile || identity) identityStore?.deleteFile(target)
    for (const indexedCopy of indexedCopies) safeRemoveFile(indexedCopy)
    const generatedRecords = removeGeneratedRecordsForOutputPaths([target])

    return {
      ok: true,
      removedFile,
      index,
      generatedRecords,
      message: index.skipped ? index.message : '',
    }
  }

  function deleteLocalMaterialCopy(options: DeleteLocalMaterialCopyOptions = {}): DeleteResult {
    try {
      const materialId = String(options.materialId || '').trim()
      const resolved = materialId ? identityStore?.getMaterialCloudFileById(materialId) : null
      if (!resolved) throw new Error('素材不存在')
      if (resolved.localStatus !== 'present') throw new Error('当前设备没有可删除的本机副本')
      if (resolved.cloudStatus !== 'ready' || resolved.cloudRevision < 1) {
        throw new Error('云端副本尚未校验完成，不能删除本机副本')
      }
      const target = assertMaterialPath(resolved.localPath, '素材文件')
      for (const indexedCopy of materialFileOperations.findIndexedCopies(target)) safeRemoveFile(indexedCopy)
      const removedFile = safeRemoveFile(target)
      identityStore?.removeLocalCopy(materialId)
      return { ok: true, removedFile }
    } catch (error) {
      return { ok: false, removedFile: false, message: errorMessage(error, '删除本机副本失败') }
    }
  }

  function previewMaterialDeletion(
    options: PreviewMaterialDeletionOptions = {},
  ): MaterialDeletionImpact {
    try {
      const pathValues = Array.isArray(options.paths) ? options.paths : []
      const folderValues = Array.isArray(options.folderIds) ? options.folderIds : []
      const paths = [...new Set(pathValues.map((value) => assertMaterialPath(value, '素材文件')))]
      const folderIds = [...new Set(folderValues.map((value) => String(value || '').trim()).filter(Boolean))]
      if (!paths.length && !folderIds.length) throw new Error('请选择要删除的素材或文件夹')
      if (paths.length + folderIds.length > 1000) throw new Error('单次最多预检 1000 个删除目标')

      const materialIds = paths.flatMap((filePath) => {
        const material = identityStore?.getMaterialCloudFileByPath(filePath)
        return material ? [material.materialId] : []
      })
      for (const folderId of folderIds) directoryBrowser.prepareFolderOperation(folderId)
      const impact = identityStore?.getDeletionImpact(materialIds, folderIds) || {
        materialCount: paths.length,
        folderCount: folderIds.length,
        localFileCount: paths.filter((filePath) => fs.existsSync(filePath)).length,
        cloudCopyCount: 0,
        publicMaterialCount: 0,
        taskReferenceCount: 0,
        canDelete: true,
        blockers: [],
      }
      return { ok: true, ...impact }
    } catch (error) {
      return {
        ok: false,
        message: errorMessage(error, '删除影响检查失败'),
        materialCount: 0,
        folderCount: 0,
        localFileCount: 0,
        cloudCopyCount: 0,
        publicMaterialCount: 0,
        taskReferenceCount: 0,
        canDelete: false,
        blockers: [],
      }
    }
  }

  async function deleteMaterials(
    options: DeleteMaterialsOptions = {},
  ): Promise<DeleteMaterialsBatchResult> {
    const values = Array.isArray(options.paths) ? options.paths : []
    const paths = [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
    if (!paths.length) return { ok: false, message: '请选择要删除的素材', succeeded: 0, failed: 0, results: [] }
    if (paths.length > 1000) return { ok: false, message: '单次最多删除 1000 个素材', succeeded: 0, failed: paths.length, results: [] }

    const results: DeleteMaterialsBatchResult['results'] = []
    for (const filePath of paths) {
      try {
        const result = await deleteMaterial(filePath)
        results.push({ path: filePath, ok: result.ok, message: result.message })
      } catch (error) {
        results.push({ path: filePath, ok: false, message: errorMessage(error, '删除素材失败') })
      }
    }
    const succeeded = results.filter((result) => result.ok).length
    const failed = results.length - succeeded
    return {
      ok: failed === 0,
      message: failed ? `${succeeded} 个素材删除成功，${failed} 个删除失败` : '',
      succeeded,
      failed,
      results,
    }
  }

  async function renameMaterial(options: RenameMaterialOptions = {}): Promise<RenameResult> {
    let renamed: ReturnType<typeof materialFileOperations.renameMaterialFile>
    let indexedCopies: string[]
    try {
      indexedCopies = materialFileOperations.findIndexedCopies(options.path)
      renamed = materialFileOperations.renameMaterialFile(options.path, options.name)
    } catch (error) {
      return { ok: false, message: errorMessage(error, '重命名素材失败') }
    }

    if (!renamed.changed) return { ok: true, file: renamed.file }

    const rollbackRename = () => {
      let rollbackMessage = ''
      try {
        materialFileOperations.renameMaterialFile(
          renamed.file.path,
          path.basename(renamed.previousPath),
        )
      } catch (error) {
        rollbackMessage = `；恢复原文件名失败：${errorMessage(error)}`
      }
      return rollbackMessage
    }

    let index: VectorIndexResult
    try {
      index = await removeMaterialsFromVectorIndex([renamed.previousPath, ...indexedCopies])
    } catch (error) {
      return {
        ok: false,
        message: `向量索引清理失败：${errorMessage(error)}${rollbackRename()}`,
      }
    }

    if (!index.ok) {
      return {
        ok: false,
        index,
        message: `${index.message || '向量索引清理失败'}${rollbackRename()}`,
      }
    }

    for (const indexedCopy of indexedCopies) safeRemoveFile(indexedCopy)

    try {
      identityStore?.moveFile(renamed.previousPath, renamed.file.path)
    } catch (error) {
      return {
        ok: false,
        index,
        message: `素材身份更新失败：${errorMessage(error)}${rollbackRename()}`,
      }
    }

    try {
      generatedStore.renameGeneratedRecordOutputPath(renamed.previousPath, renamed.file.path)
    } catch (error) {
      return {
        ok: true,
        file: renamed.file,
        index,
        message: `素材已重命名，但生成记录同步失败：${errorMessage(error)}`,
      }
    }

    return {
      ok: true,
      file: renamed.file,
      index,
    }
  }

  function getMaterialFolderDetails(options: MaterialFolderOptions = {}) {
    return directoryBrowser.getMaterialFolderDetails(options.folderId)
  }

  function createMaterialFolder(
    options: CreateMaterialFolderOptions = {},
  ): MaterialFolderOperationResult {
    try {
      const result = {
        ok: true,
        folder: directoryBrowser.createMaterialFolder(
          options.parentFolderId,
          options.name,
        ),
      }
      onMaterialFolderCreated?.(directoryBrowser.getMaterialFolderIdentityId(result.folder.id))
      return result
    } catch (error) {
      return { ok: false, message: errorMessage(error, '新建素材文件夹失败') }
    }
  }

  function moveMaterials(options: MoveMaterialsOptions = {}): MoveMaterialsResult {
    try {
      const result = directoryBrowser.moveMaterialFiles(
        options.sourceFolderId,
        options.destinationFolderId,
        options.paths,
      )
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: errorMessage(error, '移动素材失败') }
    }
  }

  function moveMaterialFolder(options: MoveMaterialFolderOptions = {}): MoveMaterialsResult {
    try {
      const result = directoryBrowser.moveMaterialFolder(
        options.folderId,
        options.destinationFolderId,
      )
      return {
        ok: true,
        moved: result.changed ? 1 : 0,
        folder: result.folder,
        previousParentId: result.previousParentId,
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error, '移动素材文件夹失败') }
    }
  }

  function folderRenameMappings(
    prepared: PreparedMaterialFolderOperation,
    destinationDirectory: string,
  ) {
    return prepared.videoPaths.map((previousPath) => ({
      previousPath,
      nextPath: path.join(
        destinationDirectory,
        path.relative(prepared.directory, previousPath),
      ),
    }))
  }

  async function stagedDeletionVideoPaths(stagedDirectory: string): Promise<string[]> {
    const files: string[] = []
    const pending = [stagedDirectory]
    while (pending.length > 0) {
      const current = pending.pop()
      if (!current) continue
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const candidate = path.join(current, entry.name)
        if (entry.isDirectory()) pending.push(candidate)
        else if (entry.isFile() && VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLocaleLowerCase())) {
          files.push(candidate)
        }
      }
    }
    return files
  }

  function scheduleDeletedFolderCleanup(
    deleted: ReturnType<typeof directoryBrowser.deleteMaterialFolder>,
  ): void {
    if (!deleted.stagedDirectory) return
    setImmediate(() => {
      void (async () => {
        const stagedPaths = await stagedDeletionVideoPaths(deleted.stagedDirectory || '')
        const previousPaths = stagedPaths.map((filePath) => path.join(
          deleted.directory,
          path.relative(deleted.stagedDirectory || '', filePath),
        ))
        try {
          const index = await removeMaterialsFromVectorIndex(previousPaths)
          if (!index.ok) console.error('[VideoAutoCut] background material index cleanup failed', index.message)
          removeGeneratedRecordsForOutputPaths(previousPaths)
        } catch (error) {
          console.error('[VideoAutoCut] background material metadata cleanup failed', error)
        } finally {
          await fs.promises.rm(deleted.stagedDirectory || '', { recursive: true, force: true })
        }
      })().catch((error) => {
        console.error('[VideoAutoCut] background material folder cleanup failed', error)
      })
    })
  }

  async function renameMaterialFolder(
    options: RenameMaterialFolderOptions = {},
  ): Promise<MaterialFolderOperationResult> {
    try {
      const target = directoryBrowser.getMaterialFolderDetails(options.folderId)
      if (target.kind === 'cloud') {
        const renamed = directoryBrowser.renameMaterialFolder(options.folderId, options.name)
        return {
          ok: true,
          folder: renamed.folder,
          previousFolderId: renamed.previousFolderId,
        }
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error, '重命名素材文件夹失败') }
    }

    let prepared: PreparedMaterialFolderOperation
    let renamed: ReturnType<typeof directoryBrowser.renameMaterialFolder>
    try {
      prepared = directoryBrowser.prepareFolderOperation(options.folderId)
      renamed = directoryBrowser.renameMaterialFolder(options.folderId, options.name)
    } catch (error) {
      return { ok: false, message: errorMessage(error, '重命名素材文件夹失败') }
    }

    if (!renamed.changed) return { ok: true, folder: renamed.folder }

    const rollbackRename = () => {
      let restored: ReturnType<typeof directoryBrowser.renameMaterialFolder>
      try {
        restored = directoryBrowser.renameMaterialFolder(
          renamed.folder.id,
          path.basename(renamed.previousDirectory),
        )
      } catch (error) {
        return `；恢复原文件夹名称失败：${errorMessage(error)}`
      }

      try {
        directoryBrowser.prepareFolderOperation(restored.folder.id)
        return '；已恢复原文件夹名称'
      } catch (error) {
        return `；已恢复原文件夹名称，但目录缓存重建失败：${errorMessage(error)}`
      }
    }

    let index: VectorIndexResult
    try {
      index = await removeMaterialsFromVectorIndex(prepared.videoPaths)
    } catch (error) {
      return {
        ok: false,
        message: `向量索引清理失败：${errorMessage(error)}${rollbackRename()}`,
      }
    }

    if (!index.ok) {
      return {
        ok: false,
        index,
        message: `${index.message || '向量索引清理失败'}${rollbackRename()}`,
      }
    }

    try {
      generatedStore.renameGeneratedRecordOutputPaths(
        folderRenameMappings(prepared, renamed.directory),
      )
    } catch (error) {
      return {
        ok: true,
        folder: renamed.folder,
        previousFolderId: renamed.previousFolderId,
        index,
        message: `素材文件夹已重命名，但生成记录同步失败：${errorMessage(error)}`,
      }
    }

    return {
      ok: true,
      folder: renamed.folder,
      previousFolderId: renamed.previousFolderId,
      index,
    }
  }

  async function deleteMaterialFolder(
    options: MaterialFolderOptions = {},
  ): Promise<MaterialFolderOperationResult> {
    let target: ReturnType<typeof directoryBrowser.getMaterialFolderDetails>
    let identityFolderId: string
    try {
      target = directoryBrowser.getMaterialFolderDetails(options.folderId)
      identityFolderId = directoryBrowser.getMaterialFolderIdentityId(options.folderId)
    } catch (error) {
      return { ok: false, message: errorMessage(error, '删除素材文件夹失败') }
    }
    const impact = identityStore?.getDeletionImpact([], [identityFolderId])
    if (impact && !impact.canDelete) {
      return { ok: false, message: impact.blockers.join('；') || '该文件夹当前不可删除' }
    }

    let deleted: ReturnType<typeof directoryBrowser.deleteMaterialFolder>
    try {
      deleted = directoryBrowser.deleteMaterialFolder(options.folderId)
    } catch (error) {
      return { ok: false, message: errorMessage(error, '删除素材文件夹失败') }
    }

    scheduleDeletedFolderCleanup(deleted)
    onMaterialFolderDeleted?.()
    return {
      ok: true,
      parentId: deleted.parentId,
      message: target.kind === 'cloud'
        ? '云端文件夹记录已删除，COS 中的真实素材文件已保留'
        : '本地文件夹已移出素材库，后台正在清理索引并同步云端记录',
    }
  }

  async function deleteGenerated(options: DeleteGeneratedOptions = {}) {
    const id = String(options.id || '').trim()
    const outputPath = String(options.outputPath || options.output_path || '').trim()
    const matched = generatedStore.listGenerated().filter((record) => {
      if (id && String(record.id || '') === id) return true
      return !!outputPath && samePath(record.output_path, outputPath)
    })

    if (!matched.length) return { ok: false, message: '没有找到生成素材记录' }

    const details: unknown[] = []
    let firstError = ''

    for (const record of matched) {
      const file = String(record.output_path || '')
      let deleted: DeleteResult = {
        ok: true,
        removedFile: false,
        index: { ok: true, skipped: true, removedChunks: 0, message: '没有输出文件' },
      }

      if (file) {
        try {
          const fileExists = fs.existsSync(file)
          const insideWorkspace = isInsideDir(resolveExistingOrParent(file), dataRoot)
          if (!insideWorkspace && !fileExists) {
            const index = await removeMaterialFromVectorIndex(file)
            if (!index.ok) {
              deleted = { ok: false, message: index.message || '向量索引清理失败', index }
            } else {
              generatedStore.removeGeneratedRecordById(record.id)
              deleted = { ok: true, removedFile: false, index, message: '已清理不存在的旧生成记录' }
            }
          } else {
            deleted = await deleteMaterial(file)
          }
        } catch (error) {
          deleted = { ok: false, message: errorMessage(error) }
        }
      }

      if (!deleted.ok && !firstError) firstError = deleted.message || '删除生成素材失败'
      const recordFiles = deleted.ok
        ? deleted.generatedRecords?.length
          ? { recordDir: deleted.generatedRecords.some((item) => item.recordDir) }
          : generatedStore.removeGeneratedRecordFiles(record)
        : { recordDir: false }

      if (!file && deleted.ok) {
        generatedStore.removeGeneratedRecordById(record.id)
      }

      details.push({ id: record.id, outputPath: file, ...deleted, ...recordFiles })
    }

    return {
      ok: !firstError,
      message: firstError,
      details,
    }
  }

  function list() {
    ensureDir(materialsDir)
    return {
      user: listUserMaterialFiles(1000),
      runs: listRunMaterialGroups(500),
    }
  }

  function ensureImportedFolder(
    parentFolderId: string,
    parentDirectory: string,
    name: string,
  ): { folderId: string; identityFolderId: string; directory: string } {
    const siblings = directoryBrowser.browseMaterials({ folderId: parentFolderId }).folders
    const existing = siblings.find((folder) => folder.name === name)
      || siblings.find((folder) => (
        folder.name.localeCompare(name, 'zh-CN', { sensitivity: 'base' }) === 0
      ))
    if (existing) {
      return {
        folderId: existing.id,
        identityFolderId: directoryBrowser.getMaterialFolderIdentityId(existing.id),
        directory: fs.realpathSync(path.join(parentDirectory, existing.name)),
      }
    }

    const created = createMaterialFolder({ parentFolderId, name })
    if (!created.ok || !created.folder) {
      throw new Error(created.message || `无法创建素材文件夹“${name}”`)
    }
    return {
      folderId: created.folder.id,
      identityFolderId: directoryBrowser.getMaterialFolderIdentityId(created.folder.id),
      directory: fs.realpathSync(path.join(parentDirectory, created.folder.name)),
    }
  }

  function prepareFolderImportFiles(
    scan: FolderImportScan,
    target: { folderId: string; identityFolderId: string; directory: string },
  ): PreparedMaterialImportFile[] {
    const folderKey = (relativeDirectory: string) => {
      const normalized = path.normalize(relativeDirectory)
      return normalized === '.' ? '' : normalized
    }
    const importedRoot = ensureImportedFolder(target.folderId, target.directory, scan.rootName)
    const folderTargets = new Map<string, {
      folderId: string
      identityFolderId: string
      directory: string
    }>([
      ['', importedRoot],
    ])
    const directories = [...new Set(scan.directories.map(folderKey))]
      .sort((first, second) => {
        const depthDifference = first.split(path.sep).length - second.split(path.sep).length
        return depthDifference || first.localeCompare(second, 'zh-CN', {
          numeric: true,
          sensitivity: 'base',
        })
      })

    for (const relativeDirectory of directories) {
      const parentRelative = path.dirname(relativeDirectory)
      const parentKey = parentRelative === '.' ? '' : parentRelative
      const parent = folderTargets.get(parentKey)
      if (!parent) throw new Error(`无法还原文件夹层级：${relativeDirectory}`)
      folderTargets.set(
        relativeDirectory,
        ensureImportedFolder(
          parent.folderId,
          parent.directory,
          path.basename(relativeDirectory),
        ),
      )
    }

    return scan.files.map((file) => {
      const destination = folderTargets.get(folderKey(file.relativeDirectory))
      if (!destination) throw new Error(`无法定位素材目标文件夹：${file.relativeDirectory}`)
      return {
        path: file.path,
        name: file.name,
        size: file.size,
        destinationDirectory: destination.directory,
        folderId: destination.identityFolderId,
      }
    })
  }

  async function importMaterials(
    parentWindow: BrowserWindow | null,
    options: ImportMaterialsOptions = {},
  ): Promise<FileEntry[]> {
    if (materialWorkStopped) return []
    ensureDir(materialsDir)
    const target = directoryBrowser.getMaterialImportTarget(options.folderId)
    const selection = materialImportSelection(options.selection)
    const result = await showOpenDialog(parentWindow, selection === 'folder'
      ? {
          title: '选择要导入的素材文件夹',
          properties: ['openDirectory'],
        }
      : {
          title: '添加自己的素材',
          filters: [{ name: 'Video', extensions: extensionsForDialog(VIDEO_EXTENSIONS) }],
          properties: ['openFile', 'multiSelections'],
        })

    if (materialWorkStopped || result.canceled || result.filePaths.length === 0) return []
    if (currentImport) throw new Error('已有素材正在导入')
    let sourceFiles: PreparedMaterialImportFile[]
    if (selection === 'folder') {
      const scan = await scanFolderForMaterialImport(result.filePaths[0], materialsDir)
      if (materialWorkStopped) return []
      if (scan.files.length === 0) throw new Error('所选文件夹中没有支持的视频文件')
      sourceFiles = prepareFolderImportFiles(scan, target)
    } else {
      sourceFiles = result.filePaths.map((sourcePath) => ({
        path: sourcePath,
        name: path.basename(sourcePath),
        size: fs.statSync(sourcePath).size,
        destinationDirectory: target.directory,
        folderId: target.identityFolderId,
      }))
    }
    const sessionId = `import_${randomUUID().replaceAll('-', '')}`
    const controller = new AbortController()
    const stagingDirectory = path.join(materialsDir, '.staging', sessionId)
    let finishImport: () => void = () => {}
    const completed = new Promise<void>(resolve => { finishImport = resolve })
    currentImport = { sessionId, controller, completed }
    const totalBytes = sourceFiles.reduce((sum, file) => sum + file.size, 0)
    const registeredFiles: FileEntry[] = []
    let completedBytes = 0
    let failed = 0
    const startedAt = Date.now()
    send(IPC_EVENTS.materialLibrary, {
      type: 'import-started',
      sessionId,
      totalFiles: sourceFiles.length,
      totalBytes,
    })
    try {
      for (const [index, sourceFile] of sourceFiles.entries()) {
        if (controller.signal.aborted) break
        try {
          const imported = identityStore
            ? await identityStore.importMaterialFileWithProgress(
                sourceFile.path,
                sourceFile.destinationDirectory,
                sourceFile.folderId,
                {
                  stagingDirectory,
                  isCanceled: () => controller.signal.aborted,
                  onProgress: (progress) => {
                    const bytesProcessed = completedBytes + (
                      progress.phase === 'copying' ? progress.bytesProcessed : sourceFile.size
                    )
                    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000)
                    send(IPC_EVENTS.materialLibrary, {
                      type: 'import-progress',
                      sessionId,
                      phase: progress.phase,
                      fileIndex: index + 1,
                      totalFiles: sourceFiles.length,
                      fileName: sourceFile.name,
                      fileBytesProcessed: progress.bytesProcessed,
                      fileTotalBytes: sourceFile.size,
                      bytesProcessed,
                      totalBytes,
                      speedBytesPerSecond: bytesProcessed / elapsedSeconds,
                    })
                  },
                },
              )
            : copyFilesIntoDirectory([sourceFile.path], sourceFile.destinationDirectory, {
                allowedExtensions: VIDEO_EXTENSIONS,
              })[0]
          registeredFiles.push(imported)
          completedBytes += sourceFile.size
          send(IPC_EVENTS.materialLibrary, {
            type: 'import-file-completed',
            sessionId,
            fileIndex: index + 1,
            totalFiles: sourceFiles.length,
            fileName: sourceFile.name,
            bytesProcessed: completedBytes,
            totalBytes,
          })
        } catch (error) {
          if (controller.signal.aborted) break
          failed += 1
          send(IPC_EVENTS.materialLibrary, {
            type: 'import-file-failed',
            sessionId,
            fileIndex: index + 1,
            totalFiles: sourceFiles.length,
            fileName: sourceFile.name,
            message: errorMessage(error, '导入失败'),
          })
        }
      }
    } finally {
      try {
        const canceled = controller.signal.aborted
        const resolvedStaging = path.resolve(stagingDirectory)
        const stagingBoundary = path.resolve(materialsDir, '.staging')
        if (isInsideDir(resolvedStaging, stagingBoundary) && !samePath(resolvedStaging, stagingBoundary)) {
          fs.rmSync(resolvedStaging, { recursive: true, force: true })
        }
        send(IPC_EVENTS.materialLibrary, {
          type: canceled ? 'import-canceled' : 'import-completed',
          sessionId,
          imported: registeredFiles.length,
          failed,
          totalFiles: sourceFiles.length,
          bytesProcessed: completedBytes,
          totalBytes,
        })
      } finally {
        currentImport = null
        finishImport()
      }
    }
    if (materialWorkStopped) return registeredFiles
    void analyzeImportedMaterials(registeredFiles).catch((error) => {
      console.error('[VideoAutoCut] analyze imported materials failed', error)
    })
    try {
      onMaterialsImported?.(registeredFiles)
    } catch (error) {
      console.error('[VideoAutoCut] queue imported material cloud backup failed', error)
    }
    return registeredFiles
  }

  function cancelMaterialImport() {
    if (!currentImport) return { ok: false, message: '当前没有正在进行的素材导入' }
    currentImport.controller.abort()
    return { ok: true, sessionId: currentImport.sessionId }
  }

  async function generate(options: GenerateMaterialOptions = {}) {
    if (currentMaterialTask) return { ok: false, message: '已有素材生成任务正在运行' }

    const prompt = String(options.prompt || '').trim()
    if (!prompt) return { ok: false, message: '请输入素材描述' }

    const reuse = await findReusableMaterial(prompt, options.reuseThreshold)
    if (reuse.selected) {
      return {
        ok: true,
        mode: 'reused',
        message: `已从素材库复用「${reuse.selected.name || '已有素材'}」`,
        reuse: reuse.selected,
        threshold: reuse.threshold,
      }
    }

    const root = getVideoAutoRoot()
    if (!isRuntimeUsable(root)) return { ok: false, message: '运行环境未安装，请先下载运行环境' }

    const script = path.join(root, 'tools', 'material_gen', 'generate_material.py')
    if (!fs.existsSync(script)) return { ok: false, message: '没有找到生成素材脚本' }

    const args = [
      script,
      '--prompt',
      prompt,
      '--engine',
      String(options.engine || 'auto'),
    ]

    const pythonPath = getPythonPath()
    const child = spawnStreamingProcess({
      channel: IPC_EVENTS.material,
      command: pythonPath,
      args,
      cwd: root,
      env: createVideoAutoEnv(),
      onClose: () => {
        currentMaterialTask = null
      },
      send,
    })
    currentMaterialTask = child

    return {
      ok: true,
      mode: 'generated',
      pid: child.pid,
      message: reuse.message ? `素材库未命中，已开始生成；${reuse.message}` : '素材库未命中，已开始生成',
      threshold: reuse.threshold,
    }
  }

  return {
    analyzeMaterial,
    analyzeMaterialsForBackup,
    stopMaterialWork,
    autoResolveShotMaterials,
    processDownloadedMaterials,
    resumePendingMaterialWork,
    browseMaterials: directoryBrowser.browseMaterials,
    summarizeMaterialSelection: directoryBrowser.summarizeMaterialSelection,
    cancelMaterialImport,
    createMaterialFolder,
    deleteGenerated,
    deleteMaterial,
    deleteLocalMaterialCopy,
    deleteMaterials,
    deleteMaterialFolder,
    generate,
    getMaterialFolderDetails,
    importMaterials,
    list,
    listGenerated: generatedStore.listGenerated,
    moveMaterialFolder,
    moveMaterials,
    previewMaterialDeletion,
    renameMaterial,
    renameMaterialFolder,
    semanticSearch,
    searchMaterialFolders: directoryBrowser.searchMaterialFolders,
  }
}

export {
  createMaterialsService,
  findOriginalMaterialFile,
  isIndexedMaterialCopy,
  listOriginalMaterialFiles,
}
