import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import * as yauzl from 'yauzl'

interface ExtractProgress {
  percent: number
  transferred?: number
  total?: number
}

function ensureDirectory(directory: string): void {
  if (!directory || fs.existsSync(directory)) return
  fs.mkdirSync(directory, { recursive: true })
}

function clampProgressPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function isDirectoryEntry(entry: yauzl.Entry): boolean {
  return entry.fileName.endsWith('/')
}

function safeZipTarget(destination: string, entryName: string): string {
  const normalizedName = entryName.replace(/\\/g, '/')
  if (!normalizedName || normalizedName.startsWith('/') || /^[a-zA-Z]:/.test(normalizedName)) {
    throw new Error(`runtime zip contains an unsafe path: ${entryName}`)
  }

  const parts = normalizedName.split('/').filter(Boolean)
  if (parts.includes('..')) {
    throw new Error(`runtime zip contains an unsafe path: ${entryName}`)
  }

  const destinationFull = path.resolve(destination)
  const target = path.resolve(destinationFull, ...parts)
  const relative = path.relative(destinationFull, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`runtime zip contains an unsafe path: ${entryName}`)
  }

  return target
}

async function inspectZip(zipPath: string): Promise<{ fileCount: number; totalBytes: number }> {
  const zipFile = await yauzl.openPromise(zipPath, {
    autoClose: true,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  })

  let fileCount = 0
  let totalBytes = 0
  try {
    for await (const entry of zipFile.eachEntry()) {
      if (isDirectoryEntry(entry)) continue
      fileCount += 1
      if (entry.uncompressedSize > 0) totalBytes += entry.uncompressedSize
    }
  } finally {
    zipFile.close()
  }

  return { fileCount, totalBytes }
}

function createExtractProgressEmitter(
  totalBytes: number,
  fileCount: number,
  onProgress: (progress: ExtractProgress) => void,
  now: () => number = Date.now,
) {
  let transferred = 0
  let filesDone = 0
  let lastEmitAt = 0

  function snapshot(): ExtractProgress {
    if (totalBytes > 0) {
      return {
        percent: clampProgressPercent(transferred / totalBytes * 100),
        transferred,
        total: totalBytes,
      }
    }

    return {
      percent: fileCount > 0 ? clampProgressPercent(filesDone / fileCount * 100) : 100,
      transferred: filesDone,
      total: fileCount,
    }
  }

  function emit(force = false) {
    const currentTime = now()
    if (!force && currentTime - lastEmitAt < 180) return
    lastEmitAt = currentTime
    onProgress(snapshot())
  }

  return {
    start() {
      emit(true)
    },
    addBytes(bytes: number) {
      transferred += Math.max(0, bytes)
      emit(false)
    },
    finishFile() {
      filesDone += 1
      emit(false)
    },
    finish() {
      if (totalBytes > 0) transferred = totalBytes
      filesDone = fileCount
      emit(true)
    },
  }
}

async function extractZipWithProgress(
  zipPath: string,
  destination: string,
  onProgress: (progress: ExtractProgress) => void,
): Promise<void> {
  ensureDirectory(destination)
  const { fileCount, totalBytes } = await inspectZip(zipPath)
  const progress = createExtractProgressEmitter(totalBytes, fileCount, onProgress)
  progress.start()
  const zipFile = await yauzl.openPromise(zipPath, {
    autoClose: true,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  })

  try {
    for await (const entry of zipFile.eachEntry()) {
      const target = safeZipTarget(destination, entry.fileName)

      if (isDirectoryEntry(entry)) {
        ensureDirectory(target)
        continue
      }

      if (!entry.canDecodeFileData()) {
        throw new Error(`runtime zip contains an unsupported entry: ${entry.fileName}`)
      }
      if (entry.isEncrypted()) {
        throw new Error(`runtime zip contains an encrypted entry: ${entry.fileName}`)
      }

      ensureDirectory(path.dirname(target))
      const readStream = await zipFile.openReadStreamPromise(entry)
      const countProgress = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          progress.addBytes(chunk.length)
          callback(null, chunk)
        },
      })

      await pipeline(readStream, countProgress, fs.createWriteStream(target))
      progress.finishFile()
    }
  } finally {
    zipFile.close()
  }

  progress.finish()
}

export {
  createExtractProgressEmitter,
  extractZipWithProgress,
  safeZipTarget,
}

export type { ExtractProgress }
