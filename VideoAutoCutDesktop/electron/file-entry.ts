import fs from 'node:fs'
import path from 'node:path'

import type { FileEntry } from './types.js'
import { createLocalMediaUrl } from './local-media-protocol.js'
import { ensureDir } from './utils.js'

interface CopyFilesOptions {
  allowedExtensions?: string[]
}

function createFileEntry(filePath: string): FileEntry {
  const stat = fs.statSync(filePath)
  return {
    name: path.basename(filePath),
    path: filePath,
    url: createLocalMediaUrl(filePath),
    size: stat.size,
    mtime: stat.mtimeMs,
    ext: path.extname(filePath).toLowerCase(),
  }
}

function sanitizeFileStem(value: string): string {
  return value.replace(/[/\\:*?"<>|]+/g, '_') || 'file'
}

function createUniqueDestination(destinationDir: string, sourcePath: string): string {
  const extension = path.extname(sourcePath)
  const baseName = sanitizeFileStem(path.basename(sourcePath, extension))
  let destination = path.join(destinationDir, baseName + extension)
  let suffix = 1

  while (fs.existsSync(destination)) {
    destination = path.join(destinationDir, `${baseName}_${suffix}${extension}`)
    suffix += 1
  }

  return destination
}

function assertAllowedExtension(sourcePath: string, allowedExtensions: string[] | undefined): void {
  if (!allowedExtensions?.length) return

  const extension = path.extname(sourcePath).toLowerCase()
  if (!allowedExtensions.includes(extension)) {
    throw new Error(`不支持的文件格式：${extension || '未知'}`)
  }
}

function copyFilesIntoDirectory(sourcePaths: string[], destinationDir: string, options: CopyFilesOptions = {}): FileEntry[] {
  ensureDir(destinationDir)
  sourcePaths.forEach((sourcePath) => assertAllowedExtension(sourcePath, options.allowedExtensions))

  return sourcePaths.map((sourcePath) => {
    const destination = createUniqueDestination(destinationDir, sourcePath)
    fs.copyFileSync(sourcePath, destination)
    return createFileEntry(destination)
  })
}

export {
  copyFilesIntoDirectory,
  createFileEntry,
  createUniqueDestination,
}
