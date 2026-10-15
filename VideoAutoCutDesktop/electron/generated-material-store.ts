import fs from 'node:fs'
import path from 'node:path'

import { asRecord } from './types.js'
import { ensureDir } from './utils.js'
import type { GeneratedRecord, GeneratedRecordFiles } from './materials-types.js'

interface GeneratedMaterialStoreOptions {
  dataRoot: string
  generatedRecordsPath: string
  isInsideDir: (target: unknown, base: string) => boolean
  safeRemoveDirectory: (dir: unknown) => boolean
  samePath: (a: unknown, b: unknown) => boolean
}

function createGeneratedMaterialStore({
  dataRoot,
  generatedRecordsPath,
  isInsideDir,
  safeRemoveDirectory,
  samePath,
}: GeneratedMaterialStoreOptions) {
  function listGenerated(): GeneratedRecord[] {
    if (!fs.existsSync(generatedRecordsPath)) return []

    try {
      const data = JSON.parse(fs.readFileSync(generatedRecordsPath, 'utf8'))
      return Array.isArray(data) ? data.map(asRecord) as GeneratedRecord[] : []
    } catch (_error) {
      return []
    }
  }

  function writeGenerated(records: GeneratedRecord[]): void {
    ensureDir(path.dirname(generatedRecordsPath))
    fs.writeFileSync(generatedRecordsPath, JSON.stringify(records, null, 2), 'utf8')
  }

  function removeGeneratedRecord(predicate: (record: GeneratedRecord) => boolean) {
    const records = listGenerated()
    const kept: GeneratedRecord[] = []
    const removed: GeneratedRecord[] = []

    for (const record of records) {
      if (predicate(record)) removed.push(record)
      else kept.push(record)
    }

    if (removed.length) writeGenerated(kept)
    return { kept, removed }
  }

  function removeGeneratedRecordById(id: unknown) {
    return removeGeneratedRecord((item) => String(item.id || '') === String(id || ''))
  }

  function removeGeneratedRecordByOutputPath(outputPath: unknown) {
    return removeGeneratedRecordsByOutputPaths([outputPath])
  }

  function removeGeneratedRecordsByOutputPaths(outputPaths: readonly unknown[]) {
    return removeGeneratedRecord((record) => (
      outputPaths.some((outputPath) => samePath(record.output_path, outputPath))
    ))
  }

  function renameGeneratedRecordOutputPaths(
    mappings: ReadonlyArray<{ previousPath: unknown; nextPath: string }>,
  ): number {
    const records = listGenerated()
    let changedCount = 0
    const updated = records.map((record) => {
      const mapping = mappings.find(({ previousPath }) => samePath(record.output_path, previousPath))
      if (!mapping) return record
      changedCount += 1
      return { ...record, output_path: mapping.nextPath }
    })

    if (changedCount > 0) writeGenerated(updated)
    return changedCount
  }

  function renameGeneratedRecordOutputPath(previousPath: unknown, nextPath: string): boolean {
    return renameGeneratedRecordOutputPaths([{ previousPath, nextPath }]) > 0
  }

  function removeGeneratedRecordFiles(record: GeneratedRecord): GeneratedRecordFiles {
    const removed = { recordDir: false }
    const recordDir = String(record.record_dir || '')
    if (recordDir && isInsideDir(recordDir, path.join(dataRoot, 'video', 'materials', 'generated', 'records'))) {
      removed.recordDir = safeRemoveDirectory(recordDir)
    }
    return removed
  }

  return {
    listGenerated,
    removeGeneratedRecordById,
    removeGeneratedRecordByOutputPath,
    removeGeneratedRecordsByOutputPaths,
    removeGeneratedRecordFiles,
    renameGeneratedRecordOutputPath,
    renameGeneratedRecordOutputPaths,
  }
}

export {
  createGeneratedMaterialStore,
}
