import { useCallback, useEffect, useMemo, useState } from 'react'

import type { GeneratedMaterialRecord, SemanticSearchResult, TaskEvent } from '../../types/videoauto'
import { useAsyncRefresh } from '../../hooks/useAsyncRefresh'
import { usePendingKeys } from '../../hooks/usePendingKeys'
import { confirmDestructiveAction, reportOperationResult } from '../../lib/dialog'
import type { MaterialEngine } from './types'

export function useGenerateMaterial() {
  const [prompt, setPrompt] = useState('')
  const [engine, setEngine] = useState<MaterialEngine>('auto')
  const [generating, setGenerating] = useState(false)
  const [log, setLog] = useState('')
  const [logOpen, setLogOpen] = useState(false)
  const [records, setRecords] = useState<GeneratedMaterialRecord[]>([])
  const [reusedMaterial, setReusedMaterial] = useState<SemanticSearchResult | null>(null)
  const { pendingKeys: deletingIds, runWithPending } = usePendingKeys<string>()

  const latestRecord = useMemo(() => records[0], [records])

  const loadRecords = useCallback(() => window.videoAutoCut.listGeneratedMaterials(), [])
  const applyRecords = useCallback((items: GeneratedMaterialRecord[]) => setRecords(items), [])
  const { refresh: refreshRecords } = useAsyncRefresh({
    load: loadRecords,
    apply: applyRecords,
  })

  async function deleteGeneratedRecord(record: GeneratedMaterialRecord) {
    if (deletingIds.has(record.id)) return
    const confirmed = confirmDestructiveAction(`确定删除生成素材「${record.title || record.prompt || record.id}」吗？\n\n会同步删除输出视频、生成记录和向量索引。`)
    if (!confirmed) return

    await runWithPending(record.id, async () => {
      const result = await window.videoAutoCut.deleteGeneratedMaterial({ id: record.id, outputPath: record.output_path })
      if (!reportOperationResult(result, '删除生成素材失败')) return
      await refreshRecords()
    })
  }

  function handleEngineChange(value: string) {
    setEngine(value as MaterialEngine)
  }

  async function generateMaterial() {
    const text = prompt.trim()
    if (!text) {
      setLog('请输入素材描述')
      setLogOpen(true)
      return
    }

    setGenerating(true)
    setReusedMaterial(null)
    setLog('正在检索素材库...\n')
    setLogOpen(true)
    try {
      const result = await window.videoAutoCut.generateMaterial({ prompt: text, engine })
      if (!result.ok) {
        setGenerating(false)
        setLog(result.message || '生成素材失败')
        return
      }
      if (result.mode === 'reused' && result.reuse) {
        setGenerating(false)
        setReusedMaterial(result.reuse)
        setLog(`${result.message || '已复用素材库中的已有素材'}\n匹配分数：${result.reuse.score.toFixed(3)}\n`)
        return
      }
      if (result.message) setLog((text) => `${text}${result.message}\n`)
    } catch (error) {
      setGenerating(false)
      setLog(`生成素材失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  useEffect(() => {
    const disposeMaterial = window.videoAutoCut.onMaterialEvent((event: TaskEvent) => {
      if (event.type === 'start') {
        setGenerating(true)
        setLog(`>>> ${event.command || '生成素材'}\n`)
      }
      if (event.text) setLog((text) => text + event.text)
      if (event.type === 'close') {
        setGenerating(false)
        setLog((text) => text + `\n素材生成结束，退出码：${event.code}\n`)
        refreshRecords().catch(() => undefined)
      }
    })
    return () => { disposeMaterial() }
  }, [refreshRecords])

  return {
    deletingIds,
    deleteGeneratedRecord,
    engine,
    generateMaterial,
    generating,
    handleEngineChange,
    latestRecord,
    log,
    logOpen,
    prompt,
    records,
    reusedMaterial,
    refreshRecords,
    setLogOpen,
    setPrompt,
  }
}
