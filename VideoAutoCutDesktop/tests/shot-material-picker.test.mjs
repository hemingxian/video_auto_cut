import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import {
  createPickerRefreshScheduler,
  createShotMaterialPickerBrowser,
  createShotMaterialPickerCache,
  filesForPickerSemanticQuery,
  materialErrorDetail,
  pageMaterialPickerListing,
} from '../src/pages/start/shotMaterialPickerModel.ts'
import {
  applyMaterialSelectionSummary,
  createFolderMaterialSelection,
  selectionsToMaterialBindings,
} from '../src/pages/start/shotMaterialSelectionModel.ts'

const listing = (id, files = [], folders = []) => ({
  current: { id, kind: id.startsWith('root') ? null : 'user', name: id },
  breadcrumbs: [{ id, name: id }], files, folders,
})
function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('reopening a picker shows the account cache synchronously, then refreshes it', async () => {
  const cache = createShotMaterialPickerCache()
  const cached = listing('root-account-a', [{ name: 'cached' }])
  cache.set(cached)
  const browser = createShotMaterialPickerBrowser(cache)
  const response = deferred()
  const displayed = []
  const pending = browser.load('', () => response.promise, (value) => displayed.push(value))
  assert.deepEqual(displayed, [cached], 'display must not wait for the directory IPC')
  const fresh = listing('root-account-a', [{ name: 'fresh' }])
  response.resolve(fresh)
  assert.deepEqual(await pending, { status: 'loaded' })
  assert.deepEqual(displayed, [cached, fresh])
  assert.equal(cache.get(''), fresh)
})

test('slow old navigation cannot overwrite the current directory or its cache', async () => {
  const cache = createShotMaterialPickerCache()
  const browser = createShotMaterialPickerBrowser(cache)
  const first = deferred()
  const second = deferred()
  const displayed = []
  const firstRead = browser.load('one', () => first.promise, (value) => displayed.push(value.current.id))
  const secondRead = browser.load('two', () => second.promise, (value) => displayed.push(value.current.id))
  second.resolve(listing('two'))
  assert.equal((await secondRead).status, 'loaded')
  first.resolve(listing('one'))
  assert.equal((await firstRead).status, 'stale')
  assert.deepEqual(displayed, ['two'])
  assert.equal(cache.get('one'), null)
})

test('cache instances and late IPC responses stay within the original account mount', async () => {
  const accountA = createShotMaterialPickerCache()
  const accountB = createShotMaterialPickerCache()
  accountA.set(listing('root-account-a'))
  assert.equal(accountB.get(''), null)
  assert.equal(accountB.get('root-account-a'), null)
  const browser = createShotMaterialPickerBrowser(accountA)
  const response = deferred()
  let renders = 0
  const pending = browser.load('private-a', () => response.promise, () => { renders += 1 })
  browser.cancel()
  response.resolve(listing('private-a'))
  assert.equal((await pending).status, 'stale')
  assert.equal(renders, 0)
  assert.equal(accountA.get('private-a'), null)
  assert.equal(accountB.get('private-a'), null)
})

test('background read failure keeps the visible cached directory; stale errors are ignored', async () => {
  const cache = createShotMaterialPickerCache()
  const cached = listing('available')
  cache.set(cached)
  const browser = createShotMaterialPickerBrowser(cache)
  let displayed
  const result = await browser.load('available', async () => { throw new Error('offline') }, (value) => { displayed = value })
  assert.equal(result.status, 'error')
  assert.equal(displayed, cached)
  const old = deferred()
  const pending = browser.load('old', () => old.promise, () => assert.fail('stale response rendered'))
  await browser.load('new', async () => listing('new'), () => undefined)
  old.reject(new Error('old read failed'))
  assert.equal((await pending).status, 'stale')
})

test('Step4 D6 material picker exposes copyable error name and original message', () => {
  const named = new TypeError('素材目录暂时不可读')
  assert.equal(materialErrorDetail(named), 'TypeError: 素材目录暂时不可读')
  assert.equal(
    materialErrorDetail({ name: 'IpcError', message: '主进程原始错误：ENOENT' }),
    'IpcError: 主进程原始错误：ENOENT',
  )
  assert.equal(materialErrorDetail('连接断开'), 'Error: 连接断开')
})

