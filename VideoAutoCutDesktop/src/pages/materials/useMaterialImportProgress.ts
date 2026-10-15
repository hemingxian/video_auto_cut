import { useCallback, useEffect, useState } from 'react'

import type { MaterialImportProgressState } from './types'

function numberField(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : 0
}

export function useMaterialImportProgress() {
  const [progress, setProgress] = useState<MaterialImportProgressState | null>(null)

  useEffect(() => window.videoAutoCut.onMaterialLibraryEvent((event) => {
    if (event.type === 'import-started') {
      setProgress({
        sessionId: String(event.sessionId || ''),
        status: 'copying',
        fileName: '',
        fileIndex: 0,
        totalFiles: numberField(event.totalFiles),
        bytesProcessed: 0,
        totalBytes: numberField(event.totalBytes),
        speedBytesPerSecond: 0,
        imported: 0,
        failed: 0,
        message: '',
      })
      return
    }
    if (!event.type.startsWith('import-')) return
    setProgress((current) => {
      if (!current || (event.sessionId && String(event.sessionId) !== current.sessionId)) return current
      if (event.type === 'import-progress') {
        return {
          ...current,
          status: event.phase === 'verifying' ? 'verifying' : 'copying',
          fileName: String(event.fileName || current.fileName),
          fileIndex: numberField(event.fileIndex),
          totalFiles: numberField(event.totalFiles) || current.totalFiles,
          bytesProcessed: numberField(event.bytesProcessed),
          totalBytes: numberField(event.totalBytes) || current.totalBytes,
          speedBytesPerSecond: numberField(event.speedBytesPerSecond),
        }
      }
      if (event.type === 'import-file-completed') {
        return {
          ...current,
          fileName: String(event.fileName || current.fileName),
          fileIndex: numberField(event.fileIndex),
          imported: current.imported + 1,
          bytesProcessed: numberField(event.bytesProcessed),
        }
      }
      if (event.type === 'import-file-failed') {
        return {
          ...current,
          fileName: String(event.fileName || current.fileName),
          fileIndex: numberField(event.fileIndex),
          failed: current.failed + 1,
          message: String(event.message || '导入失败'),
        }
      }
      if (event.type === 'import-completed' || event.type === 'import-canceled') {
        return {
          ...current,
          status: event.type === 'import-canceled' ? 'canceled' : 'completed',
          imported: numberField(event.imported),
          failed: numberField(event.failed),
          bytesProcessed: numberField(event.bytesProcessed),
          totalBytes: numberField(event.totalBytes) || current.totalBytes,
          speedBytesPerSecond: 0,
        }
      }
      return current
    })
  }), [])

  const cancel = useCallback(async () => {
    setProgress((current) => current && ['copying', 'verifying'].includes(current.status)
      ? { ...current, status: 'canceling' }
      : current)
    const result = await window.videoAutoCut.cancelMaterialImport()
    if (!result.ok) {
      setProgress((current) => current ? {
        ...current,
        status: 'canceled',
        message: result.message || '取消导入失败',
      } : current)
    }
  }, [])

  const dismiss = useCallback(() => {
    setProgress((current) => current && ['completed', 'canceled'].includes(current.status) ? null : current)
  }, [])

  return { cancel, dismiss, progress }
}
