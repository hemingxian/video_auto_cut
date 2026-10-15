import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAccountService } from '../dist-electron/account-service.js'
import { sanitizeAuthUser } from '../dist-electron/auth-utils.js'

test('unknown account balances remain distinguishable from a confirmed zero', () => {
  for (const balance of [undefined, null, '', 'invalid']) {
    assert.equal(sanitizeAuthUser({ id: 'a', balance }).balanceKnown, false)
  }
  assert.equal(sanitizeAuthUser({ id: 'a', balance: 0 }).balanceKnown, true)
  assert.equal(sanitizeAuthUser({ id: 'a', balance: '0.00' }).balanceKnown, true)
  assert.equal(sanitizeAuthUser({ id: 'a', balance: 0, balanceKnown: false }).balanceKnown, false)
})

const agentBaseUrl = 'https://agent.example.com'
const gatewayBaseUrl = 'https://api.evstai.com'

function createFixture(t, requestJson, initialState, extraOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-account-'))
  const authStatePath = path.join(root, 'auth.json')
  if (initialState) fs.writeFileSync(authStatePath, JSON.stringify(initialState), 'utf8')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const installed = []
  let clearCount = 0
  const service = createAccountService({
    authStatePath,
    agentBaseUrl,
    sub2ApiBaseUrl: gatewayBaseUrl,
    registerUrl: 'https://agent.example.com/register',
    defaultRechargeUrl: 'https://agent.example.com/recharge',
    requestJson,
    setRemoteEnv: (env) => installed.push(env),
    clearRemoteEnv: () => { clearCount += 1 },
    ...extraOptions,
  })

  return {
    authStatePath,
    get clearCount() { return clearCount },
    installed,
    service,
  }
}

function successfulGatewayResponse(url) {
  if (url.includes('/api/v1/keys?')) {
    return { data: { items: [{ id: 21, key: 'account-gateway-key', name: 'VideoAutoCut', group_id: 11, status: 'active' }] } }
  }
  return null
}

test('login retrieves the gateway key with the Sub2API token and keeps it memory-only', async (t) => {
  const calls = []
  const fixture = createFixture(t, async (url, options = {}) => {
    calls.push({ url, options })
    if (url.endsWith('/api/auth/login')) {
      return { token: 'agent-token', user: { id: 'user-1', email: 'user@example.com' } }
    }
    if (url.endsWith('/api/billing/sub2api-session')) {
      assert.equal(options.headers.Authorization, 'Bearer agent-token')
      return { accessToken: 'sub2-token', expiresIn: 3600, tokenType: 'Bearer' }
    }
    if (url.endsWith('/api/v1/auth/me')) {
      assert.equal(options.headers.Authorization, 'Bearer sub2-token')
      return { data: { id: 'user-1', email: 'user@example.com', balance: 88.5 } }
    }
    return successfulGatewayResponse(url)
  })

  const result = await fixture.service.authLogin({
    identifier: 'user@example.com',
    password: 'password',
    captchaToken: 'captcha-token',
    captchaCode: '1234',
  })

  assert.equal(result.ok, true)
  assert.equal(result.auth.user.balance, 88.5)
  const gatewayCalls = calls.filter(({ url }) => url.includes('/keys?'))
  assert.equal(gatewayCalls.length, 1)
  assert.ok(gatewayCalls.every(({ options }) => options.headers.Authorization === 'Bearer sub2-token'))
  assert.deepEqual(fixture.installed.at(-1), {
    DASHSCOPE_API_KEY: 'account-gateway-key',
    DASHSCOPE_BASE_URL: gatewayBaseUrl,
  })

  const persisted = JSON.parse(fs.readFileSync(fixture.authStatePath, 'utf8'))
  assert.equal(persisted.remoteConfigEnv.DASHSCOPE_API_KEY, undefined)
  assert.equal(persisted.remoteConfigEnv.DASHSCOPE_BASE_URL, undefined)
})