test('24-item pagination includes folders without omitting or duplicating files', () => {
  const folders = Array.from({ length: 29 }, (_, index) => ({ id: `folder-${index}`, name: `Folder ${index}`, kind: 'user' }))
  const files = Array.from({ length: 60 }, (_, index) => ({ materialId: `mat_${index}`, name: `File ${index}` }))
  const source = listing('root-large', files, folders)
  const pages = [1, 2, 3, 4].map((page) => pageMaterialPickerListing(source, page))
  assert.deepEqual(pages.map((page) => page.folders.length + page.files.length), [24, 24, 24, 17])
  assert.deepEqual(pages.flatMap((page) => page.folders), folders)
  assert.deepEqual(pages.flatMap((page) => page.files), files)
  assert.equal(pageMaterialPickerListing(source, 99).page, 4)
  assert.equal(pageMaterialPickerListing(listing('empty'), 5).page, 1)
})

test('cross-page selections keep recursive folder scope and use refreshed candidate keys', () => {
  const selected = [
    createFolderMaterialSelection({ id: 'folder-a', name: 'scara', kind: 'user', videoCount: 999 }),
    { id: 'mat_59', kind: 'file', name: 'Page 3 material' },
  ]
  const source = listing('root', Array.from({ length: 60 }, (_, index) => ({ materialId: `mat_${index}` })))
  assert.ok(pageMaterialPickerListing(source, 3).files.some((file) => file.materialId === selected[1].id))
  assert.deepEqual(selectionsToMaterialBindings(selected), [
    { binding_type: 'folder', folder_id: 'folder-a', include_subfolders: true },
    { binding_type: 'material', material_id: 'mat_59' },
  ])
  const refreshed = applyMaterialSelectionSummary(selected, { candidateCount: 2, entries: [
    { key: 'folder:folder-a', candidateKeys: ['valid-subfolder-video'] },
    { key: 'material:mat_59', candidateKeys: ['video-59'] },
  ] })
  assert.equal(refreshed[0].videoCount, 1, 'cached display count must not become the confirmed scope')
  assert.equal(refreshed[0].includeSubfolders, true)
  assert.throws(() => applyMaterialSelectionSummary(selected, { candidateCount: 1, entries: [] }))
})

test('analysis event bursts are coalesced with only one trailing read while busy', async () => {
  const firstRead = deferred()
  let calls = 0
  const scheduler = createPickerRefreshScheduler(async () => {
    calls += 1
    if (calls === 1) await firstRead.promise
  }, 5)
  for (let index = 0; index < 100; index += 1) scheduler.request()
  await delay(20)
  assert.equal(calls, 1)
  for (let index = 0; index < 100; index += 1) scheduler.request()
  await delay(20)
  assert.equal(calls, 1)
  firstRead.resolve()
  await delay(20)
  assert.equal(calls, 2)
  scheduler.cancel()
  scheduler.request()
  await delay(15)
  assert.equal(calls, 2)
})

test('a failed event refresh does not leave the scheduler stuck or reject unhandled', async () => {
  let calls = 0
  const scheduler = createPickerRefreshScheduler(() => {
    calls += 1
    if (calls === 1) throw new Error('temporary directory error')
    return Promise.resolve()
  }, 5)
  scheduler.request()
  await delay(20)
  assert.equal(calls, 1)
  scheduler.request()
  await delay(20)
  assert.equal(calls, 2)
  scheduler.cancel()
})

test('semantic results from A are not selectable as B during debounce, loading or failure', () => {
  const resultA = { query: 'robot palletizing', files: [{ materialId: 'mat_a', name: 'Palletizing' }] }
  assert.deepEqual(filesForPickerSemanticQuery(resultA, '  robot palletizing  '), resultA.files)
  assert.deepEqual(filesForPickerSemanticQuery(resultA, 'CNC tending'), [], 'changing the input hides A before B starts')
  const pendingB = { query: 'CNC tending', files: [] }
  assert.deepEqual(filesForPickerSemanticQuery(pendingB, 'CNC tending'), [], 'waiting for B cannot reuse old results')
  assert.deepEqual(filesForPickerSemanticQuery(null, 'CNC tending'), [], 'failed B has no selectable result')
  const resultB = { query: 'CNC tending', files: [{ materialId: 'mat_b', name: 'CNC machine' }] }
  assert.deepEqual(filesForPickerSemanticQuery(resultB, 'CNC tending'), resultB.files)
  assert.deepEqual(filesForPickerSemanticQuery(resultB, 'robot palletizing'), [])
  assert.deepEqual(filesForPickerSemanticQuery(resultA, '  '), [])
})
