import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useBusyAction } from '../../hooks/useBusyAction'
import { progressPercent } from '../../lib/progress'
import type { RuntimeState } from '../../types/videoauto'
import { canUseApp, hasRuntimePercent, isInstallingRuntime, runtimeUpdateKey, shouldShowGate, versionText } from './runtimeGateState'
import { useRuntimeState } from './useRuntimeState'

const RUNTIME_DISMISSED_KEY_STORAGE = 'videoautocut.runtime.dismissedUpdateKey'

function readDismissedRuntimeKey() {
  try {
    return window.sessionStorage.getItem(RUNTIME_DISMISSED_KEY_STORAGE) || ''
  } catch {
    return ''
  }
}

function writeDismissedRuntimeKey(key: string) {
  try {
    if (key) window.sessionStorage.setItem(RUNTIME_DISMISSED_KEY_STORAGE, key)
  } catch {
    // sessionStorage may be unavailable in some embedded contexts; in-memory state still works.
  }
}

export function useRuntimeGate(onReady: () => void) {
  const [busy, runBusy] = useBusyAction()
  const [checked, setChecked] = useState(false)
  const [showGate, setShowGate] = useState(false)
  const [dismissedKey, setDismissedKey] = useState(readDismissedRuntimeKey)
  const readyNotifiedRef = useRef(false)
  const actionStartedRef = useRef(false)

  const notifyReady = useCallback(() => {
    if (readyNotifiedRef.current) return
    readyNotifiedRef.current = true
    onReady()
  }, [onReady])

  const applyRuntimeViewState = useCallback((next: RuntimeState) => {
    if (canUseApp(next)) notifyReady()
    if (next.status === 'ready') actionStartedRef.current = false
    setShowGate(shouldShowGate(next, dismissedKey, actionStartedRef.current))
  }, [dismissedKey, notifyReady])

  const [state, setState, runtimeLoaded] = useRuntimeState(null, applyRuntimeViewState)

  const applyRuntimeState = useCallback((next: RuntimeState) => {
    setState(next)
    applyRuntimeViewState(next)
  }, [applyRuntimeViewState, setState])

  useEffect(() => {
    if (!runtimeLoaded || checked) return
    let alive = true

    window.videoAutoCut.checkRuntime({ silent: true }).then((next) => {
      if (!alive) return
      setChecked(true)
      applyRuntimeState(next)
    }).catch(() => {
      if (!alive) return
      setChecked(true)
      if (!state?.ready) setShowGate(true)
    })

    return () => {
      alive = false
    }
  }, [applyRuntimeState, checked, runtimeLoaded, state?.ready])

  async function check() {
    await runBusy(async () => {
      const next = await window.videoAutoCut.checkRuntime()
      setChecked(true)
      applyRuntimeState(next)
    })
  }

  async function download() {
    actionStartedRef.current = true
    setShowGate(true)
    await runBusy(async () => {
      const next = await window.videoAutoCut.downloadRuntime()
      applyRuntimeState(next)
    })
  }

  function dismiss() {
    if (!state?.ready || isInstallingRuntime(state) || busy) return
    const key = runtimeUpdateKey(state)
    if (key) {
      setDismissedKey(key)
      writeDismissedRuntimeKey(key)
    }
    actionStartedRef.current = false
    setShowGate(false)
    notifyReady()
  }

  const viewState = useMemo(() => {
    const progress = state?.progress || null
    const checking = !checked || state?.status === 'checking'
    const downloading = state?.status === 'downloading'
    const verifying = state?.status === 'verifying'
    const extracting = state?.status === 'extracting'
    const updateAvailable = state?.status === 'available' && Boolean(state.ready)
    const installRequired = !state?.ready
    const starting = busy && state?.status === 'available'
    const hasProgressPercent = hasRuntimePercent(progress)
    const progressVisible = starting || downloading || verifying || extracting
    const progressIndeterminate = starting
    const percent = progressPercent(progress)
    const canDownload = Boolean(state?.url || state?.latestVersion)
    const working = busy || checking || downloading || verifying || extracting
    const canClose = Boolean(state?.ready && !working)
    const showStatusLine = Boolean(!updateAvailable || working || state?.status === 'error')

    return {
      canClose,
      canDownload,
      checked,
      checking,
      extracting,
      hasProgressPercent,
      installRequired,
      percent,
      progress,
      progressIndeterminate,
      progressVisible,
      showStatusLine,
      starting,
      updateAvailable,
      verifying,
      versionInfo: versionText(state),
      working,
    }
  }, [busy, checked, state])

  return {
    ...viewState,
    check,
    dismiss,
    download,
    showGate,
    state,
  }
}
