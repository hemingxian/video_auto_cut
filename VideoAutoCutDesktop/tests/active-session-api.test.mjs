import assert from 'node:assert/strict'
import test from 'node:test'
import { activeSessionApi } from '../src/lib/activeSessionApi.ts'

test('an unmounted workbench cannot continue from material resolution into draft writes', async () => {
  let active = true
  let finish
  let writes = 0
  const api = activeSessionApi(Object.freeze({
    resolve: () => new Promise((accept) => { finish = accept }),
    write: async () => { writes += 1 },
  }), () => active)
  const generation = (async () => { await api.resolve(); await api.write() })()
  active = false
  finish({ shots: [] })
  await assert.rejects(generation, /账号已切换/)
  assert.throws(() => api.write(), /账号已切换/)
  assert.equal(writes, 0)
})

test('a new workspace does not reactivate the old API and event cleanup remains synchronous', async () => {
  const old = { active: true }
  let unsubscribed = false
  const source = { value: 7, read() { return Promise.resolve(this.value) }, subscribe() { return () => { unsubscribed = true } } }
  const oldApi = activeSessionApi(source, () => old.active)
  const unsubscribe = oldApi.subscribe()
  assert.equal(await oldApi.read(), 7)
  old.active = false
  const currentApi = activeSessionApi(source, () => true)
  assert.equal(await currentApi.read(), 7)
  assert.throws(() => oldApi.read(), /账号已切换/)
  unsubscribe()
  assert.equal(unsubscribed, true)
})

test('frozen contextBridge methods can be wrapped without violating proxy invariants', async () => {
  let active = true
  let calls = 0
  const bridge = Object.freeze({
    value: 7,
    taskStatus() { calls += 1; assert.equal(this, bridge); return Promise.resolve({ running: false }) },
    subscribe() { calls += 1; return () => { calls += 1 } },
  })
  const original = Object.getOwnPropertyDescriptor(bridge, 'taskStatus')
  assert.equal(original.writable, false)
  assert.equal(original.configurable, false)
  const api = activeSessionApi(bridge, () => active)
  assert.equal(api.value, 7)
  assert.deepEqual(await api.taskStatus(), { running: false })
  const unsubscribe = api.subscribe()
  assert.equal(typeof unsubscribe, 'function')
  active = false
  assert.throws(() => api.taskStatus(), /账号已切换/)
  assert.throws(() => api.subscribe(), /账号已切换/)
  assert.equal(calls, 2, 'inactive wrappers never invoke the exposed bridge methods')
  unsubscribe()
  assert.equal(calls, 3, 'subscription cleanup remains callable after logout')
  assert.equal(Object.isFrozen(bridge), true)
  assert.deepEqual(Object.getOwnPropertyDescriptor(bridge, 'taskStatus'), original)
})

test('a captured wrapper protects a non-configurable method after logout and rejects its late result', async () => {
  let active = true
  let calls = 0
  let resolve
  const bridge = {}
  Object.defineProperty(bridge, 'loadTaskDraft', {
    configurable: false,
    writable: false,
    enumerable: true,
    value() { calls += 1; return new Promise(accept => { resolve = accept }) },
  })
  const api = activeSessionApi(bridge, () => active)
  const load = api.loadTaskDraft
  const pending = load()
  active = false
  assert.throws(load, /账号已切换/)
  resolve({ materialId: 'belongs-to-previous-account' })
  await assert.rejects(pending, /账号已切换/)
  assert.equal(calls, 1)
})
