import { formatProgressText, hasProgressPercent, progressPercent } from '../../lib/progress'
import type { UpdateState } from '../../types/videoauto'

export interface UpdatePromptCopy {
  title: string
  description: string
  primary: string
  note: string
}

export function updatePromptKey(state: UpdateState | null) {
  if (!state) return ''
  const version = state.availableVersion || state.updateInfo?.version || ''
  if (!version) return ''
  if (state.status === 'installing') return `installing:${version}`
  if (state.downloaded || state.status === 'downloaded') return `downloaded:${version}`
  if (state.available || state.status === 'available') return `available:${version}`
  return ''
}

export function isUpdateDownloaded(state: UpdateState | null) {
  return Boolean((state?.downloaded || state?.status === 'downloaded') && state?.status !== 'installing')
}

export function isUpdateDownloading(state: UpdateState | null) {
  return state?.status === 'downloading'
}

export function isUpdateInstalling(state: UpdateState | null) {
  return state?.status === 'installing'
}

export function updatePromptVersion(state: UpdateState | null) {
  return state?.availableVersion || state?.updateInfo?.version || ''
}

export function hasUpdatePromptPercent(progress: UpdateState['progress']) {
  return hasProgressPercent(progress)
}

export function updatePromptProgressText(progress: UpdateState['progress']) {
  return formatProgressText(progress)
}

export function updatePromptPercent(state: UpdateState | null) {
  if (isUpdateInstalling(state)) return 100
  if (isUpdateDownloaded(state)) return 100
  return progressPercent(state?.progress)
}

export function buildUpdatePromptCopy(downloaded: boolean, downloading: boolean, installing: boolean): UpdatePromptCopy {
  if (installing) {
    return {
      title: '正在安装更新',
      description: '新版本已经下载完成，软件将自动重启完成升级。',
      primary: '正在更新',
      note: '请不要关闭软件。',
    }
  }

  if (downloaded) {
    return {
      title: '更新已准备好',
      description: '新版本已经下载完成，软件将自动重启完成升级。',
      primary: '正在更新',
      note: '请不要关闭软件。',
    }
  }

  if (downloading) {
    return {
      title: '正在下载更新',
      description: '正在获取新版本文件，请保持网络连接。',
      primary: '下载中',
      note: '下载完成后会自动安装并重启。',
    }
  }

  return {
    title: '发现新版本',
    description: '建议升级，项目文件、素材和本地配置不会受影响。',
    primary: '下载更新',
    note: '',
  }
}