test('login reports a registration problem instead of creating a missing gateway key', async (t) => {
  const calls = []
  const fixture = createFixture(t, async (url, options = {}) => {
    calls.push({ url, options })
    if (url.endsWith('/api/auth/login')) {
      return { token: 'agent-token', user: { id: 'user-1', email: 'user@example.com' } }
    }
    if (url.endsWith('/api/billing/sub2api-session')) {
      return { accessToken: 'sub2-token', expiresIn: 3600 }
    }
    return { data: { items: [] } }
  })

  const result = await fixture.service.authLogin({
    identifier: 'user@example.com',
    password: 'password',
    captchaToken: 'captcha-token',
    captchaCode: '1234',
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'GATEWAY_KEY_UNAVAILABLE')
  assert.match(result.message, /尚未分配 AI 服务密钥/)
  assert.equal(fixture.installed.length, 0)
  assert.equal(fixture.clearCount, 1)
  assert.equal(calls.some(({ url, options }) => url.endsWith('/api/v1/keys') && options.method === 'POST'), false)
})

test('refresh renews an expiring Sub2API token before retrieving the gateway key', async (t) => {
  const calls = []
  const fixture = createFixture(t, async (url, options = {}) => {
    calls.push({ url, options })
    if (url.endsWith('/api/billing/sub2api-session')) {
      return { accessToken: 'renewed-token', expiresIn: 7200, tokenType: 'Bearer' }
    }
    if (url.endsWith('/api/v1/auth/me')) {
      assert.equal(options.headers.Authorization, 'Bearer renewed-token')
      return { data: { id: 'user-1', email: 'user@example.com', balance: 1 } }
    }
    return successfulGatewayResponse(url)
  }, {
    accessToken: 'expired-token',
    token: 'expired-token',
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    agentToken: 'agent-token',
    user: { id: 'user-1', email: 'user@example.com' },
    remoteConfigEnv: { DASHSCOPE_API_KEY: 'persisted-stale-key' },
  })

  const result = await fixture.service.authRefresh()

  assert.equal(result.ok, true)
  const persisted = JSON.parse(fs.readFileSync(fixture.authStatePath, 'utf8'))
  assert.equal(persisted.accessToken, 'renewed-token')
  assert.equal(persisted.token, 'renewed-token')
  assert.equal(persisted.remoteConfigEnv.DASHSCOPE_API_KEY, undefined)
  assert.ok(calls.find(({ url }) => url.endsWith('/api/billing/sub2api-session')))
  assert.deepEqual(fixture.installed.at(-1), {
    DASHSCOPE_API_KEY: 'account-gateway-key',
    DASHSCOPE_BASE_URL: gatewayBaseUrl,
  })
})

test('refresh retries once with a newly minted token after a 401', async (t) => {
  let meCalls = 0
  let sessionCalls = 0
  const fixture = createFixture(t, async (url, options = {}) => {
    if (url.endsWith('/api/v1/auth/me')) {
      meCalls += 1
      if (options.headers.Authorization === 'Bearer old-token') {
        throw Object.assign(new Error('unauthorized'), { status: 401 })
      }
      assert.equal(options.headers.Authorization, 'Bearer renewed-token')
      return { data: { id: 'user-1', email: 'user@example.com' } }
    }
    if (url.endsWith('/api/billing/sub2api-session')) {
      sessionCalls += 1
      return { accessToken: 'renewed-token', expiresIn: 3600, tokenType: 'Bearer' }
    }
    return successfulGatewayResponse(url)
  }, {
    accessToken: 'old-token',
    token: 'old-token',
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    agentToken: 'agent-token',
    user: { id: 'user-1', email: 'user@example.com' },
  })

  const result = await fixture.service.authRefresh()

  assert.equal(result.ok, true)
  assert.equal(meCalls, 2)
  assert.equal(sessionCalls, 1)
})

for (const status of [502, 403]) {
  test(`successful balance refresh survives AI key HTTP ${status} without logging out`, async (t) => {
    let sessionCalls = 0
    const fixture = createFixture(t, async (url) => {
      if (url.endsWith('/api/v1/auth/me')) return { data: { id: 'user-1', balance: 88.5 } }
      if (url.endsWith('/api/billing/sub2api-session')) sessionCalls++
      throw Object.assign(new Error('key service unavailable'), { status })
    }, {
      accessToken: 'valid-token', token: 'valid-token', agentToken: 'agent-token',
      user: { id: 'user-1', balance: 0 },
      remoteConfigEnv: { DASHSCOPE_API_KEY: 'old-key' },
    })
    const result = await fixture.service.authRefresh()
    assert.equal(result.ok, true)
    assert.equal(result.auth.loggedIn, true)
    assert.equal(result.auth.user.balance, 88.5)
    assert.match(result.warning, /账户信息已更新.*AI 服务密钥初始化失败/)
    const persisted = JSON.parse(fs.readFileSync(fixture.authStatePath, 'utf8'))
    assert.equal(persisted.user.balance, 88.5)
    assert.equal(persisted.accessToken, 'valid-token')
    assert.equal(persisted.remoteConfigEnv.DASHSCOPE_API_KEY, undefined)
    assert.equal(sessionCalls, 0)
    assert.equal(fixture.clearCount, 1)
  })
}

function deferred() {
  let resolve, reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

const credentials = (id) => ({ identifier: id, password: 'password', captchaToken: 'captcha', captchaCode: '1234' })
function sessionReply(url, options = {}) {
  const token = String(options.headers?.Authorization || '').replace('Bearer ', '')
  if (url.endsWith('/api/auth/login')) return { token: `agent-${options.body.identifier}`, user: { id: options.body.identifier } }
  if (url.endsWith('/api/billing/sub2api-session')) return { accessToken: token.replace('agent-', 'token-'), expiresIn: 3600 }
  if (url.endsWith('/api/v1/auth/me')) return { data: { id: token.replace('token-', ''), balance: 88 } }
  if (url.includes('/api/v1/keys?')) return { data: { items: [{ id: 21, key: `key-${token}`, name: 'VideoAutoCut', group_id: 11, status: 'active' }] } }
  throw new Error(`Unexpected request ${url}`)
}

for (const failure of [false, true]) {
  test(`old account refresh ${failure ? 'failure' : 'success'} cannot overwrite or log out the new account`, async (t) => {
    const gate = deferred()
    const fixture = createFixture(t, (url, options = {}) => {
      if (url.endsWith('/api/v1/auth/me') && options.headers?.Authorization === 'Bearer token-A') return gate.promise
      return sessionReply(url, options)
    }, { accessToken: 'token-A', user: { id: 'A' } })
    const refresh = fixture.service.authRefresh()
    const login = await fixture.service.authLogin(credentials('B'))
    assert.equal(login.ok, true)
    const clears = fixture.clearCount
    const installs = fixture.installed.length
    if (failure) gate.reject(Object.assign(new Error('unauthorized A'), { status: 401 }))
    else gate.resolve({ data: { id: 'A', balance: 12 } })
    const result = await refresh
    assert.equal(result.ok, false)
    assert.equal(result.auth.user.id, 'B')
    assert.equal(fixture.service.readAuthState().user.id, 'B')
    assert.equal(fixture.clearCount, clears)
    assert.equal(fixture.installed.length, installs)
  })

  test(`late AI key ${failure ? 'failure' : 'success'} cannot change the new account environment`, async (t) => {
    const gate = deferred()
    const entered = deferred()
    const fixture = createFixture(t, (url, options = {}) => {
      if (url.includes('/keys?') && options.headers?.Authorization === 'Bearer token-A') {
        entered.resolve()
        return gate.promise
      }
      return sessionReply(url, options)
    }, { accessToken: 'token-A', user: { id: 'A' } })
    const refresh = fixture.service.authRefresh()
    await entered.promise
    assert.equal((await fixture.service.authLogin(credentials('B'))).ok, true)
    const clears = fixture.clearCount
    const installs = fixture.installed.length
    if (failure) gate.reject(Object.assign(new Error('key A rejected'), { status: 403 }))
    else gate.resolve(sessionReply(`${gatewayBaseUrl}/api/v1/keys?`, { headers: { Authorization: 'Bearer token-A' } }))
    assert.equal((await refresh).ok, false)
    assert.equal(fixture.service.readAuthState().user.id, 'B')
    assert.equal(fixture.clearCount, clears)
    assert.equal(fixture.installed.length, installs)
    assert.equal(fixture.installed.at(-1).DASHSCOPE_API_KEY, 'key-token-B')
  })
}

test('logout invalidates an in-flight login and reports the persisted transition immediately', async (t) => {
  const gate = deferred()
  const transitions = []
  let fixture
  fixture = createFixture(t, (url, options = {}) => url.endsWith('/api/auth/login') ? gate.promise : sessionReply(url, options),
    { accessToken: 'token-A', user: { id: 'A' } },
    { onAuthStateChanged: () => transitions.push(fixture.service.readAuthState().user?.id || '') })
  const login = fixture.service.authLogin(credentials('B'))
  fixture.service.clearAuthState()
  assert.deepEqual(transitions, [''])
  gate.resolve({ token: 'agent-B', user: { id: 'B' } })
  assert.equal((await login).ok, false)
  assert.equal(fixture.service.publicAuthState(fixture.service.readAuthState()).loggedIn, false)
  assert.equal(fixture.installed.length, 0)
})

test('A to B to A rejects the first A response despite the matching user ID', async (t) => {
  const gate = deferred()
  let first = true
  const transitions = []
  let fixture
  fixture = createFixture(t, (url, options = {}) => {
    if (first && url.endsWith('/api/v1/auth/me')) { first = false; return gate.promise }
    return sessionReply(url, options)
  }, { accessToken: 'token-A', user: { id: 'A', balance: 1 } },
  { onAuthStateChanged: () => transitions.push(fixture.service.readAuthState().user?.id || '') })
  const refresh = fixture.service.authRefresh()
  assert.equal((await fixture.service.authLogin(credentials('B'))).ok, true)
  assert.equal((await fixture.service.authLogin(credentials('A'))).ok, true)
  gate.resolve({ data: { id: 'A', balance: -999 } })
  assert.equal((await refresh).ok, false)
  assert.equal(fixture.service.readAuthState().user.balance, 88)
  assert.deepEqual(transitions, ['B', 'A'])
})

test('a refresh started during another account login cannot replace that completed login', async (t) => {
  const loginGate = deferred()
  const loginEntered = deferred()
  const refreshGate = deferred()
  const fixture = createFixture(t, (url, options = {}) => {
    if (url.endsWith('/api/v1/auth/me')) {
      if (options.headers?.Authorization === 'Bearer token-B') {
        loginEntered.resolve()
        return loginGate.promise
      }
      return refreshGate.promise
    }
    return sessionReply(url, options)
  }, { accessToken: 'token-A', user: { id: 'A' } })
  const login = fixture.service.authLogin(credentials('B'))
  await loginEntered.promise
  const refresh = fixture.service.authRefresh()
  loginGate.resolve({ data: { id: 'B', balance: 20 } })
  assert.equal((await login).ok, true)
  refreshGate.resolve({ data: { id: 'A', balance: 1 } })
  assert.equal((await refresh).ok, false)
  assert.equal(fixture.service.readAuthState().user.id, 'B')
})
