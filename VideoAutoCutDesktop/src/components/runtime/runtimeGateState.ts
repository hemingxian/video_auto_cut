import { formatPercent, formatProgressText, hasProgressPercent } from '../../lib/progress'
import type { RuntimeState } from '../../types/videoauto'

export function hasRuntimePercent(progress: RuntimeState['progress']) {
  return hasProgressPercent(progress)
}

export function runtimeUpdateKey(state: RuntimeState | null) {
  if (!state?.latestVersion) return ''
  return `runtime:${state.latestVersion}`
}

export function isInstallingRuntime(state: RuntimeState | null) {
  return state?.status === 'downloading' || state?.status === 'verifying' || state?.status === 'extracting'
}

export function canUseApp(state: RuntimeState | null) {
  return Boolean(state?.ready && !isInstallingRuntime(state))
}

export function shouldShowGate(state: RuntimeState | null, dismissedKey: string, actionStarted: boolean) {
  if (!state) return false
  if (isInstallingRuntime(state)) return true
  if (!state.ready) return true
  if (state.status === 'available') return runtimeUpdateKey(state) !== dismissedKey
  if (state.status === 'error') return actionStarted
  return false
}

export function titleFor(state: RuntimeState | null, checked: boolean) {
  if (!checked || state?.status === 'checking') return '正在准备'
  if (state?.status === 'downloading') return '正在下载更新'
  if (state?.status === 'verifying') return '正在校验安装包'
  if (state?.status === 'extracting') return '正在安装更新'
  if (state?.status === 'error') return state.ready ? '更新失败' : '安装失败'
  if (state?.status === 'available') return state.ready ? '发现新版本' : '需要安装视频生成引擎'
  return '已准备就绪'
}

export function descriptionFor(state: RuntimeState | null) {
  if (state?.status === 'downloading') return '请保持网络连接。'
  if (state?.status === 'verifying') return '正在确认安装包完整性。'
  if (state?.status === 'extracting') return '请不要关闭软件。'
  if (state?.status === 'available') return state.ready ? '发现新版本，建议立即升级。' : '首次使用前需要完成安装。'
  if (state?.status === 'error') return '请稍后重试。'
  return '正在检查本机环境。'
}

export function phaseLabel(state: RuntimeState | null, checked: boolean) {
  if (!checked || state?.status === 'checking') return '检查中'
  if (state?.status === 'verifying') return '校验中'
  if (state?.status === 'extracting') return '安装中'
  if (state?.status === 'downloading') return '下载中'
  if (state?.status === 'available') return state.ready ? '可更新' : '待安装'
  if (state?.ready) return '已完成'
  if (state?.status === 'error') return '未完成'
  return '等待安装'
}

export function statusText(state: RuntimeState | null, checked: boolean) {
  if (!checked || state?.status === 'checking') return '正在检查状态'
  if (state?.status === 'downloading') return '正在下载文件'
  if (state?.status === 'verifying') return '正在校验安装包'
  if (state?.status === 'extracting') return '正在安装到本机'
  if (state?.status === 'available') return state.ready ? '可以稍后更新' : '必须安装后才能使用'
  if (state?.ready) return '可以正常使用'
  if (state?.status === 'error') return '操作没有完成'
  return '准备安装'
}

export function progressDetail(state: RuntimeState | null, percent: number) {
  const progress = state?.progress
  if (state?.status === 'downloading') return formatProgressText({ ...progress, percent })
  return formatPercent(percent)
}

export function versionText(state: RuntimeState | null) {
  if (!state?.latestVersion) return ''
  return `视频生成引擎 v${state.latestVersion.replace(/^v/i, '')}`
}
