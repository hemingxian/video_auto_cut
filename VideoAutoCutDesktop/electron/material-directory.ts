import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { createFileEntry } from './file-entry.js'
import { VIDEO_EXTENSIONS } from './file-extensions.js'
import { parseMaterialBindings } from './material-local-store.js'
import type {
  MaterialFolderIdentity,
  MaterialIdentityStore,
  MaterialSelectionSummary,
  MaterialSelectionSummaryOptions,
} from './material-local-store.js'
import type {
  DeleteMaterialFolderResult,
  MaterialBreadcrumb,
  MaterialDirectoryKind,
  MaterialDirectoryListing,
  MaterialFolderNode,
  MaterialFolderSearchResult,
  PreparedMaterialFolderOperation,
  RenameMaterialFolderResult,
} from './materials-types.js'
import type { FileEntry } from './types.js'

interface MaterialDirectoryOptions {
  materialsDir: string
  runsDir: string
  identityStore?: MaterialIdentityStore
}

interface BrowseOptions {
  folderId?: unknown
}

interface SearchOptions {
  query?: unknown
  limit?: unknown
}

type FolderMode = 'root' | 'user' | 'downloads' | 'batch' | 'directory' | 'cloud' | 'local-download'

interface FolderRecord {
  id: string
  name: string
  kind: MaterialDirectoryKind | null
  mode: FolderMode
  parentId?: string
  directory?: string
  boundary?: string
  identityFolderId?: string
}

interface DirectoryContents {
  folders: FolderRecord[]
  files: FileEntry[]
  videoCount: number
}

interface DirectoryReadSnapshot {
  entries: Map<string, fs.Dirent[] | Error>
  contents: Map<string, DirectoryContents>
  files: Map<string, FileEntry | null>
  folderFiles: Map<string, FileEntry[]>
  directoryVersions: Map<string, string>
  storedCloudFolders?: FolderRecord[]
  cloudFiles?: FileEntry[]
  downloadBatches?: FolderRecord[]
}

const ROOT_NAME = '素材库'
const USER_ROOT_NAME = '本地素材'
const DOWNLOADS_ROOT_NAME = '云端素材'
const RAW_DIRECTORY_NAME = 'raw'
const INDEX_CACHE_DIRECTORY_NAME = '_indexed_h264'
const TASK_WORK_DIRECTORY_NAME = '.videoautocut'
const GENERATED_ROOT_NAME = 'generated'
const IMPORT_STAGING_DIRECTORY_NAME = '.staging'
const DELETION_STAGING_DIRECTORY_NAME = '.deleting'
const CLOUD_CACHE_DIRECTORY_NAME = 'cloud'
const DEFAULT_SEARCH_LIMIT = 100
const MAX_SEARCH_LIMIT = 500
const MAX_SEARCHED_FOLDERS = 10_000
const MAX_DIRECTORY_NAME_LENGTH = 255
const INVALID_DIRECTORY_NAME_CHARACTERS = /[<>:"/\\|?*]/
const WINDOWS_RESERVED_DIRECTORY_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i

function normalizePathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(first: string, second: string): boolean {
  return normalizePathKey(first) === normalizePathKey(second)
}

function isInsideDirectory(target: string, base: string): boolean {
  const relative = path.relative(normalizePathKey(base), normalizePathKey(target))
  return relative === '' || (!!relative
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative))
}

function canonicalPath(target: string): string {
  const resolved = path.resolve(target)
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved
}

function opaqueFolderId(scope: string, value: string): string {
  const digest = createHash('sha256')
    .update(`${scope}\0${normalizePathKey(value)}`)
    .digest('base64url')
    .slice(0, 24)
  return `folder-${digest}`
}

function compareNames(first: { name: string }, second: { name: string }): number {
  return first.name.localeCompare(second.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
}

function safeSearchLimit(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_SEARCH_LIMIT
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(parsed)))
}

function errorDetails(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function desiredDirectoryName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('请输入有效的新文件夹名称')
  if (!value.trim()) throw new Error('文件夹名称不能为空')
  if (value !== value.trim()) throw new Error('文件夹名称不能以空白字符开头或结尾')
  if (value === '.' || value === '..') throw new Error('文件夹名称不能是 "." 或 ".."')

  const containsControlCharacter = Array.from(value)
    .some((character) => character.charCodeAt(0) <= 31)
  if (INVALID_DIRECTORY_NAME_CHARACTERS.test(value) || containsControlCharacter) {
    throw new Error('文件夹名称包含非法字符')
  }
  if (value.endsWith('.') || value.endsWith(' ')) {
    throw new Error('文件夹名称不能以句点或空格结尾')
  }
  if (WINDOWS_RESERVED_DIRECTORY_NAME.test(value)) {
    throw new Error('文件夹名称使用了 Windows 保留名称')
  }
  if (value.length > MAX_DIRECTORY_NAME_LENGTH) {
    throw new Error(`文件夹名称不能超过 ${MAX_DIRECTORY_NAME_LENGTH} 个字符`)
  }
  return value
}

function samePhysicalDirectory(first: string, second: string): boolean {
  try {
    const firstStat = fs.statSync(first, { bigint: true })
    const secondStat = fs.statSync(second, { bigint: true })
    if (firstStat.dev === secondStat.dev && firstStat.ino !== 0n && firstStat.ino === secondStat.ino) {
      return true
    }
    return samePath(fs.realpathSync(first), fs.realpathSync(second))
  } catch {
    return false
  }
}

function temporaryRenameDirectory(parentDirectory: string): string {
  const prefix = `.videoautocut-folder-rename-${process.pid}-${Date.now()}`
  let suffix = 0
  let candidate = path.join(parentDirectory, prefix)
  while (fs.existsSync(candidate)) {
    suffix += 1
    candidate = path.join(parentDirectory, `${prefix}-${suffix}`)
  }
  return candidate
}

function renameDirectoryWithCaseSupport(
  sourceDirectory: string,
  destinationDirectory: string,
  caseOnly: boolean,
): void {
  if (!caseOnly) {
    fs.renameSync(sourceDirectory, destinationDirectory)
    return
  }

  const temporaryDirectory = temporaryRenameDirectory(path.dirname(sourceDirectory))
  fs.renameSync(sourceDirectory, temporaryDirectory)
  try {
    fs.renameSync(temporaryDirectory, destinationDirectory)
  } catch (error) {
    try {
      fs.renameSync(temporaryDirectory, sourceDirectory)
    } catch {
      // Preserve the original rename error. Rollback is a best-effort safeguard.
    }
    throw error
  }
}

