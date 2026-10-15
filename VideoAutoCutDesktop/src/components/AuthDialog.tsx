import { Eye, EyeOff } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import appIconUrl from '../assets/app-icon.png'
import { CloseButton } from './common/CloseButton'
import { useBusyAction } from '../hooks/useBusyAction'
import { cx } from '../lib/className'
import { deferToNextTick } from '../lib/defer'
import type { AppInfo } from '../types/app'
import type { AuthState } from '../types/videoauto'
import './AuthDialog.css'

export function AuthDialog({
  open,
  appInfo,
  locked = false,
  onClose,
  onAuthed,
}: {
  open: boolean
  appInfo?: AppInfo | null
  initialMode?: 'login' | 'register'
  locked?: boolean
  onClose: () => void
  onAuthed: (auth: AuthState) => void
}) {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [captchaToken, setCaptchaToken] = useState('')
  const [captchaSvg, setCaptchaSvg] = useState('')
  const [captchaCode, setCaptchaCode] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [busy, runBusy] = useBusyAction()
  const [captchaLoading, runCaptchaLoading] = useBusyAction()
  const [message, setMessage] = useState('')

  const loadCaptcha = useCallback(async () => {
    await runCaptchaLoading(async () => {
      const result = await window.videoAutoCut.authCaptcha()
      if (!result.ok || !result.captchaToken || !result.svg) {
        setMessage(result.message || '验证码加载失败')
        return
      }
      setCaptchaToken(result.captchaToken)
      setCaptchaSvg(result.svg)
    })
  }, [runCaptchaLoading])

  useEffect(() => {
    if (!open) return
    return deferToNextTick(() => {
      setMessage('')
      setCaptchaCode('')
      loadCaptcha()
    })
  }, [open, loadCaptcha])

  async function submitLogin() {
    if (!identifier.trim() || !password) {
      setMessage('请输入邮箱/手机号和密码')
      return
    }
    if (!captchaCode.trim()) {
      setMessage('请输入验证码')
      return
    }
    setMessage('')
    await runBusy(async () => {
      const result = await window.videoAutoCut.authLogin({
        identifier: identifier.trim(),
        password,
        captchaToken,
        captchaCode: captchaCode.trim(),
      })
      if (!result.ok || !result.auth) {
        setMessage(result.message || '登录失败')
        setCaptchaCode('')
        loadCaptcha()
        return
      }
      onAuthed(result.auth)
      onClose()
    })
  }

  async function openRegister() {
    await window.videoAutoCut.authOpenRegister()
  }

  if (!open) return null

  return <div className="auth-overlay">
    <div className="auth-bg-orb auth-bg-orb-one" />
    <div className="auth-bg-orb auth-bg-orb-two" />
    <div className="auth-card">
      {!locked ? <CloseButton className="auth-close" onClick={onClose} /> : null}

      <div className="auth-brand-simple">
        <div className="auth-logo-wrap"><img src={appIconUrl} alt="" /></div>
        <div>
          <strong>VideoAutoCut Studio</strong>
          <small className="auth-version">v{appInfo?.version || '0.1.0'}</small>
        </div>
      </div>

      <div className="auth-form">
        <input value={identifier} placeholder="邮箱 / 手机号" onChange={(event) => setIdentifier(event.target.value)} />
        <div className="auth-password-field">
          <input type={passwordVisible ? 'text' : 'password'} value={password} placeholder="密码" onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitLogin() }} />
          <button type="button" title={passwordVisible ? '隐藏密码' : '显示密码'} onClick={() => setPasswordVisible((value) => !value)}>
            {passwordVisible ? <EyeOff className="button-icon" /> : <Eye className="button-icon" />}
          </button>
        </div>
        <div className="auth-captcha-row">
          <input value={captchaCode} placeholder="验证码" onChange={(event) => setCaptchaCode(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitLogin() }} />
          <button className="auth-captcha-image" type="button" onClick={loadCaptcha} title="点击刷新验证码" disabled={captchaLoading}>
            {captchaSvg ? <span dangerouslySetInnerHTML={{ __html: captchaSvg }} /> : captchaLoading ? '加载中' : '刷新'}
          </button>
        </div>
        {message ? <div className={cx('auth-message')}>{message}</div> : null}
        <button className="button primary auth-submit" type="button" disabled={busy} onClick={submitLogin}>{busy ? '登录中...' : '登录'}</button>
        <div className="auth-switch-line">还没有账号？<button type="button" onClick={openRegister}>注册账号</button></div>
      </div>
    </div>
  </div>
}
