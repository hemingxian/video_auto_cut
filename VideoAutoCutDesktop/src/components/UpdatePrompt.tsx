import appIconUrl from '../assets/app-icon.png'
import { CloseButton } from './common/CloseButton'
import { ProgressBar } from './common/ProgressBar'
import { updatePromptProgressText } from './updates/updatePromptState'
import { useUpdatePrompt } from './updates/useUpdatePrompt'

export function UpdatePrompt({ onDismissed }: { onDismissed?: (key: string) => void }) {
  const {
    busy,
    canShowProgress,
    copy,
    dismiss,
    downloaded,
    downloading,
    hasProgressPercent,
    installing,
    percent,
    progressIndeterminate,
    primaryAction,
    state,
    updateKey,
    version,
    visible,
  } = useUpdatePrompt()

  if (!visible) return null
  const progressLabel = installing ? '安装更新' : downloaded ? '下载完成' : '下载进度'
  const progressValue = installing ? '即将重启' : downloaded ? '100%' : hasProgressPercent ? updatePromptProgressText(state?.progress || null) : '正在下载'
  const showActions = !downloading && !installing && !downloaded

  return <div className="update-prompt-overlay" role="dialog" aria-modal="true">
    <section className={`update-prompt-card shell-update-modal shell-update-modal-v3 is-${installing ? 'installing' : downloaded ? 'ready' : downloading ? 'downloading' : 'available'}`}>
      <CloseButton className="update-dialog-close" disabled={installing} onClick={() => {
        dismiss()
        if (updateKey) onDismissed?.(updateKey)
      }} />

      <div className="shell-update-v3-head">
        <div className="shell-update-icon"><img src={appIconUrl} alt="" /></div>
        <div className="shell-update-copy">
          <span className="shell-update-product">VideoAutoCut Studio</span>
          <div className="shell-update-title-row">
            <strong>{copy.title}</strong>
            {version ? <span className="shell-update-version-inline">v{version}</span> : null}
          </div>
          <p>{copy.description}</p>
        </div>
      </div>

      {canShowProgress ? <div className="modal-progress shell-update-progress">
        <div className="modal-progress-head">
          <span>{progressLabel}</span>
          <strong>{progressValue}</strong>
        </div>
        <ProgressBar ariaLabel="软件更新进度" indeterminate={progressIndeterminate} size="compact" value={hasProgressPercent || downloaded || installing ? percent : 0} />
      </div> : null}

      {showActions ? <div className="modal-actions">
        <button className="button" type="button" onClick={() => {
          dismiss()
          if (updateKey) onDismissed?.(updateKey)
        }} disabled={busy || downloading}>稍后</button>
        <button className="button primary" type="button" onClick={primaryAction} disabled={busy || downloading}>
          {copy.primary}
        </button>
      </div> : null}
    </section>
  </div>
}
