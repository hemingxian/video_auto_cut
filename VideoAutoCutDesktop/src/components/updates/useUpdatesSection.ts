import { useCallback, useMemo } from 'react'

import { useBusyAction } from '../../hooks/useBusyAction'
import { progressPercent } from '../../lib/progress'
import type { AppInfo } from '../../types/app'
import { useRuntimeState } from '../runtime/useRuntimeState'
import { buildUpdateViewModel } from './UpdateViewModel'
import { useAppUpdateState } from './useAppUpdateState'
import { isRuntimeWorking, resolveUpdateMode } from './updateState'

export function useUpdatesSection(appInfo: AppInfo | null) {
  const [appUpdate, setAppUpdate] = useAppUpdateState(appInfo?.version || '')
  const [runtime, setRuntime] = useRuntimeState(appInfo?.runtime || null)
  const [busy, runBusy] = useBusyAction()

  const flags = useMemo(() => {
    const appInstalling = appUpdate.status === 'installing'
    const appDownloaded = !appInstalling && (appUpdate.downloaded || appUpdate.status === 'downloaded')
    const appUpdateAvailable = appUpdate.available && !appDownloaded && !appInstalling
    const appChecking = appUpdate.status === 'checking'
    const appDownloading = appUpdate.status === 'downloading'
    const runtimeChecking = runtime?.status === 'checking'
    const runtimeDownloading = runtime?.status === 'downloading'
    const runtimeVerifying = runtime?.status === 'verifying'
    const runtimeExtracting = runtime?.status === 'extracting'
    const runtimeNeedsInstall = Boolean(runtime && !runtime.ready && runtime.status !== 'checking')
    const runtimeUpdateAvailable = runtime?.status === 'available' && Boolean(runtime.ready)
    const runtimeError = runtime?.status === 'error'
    const appError = appUpdate.status === 'error'

    return {
      appChecking,
      appDownloaded,
      appDownloading,
      appError,
      appInstalling,
      appUpdateAvailable,
      runtimeChecking,
      runtimeDownloading,
      runtimeError,
      runtimeExtracting,
      runtimeNeedsInstall,
      runtimeUpdateAvailable,
      runtimeVerifying,
    }
  }, [appUpdate, runtime])

  const working = busy || flags.appChecking || flags.appDownloading || flags.appInstalling || isRuntimeWorking(runtime)

  const mode = useMemo(() => resolveUpdateMode(flags), [flags])
  const view = useMemo(() => buildUpdateViewModel(mode, runtime), [mode, runtime])

  const checkAll = useCallback(async () => {
    await runBusy(async () => {
      const appResult = await window.videoAutoCut.checkForUpdates()
      setAppUpdate(appResult.status)

      const appUpdateAvailable = appResult.status.available || appResult.status.status === 'available'
      const appBusy = appResult.status.status === 'downloading' || appResult.status.status === 'downloaded' || appResult.status.status === 'installing'
      if (appUpdateAvailable || appBusy) return

      setRuntime(await window.videoAutoCut.checkRuntime())
    })
  }, [runBusy, setAppUpdate, setRuntime])

  const primaryAction = useCallback(async () => {
    if (flags.appDownloaded) {
      await window.videoAutoCut.installUpdate()
      return
    }
    if (flags.appInstalling) return

    await runBusy(async () => {
      if (flags.appUpdateAvailable) {
        const result = await window.videoAutoCut.downloadUpdate()
        setAppUpdate(result.status)
        return
      }
      if (flags.runtimeNeedsInstall || flags.runtimeUpdateAvailable) {
        setRuntime(await window.videoAutoCut.downloadRuntime())
        return
      }
      await checkAll()
    })
  }, [checkAll, flags, runBusy, setAppUpdate, setRuntime])

  const runtimeShowingProgress = flags.runtimeDownloading || flags.runtimeVerifying || flags.runtimeExtracting
  const activeProgress = flags.appDownloading
    ? appUpdate.progress
    : flags.appInstalling
      ? appUpdate.progress
    : runtimeShowingProgress
      ? runtime?.progress
      : null
  const progressIndeterminate = false
  const showProgress = flags.appDownloaded || flags.appDownloading || flags.appInstalling || runtimeShowingProgress
  const percent = flags.appDownloaded || flags.appInstalling ? 100 : progressPercent(activeProgress)

  return {
    activeProgress,
    appUpdate,
    clientVersion: appUpdate.currentVersion || appInfo?.version || '-',
    engineVersion: runtime?.localVersion || '未安装',
    mode,
    percent,
    progressIndeterminate,
    primaryAction,
    runtime,
    runtimeExtracting: flags.runtimeExtracting,
    runtimeVerifying: flags.runtimeVerifying,
    showProgress,
    view,
    working,
  }
}
