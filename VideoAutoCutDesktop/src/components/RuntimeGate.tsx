import appIconUrl from '../assets/app-icon.png'
import { CloseButton } from './common/CloseButton'
import { ProgressBar } from './common/ProgressBar'
import {
  descriptionFor,
  phaseLabel,
  progressDetail,
  statusText,
  titleFor,
} from './runtime/runtimeGateState'
import { useRuntimeGate } from './runtime/useRuntimeGate'

export function RuntimeGate({ onReady }: { onReady: () => void }) {
  const {
    canClose,
    canDownload,
    check,
    checked,
    dismiss,
    download,
    hasProgressPercent,
    installRequired,
    percent,
    progressIndeterminate,
    progressVisible,
    showGate,
    showStatusLine,
    starting,
    state,
    updateAvailable,
    versionInfo,
    working,
  } = useRuntimeGate(onReady)

  if (!showGate) return null
  if (state?.ready && !updateAvailable && !working && state.status !== 'error') return null

  const phase = starting ? '准备中' : phaseLabel(state, checked)
  const status = starting
    ? (updateAvailable ? '正在准备更新' : '正在准备安装')
    : statusText(state, checked)
  const title = starting
    ? (updateAvailable ? '正在准备更新' : '正在准备安装')
    : titleFor(state, checked)
  const description = starting ? '正在连接下载服务。' : descriptionFor(state)
  const showActionStatus = showStatusLine && !progressVisible
  const showBody = progressVisible || Boolean(state?.error)
  const showPrimaryAction = (installRequired || updateAvailable) && !working && !progressVisible
  const showRetryAction = state?.status === 'error'
  const showLaterAction = updateAvailable && !working
  const showActions = showActionStatus || showRetryAction || showLaterAction || showPrimaryAction

  return <div className="runtime-dialog-overlay" role="dialog" aria-modal="true">
    <section className={`runtime-dialog-card runtime-install-modal runtime-install-modal-v2 is-${state?.status || 'checking'}`}>
      {canClose ? <CloseButton className="update-dialog-close" onClick={dismiss} /> : null}

      <div className="runtime-install-head">
        <div className="runtime-install-icon"><img src={appIconUrl} alt="" /></div>
        <div className="runtime-install-copy">
          <span>VideoAutoCut Studio</span>
          <strong>{title}</strong>
          <p>{description}</p>
          {versionInfo ? <small className="runtime-install-version-text">{versionInfo}</small> : null}
        </div>
      </div>

      {showBody ? <div className="runtime-install-body">
        {progressVisible ? <div className="modal-progress runtime-install-progress">
          <div className="modal-progress-head">
            <span>{phase}</span>
            <strong>{hasProgressPercent && !starting ? progressDetail(state, percent) : status}</strong>
          </div>
          <ProgressBar ariaLabel="运行时安装进度" indeterminate={progressIndeterminate} size="compact" value={hasProgressPercent ? percent : 0} />
        </div> : null}

        {state?.error ? <p className="runtime-install-error">{state.error}</p> : null}
      </div> : null}

      {showActions ? <div className="modal-actions">
        {showActionStatus ? <div className="runtime-install-action-hint">
          <strong>{phase}</strong>
          <span>{status}</span>
        </div> : null}
        {showRetryAction && <button className="button" onClick={check} disabled={working}>重试</button>}
        {showLaterAction && <button className="button" type="button" onClick={dismiss}>稍后</button>}
        {showPrimaryAction && <button className="button primary" onClick={download} disabled={!canDownload}>{updateAvailable ? '立即更新' : '立即安装'}</button>}
      </div> : null}
    </section>
  </div>
}
