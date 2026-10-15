import { DownloadCloud, RefreshCw, Sparkles } from 'lucide-react'

import appIconUrl from '../assets/app-icon.png'
import type { AppInfo } from '../types/app'
import { Panel } from './common/Panel'
import { ProgressBar } from './common/ProgressBar'
import { progressText } from './updates/updateState'
import { useUpdatesSection } from './updates/useUpdatesSection'

export function UpdatesSection({ appInfo }: { appInfo: AppInfo | null }) {
  const {
    activeProgress,
    clientVersion,
    engineVersion,
    mode,
    percent,
    progressIndeterminate,
    primaryAction,
    runtimeExtracting,
    runtimeVerifying,
    showProgress,
    view,
    working,
  } = useUpdatesSection(appInfo)

  return <div className="settings-update-section simple-settings-update">
    <div className="settings-section-title compact">
      <div>
        <h2>关于与更新</h2>
        <p>查看软件版本并检查更新。</p>
      </div>
    </div>

    <Panel className={`simple-update-card product-about-card is-${view.tone}`}>
      <div className="about-product-main">
        <div className="about-product-mark">
          <img src={appIconUrl} alt="" />
        </div>
        <div className="about-product-copy">
          <span className="about-eyebrow"><Sparkles className="mini-icon" />AI 视频自动剪辑工作台</span>
          <strong>VideoAutoCut Studio</strong>
          <p>面向短视频和口播内容创作，支持脚本解析、素材检索、智能剪辑、语音生成、字幕与成片输出。</p>
          <div className="about-version-row">
            <span>客户端 v{clientVersion}</span>
            <span>视频生成引擎 {engineVersion}</span>
          </div>
          <div className="about-update-status">
            <div className="simple-update-icon">{view.icon}</div>
            <div>
              <strong>{view.title}</strong>
              <p>{view.description}</p>
            </div>
          </div>
        </div>
      </div>

      {mode === 'app-installing' || mode === 'app-downloaded' ? null : <div className="about-update-side">
        <button className="button primary" disabled={working} onClick={primaryAction}>
          {mode === 'ready' || mode.includes('error') || mode === 'checking'
            ? <RefreshCw className={`button-icon ${working ? 'is-spinning' : ''}`} />
            : <DownloadCloud className="button-icon" />}
          {view.button}
        </button>
      </div>}

      {showProgress ? <div className="simple-update-progress">
        <div className="update-progress-head">
          <span>{mode === 'app-installing' ? '安装更新' : mode === 'app-downloaded' ? '已下载' : runtimeVerifying ? '校验进度' : runtimeExtracting ? '安装进度' : '下载进度'}</span>
          <strong>{mode === 'app-installing' ? '即将重启' : mode === 'app-downloaded' ? '100%' : progressIndeterminate ? runtimeVerifying ? '正在校验' : runtimeExtracting ? '正在安装' : '正在处理' : progressText(activeProgress) || '处理中'}</strong>
        </div>
        <ProgressBar ariaLabel="更新下载进度" indeterminate={progressIndeterminate} value={progressIndeterminate ? 0 : percent} />
      </div> : null}
    </Panel>
  </div>
}
