import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAccountSessions, materialAccountIdentity } from '../dist-electron/account-session.js'
import { createAccountScopedMaterialStore } from '../dist-electron/material-account-store.js'
import { createMaterialCloudService } from '../dist-electron/material-cloud-service.js'

function deferred() {
  let resolve
  const promise = new Promise(accept => { resolve = accept })
  return { promise, resolve }
}

async function fixture(t, { ignoreTransportAbort = false } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-account-integration-'))
  const options = {
    dataRoot,
    materialsDir: path.join(dataRoot, 'video', 'materials'),
    runsDir: path.join(dataRoot, 'video', 'runs'),
    manifestsDir: path.join(dataRoot, 'video', 'manifests'),
    databasePath: path.join(dataRoot, 'video', 'material-library.sqlite'),
  }
  fs.mkdirSync(options.materialsDir, { recursive: true })
  fs.mkdirSync(options.runsDir, { recursive: true })
  const requests = []
  const events = []
  const handlerErrors = []
  let owner = 'A'
  let hold
  const server = http.createServer(async (request, response) => {
    try {
      const account = request.headers.authorization?.replace('Bearer token-', '')
      assert.ok(['A', 'B'].includes(account), 'every request has its original account token')
      const url = new URL(request.url, 'http://localhost')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
      requests.push({ owner: account, pathname: url.pathname, cursor: url.searchParams.get('cursor'), method: request.method, body })
      let result
      if (url.pathname.endsWith('/v1/material-config')) result = { platform_downloads: { auto_sync_enabled: false } }
      else if (url.pathname.endsWith('/v1/sync/changes')) result = { changes: [], next_cursor: account === 'A' ? 11 : 22, has_more: false }
      else if (url.pathname.endsWith('/v1/folders')) result = {
        items: [
          { folder_id: `fld_remote_root_${account}`, parent_folder_id: null, name: '本地素材', revision: 1 },
          { folder_id: `fld_remote_${account}`, parent_folder_id: `fld_remote_root_${account}`, name: 'scara', revision: 1 },
        ], has_more: false,
      }
      else if (url.pathname.endsWith('/v1/materials')) result = { items: [], has_more: false }
      else if (url.pathname.endsWith('/v1/sync/batch')) {
        for (const folder of body.folders || []) {
          assert.equal(folder.folder_id, folder.name === '本地素材' ? `fld_remote_root_${account}` : `fld_remote_${account}`,
            'same-name folders resolve only within the request owner')
        }
        result = { results: [
          ...(body.folders || []).map(folder => ({ ok: true, entity_type: 'folder', entity_id: folder.folder_id, revision: 2 })),
          ...(body.materials || []).map(material => ({ ok: true, entity_type: 'material', entity_id: material.material_id, revision: 2 })),
        ] }
      } else throw new Error(`Unexpected route ${request.method} ${url.pathname}`)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      const json = JSON.stringify(result)
      if (hold && hold.owner === account && url.pathname.endsWith('/v1/folders')) {
        const pending = hold
        hold = undefined
        // Deliver headers and half of the body before account switching. This
        // exercises response-body lifetime, not just pre-fetch cancellation.
        const middle = Math.floor(json.length / 2)
        response.write(json.slice(0, middle))
        pending.entered.resolve()
        await pending.release.promise
        if (!response.destroyed) response.end(json.slice(middle))
      } else response.end(json)
    } catch (error) {
      handlerErrors.push(error)
      if (!response.headersSent) response.writeHead(500)
      response.end(JSON.stringify({ error: { message: error.message } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let base = `http://127.0.0.1:${server.address().port}`
  const readAuth = () => ({ accessToken: `token-${owner}`, user: { id: owner } })
  const identity = () => materialAccountIdentity(readAuth(), base)
  let store
  let sessions
  let service
  function open() {
    store = createAccountScopedMaterialStore(options, identity)
    sessions = createAccountSessions(identity, store)
    const forSession = session => {
      const initialAuth = readAuth()
      const sessionBase = base
      const cloud = createMaterialCloudService({
        deviceId: 'dev_account_integration',
        readAuthState: () => session.active() ? readAuth() : initialAuth,
        isSessionActive: session.active,
        transferAbortSignal: session.signal,
        readEnv: () => ({}),
        readPlatformEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: sessionBase }),
        store: session.bindStore(store),
        send: (channel, event) => session.send((_channel, value) => events.push({ owner, ...value }), channel, event),
        request: (input, init) => session.fetch((target, requestInit) => fetch(target, {
          ...requestInit, ...(ignoreTransportAbort ? { signal: undefined } : {}),
        }), input, init),
        exportAnalysisResult: async () => { throw new Error('analysis is not used by catalog registration') },
        importAnalysisResult: async () => { throw new Error('analysis is not used by catalog registration') },
      })
      session.onDispose(cloud.stop)
      return cloud
    }
    service = sessions.proxy(forSession)
  }
  open()
  t.after(async () => {
    hold?.release.resolve()
    sessions.close()
    store.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(dataRoot), path.resolve(os.tmpdir()))
    fs.rmSync(dataRoot, { recursive: true, force: true })
    assert.deepEqual(handlerErrors, [])
  })
  return {
    options, requests, events,
    get store() { return store },
    get sessions() { return sessions },
    get service() { return service },
    get base() { return base },
    switch(nextOwner, suffix = '') { owner = nextOwner; base = `http://127.0.0.1:${server.address().port}${suffix}`; return sessions.refresh() },
    reopen() { sessions.close(); store.close(); open() },
    holdFolders(account) {
      const pending = { owner: account, entered: deferred(), release: deferred() }
      hold = pending
      return pending
    },
    register() {
      const localPath = path.join(options.materialsDir, 'scara', 'shared.mp4')
      fs.mkdirSync(path.dirname(localPath), { recursive: true })
      if (!fs.existsSync(localPath)) fs.writeFileSync(localPath, 'same physical local video bytes')
      const parentFolderId = store.getOrCreateFolder({ scope: 'user', storageKey: '.', name: '本地素材' })
      const folderId = store.getOrCreateFolder({ scope: 'user', storageKey: 'scara', name: 'scara', parentFolderId })
      return { folderId, ...store.registerMaterialFile(localPath, { folderId, origin: 'user_upload', addedFrom: 'user_import' }), localPath }
    },
    cursor(account) {
      const key = `catalog_v4_${createHash('sha256').update(`${base}:${account}`).digest('hex')}`
      return store.getCloudState(key)
    },
  }
}

test('real SQLite and HTTP isolate same-name cloud folders, queued work and cursors through A -> B -> A and restart', async t => {
  const h = await fixture(t)
  await h.service.syncNow()
  const materialA = h.register()
  h.store.queueCloudOperation('sync_folder', materialA.folderId)
  assert.equal(h.cursor('A'), '11')
  assert.ok(h.store.getFolder('fld_remote_A'))

  h.switch('B')
  assert.equal(h.store.getFolder('fld_remote_A'), null)
  assert.equal(h.store.getMaterialCloudFileById(materialA.materialId), null)
  assert.equal(h.cursor('B'), '')
  assert.deepEqual(h.store.cloudOperationCounts(), { pending: 0, failed: 0 })
  await h.service.syncNow()
  const materialB = h.register()
  assert.notEqual(materialA.materialId, materialB.materialId)
  assert.notEqual(materialA.folderId, materialB.folderId)
  h.store.queueCloudOperation('sync_folder', materialB.folderId)
  assert.equal(h.cursor('B'), '22')

  h.switch('A')
  assert.equal(h.cursor('A'), '11')
  assert.equal(h.store.getFolder('fld_remote_B'), null)
  await h.service.syncNow()
  assert.equal(h.store.cloudOperationCounts().pending, 0, JSON.stringify(h.requests.filter(item => item.method === 'POST')))
  assert.deepEqual(h.requests.filter(item => item.method === 'POST').map(item => item.owner), ['A'])
  assert.equal(h.requests.filter(item => item.owner === 'A' && item.pathname.endsWith('/sync/changes')).at(-1).cursor, '11')

  h.reopen()
  assert.equal(h.cursor('A'), '11')
  assert.equal(h.store.getMaterialCloudFileByPath(materialA.localPath).materialId, materialA.materialId)
  h.switch('B')
  assert.equal(h.cursor('B'), '22')
  assert.equal(h.store.cloudOperationCounts().pending, 1)
  await h.service.processQueue()
  assert.deepEqual(h.requests.filter(item => item.method === 'POST').map(item => item.owner), ['A', 'B'])
  assert.equal(h.store.cloudOperationCounts().pending, 0, JSON.stringify(h.requests.filter(item => item.method === 'POST')))
  assert.equal(fs.readFileSync(materialA.localPath, 'utf8'), 'same physical local video bytes')
})

for (const ignoreTransportAbort of [false, true]) {
  test(`delayed folder response cannot POST after A -> B -> A (${ignoreTransportAbort ? 'transport ignores abort' : 'real transport abort'})`, async t => {
    const h = await fixture(t, { ignoreTransportAbort })
    const materialA = h.register()
    h.store.queueCloudOperation('sync_folder', materialA.folderId)
    const held = h.holdFolders('A')
    const pending = h.service.processQueue()
    const failure = assert.rejects(pending, /账号已切换/)
    await held.entered.promise
    h.switch('B')
    assert.equal(h.store.getFolder('fld_remote_A'), null)
    assert.equal(h.store.cloudOperationCounts().pending, 0)
    h.switch('A')
    const eventCount = h.events.length
    held.release.resolve()
    await failure
    assert.equal(h.events.length, eventCount, 'old-session completion events are suppressed even after returning to A')
    assert.equal(h.requests.some(item => item.method === 'POST'), false)
    assert.equal(h.store.cloudOperationCounts().pending, 1, 'canceled work returns to its original account queue')
    assert.equal(h.store.getFolder('fld_remote_A'), null, 'the stale response was never applied')
    await h.service.processQueue()
    assert.deepEqual(h.requests.filter(item => item.method === 'POST').map(item => item.owner), ['A'])
  })
}

test('changing material service URL with the same account uses a separate database and cursor', async t => {
  const h = await fixture(t)
  await h.service.syncNow()
  const database = h.store.getScopeDatabasePath()
  const original = h.sessions.refresh()
  h.switch('A', '/alternate')
  assert.equal(original.active(), false)
  assert.notEqual(h.store.getScopeDatabasePath(), database)
  assert.equal(h.cursor('A'), '')
  await h.service.syncNow()
  assert.equal(h.requests.filter(item => item.pathname === '/alternate/v1/sync/changes').at(-1).cursor, '0')
  h.switch('A')
  assert.equal(h.store.getScopeDatabasePath(), database)
  assert.equal(h.cursor('A'), '11')
})

test('a slow old model operation does not block the new account cloud catalog', async t => {
  const h = await fixture(t)
  const modelGate = deferred()
  const models = h.sessions.proxy(() => ({ analyze: async () => modelGate.promise }))
  const oldModel = models.analyze()
  const canceled = assert.rejects(oldModel, /账号已切换/)
  h.switch('B')
  let timeout
  const synced = h.service.syncNow().then(() => 'synced')
  try {
    const first = await Promise.race([
      synced,
      new Promise(resolve => { timeout = setTimeout(() => resolve('blocked'), 2000) }),
    ])
    assert.equal(first, 'synced', 'only conflicting transport/process resources should delay the new account')
    assert.equal(h.cursor('B'), '22')
    assert.ok(h.store.getFolder('fld_remote_B'))
    assert.equal(h.store.getFolder('fld_remote_A'), null)
  } finally {
    clearTimeout(timeout)
    modelGate.resolve({ result: 'old account A model result' })
    await canceled
    await synced
  }
})
