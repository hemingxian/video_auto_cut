import fs from 'node:fs'
import path from 'node:path'

import { createFileEntry } from './file-entry.js'
import { VIDEO_EXTENSIONS } from './file-extensions.js'
import type { FileEntry } from './types.js'

interface MaterialFileOperationsDependencies {
  assertInsideWorkspace: (target: unknown, label?: string) => string
  samePath: (first: unknown, second: unknown) => boolean
}

interface RenameMaterialFileResult {
  previousPath: string
  changed: boolean
  file: FileEntry
}

const WINDOWS_RESERVED_FILE_STEM = /^(?:con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i
const INVALID_FILE_NAME_CHARACTERS = /[<>:"/\\|?*]/
const MAX_FILE_NAME_LENGTH = 255
const INDEX_DIRECTORY_NAME = '_indexed_h264'

function errorDetails(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function sourceFileStat(sourcePath: string): fs.Stats {
  try {
    return fs.lstatSync(sourcePath)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : ''
    if (code === 'ENOENT') throw new Error('素材文件不存在', { cause: error })
    throw new Error(`无法读取素材文件：${errorDetails(error)}`, { cause: error })
  }
}

function desiredFileStem(value: unknown, extension: string): string {
  if (typeof value !== 'string') throw new Error('请输入有效的新文件名')

  if (!value.trim()) throw new Error('文件名不能为空')
  if (value !== value.trim()) throw new Error('文件名不能以空白字符开头或结尾')
  const requestedName = value
  if (requestedName === '.' || requestedName === '..') throw new Error('文件名不能是 "." 或 ".."')
  const containsControlCharacter = Array.from(requestedName).some((character) => character.charCodeAt(0) <= 31)
  if (INVALID_FILE_NAME_CHARACTERS.test(requestedName) || containsControlCharacter) {
    throw new Error('文件名包含非法字符')
  }
  if (requestedName.endsWith('.') || requestedName.endsWith(' ')) {
    throw new Error('文件名不能以句点或空格结尾')
  }

  const requestedExtension = path.extname(requestedName)
  const stem = requestedExtension.toLowerCase() === extension.toLowerCase()
    ? requestedName.slice(0, -requestedExtension.length)
    : requestedName

  if (!stem || stem === '.' || stem === '..') throw new Error('文件名不能为空')
  if (stem.endsWith('.') || stem.endsWith(' ')) throw new Error('文件名不能以句点或空格结尾')
  if (WINDOWS_RESERVED_FILE_STEM.test(stem)) throw new Error('文件名使用了 Windows 保留名称')
  if (`${stem}${extension}`.length > MAX_FILE_NAME_LENGTH) {
    throw new Error(`文件名不能超过 ${MAX_FILE_NAME_LENGTH} 个字符`)
  }
  return stem
}

function samePhysicalFile(first: string, second: string): boolean {
  try {
    const firstStat = fs.statSync(first)
    const secondStat = fs.statSync(second)
    if (firstStat.dev === secondStat.dev && firstStat.ino !== 0 && firstStat.ino === secondStat.ino) {
      return true
    }
    return fs.realpathSync(first) === fs.realpathSync(second)
  } catch {
    return false
  }
}

function temporaryRenamePath(directory: string, extension: string): string {
  const prefix = `.videoautocut-rename-${process.pid}-${Date.now()}`
  let suffix = 0
  let candidate = path.join(directory, `${prefix}${extension}`)

  while (fs.existsSync(candidate)) {
    suffix += 1
    candidate = path.join(directory, `${prefix}-${suffix}${extension}`)
  }
  return candidate
}

function renameWithCaseSupport(sourcePath: string, destinationPath: string, caseOnly: boolean): void {
  if (!caseOnly) {
    fs.renameSync(sourcePath, destinationPath)
    return
  }

  const temporaryPath = temporaryRenamePath(path.dirname(sourcePath), path.extname(sourcePath))
  fs.renameSync(sourcePath, temporaryPath)
  try {
    fs.renameSync(temporaryPath, destinationPath)
  } catch (error) {
    try {
      fs.renameSync(temporaryPath, sourcePath)
    } catch {
      // The original error is more useful; rollback is only a best-effort safeguard.
    }
    throw error
  }
}

function createMaterialFileOperations({
  assertInsideWorkspace,
  samePath,
}: MaterialFileOperationsDependencies) {
  function findIndexedCopies(file: unknown): string[] {
    const sourcePath = path.resolve(assertInsideWorkspace(file, '素材文件'))
    const sourceDirectory = path.dirname(sourcePath)
    const indexDirectory = path.join(sourceDirectory, INDEX_DIRECTORY_NAME)
    if (!fs.existsSync(indexDirectory)) return []

    let sourceFiles: string[]
    let indexedEntries: fs.Dirent[]
    try {
      sourceFiles = fs.readdirSync(sourceDirectory, { withFileTypes: true })
        .filter((entry) => (
          entry.isFile()
          && !entry.isSymbolicLink()
          && VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())
        ))
        .map((entry) => path.join(sourceDirectory, entry.name))
        .sort()
      indexedEntries = fs.readdirSync(indexDirectory, { withFileTypes: true })
    } catch {
      return []
    }

    const indexedFiles = indexedEntries
      .filter((entry) => (
        entry.isFile()
        && !entry.isSymbolicLink()
        && VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())
      ))
      .map((entry) => path.join(indexDirectory, entry.name))
      .filter((candidate) => {
        try {
          const realPath = fs.realpathSync(candidate)
          assertInsideWorkspace(realPath, '索引素材文件')
          return samePath(candidate, realPath)
        } catch {
          return false
        }
      })
      .sort()

    const sourceStem = path.parse(sourcePath).name.toLocaleLowerCase()
    const matchedByStem = indexedFiles.filter((candidate) => (
      path.parse(candidate).name.replace(/^\d+_/, '').toLocaleLowerCase() === sourceStem
    ))
    if (matchedByStem.length > 0) return matchedByStem

    const sourceIndex = sourceFiles.findIndex((candidate) => samePath(candidate, sourcePath))
    if (sourceIndex < 0) return []
    const expectedPrefix = `${String(sourceIndex + 1).padStart(3, '0')}_`
    return indexedFiles.filter((candidate) => path.basename(candidate).startsWith(expectedPrefix))
  }

  function renameMaterialFile(file: unknown, name: unknown): RenameMaterialFileResult {
    const checkedSourcePath = path.resolve(assertInsideWorkspace(file, '素材文件'))
    const extension = path.extname(checkedSourcePath)
    if (!VIDEO_EXTENSIONS.includes(extension.toLowerCase())) {
      throw new Error('只允许重命名视频素材文件')
    }

    const sourceStat = sourceFileStat(checkedSourcePath)
    if (sourceStat.isSymbolicLink()) throw new Error('不允许重命名符号链接文件')
    if (!sourceStat.isFile()) throw new Error('目标不是视频素材文件')

    const realSourcePath = fs.realpathSync(checkedSourcePath)
    assertInsideWorkspace(realSourcePath, '素材文件')
    if (!samePath(checkedSourcePath, realSourcePath)) {
      throw new Error('不允许通过符号链接重命名素材文件')
    }

    const stem = desiredFileStem(name, extension)
    const destinationName = `${stem}${extension}`
    const sourceDirectory = path.dirname(realSourcePath)
    const destinationPath = path.resolve(
      assertInsideWorkspace(path.join(sourceDirectory, destinationName), '重命名目标'),
    )

    if (!samePath(path.dirname(destinationPath), sourceDirectory)) {
      throw new Error('重命名目标必须位于素材文件原目录')
    }

    const previousPath = realSourcePath
    if (path.basename(realSourcePath) === destinationName) {
      return {
        previousPath,
        changed: false,
        file: createFileEntry(realSourcePath),
      }
    }

    const caseOnly = samePath(realSourcePath, destinationPath)
    if (fs.existsSync(destinationPath)) {
      if (!caseOnly || !samePhysicalFile(realSourcePath, destinationPath)) {
        throw new Error('同目录下已存在同名文件')
      }
    }

    try {
      renameWithCaseSupport(realSourcePath, destinationPath, caseOnly)
    } catch (error) {
      throw new Error(`重命名素材文件失败：${errorDetails(error)}`, { cause: error })
    }

    return {
      previousPath,
      changed: true,
      file: createFileEntry(destinationPath),
    }
  }

  return {
    findIndexedCopies,
    renameMaterialFile,
  }
}

export {
  createMaterialFileOperations,
}

export type {
  MaterialFileOperationsDependencies,
  RenameMaterialFileResult,
}
