import { useEffect, useMemo, useState } from 'react'

import { progressTemplates } from '../../config/progressTemplates'
import type { ProgressTemplateRecord } from '../../types/videoauto'
import {
  featuredProgressTemplates,
  progressTemplateItems,
  resolveProgressTemplate,
  selectedProgressTemplateKey,
} from './progressTemplateModel'
import { DEFAULT_PROGRESS_TEMPLATE } from './progressTemplateStyle'

export function useProgressTemplateLibrary(selectedValue: unknown) {
  const [userTemplates, setUserTemplates] = useState<ProgressTemplateRecord[]>([])
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let active = true
    window.videoAutoCut.readProgressTemplates()
      .then((templates) => {
        if (active) setUserTemplates(templates)
      })
      .catch((error) => {
        if (active) setLoadError(String(error instanceof Error ? error.message : error))
      })
    return () => { active = false }
  }, [])

  const items = useMemo(
    () => progressTemplateItems(progressTemplates, userTemplates),
    [userTemplates],
  )
  const selectedKey = selectedProgressTemplateKey(selectedValue)
  const selected = resolveProgressTemplate(items, selectedKey)
    || { ...DEFAULT_PROGRESS_TEMPLATE, source: 'built-in' as const }
  const featured = useMemo(
    () => featuredProgressTemplates(items, selected.key),
    [items, selected.key],
  )
  const customTemplates = useMemo(
    () => items.filter((template) => template.source === 'user'),
    [items],
  )
  const builtInTemplates = useMemo(
    () => items.filter((template) => template.source === 'built-in'),
    [items],
  )

  async function persist(next: ProgressTemplateRecord[]) {
    const saved = await window.videoAutoCut.writeProgressTemplates(next)
    setUserTemplates(saved)
    return saved
  }

  return {
    builtInTemplates,
    customTemplates,
    featured,
    items,
    loadError,
    persist,
    selected,
    selectedKey,
    userTemplates,
  }
}

export type ProgressTemplateLibrary = ReturnType<typeof useProgressTemplateLibrary>