function createMaterialDirectoryBrowser({
  materialsDir,
  runsDir,
  identityStore,
}: MaterialDirectoryOptions) {
  const materialsBoundary = canonicalPath(materialsDir)
  const runsBoundary = canonicalPath(runsDir)
  const generatedRootDirectory = path.join(materialsBoundary, GENERATED_ROOT_NAME)
  const foldersById = new Map<string, FolderRecord>()
  let readSnapshot: DirectoryReadSnapshot | undefined
  let rootDetailsCache: {
    revision: string
    directoryVersions: Map<string, string>
    root: MaterialFolderNode
    rootFolders: MaterialFolderNode[]
  } | undefined
  const root: FolderRecord = {
    id: identityStore?.getOrCreateFolder({
      scope: 'virtual',
      storageKey: 'materials-root',
      name: ROOT_NAME,
    }) || opaqueFolderId('virtual', `${materialsBoundary}\0${runsBoundary}\0materials-root`),
    name: ROOT_NAME,
    kind: null,
    mode: 'root',
  }
  const userRoot: FolderRecord = {
    id: identityStore?.getOrCreateFolder({
      scope: 'user',
      storageKey: '.',
      name: USER_ROOT_NAME,
      parentFolderId: root.id,
    }) || opaqueFolderId('virtual', `${materialsBoundary}\0user-materials`),
    name: USER_ROOT_NAME,
    kind: 'user',
    mode: 'user',
    parentId: root.id,
    directory: materialsBoundary,
    boundary: materialsBoundary,
  }
  const downloadsRoot: FolderRecord = {
    id: identityStore?.getOrCreateFolder({
      scope: 'virtual',
      storageKey: 'downloads-root',
      name: DOWNLOADS_ROOT_NAME,
      parentFolderId: root.id,
    }) || opaqueFolderId('virtual', `${runsBoundary}\0download-materials`),
    name: DOWNLOADS_ROOT_NAME,
    kind: 'cloud',
    mode: 'downloads',
    parentId: root.id,
  }
  for (const folder of [root, userRoot, downloadsRoot]) foldersById.set(folder.id, folder)

  function directoryVersion(directory: string): string {
    try {
      const stat = fs.statSync(directory, { bigint: true })
      return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`
    } catch {
      return 'missing'
    }
  }

  function readDirectoryEntries(directory: string): fs.Dirent[] {
    const key = normalizePathKey(directory)
    const cached = readSnapshot?.entries.get(key)
    if (cached instanceof Error) throw cached
    if (cached) return cached
    readSnapshot?.directoryVersions.set(key, directoryVersion(directory))
    try {
      const entries = fs.readdirSync(directory, { withFileTypes: true })
      readSnapshot?.entries.set(key, entries)
      return entries
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      readSnapshot?.entries.set(key, failure)
      throw failure
    }
  }

  function withDirectoryReadSnapshot<T>(read: () => T): T {
    if (readSnapshot) return read()
    readSnapshot = {
      entries: new Map(), contents: new Map(), files: new Map(), folderFiles: new Map(), directoryVersions: new Map(),
    }
    try {
      return identityStore?.withMaterialReadSnapshot ? identityStore.withMaterialReadSnapshot(read) : read()
    } finally {
      readSnapshot = undefined
    }
  }

  function knownFolderFiles(folderId: string): FileEntry[] {
    const cached = readSnapshot?.folderFiles.get(folderId)
    if (cached) return cached
    const files = identityStore?.listFolderFiles(folderId) || []
    readSnapshot?.folderFiles.set(folderId, files)
    return files
  }

  function knownCloudFiles(): FileEntry[] {
    if (readSnapshot?.cloudFiles) return readSnapshot.cloudFiles
    const files = identityStore?.listCloudFiles() || []
    if (readSnapshot) readSnapshot.cloudFiles = files
    return files
  }

  function isUserFolderOperable(folder: FolderRecord): boolean {
    if (
      folder.mode !== 'directory'
      || folder.kind !== 'user'
      || !folder.directory
      || !folder.boundary
      || !samePath(folder.boundary, materialsBoundary)
    ) {
      return false
    }

    return isInsideDirectory(folder.directory, materialsBoundary)
      && !samePath(folder.directory, materialsBoundary)
      && !samePath(folder.directory, generatedRootDirectory)
  }

  function isLocalDownloadFolderOperable(folder: FolderRecord): boolean {
    return folder.mode === 'local-download'
      && Boolean(folder.directory && folder.boundary)
      && isInsideDirectory(folder.directory || '', runsBoundary)
      && !samePath(folder.directory || '', runsBoundary)
  }

  function isLocalFolderOperable(folder: FolderRecord): boolean {
    return isUserFolderOperable(folder) || isLocalDownloadFolderOperable(folder)
  }

  function folderIdentityId(folder: FolderRecord): string {
    return folder.identityFolderId || folder.id
  }

  function folderStorageScope(folder: FolderRecord): 'virtual' | 'user' | 'downloads' {
    if (folder.mode === 'root') return 'virtual'
    if (folder.mode === 'user' || isUserFolderOperable(folder)) return 'user'
    return 'downloads'
  }

  function physicalScopeBoundary(directory: string): string {
    return isInsideDirectory(directory, materialsBoundary) ? materialsBoundary : runsBoundary
  }

  function isCloudFolderOperable(folder: FolderRecord): boolean {
    return folder.kind === 'cloud'
      && folder.mode !== 'downloads'
      && folder.mode !== 'root'
      && Boolean(identityStore)
  }

  function isFolderOperable(folder: FolderRecord): boolean {
    return isLocalFolderOperable(folder) || isCloudFolderOperable(folder)
  }

  function getMaterialFolderIdentityId(folderId: unknown): string {
    return folderIdentityId(folderForId(folderId))
  }

  function folderForId(folderId: unknown): FolderRecord {
    const id = typeof folderId === 'string' ? folderId.trim() : ''
    const folder = id ? foldersById.get(id) : undefined
    if (!folder) throw new Error('无效的素材文件夹')
    return folder
  }

  function invalidatePhysicalFoldersAtOrBelow(directory: string): void {
    for (const [id, folder] of foldersById) {
      if (folder.directory && isInsideDirectory(folder.directory, directory)) {
        foldersById.delete(id)
      }
    }
  }

  function registerPhysicalFolder({
    directory,
    boundary,
    name,
    kind,
    mode,
    parentId,
  }: Omit<FolderRecord, 'id'> & { directory: string; boundary: string }): FolderRecord {
    const scope = isInsideDirectory(directory, materialsBoundary) ? 'user' : 'downloads'
    const scopeBoundary = scope === 'user' ? materialsBoundary : runsBoundary
    const storageKey = path.relative(scopeBoundary, directory)
    const id = identityStore?.getOrCreateFolder({
      scope,
      storageKey,
      name,
      parentFolderId: parentId,
    }) || opaqueFolderId('physical-material', directory)
    const stored = identityStore?.getFolder?.(id)
    const folder: FolderRecord = {
      id,
      directory,
      boundary,
      name: stored?.name || name,
      kind: scope === 'downloads' ? 'cloud' : kind,
      mode,
      parentId: stored?.parentFolderId || parentId,
    }
    foldersById.set(id, folder)
    return folder
  }

  function registerLocalDownloadFolder(
    physicalFolder: FolderRecord,
    parentId: string,
  ): FolderRecord {
    if (!physicalFolder.directory || !physicalFolder.boundary) {
      throw new Error('无效的本地下载素材文件夹')
    }
    const id = opaqueFolderId('local-download-view', physicalFolder.id)
    const folder: FolderRecord = {
      id,
      name: physicalFolder.name,
      kind: 'user',
      mode: 'local-download',
      parentId,
      directory: physicalFolder.directory,
      boundary: physicalFolder.boundary,
      identityFolderId: physicalFolder.identityFolderId || physicalFolder.id,
    }
    foldersById.set(id, folder)
    return folder
  }

  function cloudFolderRecord(identity: MaterialFolderIdentity): FolderRecord {
    const existing = foldersById.get(identity.folderId)
    if (existing) {
      existing.name = identity.name
      existing.kind = 'cloud'
      existing.parentId = identity.parentFolderId || downloadsRoot.id
      return existing
    }

    const candidate = path.resolve(runsBoundary, identity.storageKey === '.' ? '' : identity.storageKey)
    let directory: string | undefined
    try {
      const stat = fs.lstatSync(candidate)
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const realCandidate = fs.realpathSync(candidate)
        if (isInsideDirectory(realCandidate, runsBoundary)) directory = realCandidate
      }
    } catch {
      // Logical cloud folders intentionally have no physical directory.
    }
    const folder: FolderRecord = {
      id: identity.folderId,
      name: identity.name,
      kind: 'cloud',
      mode: directory ? 'directory' : 'cloud',
      parentId: identity.parentFolderId || downloadsRoot.id,
      ...(directory ? { directory, boundary: runsBoundary } : {}),
    }
    foldersById.set(folder.id, folder)
    return folder
  }

  function refreshStoredCloudFolders(): FolderRecord[] {
    if (readSnapshot?.storedCloudFolders) return readSnapshot.storedCloudFolders
    if (!identityStore?.listFolders) return []
    const identities = identityStore.listFolders('downloads')
    const folders = identities.map(cloudFolderRecord)
    const validIds = new Set(folders.map((folder) => folder.id))
    for (const folder of folders) {
      if (folder.parentId === downloadsRoot.id) continue
      if (!folder.parentId || !validIds.has(folder.parentId)) folder.parentId = downloadsRoot.id
    }
    if (readSnapshot) readSnapshot.storedCloudFolders = folders
    return folders
  }

  function isDeletedCloudDirectory(directory: string): boolean {
    return Boolean(identityStore?.isFolderStorageDeleted?.(
      'downloads',
      path.relative(runsBoundary, directory),
    ))
  }

  function resolveTrustedDirectory(directory: string, boundary: string): string {
    try {
      const boundaryStat = fs.lstatSync(boundary)
      const directoryStat = fs.lstatSync(directory)
      if (
        !boundaryStat.isDirectory()
        || boundaryStat.isSymbolicLink()
        || !directoryStat.isDirectory()
        || directoryStat.isSymbolicLink()
      ) {
        throw new Error('invalid directory')
      }

      const realBoundary = fs.realpathSync(boundary)
      const realDirectory = fs.realpathSync(directory)
      if (!samePath(realBoundary, boundary) || !isInsideDirectory(realDirectory, realBoundary)) {
        throw new Error('directory escaped boundary')
      }
      return realDirectory
    } catch {
      throw new Error('素材文件夹不存在或不可访问')
    }
  }

  function resolveSafeDirectory(folder: FolderRecord): string {
    if (!folder.directory || !folder.boundary) throw new Error('无效的素材文件夹')
    if (isInsideDirectory(folder.directory, path.join(materialsBoundary, CLOUD_CACHE_DIRECTORY_NAME))) {
      throw new Error('云端下载缓存不能作为本地素材文件夹遍历，请从当前账号的云端素材选择')
    }
    return resolveTrustedDirectory(folder.directory, folder.boundary)
  }

  function isHiddenDirectory(parentDirectory: string, name: string): boolean {
    const normalizedName = name.toLowerCase()
    if (normalizedName === INDEX_CACHE_DIRECTORY_NAME) return true
    if (normalizedName === TASK_WORK_DIRECTORY_NAME) return true
    if (normalizedName === DELETION_STAGING_DIRECTORY_NAME) return true
    if (normalizedName === IMPORT_STAGING_DIRECTORY_NAME && samePath(parentDirectory, materialsBoundary)) return true
    // Cloud downloads are a byte cache shared by the device, not an inventory of
    // materials owned by the currently signed-in account. Its owned records are
    // included separately through listCloudFiles/listFolderFiles.
    if (normalizedName === CLOUD_CACHE_DIRECTORY_NAME && samePath(parentDirectory, materialsBoundary)) return true
    if (normalizedName === GENERATED_ROOT_NAME && samePath(parentDirectory, materialsBoundary)) {
      return true
    }

    return normalizedName === 'records'
      && samePath(parentDirectory, generatedRootDirectory)
  }

  function isReservedDirectoryName(parentDirectory: string, name: string): boolean {
    const normalizedName = name.toLowerCase()
    return normalizedName === INDEX_CACHE_DIRECTORY_NAME
      || normalizedName === DELETION_STAGING_DIRECTORY_NAME
      || (normalizedName === IMPORT_STAGING_DIRECTORY_NAME && samePath(parentDirectory, materialsBoundary))
      || (normalizedName === CLOUD_CACHE_DIRECTORY_NAME && samePath(parentDirectory, materialsBoundary))
      || (
        normalizedName === GENERATED_ROOT_NAME
        && samePath(parentDirectory, materialsBoundary)
      )
  }

  function safeChildDirectory(
    parent: FolderRecord,
    parentDirectory: string,
    name: string,
  ): string | null {
    if (!parent.boundary || isHiddenDirectory(parentDirectory, name)) return null

    const candidate = path.join(parentDirectory, name)
    try {
      const stat = fs.lstatSync(candidate)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null

      const realBoundary = resolveTrustedDirectory(parent.boundary, parent.boundary)
      const realCandidate = fs.realpathSync(candidate)
      if (!isInsideDirectory(realCandidate, realBoundary)) return null
      return realCandidate
    } catch {
      return null
    }
  }

  function safeVideoFile(
    parent: FolderRecord,
    parentDirectory: string,
    name: string,
  ): FileEntry | null {
    if (!parent.boundary || !VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase())) return null

    const candidate = path.join(parentDirectory, name)
    const fileKey = `${folderIdentityId(parent)}:${normalizePathKey(candidate)}`
    if (readSnapshot?.files.has(fileKey)) return readSnapshot.files.get(fileKey) || null
    try {
      const stat = fs.lstatSync(candidate)
      if (!stat.isFile() || stat.isSymbolicLink()) return null

      const realBoundary = resolveTrustedDirectory(parent.boundary, parent.boundary)
      const realCandidate = fs.realpathSync(candidate)
      if (!isInsideDirectory(realCandidate, realBoundary)) return null
      const file = createFileEntry(realCandidate)
      if (!identityStore) {
        readSnapshot?.files.set(fileKey, file)
        return file
      }
      const isDownloaded = parent.mode === 'local-download'
        || parent.kind === 'raw'
        || parent.kind === 'cloud'
      const described = identityStore.describeFile(
        file,
        folderIdentityId(parent),
        isDownloaded ? 'platform_download' : 'user_upload',
        isDownloaded ? 'task_download' : 'user_import',
      )
      readSnapshot?.files.set(fileKey, described)
      return described
    } catch {
      return null
    }
  }

  function readDirectoryContents(
    folder: FolderRecord,
    tolerateErrors = false,
    includeFiles = true,
    countVideos = includeFiles,
  ): DirectoryContents {
    let directory: string
    let entries: fs.Dirent[]
    try {
      directory = resolveSafeDirectory(folder)
      entries = readDirectoryEntries(directory)
    } catch (error) {
      if (tolerateErrors) return { folders: [], files: [], videoCount: 0 }
      throw error
    }

    const folders: FolderRecord[] = []
    const files: FileEntry[] = []
    let videoCount = 0

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        const childDirectory = safeChildDirectory(folder, directory, entry.name)
        if (!childDirectory || !folder.boundary) continue
        if (folder.kind === 'cloud' && isDeletedCloudDirectory(childDirectory)) continue
        const physicalFolder = registerPhysicalFolder({
          directory: childDirectory,
          boundary: folder.boundary,
          name: entry.name,
          kind: folder.kind,
          mode: 'directory',
          parentId: folder.identityFolderId || folder.id,
        })
        folders.push(folder.mode === 'local-download'
          ? registerLocalDownloadFolder(physicalFolder, folder.id)
          : physicalFolder)
        continue
      }

      if (!entry.isFile() || (!includeFiles && !countVideos)) continue
      if (!VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue
      if (includeFiles) {
        const file = safeVideoFile(folder, directory, entry.name)
        if (!file) continue
        files.push(file)
      }
      videoCount += 1
    }

    if (identityStore) {
      const knownFiles = knownFolderFiles(folder.identityFolderId || folder.id)
      videoCount = Math.max(videoCount, knownFiles.length)
      if (includeFiles) {
        const knownKeys = new Set(files.map((file) => file.materialId || normalizePathKey(file.path)))
        for (const file of knownFiles) {
          const key = file.materialId || normalizePathKey(file.path)
          if (knownKeys.has(key)) continue
          knownKeys.add(key)
          files.push(file)
        }
      }
    }

    folders.sort(compareNames)
    files.sort((first, second) => second.mtime - first.mtime || compareNames(first, second))
    return { folders, files, videoCount }
  }

  function safeRawDirectory(runDirectory: string): string | null {
    const candidate = path.join(runDirectory, RAW_DIRECTORY_NAME)
    try {
      const stat = fs.lstatSync(candidate)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null

      const realRawDirectory = fs.realpathSync(candidate)
      if (
        !isInsideDirectory(realRawDirectory, runDirectory)
        || !isInsideDirectory(realRawDirectory, runsBoundary)
      ) {
        return null
      }
      return realRawDirectory
    } catch {
      return null
    }
  }

  function containsOriginalVideo(directory: string): boolean {
    const pending = [directory]
    const visited = new Set<string>()

    while (pending.length > 0) {
      const current = pending.pop()
      if (!current) continue
      const currentKey = normalizePathKey(current)
      if (visited.has(currentKey)) continue
      visited.add(currentKey)

      let entries: fs.Dirent[]
      try {
        entries = readDirectoryEntries(current)
      } catch {
        continue
      }

      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const candidate = path.join(current, entry.name)

        if (entry.isDirectory()) {
          const normalizedName = entry.name.toLowerCase()
          if (
            normalizedName === INDEX_CACHE_DIRECTORY_NAME
            || normalizedName === TASK_WORK_DIRECTORY_NAME
          ) continue
          try {
            const realCandidate = fs.realpathSync(candidate)
            if (isInsideDirectory(realCandidate, directory)) pending.push(realCandidate)
          } catch {
            // Ignore inaccessible or unsafe descendants.
          }
          continue
        }

        if (
          entry.isFile()
          && VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())
        ) {
          return true
        }
      }
    }

    return false
  }

  function readDownloadBatches(tolerateErrors = false): FolderRecord[] {
    if (readSnapshot?.downloadBatches) return readSnapshot.downloadBatches
    let entries: fs.Dirent[]
    try {
      resolveTrustedDirectory(runsBoundary, runsBoundary)
      entries = readDirectoryEntries(runsBoundary)
    } catch (error) {
      if (tolerateErrors) return []
      throw error
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (entry.name.toLocaleLowerCase() === DELETION_STAGING_DIRECTORY_NAME) continue
      const runCandidate = path.join(runsBoundary, entry.name)
      let runDirectory: string
      try {
        const stat = fs.lstatSync(runCandidate)
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue
        runDirectory = fs.realpathSync(runCandidate)
        if (!isInsideDirectory(runDirectory, runsBoundary)) continue
      } catch {
        continue
      }

      const rawDirectory = safeRawDirectory(runDirectory)
      if (/^\d{8}$/.test(entry.name) && containsOriginalVideo(runDirectory)) {
        if (isDeletedCloudDirectory(runDirectory)) continue
        registerPhysicalFolder({
          directory: runDirectory,
          boundary: runDirectory,
          name: entry.name,
          kind: 'cloud',
          mode: 'batch',
          parentId: downloadsRoot.id,
        })
        continue
      }
      if (
        !rawDirectory
        || !containsOriginalVideo(rawDirectory)
        || isDeletedCloudDirectory(rawDirectory)
      ) continue
      registerPhysicalFolder({
        directory: rawDirectory,
        boundary: rawDirectory,
        name: entry.name,
        kind: 'cloud',
        mode: 'batch',
        parentId: downloadsRoot.id,
      })
    }

    refreshStoredCloudFolders()
    const batches = [...foldersById.values()]
      .filter((folder) => folder.kind === 'cloud' && folder.parentId === downloadsRoot.id)
      .sort((first, second) => compareNames(second, first))
    if (readSnapshot) readSnapshot.downloadBatches = batches
    return batches
  }

  function readLocalDownloadBatches(tolerateErrors = false): FolderRecord[] {
    return readDownloadBatches(tolerateErrors)
      .filter((folder) => Boolean(folder.directory && folder.boundary))
      .map((folder) => registerLocalDownloadFolder(folder, userRoot.id))
  }

  function readCloudFolderContents(
    folder: FolderRecord,
    tolerateErrors = false,
    includeFiles = true,
    countVideos = includeFiles,
  ): DirectoryContents {
    if (folder.mode === 'downloads') readDownloadBatches(tolerateErrors)
    let physical: DirectoryContents = { folders: [], files: [], videoCount: 0 }
    if (folder.directory) {
      physical = readDirectoryContents(folder, tolerateErrors, includeFiles, countVideos)
    }
    refreshStoredCloudFolders()
    const childFolders = [...foldersById.values()]
      .filter((candidate) => candidate.kind === 'cloud' && candidate.parentId === folder.id)
      .sort(compareNames)
    const files = [...physical.files]
    if (identityStore && includeFiles) {
      const knownKeys = new Set(files.map((file) => file.materialId || normalizePathKey(file.path)))
      const knownFiles = folder.mode === 'downloads'
        ? knownCloudFiles()
        : knownFolderFiles(folder.id)
      for (const file of knownFiles) {
        const key = file.materialId || normalizePathKey(file.path)
        if (knownKeys.has(key)) continue
        knownKeys.add(key)
        files.push(file)
      }
      files.sort((first, second) => second.mtime - first.mtime || compareNames(first, second))
    }
    return {
      folders: childFolders,
      files,
      videoCount: includeFiles ? files.length : Math.max(
        physical.videoCount,
        (folder.mode === 'downloads'
          ? knownCloudFiles().length
          : knownFolderFiles(folder.id).length) || 0,
      ),
    }
  }

  function readSingleFolderContents(
    folder: FolderRecord,
    tolerateErrors = false,
    includeFiles = true,
    countVideos = includeFiles,
  ): DirectoryContents {
    const key = `${folder.id}:${includeFiles}:${countVideos}:${tolerateErrors}`
    const cached = readSnapshot?.contents.get(key)
    if (cached) return cached
    const result = readSingleFolderContentsUncached(folder, tolerateErrors, includeFiles, countVideos)
    readSnapshot?.contents.set(key, result)
    // A strict success is safe for either caller. Tolerant partial results
    // remain scoped to tolerant callers so missing folders still fail strictly.
    if (!tolerateErrors) readSnapshot?.contents.set(`${folder.id}:${includeFiles}:${countVideos}:true`, result)
    return result
  }

  function readSingleFolderContentsUncached(
    folder: FolderRecord,
    tolerateErrors: boolean,
    includeFiles: boolean,
    countVideos: boolean,
  ): DirectoryContents {
    if (folder.mode === 'downloads' || folder.kind === 'cloud') {
      return readCloudFolderContents(folder, tolerateErrors, includeFiles, countVideos)
    }
    return readDirectoryContents(folder, tolerateErrors, includeFiles, countVideos)
  }

  function readDescendantContents(
    folder: FolderRecord,
    tolerateErrors = false,
    includeFiles = true,
    countVideos = includeFiles,
  ): DirectoryContents {
    const collectFiles = includeFiles || countVideos
    const direct = readSingleFolderContents(folder, tolerateErrors, collectFiles, countVideos)
    const pending = [...direct.folders]
    const visited = new Set<string>([folder.id])
    const files = [...direct.files]

    while (pending.length > 0 && visited.size <= MAX_SEARCHED_FOLDERS) {
      const current = pending.pop()
      if (!current || visited.has(current.id)) continue
      visited.add(current.id)
      const contents = readSingleFolderContents(current, tolerateErrors, collectFiles, countVideos)
      pending.push(...contents.folders)
      files.push(...contents.files)
    }

    const sortedFiles = uniqueMaterialFiles(files)
    return {
      folders: direct.folders,
      files: includeFiles ? sortedFiles : [],
      videoCount: sortedFiles.length,
    }
  }

  function materialFileKey(file: FileEntry): string {
    if (file.assetId) return `asset:${file.assetId}:${file.assetVersion || 1}`
    if (file.sourceSha256) return `source:${file.sourceSha256.toLocaleLowerCase()}:${file.size}`
    if (file.materialId) return `material:${file.materialId}`
    return `path:${normalizePathKey(file.path)}`
  }

  function uniqueMaterialFiles(files: FileEntry[]): FileEntry[] {
    const uniqueFiles = new Map<string, FileEntry>()
    for (const file of files) {
      const key = materialFileKey(file)
      const existing = uniqueFiles.get(key)
      if (!existing || (existing.localStatus !== 'present' && file.localStatus === 'present')) {
        uniqueFiles.set(key, file)
      }
    }
    return [...uniqueFiles.values()]
      .sort((first, second) => second.mtime - first.mtime || compareNames(first, second))
  }

  function readLocalRootContents(
    tolerateErrors = false,
    includeFiles = true,
    countVideos = includeFiles,
  ): DirectoryContents {
    const collectFiles = includeFiles || countVideos
    const userContents = readDescendantContents(userRoot, tolerateErrors, collectFiles, countVideos)
    const downloadedContents = readDescendantContents(downloadsRoot, tolerateErrors, collectFiles, countVideos)
    const isLocallyAvailable = (file: FileEntry): boolean => {
      // Owned cloud cache files enter the local collection without traversing
      // the device-wide cache. Track their parents too so byte removal or
      // restoration cannot leave the cached root count stale.
      const directory = normalizePathKey(path.dirname(file.path))
      if (readSnapshot && !readSnapshot.directoryVersions.has(directory)) {
        readSnapshot.directoryVersions.set(directory, directoryVersion(directory))
      }
      return fs.existsSync(file.path)
    }
    const locallyAvailableDownloads = downloadedContents.files.filter(isLocallyAvailable)
    const locallyAvailableUserFiles = userContents.files.filter(isLocallyAvailable)
    const files = uniqueMaterialFiles([...locallyAvailableUserFiles, ...locallyAvailableDownloads])
    return {
      folders: [...userContents.folders, ...readLocalDownloadBatches(tolerateErrors)]
        .sort(compareNames),
      files: includeFiles ? files : [],
      videoCount: countVideos ? files.length : 0,
    }
  }

  function readContents(
    folder: FolderRecord,
    tolerateErrors = false,
    includeFiles = true,
    countVideos = includeFiles,
  ): DirectoryContents {
    if (folder.mode === 'root') {
      const collectFiles = includeFiles || countVideos
      const userContents = readLocalRootContents(tolerateErrors, collectFiles, countVideos)
      const downloadContents = readCloudCollection(downloadsRoot, tolerateErrors)
      const aggregateFiles = uniqueMaterialFiles([...userContents.files, ...downloadContents.files])
      return {
        folders: [userRoot, downloadsRoot],
        files: includeFiles ? aggregateFiles : [],
        videoCount: countVideos ? aggregateFiles.length : 0,
      }
    }
    if (folder.mode === 'user') {
      return readLocalRootContents(tolerateErrors, includeFiles, countVideos)
    }
    if (folder.mode === 'downloads') {
      const contents = readCloudCollection(folder, tolerateErrors)
      return { ...contents, files: includeFiles ? contents.files : [] }
    }
    if (folder.kind === 'cloud' && identityStore) {
      const contents = readSingleFolderContents(folder, tolerateErrors, true, true)
      const files = uniqueMaterialFiles(contents.files.filter((file) => file.cloudStatus === 'ready'))
      return { ...contents, files: includeFiles ? files : [], videoCount: files.length }
    }
    return readSingleFolderContents(folder, tolerateErrors, includeFiles, countVideos)
  }

  function readCloudCollection(folder: FolderRecord, tolerateErrors = false): DirectoryContents {
    const contents = readDescendantContents(folder, tolerateErrors, true, true)
    const files = uniqueMaterialFiles(contents.files.filter((file) => !identityStore || file.cloudStatus === 'ready'))
    return { ...contents, files, videoCount: files.length }
  }

  function toFolderNode(folder: FolderRecord, contents?: DirectoryContents): MaterialFolderNode {
    const canOperate = isFolderOperable(folder)
    const canImport = folder.mode === 'user' || isLocalFolderOperable(folder)
    const node: MaterialFolderNode = {
      id: folder.id,
      ...(folder.identityFolderId && folder.identityFolderId !== folder.id
        ? { bindingFolderId: folder.identityFolderId } : {}),
      name: folder.name,
      kind: folder.kind,
      storageScope: folderStorageScope(folder),
      canCreate: folder.mode === 'user'
        || ((folder.mode === 'downloads' || folder.kind === 'cloud') && Boolean(identityStore))
        || isLocalFolderOperable(folder),
      canImport,
      canRename: canOperate,
      canDelete: canOperate,
    }
    if (contents) {
      node.folderCount = contents.folders.length
      node.videoCount = contents.videoCount
    }
    return node
  }

  function folderNodeWithDetails(folder: FolderRecord, tolerateErrors = false): MaterialFolderNode {
    if (folder.kind === 'cloud') return toFolderNode(folder, readCloudCollection(folder, tolerateErrors))
    const contents = folder.mode === 'root' || folder.mode === 'user' || folder.mode === 'downloads'
      ? readContents(folder, tolerateErrors, false, true)
      : readDescendantContents(folder, tolerateErrors, false, true)
    return toFolderNode(folder, contents)
  }

  function breadcrumbsFor(folder: FolderRecord): MaterialBreadcrumb[] {
    const breadcrumbs: MaterialBreadcrumb[] = []
    const visited = new Set<string>()
    let current: FolderRecord | undefined = folder

    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      breadcrumbs.push({ id: current.id, name: current.name })
      current = current.parentId ? foldersById.get(current.parentId) : undefined
    }

    return breadcrumbs.reverse()
  }

  function browseMaterials(options: BrowseOptions = {}): MaterialDirectoryListing {
    return withDirectoryReadSnapshot(() => browseMaterialsUncached(options))
  }

  function rootFolderDetails(): { root: MaterialFolderNode; rootFolders: MaterialFolderNode[] } {
    const revision = identityStore?.getMaterialReadRevision?.()
    if (revision && rootDetailsCache?.revision === revision
      && [...rootDetailsCache.directoryVersions].every(([directory, version]) => directoryVersion(directory) === version)) {
      return { root: { ...rootDetailsCache.root }, rootFolders: rootDetailsCache.rootFolders.map(folder => ({ ...folder })) }
    }
    const details = {
      root: folderNodeWithDetails(root, true),
      rootFolders: [userRoot, downloadsRoot].map(folder => folderNodeWithDetails(folder, true)),
    }
    if (revision && readSnapshot) {
      rootDetailsCache = {
        revision: identityStore!.getMaterialReadRevision!(),
        directoryVersions: new Map(readSnapshot.directoryVersions),
        root: { ...details.root },
        rootFolders: details.rootFolders.map(folder => ({ ...folder })),
      }
    }
    return details
  }

  function browseMaterialsUncached(options: BrowseOptions): MaterialDirectoryListing {
    const folderId = String(options.folderId || '').trim()
    const current = folderId ? foldersById.get(folderId) : root
    if (!current) throw new Error('无效的素材文件夹')

    const contents = readContents(current)
    const folders = contents.folders.map((folder) => folderNodeWithDetails(folder, true))
    const currentContents = current.kind === 'cloud' ? readCloudCollection(current, true) : current.mode === 'root' || current.mode === 'user' || current.mode === 'downloads'
      ? contents
      : {
          ...contents,
          videoCount: contents.videoCount + folders.reduce(
            (total, folder) => total + (folder.videoCount || 0),
            0,
          ),
        }
    const rootDetails = rootFolderDetails()
    return {
      root: rootDetails.root,
      current: toFolderNode(current, currentContents),
      breadcrumbs: breadcrumbsFor(current),
      rootFolders: rootDetails.rootFolders,
      folders,
      files: contents.files,
    }
  }

  function getMaterialFolderDetails(folderId: unknown): MaterialFolderNode {
    return withDirectoryReadSnapshot(() => folderNodeWithDetails(folderForId(folderId)))
  }

  function selectionFolder(folderId: string): FolderRecord {
    const known = foldersById.get(folderId)
    if (known?.identityFolderId && known.identityFolderId !== folderId) return selectionFolder(known.identityFolderId)
    if (known) return known
    const identity = identityStore?.getFolder(folderId)
    if (!identity) throw new Error(`素材文件夹不存在：${folderId}`)
    if (identity.scope === 'downloads') return cloudFolderRecord(identity)
    if (identity.scope !== 'user') throw new Error(`无效的素材集合：${folderId}`)
    const folder: FolderRecord = {
      id: identity.folderId,
      name: identity.name,
      kind: 'user',
      mode: identity.storageKey === '.' ? 'user' : 'directory',
      directory: path.resolve(materialsBoundary, identity.storageKey),
      boundary: materialsBoundary,
      parentId: identity.parentFolderId,
    }
    // The strict directory reader checks the real path before registering any files.
    foldersById.set(folder.id, folder)
    return folder
  }

  function summarizeMaterialSelection(options: MaterialSelectionSummaryOptions = {}): MaterialSelectionSummary {
    return withDirectoryReadSnapshot(() => summarizeMaterialSelectionUncached(options))
  }

  function summarizeMaterialSelectionUncached(options: MaterialSelectionSummaryOptions): MaterialSelectionSummary {
    if (!identityStore) throw new Error('素材登记服务不可用，无法统计所选范围')
    const bindings = parseMaterialBindings(options.bindings)
    const mappedBindings = bindings.map((binding) => binding.binding_type === 'folder'
      ? { ...binding, folder_id: selectionFolder(binding.folder_id).id }
      : binding)
    const pending = mappedBindings.flatMap((binding) => {
      if (binding.binding_type !== 'folder') return []
      const folder = selectionFolder(binding.folder_id)
      // Generation treats the local collection root as an aggregate even for old bindings.
      const includeSubfolders = binding.include_subfolders || folder.mode === 'user'
      return [{ folder, includeSubfolders }]
    })
    const scanned = new Map<string, DirectoryContents>()
    const expanded = new Set<string>()
    {
      while (pending.length) {
        const item = pending.pop()!
        const folder = selectionFolder(item.folder.id)
        let contents = scanned.get(folder.id)
        if (!contents) {
          if (scanned.size >= MAX_SEARCHED_FOLDERS) {
            throw new Error(`所选范围超过 ${MAX_SEARCHED_FOLDERS} 个文件夹，请缩小范围后重新统计`)
          }
          contents = readSingleFolderContents(folder, false, true, true)
          scanned.set(folder.id, contents)
        }
        if (item.includeSubfolders && !expanded.has(folder.id)) {
          expanded.add(folder.id)
          pending.push(...contents.folders.map((child) => ({ folder: child, includeSubfolders: true })))
        }
      }
      const summary = identityStore.summarizeMaterialSelection(mappedBindings)
      const byKey = new Map(summary.entries.map((entry) => [entry.key, entry.candidateKeys]))
      // View aliases remain stable for the renderer while expansion uses stored identities.
      const entries = bindings.map((binding, index) => {
        const mapped = mappedBindings[index]!
        const key = binding.binding_type === 'material'
          ? `material:${binding.material_id}` : `folder:${binding.folder_id}`
        const mappedKey = mapped.binding_type === 'material'
          ? `material:${mapped.material_id}` : `folder:${mapped.folder_id}`
        return { key, candidateKeys: byKey.get(mappedKey) || [] }
      })
      return { candidateCount: summary.candidateCount, entries }
    }
  }

  function getMaterialImportTarget(folderId?: unknown): {
    folderId: string
    identityFolderId: string
    directory: string
  } {
    const requestedId = typeof folderId === 'string' ? folderId.trim() : ''
    const folder = requestedId ? folderForId(requestedId) : userRoot
    if (folder.mode !== 'user' && !isLocalFolderOperable(folder)) {
      throw new Error('该素材文件夹不可导入素材')
    }
    return {
      folderId: folder.id,
      identityFolderId: folderIdentityId(folder),
      directory: resolveSafeDirectory(folder),
    }
  }

  function getMaterialImportDirectory(folderId?: unknown): string {
    return getMaterialImportTarget(folderId).directory
  }

  function resolveFolderOperationTarget(folderId: unknown): {
    folder: FolderRecord
    directory: string
  } {
    const folder = folderForId(folderId)
    if (!isFolderOperable(folder)) throw new Error('该素材文件夹不可重命名或删除')
    return {
      folder,
      directory: isLocalFolderOperable(folder) ? resolveSafeDirectory(folder) : '',
    }
  }

  function resolveWritableUserFolder(folderId: unknown): {
    folder: FolderRecord
    directory: string
  } {
    const folder = folderForId(folderId)
    if (folder.mode !== 'user' && !isLocalFolderOperable(folder)) {
      throw new Error('目标文件夹不可写入素材')
    }
    return { folder, directory: resolveSafeDirectory(folder) }
  }

  function moveMaterialFiles(
    sourceFolderId: unknown,
    destinationFolderId: unknown,
    pathValues: unknown,
  ): { files: FileEntry[]; moved: number } {
    const source = resolveWritableUserFolder(sourceFolderId)
    const destination = resolveWritableUserFolder(destinationFolderId)
    const sourceIdentityId = folderIdentityId(source.folder)
    const destinationIdentityId = folderIdentityId(destination.folder)
    const values = Array.isArray(pathValues) ? pathValues : []
    const uniquePaths = [...new Set(values.map((value) => path.resolve(String(value || ''))))]
    if (!uniquePaths.length) throw new Error('请选择要移动的素材')
    if (uniquePaths.length > 1000) throw new Error('单次最多移动 1000 个素材')

    const destinationNames = new Set([
      ...fs.readdirSync(destination.directory),
      ...(identityStore?.listFolderFiles(destinationIdentityId).map((file) => file.name) || []),
    ].map((name) => name.toLocaleLowerCase()))
    const operations = uniquePaths.map((sourcePath) => {
      const identity = identityStore?.getMaterialCloudFileByPath(sourcePath)
      if (identity && identity.folderId !== sourceIdentityId) {
        throw new Error('待移动素材不属于当前源文件夹')
      }
      const isPhysicalFolderFile = fs.existsSync(sourcePath)
        && samePath(path.dirname(sourcePath), source.directory)
      if (identity && !isPhysicalFolderFile) {
        if (identity.folderId === destinationIdentityId) {
          return { sourcePath, nextPath: sourcePath, changed: false, identity, logical: true }
        }
        const nameKey = identity.displayName.toLocaleLowerCase()
        if (destinationNames.has(nameKey)) throw new Error(`目标文件夹已存在同名素材：${identity.displayName}`)
        destinationNames.add(nameKey)
        return { sourcePath, nextPath: sourcePath, changed: true, identity, logical: true }
      }
      if (!samePath(path.dirname(sourcePath), source.directory)) throw new Error('待移动素材不属于当前源文件夹')
      const stat = fs.lstatSync(sourcePath)
      if (!stat.isFile() || stat.isSymbolicLink() || !VIDEO_EXTENSIONS.includes(path.extname(sourcePath).toLowerCase())) {
        throw new Error('待移动素材不是受支持的视频文件')
      }
      const realSource = fs.realpathSync(sourcePath)
      if (!source.folder.boundary || !isInsideDirectory(realSource, source.folder.boundary)) {
        throw new Error('待移动素材超出素材目录范围')
      }
      const nextPath = path.join(destination.directory, path.basename(realSource))
      if (samePath(realSource, nextPath)) {
        return { sourcePath: realSource, nextPath, changed: false, identity, logical: false }
      }
      const nameKey = path.basename(nextPath).toLocaleLowerCase()
      if (destinationNames.has(nameKey)) throw new Error(`目标文件夹已存在同名素材：${path.basename(nextPath)}`)
      destinationNames.add(nameKey)
      return { sourcePath: realSource, nextPath, changed: true, identity, logical: false }
    })

    const moved: Array<(typeof operations)[number]> = []
    try {
      for (const operation of operations) {
        if (!operation.changed) continue
        if (operation.logical) {
          if (!operation.identity) throw new Error('待移动素材缺少稳定身份')
          identityStore?.moveMaterial(operation.identity.materialId, destinationIdentityId)
          moved.push(operation)
          continue
        }
        fs.renameSync(operation.sourcePath, operation.nextPath)
        try {
          identityStore?.moveFile(operation.sourcePath, operation.nextPath, destinationIdentityId)
        } catch (error) {
          fs.renameSync(operation.nextPath, operation.sourcePath)
          throw error
        }
        moved.push(operation)
      }
    } catch (error) {
      const rollbackErrors: string[] = []
      for (const operation of [...moved].reverse()) {
        try {
          if (operation.logical) {
            if (operation.identity) identityStore?.moveMaterial(operation.identity.materialId, sourceIdentityId)
            continue
          }
          fs.renameSync(operation.nextPath, operation.sourcePath)
          identityStore?.moveFile(operation.nextPath, operation.sourcePath, sourceIdentityId)
        } catch (rollbackError) {
          rollbackErrors.push(errorDetails(rollbackError))
        }
      }
      const suffix = rollbackErrors.length ? `；部分回滚失败：${rollbackErrors.join('；')}` : ''
      throw new Error(`移动素材失败：${errorDetails(error)}${suffix}`, { cause: error })
    }

    return {
      files: operations.map((operation) => {
        if (operation.logical && operation.identity) {
          return identityStore?.listFolderFiles(destinationIdentityId)
            .find((file) => file.materialId === operation.identity?.materialId)
            || identityStore?.listFolderFiles(sourceIdentityId)
              .find((file) => file.materialId === operation.identity?.materialId)
            || {
              name: operation.identity.displayName,
              path: operation.identity.localPath,
              url: '',
              size: operation.identity.sourceSize,
              mtime: 0,
              ext: path.extname(operation.identity.displayName).toLocaleLowerCase(),
              materialId: operation.identity.materialId,
              assetId: operation.identity.assetId,
              assetVersion: operation.identity.assetVersion,
              sourceSha256: operation.identity.sourceSha256,
              localStatus: operation.identity.localStatus,
              analysisStatus: operation.identity.analysisStatus,
              cloudAnalysisStatus: operation.identity.cloudAnalysisStatus,
              cloudStatus: operation.identity.cloudStatus,
            }
        }
        const filePath = operation.changed ? operation.nextPath : operation.sourcePath
        const file = createFileEntry(filePath)
        return identityStore?.describeKnownFile(file) || file
      }),
      moved: moved.length,
    }
  }

  function moveMaterialFolder(folderId: unknown, destinationFolderId: unknown) {
    const source = resolveFolderOperationTarget(folderId)
    if (isCloudFolderOperable(source.folder)) {
      const destination = folderForId(destinationFolderId)
      if (destination.mode !== 'downloads' && destination.kind !== 'cloud') {
        throw new Error('云端文件夹只能移动到云端素材目录')
      }
      if (source.folder.parentId === destination.id) {
        return {
          changed: false,
          previousParentId: source.folder.parentId || '',
          previousDirectory: '',
          directory: '',
          folder: folderNodeWithDetails(source.folder),
        }
      }
      let ancestor: FolderRecord | undefined = destination
      const visited = new Set<string>()
      while (ancestor && !visited.has(ancestor.id)) {
        if (ancestor.id === source.folder.id) throw new Error('不能把文件夹移动到自身或其子文件夹中')
        visited.add(ancestor.id)
        ancestor = ancestor.parentId ? foldersById.get(ancestor.parentId) : undefined
      }
      const collision = readContents(destination, true, false, false).folders.some((folder) => (
        folder.id !== source.folder.id
        && folder.name.localeCompare(source.folder.name, 'zh-CN', { sensitivity: 'base' }) === 0
      ))
      if (collision) throw new Error('目标文件夹已存在同名文件夹')
      const stored = identityStore?.getFolder(source.folder.id)
      if (!stored || !identityStore) throw new Error('云端文件夹记录不存在')
      const previousParentId = source.folder.parentId || ''
      identityStore.moveFolder(
        source.folder.id,
        stored.storageKey,
        source.folder.name,
        destination.id,
      )
      source.folder.parentId = destination.id
      return {
        changed: true,
        previousParentId,
        previousDirectory: '',
        directory: '',
        folder: folderNodeWithDetails(source.folder),
      }
    }
    const destination = resolveWritableUserFolder(destinationFolderId)
    const sourceScopeBoundary = physicalScopeBoundary(source.directory)
    const destinationScopeBoundary = physicalScopeBoundary(destination.directory)
    if (!samePath(sourceScopeBoundary, destinationScopeBoundary)) {
      throw new Error('下载任务文件夹只能移动到同类型的本地目录')
    }
    if (source.folder.parentId === destination.folder.id) {
      return {
        changed: false,
        previousParentId: source.folder.parentId || '',
        previousDirectory: source.directory,
        directory: source.directory,
        folder: folderNodeWithDetails(source.folder),
      }
    }
    if (isInsideDirectory(destination.directory, source.directory)) {
      throw new Error('不能把文件夹移动到自身或其子文件夹中')
    }
    const nextDirectory = path.join(destination.directory, source.folder.name)
    if (!isInsideDirectory(nextDirectory, destinationScopeBoundary)) {
      throw new Error('移动目标超出素材目录范围')
    }
    if (fs.existsSync(nextDirectory)) throw new Error('目标文件夹已存在同名文件或文件夹')

    try {
      fs.renameSync(source.directory, nextDirectory)
    } catch (error) {
      throw new Error(`移动素材文件夹失败：${errorDetails(error)}`, { cause: error })
    }
    try {
      identityStore?.moveFolder(
        folderIdentityId(source.folder),
        path.relative(sourceScopeBoundary, nextDirectory),
        source.folder.name,
        folderIdentityId(destination.folder),
      )
    } catch (error) {
      try {
        fs.renameSync(nextDirectory, source.directory)
      } catch {
        // Preserve the identity-store failure; rollback is best effort.
      }
      throw error
    }
    invalidatePhysicalFoldersAtOrBelow(source.directory)
    const realDestination = fs.realpathSync(nextDirectory)
    const physicalFolder = registerPhysicalFolder({
      directory: realDestination,
      boundary: sourceScopeBoundary,
      name: source.folder.name,
      kind: sourceScopeBoundary === materialsBoundary ? 'user' : 'cloud',
      mode: 'directory',
      parentId: folderIdentityId(destination.folder),
    })
    const movedFolder = isLocalDownloadFolderOperable(source.folder)
      ? registerLocalDownloadFolder(physicalFolder, destination.folder.id)
      : physicalFolder
    return {
      changed: true,
      previousParentId: source.folder.parentId || '',
      previousDirectory: source.directory,
      directory: realDestination,
      folder: folderNodeWithDetails(movedFolder),
    }
  }

  function prepareFolderOperation(folderId: unknown): PreparedMaterialFolderOperation {
    const { folder, directory } = resolveFolderOperationTarget(folderId)
    const videoPaths: string[] = []
    const pending = [folder]
    const visited = new Set<string>()

    while (pending.length > 0) {
      const current = pending.pop()
      if (!current) continue

      const currentDirectory = resolveSafeDirectory(current)
      const pathKey = normalizePathKey(currentDirectory)
      if (visited.has(pathKey)) continue
      visited.add(pathKey)

      const contents = readContents(current)
      for (const file of contents.files) videoPaths.push(file.path)
      pending.push(...contents.folders)
    }

    videoPaths.sort((first, second) => first.localeCompare(second, 'zh-CN', {
      numeric: true,
      sensitivity: 'base',
    }))
    return {
      folder: folderNodeWithDetails(folder),
      directory,
      videoPaths,
    }
  }

  function createMaterialFolder(parentFolderId: unknown, name: unknown): MaterialFolderNode {
    const requestedId = typeof parentFolderId === 'string' ? parentFolderId.trim() : ''
    const parent = requestedId ? folderForId(requestedId) : userRoot
    if (
      parent.mode !== 'user'
      && parent.mode !== 'downloads'
      && !isFolderOperable(parent)
    ) {
      throw new Error('该素材文件夹不可新建子文件夹')
    }

    const directoryName = desiredDirectoryName(name)
    if (parent.mode === 'downloads' || (parent.kind === 'cloud' && !isLocalDownloadFolderOperable(parent))) {
      if (!identityStore) throw new Error('该素材文件夹不可新建子文件夹：云端文件夹数据库尚未就绪')
      const collision = readContents(parent, true, false, false).folders.some((folder) => (
        folder.name.localeCompare(directoryName, 'zh-CN', { sensitivity: 'base' }) === 0
      ))
      if (collision) throw new Error('同目录下已存在同名文件夹')
      const id = identityStore.getOrCreateFolder({
        scope: 'downloads',
        storageKey: `.cloud-folders/${randomUUID()}`,
        name: directoryName,
        parentFolderId: parent.id,
      })
      const createdFolder: FolderRecord = {
        id,
        name: directoryName,
        kind: 'cloud',
        mode: 'cloud',
        parentId: parent.id,
      }
      foldersById.set(id, createdFolder)
      return folderNodeWithDetails(createdFolder)
    }

    const parentDirectory = resolveSafeDirectory(parent)
    const scopeBoundary = physicalScopeBoundary(parentDirectory)
    const destinationDirectory = path.resolve(parentDirectory, directoryName)
    if (
      !samePath(path.dirname(destinationDirectory), parentDirectory)
      || !isInsideDirectory(destinationDirectory, scopeBoundary)
    ) {
      throw new Error('新建文件夹目标超出素材目录范围')
    }
    if (isReservedDirectoryName(parentDirectory, directoryName)) {
      throw new Error('不能使用受保护的素材文件夹名称')
    }

    let siblingNames: string[]
    try {
      siblingNames = fs.readdirSync(parentDirectory)
    } catch (error) {
      throw new Error(`无法读取素材文件夹所在目录：${errorDetails(error)}`, { cause: error })
    }
    if (siblingNames.some((siblingName) => siblingName.toLowerCase() === directoryName.toLowerCase())) {
      throw new Error('同目录下已存在同名文件或文件夹')
    }

    try {
      fs.mkdirSync(destinationDirectory)
    } catch (error) {
      throw new Error(`新建素材文件夹失败：${errorDetails(error)}`, { cause: error })
    }

    const physicalFolder = registerPhysicalFolder({
      directory: fs.realpathSync(destinationDirectory),
      boundary: scopeBoundary,
      name: directoryName,
      kind: scopeBoundary === materialsBoundary ? 'user' : 'cloud',
      mode: 'directory',
      parentId: folderIdentityId(parent),
    })
    const createdFolder = isLocalDownloadFolderOperable(parent)
      ? registerLocalDownloadFolder(physicalFolder, parent.id)
      : physicalFolder
    return folderNodeWithDetails(createdFolder)
  }

  function renameMaterialFolder(folderId: unknown, name: unknown): RenameMaterialFolderResult {
    const { folder, directory: sourceDirectory } = resolveFolderOperationTarget(folderId)
    const destinationName = desiredDirectoryName(name)
    if (isCloudFolderOperable(folder)) {
      if (folder.name === destinationName) {
        return {
          previousFolderId: folder.id,
          previousDirectory: '',
          directory: '',
          changed: false,
          folder: folderNodeWithDetails(folder),
        }
      }
      const parent = folder.parentId ? folderForId(folder.parentId) : downloadsRoot
      const collision = readContents(parent, true, false, false).folders.some((sibling) => (
        sibling.id !== folder.id
        && sibling.name.localeCompare(destinationName, 'zh-CN', { sensitivity: 'base' }) === 0
      ))
      if (collision) throw new Error('同目录下已存在同名文件夹')
      const stored = identityStore?.getFolder(folder.id)
      if (!stored || !identityStore) throw new Error('云端文件夹记录不存在')
      identityStore.moveFolder(
        folder.id,
        stored.storageKey,
        destinationName,
        folder.parentId,
      )
      folder.name = destinationName
      return {
        previousFolderId: folder.id,
        previousDirectory: '',
        directory: '',
        changed: true,
        folder: folderNodeWithDetails(folder),
      }
    }
    const parentDirectory = path.dirname(sourceDirectory)
    const scopeBoundary = physicalScopeBoundary(sourceDirectory)
    const destinationDirectory = path.resolve(parentDirectory, destinationName)

    if (!samePath(path.dirname(destinationDirectory), parentDirectory)) {
      throw new Error('重命名目标必须位于素材文件夹原目录')
    }
    if (!isInsideDirectory(destinationDirectory, scopeBoundary)) {
      throw new Error('重命名目标超出素材目录范围')
    }
    if (isReservedDirectoryName(parentDirectory, destinationName)) {
      throw new Error('不能使用受保护的素材文件夹名称')
    }

    if (path.basename(sourceDirectory) === destinationName) {
      return {
        previousFolderId: folder.id,
        previousDirectory: sourceDirectory,
        directory: sourceDirectory,
        changed: false,
        folder: folderNodeWithDetails(folder),
      }
    }

    let siblingNames: string[]
    try {
      siblingNames = fs.readdirSync(parentDirectory)
    } catch (error) {
      throw new Error(`无法读取素材文件夹所在目录：${errorDetails(error)}`, { cause: error })
    }
    for (const siblingName of siblingNames) {
      if (siblingName.toLowerCase() !== destinationName.toLowerCase()) continue
      const siblingPath = path.join(parentDirectory, siblingName)
      if (!samePhysicalDirectory(sourceDirectory, siblingPath)) {
        throw new Error('同目录下已存在同名文件或文件夹')
      }
    }

    const caseOnly = samePath(sourceDirectory, destinationDirectory)
    if (fs.existsSync(destinationDirectory) && !samePhysicalDirectory(sourceDirectory, destinationDirectory)) {
      throw new Error('同目录下已存在同名文件或文件夹')
    }

    try {
      renameDirectoryWithCaseSupport(sourceDirectory, destinationDirectory, caseOnly)
    } catch (error) {
      throw new Error(`重命名素材文件夹失败：${errorDetails(error)}`, { cause: error })
    }

    try {
      identityStore?.moveFolder(
        folderIdentityId(folder),
        path.relative(scopeBoundary, destinationDirectory),
        destinationName,
        folder.parentId ? folderIdentityId(folderForId(folder.parentId)) : undefined,
      )
    } catch (error) {
      try {
        renameDirectoryWithCaseSupport(destinationDirectory, sourceDirectory, caseOnly)
      } catch {
        // Rollback is best effort; preserve the identity-store error.
      }
      throw error
    }

    invalidatePhysicalFoldersAtOrBelow(sourceDirectory)
    const realDestination = fs.realpathSync(destinationDirectory)
    const physicalFolder = registerPhysicalFolder({
      directory: realDestination,
      boundary: scopeBoundary,
      name: destinationName,
      kind: scopeBoundary === materialsBoundary ? 'user' : 'cloud',
      mode: 'directory',
      parentId: folder.parentId ? folderIdentityId(folderForId(folder.parentId)) : undefined,
    })
    const renamedFolder = isLocalDownloadFolderOperable(folder)
      ? registerLocalDownloadFolder(physicalFolder, folder.parentId || userRoot.id)
      : physicalFolder

    return {
      previousFolderId: folder.id,
      previousDirectory: sourceDirectory,
      directory: realDestination,
      changed: true,
      folder: folderNodeWithDetails(renamedFolder),
    }
  }

  function stageLocalFolderDeletion(directory: string): string {
    const scopeBoundary = physicalScopeBoundary(directory)
    const stagingRoot = path.join(scopeBoundary, DELETION_STAGING_DIRECTORY_NAME)
    fs.mkdirSync(stagingRoot, { recursive: true })
    const stagedDirectory = path.join(
      stagingRoot,
      `${Date.now()}-${randomUUID()}-${path.basename(directory)}`,
    )
    fs.renameSync(directory, stagedDirectory)
    return stagedDirectory
  }

  function deleteMaterialFolder(folderId: unknown): DeleteMaterialFolderResult {
    const { folder, directory } = resolveFolderOperationTarget(folderId)
    if (!folder.parentId) throw new Error('该素材文件夹不可删除')

    if (isCloudFolderOperable(folder)) {
      if (!identityStore) throw new Error('云端文件夹数据库尚未就绪')
      refreshStoredCloudFolders()
      const deletedIds = new Set<string>()
      const pending = [folder.id]
      while (pending.length > 0) {
        const currentId = pending.pop()
        if (!currentId || deletedIds.has(currentId)) continue
        deletedIds.add(currentId)
        for (const candidate of foldersById.values()) {
          if (candidate.parentId === currentId) pending.push(candidate.id)
        }
      }
      identityStore.deleteFolder(folderIdentityId(folder))
      for (const id of deletedIds) foldersById.delete(id)
      return {
        folderId: folder.id,
        directory: '',
        parentId: folder.parentId,
      }
    }

    let stagedDirectory: string
    try {
      stagedDirectory = stageLocalFolderDeletion(directory)
    } catch (error) {
      throw new Error(`删除素材文件夹失败：${errorDetails(error)}`, { cause: error })
    }

    try {
      identityStore?.deleteFolder(folderIdentityId(folder))
    } catch (error) {
      try {
        fs.renameSync(stagedDirectory, directory)
      } catch {
        // Preserve the database error; restoring the folder is best effort.
      }
      throw error
    }
    invalidatePhysicalFoldersAtOrBelow(directory)
    foldersById.delete(folder.id)
    return {
      folderId: folder.id,
      directory,
      stagedDirectory,
      parentId: folder.parentId,
    }
  }

  async function searchMaterialFolders(options: SearchOptions = {}): Promise<MaterialFolderSearchResult[]> {
    const query = String(options.query || '').trim().toLocaleLowerCase()
    if (!query) return []

    const limit = safeSearchLimit(options.limit)
    const results: MaterialFolderSearchResult[] = []
    let visitedFolderCount = 0

    const visit = async (folder: FolderRecord): Promise<void> => {
      if (results.length >= limit || visitedFolderCount >= MAX_SEARCHED_FOLDERS) return
      if (
        (folder.mode === 'batch' || folder.mode === 'directory')
        && folder.name.toLocaleLowerCase().includes(query)
      ) {
        results.push({
          folder: folderNodeWithDetails(folder, true),
          breadcrumbs: breadcrumbsFor(folder),
        })
      }

      visitedFolderCount += 1
      if (visitedFolderCount % 64 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }

      for (const child of readContents(folder, true, false, false).folders) {
        await visit(child)
        if (results.length >= limit || visitedFolderCount >= MAX_SEARCHED_FOLDERS) break
      }
    }

    await visit(root)
    return results
  }

  return {
    browseMaterials,
    createMaterialFolder,
    deleteMaterialFolder,
    getMaterialFolderIdentityId,
    getMaterialFolderDetails,
    getMaterialImportDirectory,
    getMaterialImportTarget,
    moveMaterialFiles,
    moveMaterialFolder,
    prepareFolderOperation,
    renameMaterialFolder,
    searchMaterialFolders,
    summarizeMaterialSelection,
  }
}

export {
  createMaterialDirectoryBrowser,
}
