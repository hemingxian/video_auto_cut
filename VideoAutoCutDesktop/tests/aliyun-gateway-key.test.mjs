import assert from 'node:assert/strict'
import test from 'node:test'

import {
  gatewayRemoteEnv,
  getGatewayKey,
  responseItems,
  selectActiveGatewayKey,
} from '../electron/aliyun-gateway-key.ts'

const root = 'https://api.evstai.com'

test('response adapters handle Sub2API envelopes', () => {
  assert.deepEqual(responseItems({ data: { items: [{ id: 1 }] } }), [{ id: 1 }])
  assert.deepEqual(responseItems({ data: [{ id: 2 }] }), [{ id: 2 }])
})

test('active key selection does not inspect platform or group and rejects expired keys', () => {
  const selected = selectActiveGatewayKey({
    code: 0,
    data: {
      items: [
        { id: 2, key: 'expired-key', name: 'VideoAutoCut', group_id: 11, status: 'active', expires_at: '2020-01-01T00:00:00Z' },
        { id: 3, key: 'managed-key', name: 'marketing-agent-default', group_id: 4, status: 'active' },
        { id: 4, key: 'older-active-key', name: 'Other', group_id: 12, status: 'active' },
      ],
    },
  }, Date.parse('2026-07-13T00:00:00Z'))

  assert.equal(selected?.id, 3)
  assert.equal(selected?.key, 'managed-key')
  assert.equal(selectActiveGatewayKey({
    data: { items: [{ id: 9, key: 'unrelated-key', name: 'Other', status: 'active' }] },
  })?.key, 'unrelated-key')
})

test('gateway service retrieves the current account key without querying groups', async () => {
  const calls = []
  const result = await getGatewayKey({
    baseUrl: `${root}/`,
    accessToken: 'test-jwt',
    requestJson: async (url, options = {}) => {
      calls.push({ url, options })
      return {
        code: 0,
        data: { items: [{ id: 21, key: 'existing-key', name: 'VideoAutoCut', group_id: 11, status: 'active' }] },
      }
    },
  })

  assert.deepEqual(result, {
    apiKey: 'existing-key',
    keyId: 21,
    groupId: 11,
  })
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/api\/v1\/keys\?/)
  assert.ok(calls.every(({ options }) => options.headers.Authorization === 'Bearer test-jwt'))
  assert.ok(calls.every(({ options }) => !options.method || options.method === 'GET'))
  assert.deepEqual(gatewayRemoteEnv(result, `${root}/`), {
    DASHSCOPE_API_KEY: 'existing-key',
    DASHSCOPE_BASE_URL: root,
  })
})

test('gateway service fails closed instead of creating a key when registration did not assign one', async () => {
  const calls = []
  await assert.rejects(getGatewayKey({
    baseUrl: root,
    accessToken: 'test-jwt',
    requestJson: async (url, options = {}) => {
      calls.push({ url, options })
      return { code: 0, data: { items: [] } }
    },
  }), /GATEWAY_KEY_UNAVAILABLE/)

  assert.equal(calls.length, 1)
  assert.ok(calls.every(({ options }) => !options.method || options.method === 'GET'))
})
