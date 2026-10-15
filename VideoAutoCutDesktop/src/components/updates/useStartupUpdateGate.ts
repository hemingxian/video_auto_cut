import { useCallback, useEffect, useMemo, useState } from 'react'

import type { UpdateState } from '../../types/videoauto'
import {
  isUpdateDownloaded,
  isUpdateDownloading,
  isUpdateInstalling,
  updatePromptKey,
} from './updatePromptState'
import { useAppUpdateState } from './useAppUpdateState'

function isUpdateBusy(update: UpdateState): boolean {
  return isUpdateDownloading(update) || isUpdateDownloaded(update) || isUpdateInstalling(update)
}

function shouldBlockRuntime(update: UpdateState, startupChecked: boolean, dismissedKey: string, runtimeInstallRequired: boolean): boolean {
  if (runtimeInstallRequired && !isUpdateBusy(update)) return false
  if (!startupChecked || update.status === 'checking') return true
  if (isUpdateBusy(update)) return true

  const key = updatePromptKey(update)
  return Boolean(key && key !== dismissedKey)
}

export function useStartupUpdateGate(enabled: boolean, runtimeInstallRequired = false) {
  const [update, setUpdate] = useAppUpdateState()
  const [startupChecked, setStartupChecked] = useState(false)
  const [dismissedKey, setDismissedKey] = useState('')

  useEffect(() => {
    if (!enabled || startupChecked) return
    let alive = true

    window.videoAutoCut.checkForUpdates()
      .then((result) => {
        if (!alive) return
        setUpdate(result.status)
        setStartupChecked(true)
      })
      .catch(() => {
        if (!alive) return
        setStartupChecked(true)
      })

    return () => {
      alive = false
    }
  }, [enabled, setUpdate, startupChecked])

  const dismissUpdate = useCallback((key: string) => {
    setDismissedKey(key)
  }, [])

  return useMemo(() => ({
    allowRuntimeGate: enabled && !shouldBlockRuntime(update, startupChecked, dismissedKey, runtimeInstallRequired),
    allowUpdatePrompt: enabled && (!runtimeInstallRequired || isUpdateBusy(update)),
    dismissUpdate,
    startupChecked,
    update,
  }), [dismissUpdate, dismissedKey, enabled, runtimeInstallRequired, startupChecked, update])
}
