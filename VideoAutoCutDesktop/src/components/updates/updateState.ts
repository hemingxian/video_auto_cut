import { formatProgressText, hasProgressPercent } from '../../lib/progress'
import type { RuntimeState, UpdateState } from '../../types/videoauto'

export type UpdateMode =
  | 'checking'
  | 'app-downloading'
  | 'app-installing'
  | 'runtime-downloading'
  | 'runtime-verifying'
  | 'runtime-installing'
  | 'app-downloaded'
  | 'all-available'
  | 'app-available'
  | 'runtime-missing'
  | 'runtime-available'
  | 'app-error'
  | 'runtime-error'
  | 'ready'

export function defaultUpdateState(currentVersion = ''): UpdateState {
  return {
    status: 'idle',
    currentVersion,
    configured: false,
    canCheck: false,
    isPackaged: false,
    feedUrl: '',
    feedSource: '',
    available: false,
    downloaded: false,
    availableVersion: '',
    message: '',
    error: '',
    progress: null,
    updateInfo: null,
    lastCheckedAt: '',
  }
}

export function progressText(progress?: { percent?: number; transferred?: number; total?: number; bytesPerSecond?: number } | null) {
  return formatProgressText(progress)
}

export function hasPercent(progress?: { percent?: number } | null) {
  return hasProgressPercent(progress)
}

export function isRuntimeWorking(runtime: RuntimeState | null) {
  return runtime?.status === 'checking' || runtime?.status === 'downloading' || runtime?.status === 'verifying' || runtime?.status === 'extracting'
}

export function resolveUpdateMode({
  appChecking,
  runtimeChecking,
  appDownloading,
  appInstalling,
  runtimeDownloading,
  runtimeVerifying,
  runtimeExtracting,
  appDownloaded,
  appUpdateAvailable,
  runtimeNeedsInstall,
  runtimeUpdateAvailable,
  appError,
  runtimeError,
}: {
  appChecking: boolean
  runtimeChecking: boolean
  appDownloading: boolean
  appInstalling: boolean
  runtimeDownloading: boolean
  runtimeVerifying: boolean
  runtimeExtracting: boolean
  appDownloaded: boolean
  appUpdateAvailable: boolean
  runtimeNeedsInstall: boolean
  runtimeUpdateAvailable: boolean
  appError: boolean
  runtimeError: boolean
}): UpdateMode {
  if (appChecking || runtimeChecking) return 'checking'
  if (appDownloading) return 'app-downloading'
  if (appInstalling) return 'app-installing'
  if (runtimeDownloading) return 'runtime-downloading'
  if (runtimeVerifying) return 'runtime-verifying'
  if (runtimeExtracting) return 'runtime-installing'
  if (appDownloaded) return 'app-downloaded'
  if (appUpdateAvailable && runtimeUpdateAvailable) return 'all-available'
  if (appUpdateAvailable) return 'app-available'
  if (runtimeNeedsInstall) return 'runtime-missing'
  if (runtimeUpdateAvailable) return 'runtime-available'
  if (appError) return 'app-error'
  if (runtimeError) return 'runtime-error'
  return 'ready'
}
