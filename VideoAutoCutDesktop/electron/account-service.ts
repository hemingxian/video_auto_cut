import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { gatewayRemoteEnv, getGatewayKey, type RequestJson } from './aliyun-gateway-key.js'
import { mergeAuthUserDisplay, normalizeAgentAuthPayload, sanitizeAuthUser } from './auth-utils.js'
import { normalizeQrCode, normalizeRechargeErrorMessage, normalizeRechargeStatus } from './billing-normalizers.js'
import { httpJson, readResponseBody } from './http.js'
import { coerceRemoteEnv, extractRemoteEnv, withoutGatewayCredentials } from './managed-config.js'
import { asRecord, errorMessage, numberValue, type EnvReader, type JsonRecord } from './types.js'
import { cleanConfiguredPath, ensureDir, firstConfiguredValue, safeJsonRead } from './utils.js'

interface AccountServiceOptions {
  authStatePath: string
  agentBaseUrl: string
  sub2ApiBaseUrl: string
  registerUrl: string
  defaultRechargeUrl: string
  rechargeUrlEnvKeys?: string[]
  readEnv?: EnvReader
  setRemoteEnv?: (updates: Record<string, unknown>) => unknown
  clearRemoteEnv?: () => unknown
  openExternal?: (url: string) => Promise<unknown> | unknown
  requestJson?: RequestJson
  onAuthStateChanged?: () => void
}

interface AuthLoginOptions {
  identifier?: unknown
  email?: unknown
  password?: unknown
  captchaToken?: unknown
  captchaCode?: unknown
}

interface RechargeOptions {
  amount?: unknown
  outTradeNo?: unknown
}

interface RechargeStatusOptions {
  outTradeNo?: unknown
}

function createTradeNo(): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const random = crypto.randomBytes(4).toString('hex')
  return `vacut_${stamp}_${random}`
}

