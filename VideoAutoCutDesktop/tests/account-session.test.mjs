import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import test from 'node:test'
import { createAccountSessions, materialAccountIdentity, AccountSessionChanged } from '../dist-electron/account-session.js'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  let identity = { serviceUrl: 'https://materials.example', userId: 'A' }
  const storage = new AsyncLocalStorage()
  const values = new Map()
  const store = {
    captureScope: () => identity?.userId || 'guest',
    runInScope: (scope, run) => storage.run(scope, run),
    set(value) { values.set(storage.getStore() || identity?.userId, value) },
    get() { return values.get(storage.getStore() || identity?.userId) },
  }
  const sessions = createAccountSessions(() => identity, store)
  return { sessions, store, values, switchTo(userId) {
    identity = userId ? { serviceUrl: 'https://materials.example', userId } : undefined
    return sessions.refresh()
  } }
}

test('persistent identity requires authenticated stable user ID and excludes credentials', () => {
  assert.equal(materialAccountIdentity({ token: 'secret' }, 'https://materials.example'), undefined)
  assert.equal(materialAccountIdentity({ user: { id: 'A' } }, 'https://materials.example'), undefined)
  const expected = { userId: 'A', serviceUrl: 'https://materials.example' }
  assert.deepEqual(materialAccountIdentity({ accessToken: 'old', user: { id: 'A' } }, expected.serviceUrl + '/'), expected)
  assert.deepEqual(materialAccountIdentity({ accessToken: 'new', user: { id: 'A' } }, expected.serviceUrl), expected)
})

test('A -> B -> A invalidates both earlier epochs, even when the persistent account is identical', () => {
  const f = fixture()
  const firstA = f.sessions.refresh()
  assert.equal(f.sessions.refresh(), firstA)
  const b = f.switchTo('B')
  const nextA = f.switchTo('A')
  assert.equal(firstA.active(), false)
  assert.equal(b.active(), false)
  assert.equal(nextA.active(), true)
  assert.notEqual(nextA, firstA)
  assert.throws(firstA.assertActive, AccountSessionChanged)
  f.sessions.close()
})

test('captured IPC method resolves current session; every session rebuilds directory-like state', () => {
  const f = fixture()
  let created = 0
  const service = f.sessions.proxy(context => ({
    id: ++created,
    scope() { return `${context.scope}:${this.id}` },
  }))
  const capturedMethod = service.scope
  assert.equal(capturedMethod(), 'A:1')
  f.switchTo('B')
  assert.equal(capturedMethod(), 'B:2')
  f.switchTo('A')
  assert.equal(capturedMethod(), 'A:3')
  assert.equal(service.then, undefined)
  f.sessions.close()
})

test('late async result cannot reach new workspace and cleanup remains in old database', async () => {
  const f = fixture()
  const gate = deferred()
  const service = f.sessions.proxy(context => {
    const bound = context.bindStore(f.store)
    return { async update() { await gate.promise; bound.set('old cleanup'); return 'old result' } }
  })
  const pending = service.update()
  const rejected = assert.rejects(pending, AccountSessionChanged)
  f.switchTo('B')
  f.store.set('B value')
  gate.resolve()
  await rejected
  assert.equal(f.values.get('A'), 'old cleanup')
  assert.equal(f.values.get('B'), 'B value')
  f.sessions.close()
})

test('session cancellation aborts HTTP and rejects a delayed response body before import', async () => {
  const f = fixture()
  const body = deferred()
  const began = deferred()
  let requestSignal
  const a = f.sessions.refresh()
  const pending = a.fetch(async (_input, init) => {
    requestSignal = init.signal
    began.resolve()
    return { status: 200, statusText: 'OK', headers: {}, arrayBuffer: () => body.promise }
  }, 'https://materials.example/v1/folders')
  const rejected = assert.rejects(pending, AccountSessionChanged)
  await began.promise
  f.switchTo('B')
  assert.equal(requestSignal.aborted, true)
  body.resolve(new TextEncoder().encode('{"folders":["A"]}'))
  await rejected
  f.sessions.close()
})

test('new requests wait for old transfer file handles and task processes to settle', async () => {
  const f = fixture()
  const fileClosed = deferred()
  const taskExited = deferred()
  const a = f.sessions.refresh()
  a.track(fileClosed.promise)
  a.onDispose(() => taskExited.promise)
  const b = f.switchTo('B')
  let sent = false
  const pending = b.fetch(async () => { sent = true; return new Response('{}') }, 'https://materials.example/v1/folders')
  await new Promise(done => setImmediate(done))
  assert.equal(sent, false)
  fileClosed.resolve()
  await new Promise(done => setImmediate(done))
  assert.equal(sent, false)
  taskExited.resolve()
  assert.deepEqual(await (await pending).json(), {})
  assert.equal(sent, true)
  f.sessions.close()
})

test('old background events are suppressed after logout and cannot reappear after returning to A', () => {
  const f = fixture()
  const a = f.sessions.refresh()
  const events = []
  a.send((...args) => events.push(args), 'materials', 'A before logout')
  f.switchTo(undefined)
  a.send((...args) => events.push(args), 'materials', 'A after logout')
  f.switchTo('A')
  a.send((...args) => events.push(args), 'materials', 'old A after new A login')
  assert.deepEqual(events, [['materials', 'A before logout']])
  f.sessions.close()
})
