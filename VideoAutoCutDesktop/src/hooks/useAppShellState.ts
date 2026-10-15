import { useCallback, useEffect, useRef, useState } from 'react'

import type { AppInfo, Page } from '../types/app'
import type { AuthState } from '../types/videoauto'
import { useToast } from './useToast'

export function useAppShellState() {
  const [page, setPage] = useState<Page>('start')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [auth, setAuthState] = useState<AuthState | null>(null)
  const authEpoch = useRef(0)
  const setAuth = useCallback((next: AuthState) => {
    authEpoch.current += 1
    setAuthState(next)
  }, [])
  const [rechargeOpen, setRechargeOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const { toast, showToast } = useToast()

  useEffect(() => {
    window.videoAutoCut.appInfo().then(setAppInfo)
    let cancelled = false
    const epoch = authEpoch.current

    async function restoreAuth() {
      const storedAuth = await window.videoAutoCut.authStatus()
      if (cancelled || epoch !== authEpoch.current) return
      if (!storedAuth.loggedIn) {
        if (!cancelled) setAuth(storedAuth)
        return
      }

      const result = await window.videoAutoCut.authRefresh()
      if (cancelled || epoch !== authEpoch.current) return
      setAuth(result.auth || storedAuth)
      if (!result.ok) showToast(result.message || 'AI 服务初始化失败，请稍后重试')
      else if (result.warning) showToast(result.warning)
    }

    void restoreAuth()
    return () => {
      cancelled = true
    }
  }, [setAuth, showToast])

  useEffect(() => {
    if (!auth) return
    window.videoAutoCut.setWindowMode(auth.loggedIn ? 'main' : 'auth')
  }, [auth])

  const handleRuntimeReady = useCallback(() => {
    window.videoAutoCut.appInfo().then(setAppInfo)
  }, [])

  const refreshAuth = useCallback(async () => {
    const epoch = authEpoch.current
    try {
      const result = await window.videoAutoCut.authRefresh()
      if (epoch !== authEpoch.current) return false
      if (result.auth) setAuth(result.auth)
      if (!result.ok) showToast(result.message || '余额刷新失败，请稍后重试')
      else if (result.warning) showToast(result.warning)
      return result.ok
    } catch {
      if (epoch !== authEpoch.current) return false
      showToast('余额刷新失败，请检查网络后重试')
      return false
    }
  }, [setAuth, showToast])

  const refreshAuthAfterRecharge = useCallback(async () => {
    if (!await refreshAuth()) return
    setRechargeOpen(false)
    showToast('充值成功，余额已更新')
  }, [refreshAuth, showToast])

  const openAccount = useCallback(() => {
    setAccountOpen(true)
    void refreshAuth()
  }, [refreshAuth])

  const closeAccount = useCallback(() => {
    setAccountOpen(false)
  }, [])

  const openRecharge = useCallback(() => {
    setAccountOpen(false)
    setRechargeOpen(true)
  }, [])

  const closeRecharge = useCallback(() => {
    setRechargeOpen(false)
  }, [])

  const logout = useCallback(async () => {
    const epoch = ++authEpoch.current
    const nextAuth = await window.videoAutoCut.authLogout()
    if (epoch !== authEpoch.current) return
    setAuth(nextAuth)
    setAccountOpen(false)
    setRechargeOpen(false)
  }, [setAuth])

  return {
    accountOpen,
    appInfo,
    auth,
    closeAccount,
    closeRecharge,
    handleRuntimeReady,
    logout,
    openAccount,
    openRecharge,
    page,
    rechargeOpen,
    refreshAuthAfterRecharge,
    setAuth,
    setPage,
    toast,
  }
}
