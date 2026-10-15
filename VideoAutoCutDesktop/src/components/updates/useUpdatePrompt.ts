import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useBusyAction } from '../../hooks/useBusyAction'
import {
  buildUpdatePromptCopy,
  hasUpdatePromptPercent,
  isUpdateDownloaded,
  isUpdateDownloading,
  isUpdateInstalling,
  updatePromptKey,
  updatePromptPercent,
  updatePromptVersion,
} from './updatePromptState'
import { useAppUpdateState } from './useAppUpdateState'

export function useUpdatePrompt() {
  const [state, setState] = useAppUpdateState()
  const [dismissedKey, setDismissedKey] = useState('')
  const [busy, runBusy] = useBusyAction()
  const autoInstallKeyRef = useRef('')

  const key = updatePromptKey(state)
  const downloaded = isUpdateDownloaded(state)
  const downloading = isUpdateDownloading(state)
  const installing = isUpdateInstalling(state)
  const displayDownloading = downloading || (busy && !downloaded && !installing)
  const visible = Boolean(key && key !== dismissedKey)

  useEffect(() => {
    if (!downloaded || !key || autoInstallKeyRef.current === key) return
    autoInstallKeyRef.current = key
    window.videoAutoCut.installUpdate().catch((): undefined => undefined)
  }, [downloaded, key])

  const viewState = useMemo(() => ({
    canShowProgress: downloaded || displayDownloading || installing,
    hasProgressPercent: hasUpdatePromptPercent(state?.progress || null),
    copy: buildUpdatePromptCopy(downloaded, displayDownloading, installing),
    percent: updatePromptPercent(state),
    progressIndeterminate: false,
    version: updatePromptVersion(state),
  }), [displayDownloading, downloaded, installing, state])

  const dismiss = useCallback(() => {
    if (key) setDismissedKey(key)
  }, [key])

  const primaryAction = useCallback(async () => {
    if (downloaded) {
      await window.videoAutoCut.installUpdate()
      return
    }
    if (downloading || installing) return

    await runBusy(async () => {
      const result = await window.videoAutoCut.downloadUpdate()
      setState(result.status)
    })
  }, [downloaded, downloading, installing, runBusy, setState])

  return {
    ...viewState,
    busy,
    dismiss,
    downloaded,
    downloading: displayDownloading,
    installing,
    primaryAction,
    state,
    updateKey: key,
    visible,
  }
}
