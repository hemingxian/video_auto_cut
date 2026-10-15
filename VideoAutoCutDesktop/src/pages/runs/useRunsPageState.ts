import { useCallback, useMemo, useState } from 'react'

import { useAsyncRefresh } from '../../hooks/useAsyncRefresh'
import { usePendingKeys } from '../../hooks/usePendingKeys'
import { confirmDestructiveAction, reportOperationResult } from '../../lib/dialog'
import type { RunArtifact, RunItem } from '../../types/videoauto'
import { groupRunHistory, isRunInUse, type RunActivityTarget, type RunHistoryGroup } from './runHistoryModel'

export function useRunsPageState(protectedTasks: readonly RunActivityTarget[] = []) {
  const [records, setRecords] = useState<RunItem[]>([])
  const [selectedGroupKey, setSelectedGroupKey] = useState('')
  const [selectedRecordPath, setSelectedRecordPath] = useState('')
  const [log, setLog] = useState('')
  const [logOpen, setLogOpen] = useState(false)
  const { pendingKeys: deletingArtifactPaths, runWithPending } = usePendingKeys<string>()
  const { pendingKeys: deletingRunPaths, runWithPending: runWithDeleting } = usePendingKeys<string>()
  const runs = useMemo(() => groupRunHistory(records), [records])
  const selectedGroup = runs.find((group) => group.key === selectedGroupKey) || runs[0] || null
  const selected = selectedGroup?.records.find((run) => run.path === selectedRecordPath) || selectedGroup?.latest || null
  const selectedInUse = Boolean(selected && isRunInUse(selected, protectedTasks))

  const applyRuns = useCallback((items: RunItem[]) => {
    setRecords(items)
  }, [])

  const loadRuns = useCallback(() => window.videoAutoCut.listRuns(), [])
  const { refresh } = useAsyncRefresh({ load: loadRuns, apply: applyRuns })

  const chooseRun = useCallback((group: RunHistoryGroup) => {
    setSelectedGroupKey(group.key)
    setSelectedRecordPath('')
    setLogOpen(false)
    setLog('')
  }, [])

  const chooseRecord = useCallback((runPath: string) => {
    setSelectedRecordPath(runPath)
    setLogOpen(false)
    setLog('')
  }, [])

  const openLog = useCallback(async () => {
    if (!selected?.logPath) return
    setLogOpen(true)
    setLog('日志读取中...')

    try {
      const text = await window.videoAutoCut.readFile(selected.logPath)
      setLog(text || '暂无日志')
    } catch (error) {
      setLog(`日志读取失败：${String(error)}`)
    }
  }, [selected])

  const deleteArtifact = useCallback(async (item: RunArtifact) => {
    if (deletingArtifactPaths.has(item.path)) return
    const confirmed = confirmDestructiveAction(`确定删除视频「${item.relativePath || item.name}」吗？`)
    if (!confirmed) return

    await runWithPending(item.path, async () => {
      const result = await window.videoAutoCut.deleteFile(item.path)
      if (!reportOperationResult(result, '删除视频失败')) return
      await refresh()
    })
  }, [deletingArtifactPaths, refresh, runWithPending])

  async function deleteRun() {
    if (!selected || selectedInUse || deletingRunPaths.has(selected.path)) return
    const label = selectedGroup && selectedGroup.records.length > 1 ? '本次过程记录' : '任务记录'
    if (!confirmDestructiveAction(`将「${selected.projectName || selected.id}」的${label}（${selected.id}）移到回收站？其他过程记录和单独保存的成片会保留。`)) return
    return runWithDeleting(selected.path, async () => {
      const result = await window.videoAutoCut.deleteRun(selected.id)
      if (reportOperationResult(result, '删除任务记录失败')) {
        await refresh()
        setSelectedRecordPath('')
        setLogOpen(false)
        return selected.id
      }
    })
  }

  return {
    chooseRun,
    chooseRecord,
    deleteArtifact,
    deleteRun,
    deletingArtifactPaths,
    deletingRunPaths,
    log,
    logOpen,
    openLog,
    refresh,
    runs,
    selected,
    selectedGroup,
    selectedInUse,
    setLogOpen,
  }
}
