import { AlertCircle, CheckCircle2, DownloadCloud, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import type { RuntimeState } from '../../types/videoauto'
import type { UpdateMode } from './updateState'

export interface UpdateViewModel {
  tone: string
  icon: ReactNode
  title: string
  description: string
  button: string
}

export function buildUpdateViewModel(mode: UpdateMode, runtime: RuntimeState | null): UpdateViewModel {
  switch (mode) {
    case 'checking':
      return {
        tone: 'checking',
        icon: <RefreshCw className="status-icon is-spinning" />,
        title: '正在检查更新',
        description: '请稍候。',
        button: '检查中',
      }
    case 'app-downloading':
      return {
        tone: 'downloading',
        icon: <DownloadCloud className="status-icon" />,
        title: '正在下载软件更新',
        description: '下载完成后会自动安装并重启。',
        button: '下载中',
      }
    case 'app-installing':
      return {
        tone: 'installing',
        icon: <RefreshCw className="status-icon is-spinning" />,
        title: '正在安装软件更新',
        description: '软件即将自动重启完成升级。',
        button: '正在更新',
      }
    case 'runtime-downloading':
      return {
        tone: 'downloading',
        icon: <DownloadCloud className="status-icon" />,
        title: '正在下载更新',
        description: '请保持网络连接。',
        button: '下载中',
      }
    case 'runtime-verifying':
      return {
        tone: 'checking',
        icon: <RefreshCw className="status-icon is-spinning" />,
        title: '正在校验安装包',
        description: '正在确认文件完整性。',
        button: '校验中',
      }
    case 'runtime-installing':
      return {
        tone: 'installing',
        icon: <RefreshCw className="status-icon is-spinning" />,
        title: '正在安装更新',
        description: '请不要关闭软件。',
        button: '安装中',
      }
    case 'app-downloaded':
      return {
        tone: 'installing',
        icon: <RefreshCw className="status-icon is-spinning" />,
        title: '正在安装软件更新',
        description: '软件即将自动重启完成升级。',
        button: '正在更新',
      }
    case 'all-available':
    case 'app-available':
    case 'runtime-available':
      return {
        tone: 'available',
        icon: <DownloadCloud className="status-icon" />,
        title: '软件更新',
        description: '发现新版本，建议立即升级。',
        button: '立即更新',
      }
    case 'runtime-missing':
      return {
        tone: 'available',
        icon: <DownloadCloud className="status-icon" />,
        title: '软件更新',
        description: '需要安装视频生成引擎。',
        button: '立即安装',
      }
    case 'app-error':
      return {
        tone: 'error',
        icon: <AlertCircle className="status-icon warn" />,
        title: '软件检查更新失败',
        description: '请稍后再试。',
        button: '重新检查',
      }
    case 'runtime-error':
      return {
        tone: 'error',
        icon: <AlertCircle className="status-icon warn" />,
        title: runtime?.ready ? '检查更新失败' : '安装失败',
        description: '请稍后再试。',
        button: '重新检查',
      }
    default:
      return {
        tone: 'ready',
        icon: <CheckCircle2 className="status-icon ok" />,
        title: '已是最新版本',
        description: '当前版本可以正常使用。',
        button: '检查更新',
      }
  }
}