function createAccountService(options: AccountServiceOptions) {
  const {
    authStatePath,
    agentBaseUrl,
    sub2ApiBaseUrl,
    registerUrl,
    defaultRechargeUrl,
    rechargeUrlEnvKeys = [],
  } = options
  const readEnv = options.readEnv ?? (() => ({}))
  const setRemoteEnv = options.setRemoteEnv ?? (() => undefined)
  const clearRemoteEnv = options.clearRemoteEnv ?? (() => undefined)
  const openExternal = options.openExternal ?? (async () => undefined)
  const requestJson = options.requestJson ?? httpJson
  let authEpoch = 0

  function assertCurrentAuth(epoch: number) {
    if (epoch !== authEpoch) throw new Error('账号已切换，已取消旧账号请求')
  }

  function publicAuthState(value: unknown) {
    const state = asRecord(value)
    const token = cleanConfiguredPath(state.accessToken || state.token)
    const user = sanitizeAuthUser(state.user)

    return {
      loggedIn: Boolean(token && user),
      user,
      expiresAt: cleanConfiguredPath(state.expiresAt),
      updatedAt: cleanConfiguredPath(state.updatedAt),
    }
  }

  function readAuthState(): JsonRecord {
    return safeJsonRead<JsonRecord>(authStatePath, {})
  }

  function writeAuthState(state: JsonRecord) {
    ensureDir(path.dirname(authStatePath))
    fs.writeFileSync(authStatePath, JSON.stringify(state, null, 2), 'utf8')
    options.onAuthStateChanged?.()
    return publicAuthState(state)
  }

  function clearAuthState() {
    authEpoch += 1
    try {
      if (fs.existsSync(authStatePath)) fs.unlinkSync(authStatePath)
    } catch (_error) {}
    clearRemoteEnv()
    options.onAuthStateChanged?.()
    return publicAuthState({})
  }

  function collectRemoteConfigEnv(...payloads: unknown[]) {
    const env: Record<string, string> = {}
    for (const payload of payloads) Object.assign(env, extractRemoteEnv(payload))
    return env
  }

  function syncRemoteConfigEnv(value: unknown) {
    const env = coerceRemoteEnv(value)
    if (Object.keys(env).length) setRemoteEnv(env)
    return env
  }

  function syncRemoteConfigFromState() {
    clearRemoteEnv()
    const restored = withoutGatewayCredentials(readAuthState().remoteConfigEnv)
    return syncRemoteConfigEnv(restored)
  }

  function gatewayProvisionErrorCode(error: unknown): string {
    const details = asRecord(error)
    const message = cleanConfiguredPath(details.message)
    if (/^[A-Z][A-Z0-9_]{2,63}$/.test(message)) return message
    const status = numberValue(details.status, 0)
    return status ? `HTTP_${status}` : 'UNKNOWN_ERROR'
  }

  function gatewayProvisionError(error: unknown): Error {
    const code = gatewayProvisionErrorCode(error)
    const status = numberValue(asRecord(error).status, 0)
    const message = code === 'GATEWAY_KEY_UNAVAILABLE'
      ? '当前账号尚未分配 AI 服务密钥，请联系管理员'
      : `AI 服务密钥初始化失败，请稍后重试（${code}）`
    return Object.assign(new Error(message, { cause: error }), {
      status,
      data: { reason: code },
    })
  }

  async function syncAliyunGatewayEnv(accessToken: string, current: Record<string, string>, epoch: number) {
    try {
      const result = await getGatewayKey({
        baseUrl: sub2ApiBaseUrl,
        accessToken,
        requestJson,
      })
      assertCurrentAuth(epoch)
      console.info('[auth:gateway-key] ready', {
        keyId: result.keyId,
        groupId: result.groupId,
      })
      return {
        ...withoutGatewayCredentials(current),
        ...gatewayRemoteEnv(result, sub2ApiBaseUrl),
      }
    } catch (error) {
      assertCurrentAuth(epoch)
      const code = gatewayProvisionErrorCode(error)
      console.warn('[auth:gateway-key] sync failed', {
        code,
      })
      clearRemoteEnv()
      throw gatewayProvisionError(error)
    }
  }

  function authError(error: unknown) {
    const details = asRecord(error)
    const data = asRecord(details.data)

    return {
      ok: false,
      message: errorMessage(error, '请求失败'),
      status: numberValue(details.status, 0),
      reason: cleanConfiguredPath(data.reason || data.error),
      retryAfterSeconds: data.retryAfterSeconds,
      auth: publicAuthState(readAuthState()),
    }
  }

  async function authCaptcha() {
    try {
      const data = await requestJson(`${agentBaseUrl}/api/auth/captcha`, {
        timeoutMs: 12000,
      })
      const nested = asRecord(data.data)

      return {
        ok: true,
        captchaToken: cleanConfiguredPath(data.captchaToken || nested.captchaToken),
        svg: String(data.svg || nested.svg || ''),
      }
    } catch (error) {
      return authError(error)
    }
  }

  async function createSub2ApiSession(agentToken: unknown) {
    const token = cleanConfiguredPath(agentToken)
    if (!token) throw new Error('A 系统登录成功，但没有返回登录凭证')

    const payload = await requestJson(`${agentBaseUrl}/api/billing/sub2api-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: {},
      timeoutMs: 20000,
    })

    return {
      accessToken: cleanConfiguredPath(payload.accessToken),
      expiresIn: numberValue(payload.expiresIn, 0),
      tokenType: cleanConfiguredPath(payload.tokenType) || 'Bearer',
    }
  }

  function sessionExpiresSoon(state: JsonRecord): boolean {
    const expiresAt = Date.parse(cleanConfiguredPath(state.expiresAt))
    return Number.isFinite(expiresAt) && expiresAt <= Date.now() + 120_000
  }

  async function authLogin(options: AuthLoginOptions = {}) {
    const identifier = String(options.identifier || options.email || '').trim()
    const password = String(options.password || '')
    const captchaToken = cleanConfiguredPath(options.captchaToken)
    const captchaCode = String(options.captchaCode || '').trim()

    if (!identifier) return { ok: false, message: '请输入邮箱或手机号' }
    if (!password) return { ok: false, message: '请输入密码' }
    if (!captchaToken || !captchaCode) return { ok: false, message: '请输入图形验证码' }

    const epoch = ++authEpoch

    try {
      const agentData = await requestJson(`${agentBaseUrl}/api/auth/login`, {
        method: 'POST',
        body: {
          identifier,
          password,
          captchaToken,
          captchaCode,
        },
        timeoutMs: 20000,
      })
      assertCurrentAuth(epoch)
      const agentPayload = normalizeAgentAuthPayload(agentData)
      const nestedAgentData = asRecord(agentData.data)
      const agentToken = cleanConfiguredPath(agentPayload.token || agentData.token || nestedAgentData.token)
      const agentUser = asRecord(agentPayload.user)
      const sub2apiSession = await createSub2ApiSession(agentToken)
      assertCurrentAuth(epoch)
      if (!sub2apiSession.accessToken) throw new Error('没有获取到 Sub2API 访问凭证')
      const remoteConfigEnv = await syncAliyunGatewayEnv(
        sub2apiSession.accessToken,
        collectRemoteConfigEnv(agentData, agentPayload, agentUser),
        epoch,
      )
      const persistedRemoteConfigEnv = withoutGatewayCredentials(remoteConfigEnv)
      const accountData = await requestJson(`${sub2ApiBaseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${sub2apiSession.accessToken}` },
      })
      assertCurrentAuth(epoch)
      const accountUser = mergeAuthUserDisplay(
        accountData.data || accountData.user || accountData,
        agentUser,
      )
      if (!accountUser) throw new Error('没有获取到用户信息')

      // Also invalidate refreshes that began while this login was in flight.
      authEpoch += 1
      syncRemoteConfigEnv(remoteConfigEnv)
      const auth = writeAuthState({
        accessToken: sub2apiSession.accessToken,
        token: sub2apiSession.accessToken,
        tokenType: sub2apiSession.tokenType,
        expiresAt: sub2apiSession.expiresIn ? new Date(Date.now() + sub2apiSession.expiresIn * 1000).toISOString() : '',
        user: accountUser,
        agentToken,
        agentUserId: cleanConfiguredPath(agentUser.id),
        remoteConfigEnv: persistedRemoteConfigEnv,
        remoteConfigUpdatedAt: Object.keys(persistedRemoteConfigEnv).length ? new Date().toISOString() : '',
        updatedAt: new Date().toISOString(),
      })

      return { ok: true, auth }
    } catch (error) {
      return authError(error)
    }
  }

  async function authRefresh() {
    const epoch = authEpoch
    const state = readAuthState()
    const storedToken = cleanConfiguredPath(state.accessToken || state.token)
    const agentToken = cleanConfiguredPath(state.agentToken)
    if (!storedToken) return { ok: false, message: '未登录', auth: publicAuthState({}) }

    try {
      let session = {
        accessToken: storedToken,
        expiresIn: 0,
        tokenType: cleanConfiguredPath(state.tokenType) || 'Bearer',
      }
      if (sessionExpiresSoon(state) && agentToken) session = await createSub2ApiSession(agentToken)
      assertCurrentAuth(epoch)
      if (!session.accessToken) throw new Error('没有获取到 Sub2API 访问凭证')

      const loadAccount = async () => {
        const data = await requestJson(`${sub2ApiBaseUrl}/api/v1/auth/me`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        })
        assertCurrentAuth(epoch)
        const user = mergeAuthUserDisplay(data.data || data.user || data, state.user)
        if (!user) throw new Error('没有获取到用户信息')
        const remoteConfigEnv = {
          ...coerceRemoteEnv(state.remoteConfigEnv),
          ...collectRemoteConfigEnv(data, data.data, data.user),
        }
        return { user, remoteConfigEnv }
      }

      let account
      try {
        account = await loadAccount()
      } catch (error) {
        assertCurrentAuth(epoch)
        const status = numberValue(asRecord(error).status, 0)
        if (status !== 401 || !agentToken || session.accessToken !== storedToken) throw error
        session = await createSub2ApiSession(agentToken)
        assertCurrentAuth(epoch)
        if (!session.accessToken) throw new Error('没有获取到 Sub2API 访问凭证', { cause: error })
        account = await loadAccount()
      }

      const { user, remoteConfigEnv } = account
      assertCurrentAuth(epoch)
      const persistedRemoteConfigEnv = withoutGatewayCredentials(remoteConfigEnv)

      const auth = writeAuthState({
        ...state,
        accessToken: session.accessToken,
        token: session.accessToken,
        tokenType: session.tokenType,
        expiresAt: session.expiresIn
          ? new Date(Date.now() + session.expiresIn * 1000).toISOString()
          : cleanConfiguredPath(state.expiresAt),
        user,
        remoteConfigEnv: persistedRemoteConfigEnv,
        remoteConfigUpdatedAt: Object.keys(persistedRemoteConfigEnv).length ? new Date().toISOString() : cleanConfiguredPath(state.remoteConfigUpdatedAt),
        updatedAt: new Date().toISOString(),
      })

      // Persist a successful account response independently of AI key provisioning.
      // A key endpoint failure must not discard a fresh balance or sign the user out.
      try {
        const gatewayEnv = await syncAliyunGatewayEnv(session.accessToken, remoteConfigEnv, epoch)
        assertCurrentAuth(epoch)
        syncRemoteConfigEnv(gatewayEnv)
        return { ok: true, auth }
      } catch (error) {
        assertCurrentAuth(epoch)
        return { ok: true, auth, warning: `账户信息已更新；${errorMessage(error, 'AI 服务暂不可用，请稍后重试')}` }
      }
    } catch (error) {
      if (epoch !== authEpoch) return authError(error)
      clearRemoteEnv()
      const status = numberValue(asRecord(error).status, 0)
      if (status === 401 || status === 403) clearAuthState()
      return authError(error)
    }
  }

  async function authCreateRecharge(options: RechargeOptions = {}) {
    const amount = Number(options.amount)
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: '请输入有效充值金额' }

    const state = readAuthState()
    const token = cleanConfiguredPath(state.accessToken || state.token)
    if (!token) return { ok: false, message: '未登录', auth: publicAuthState({}) }

    const env = readEnv()
    const configured = cleanConfiguredPath(firstConfiguredValue(rechargeUrlEnvKeys, env))
    const url = configured || defaultRechargeUrl
    const outTradeNo = cleanConfiguredPath(options.outTradeNo) || createTradeNo()

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json,image/*,*/*',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          amount,
          out_trade_no: outTradeNo,
          payment_type: 'alipay',
          order_type: 'balance',
          payment_source: 'desktop_qrcode',
          is_mobile: false,
        }),
      })
      const body = await readResponseBody(response)

      if (!response.ok) {
        const message = body.json?.message || body.json?.reason || body.text || `HTTP ${response.status}`
        return { ok: false, message: normalizeRechargeErrorMessage(message), status: response.status }
      }

      if (!body.json) {
        return { ok: false, message: '充值接口返回格式异常', status: response.status }
      }

      const payloadData = asRecord(body.json.data)
      const payload = Object.keys(payloadData).length ? payloadData : body.json
      const returnedTradeNo = cleanConfiguredPath(payload.out_trade_no) || outTradeNo
      const qrCode = normalizeQrCode(payload.qr_code)
      const payUrl = cleanConfiguredPath(payload.pay_url)
      const orderId = numberValue(payload.order_id, 0) || undefined
      const payAmount = numberValue(payload.pay_amount, 0) || amount
      const paymentType = cleanConfiguredPath(payload.payment_type) || 'alipay'
      const expiresAt = cleanConfiguredPath(payload.expires_at)
      const paymentMode = cleanConfiguredPath(payload.payment_mode)

      console.info('[auth:recharge] payment response', {
        resultType: cleanConfiguredPath(payload.result_type),
        paymentType,
        paymentMode,
        hasQrCode: Boolean(qrCode),
        hasPayUrl: Boolean(payUrl),
      })

      if (!qrCode) {
        return {
          ok: false,
          amount,
          payAmount,
          outTradeNo: returnedTradeNo,
          contentType: body.contentType,
          message: '支付通道未返回支付二维码',
          raw: body.json,
        }
      }

      return {
        ok: true,
        orderId,
        amount,
        payAmount,
        outTradeNo: returnedTradeNo,
        contentType: body.contentType,
        qrCode,
        payUrl,
        paymentType,
        expiresAt,
        paymentMode,
        message: '',
        raw: body.json,
      }
    } catch (error) {
      return authError(error)
    }
  }

  async function authQueryRechargeStatus(options: RechargeStatusOptions = {}) {
    const outTradeNo = cleanConfiguredPath(options.outTradeNo)
    if (!outTradeNo) return { ok: false, message: '缺少订单号' }

    const state = readAuthState()
    const token = cleanConfiguredPath(state.accessToken || state.token)
    if (!token) return { ok: false, message: '未登录', auth: publicAuthState({}) }

    try {
      const data = await requestJson(`${sub2ApiBaseUrl}/api/v1/payment/orders/verify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { out_trade_no: outTradeNo },
        timeoutMs: 8000,
      })

      if (typeof data.code === 'number' && data.code !== 0) {
        return { ok: false, message: data.message || data.reason || '查询支付状态失败', reason: data.reason || '', raw: data }
      }

      const normalized = normalizeRechargeStatus(data, outTradeNo)
      console.info('[auth:recharge-status] verify result', {
        outTradeNo: normalized.outTradeNo,
        orderStatus: normalized.orderStatus,
        hasPaidAt: Boolean(normalized.paidAt),
        hasCompletedAt: Boolean(normalized.completedAt),
      })

      return {
        ok: true,
        ...normalized,
        raw: data,
      }
    } catch (error) {
      return authError(error)
    }
  }

  async function authOpenRegister() {
    await openExternal(registerUrl)
    return { ok: true }
  }

  return {
    publicAuthState,
    readAuthState,
    clearAuthState,
    syncRemoteConfigFromState,
    authCaptcha,
    authLogin,
    authRefresh,
    authCreateRecharge,
    authQueryRechargeStatus,
    authOpenRegister,
  }
}

export {
  createAccountService,
}
