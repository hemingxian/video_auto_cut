import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createMaterialLocalStore } from '../dist-electron/material-local-store.js'
import { createMaterialCloudService } from '../dist-electron/material-cloud-service.js'

function fixture(t) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-analysis-transfer-'))
  const workspace = { dataRoot, materialsDir: path.join(dataRoot, 'video', 'materials'),
    runsDir: path.join(dataRoot, 'video', 'runs'), manifestsDir: path.join(dataRoot, 'video', 'manifests'),
    databasePath: path.join(dataRoot, 'video', 'materials.sqlite') }
  fs.mkdirSync(workspace.materialsDir, { recursive: true })
  fs.mkdirSync(workspace.runsDir, { recursive: true })
  const store = createMaterialLocalStore(workspace)
  t.after(() => {
    store.close()
    assert.ok(path.resolve(dataRoot).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`))
    fs.rmSync(dataRoot, { recursive: true, force: true })
  })
  const localPath = path.join(workspace.materialsDir, 'source.mp4')
  fs.writeFileSync(localPath, 'isolated identity fixture; no model or media upload')
  const folderId = store.getOrCreateFolder({ scope: 'user', storageKey: '', name: '本地素材' })
  const identity = store.registerMaterialFile(localPath, { folderId, origin: 'user_upload', addedFrom: 'user_import' })
  store.setCloudStatusForMaterial(identity.materialId, 'ready')
  store.setAnalysisStatusForFile(localPath, 'ready', '', false)
  for (const op of store.claimCloudOperations(20)) store.completeCloudOperation(op.operationId)
  return { store, localPath, material: store.getMaterialCloudFileById(identity.materialId) }
}

const analysis = { analysis_profile_id: 'profile', embedding_backend: 'qwen-cloud', model_name: 'qwen3-vl-embedding',
  model_version: '1', dimension: 3, result_schema_version: 1,
  chunks: [{ chunk_id: 'chunk', start_ms: 0, end_ms: 1000, caption: 'existing caption', embedding: [0.1, 0.2, 0.3] }] }

test('terminal analysis transfer can retry the same idempotent operation and exposes exact failure without losing valid results', t => {
  const { store, localPath, material } = fixture(t)
  const op = store.queueCloudOperation('sync_analysis', material.materialId)
  for (let attempt = 0; attempt < 8; attempt++) {
    const claimed = store.claimCloudOperations(20).find(item => item.operationId === op.operationId)
    assert.ok(claimed)
    assert.equal(store.queueCloudOperation('sync_analysis', material.materialId).operationId, op.operationId)
    store.retryCloudOperation(op.operationId, 'analysis API HTTP 503: maintenance', new Date(0).toISOString())
  }
  const failed = store.describeKnownFile({ path: localPath })
  assert.equal(failed.analysisTransferStatus, 'failed')
  assert.equal(failed.analysisTransferDirection, 'upload')
  assert.match(failed.analysisTransferError, /HTTP 503: maintenance/)
  assert.equal(failed.analysisStatus, 'ready')
  assert.equal(failed.cloudStatus, 'ready')
  assert.equal(store.listCloudFiles().find(file => file.materialId === material.materialId).analysisTransferStatus, 'failed')
  const retried = store.queueCloudOperation('sync_analysis', material.materialId)
  assert.equal(retried.operationId, op.operationId)
  assert.equal(retried.attemptCount, 0)
  assert.equal(retried.status, 'queued')
  assert.equal(store.describeKnownFile({ path: localPath }).analysisTransferError, undefined)
  store.claimCloudOperations(20)
  store.markCloudAnalysisReady(material)
  store.completeCloudOperation(op.operationId)
  assert.equal(store.describeKnownFile({ path: localPath }).analysisTransferStatus, 'ready')
  assert.equal(store.describeKnownFile({ path: localPath }).cloudAnalysisStatus, 'ready')
  assert.deepEqual(store.cloudOperationCounts(), { pending: 0, failed: 0 })
  assert.throws(() => store.markCloudAnalysisReady({ ...material, sourceSha256: 'f'.repeat(64) }), /素材身份已变化/)
})

for (const failure of ['http', 'wrong-material', 'not-completed', 'account-changed']) {
  test(`analysis sync ${failure} keeps ready local analysis and reports the persistent failure`, async t => {
    const { store, localPath, material } = fixture(t)
    let account = 'one'
    const events = []
    store.queueCloudOperation('sync_analysis', material.materialId)
    const service = createMaterialCloudService({ deviceId: 'isolated-device', store,
      readAuthState: () => ({ accessToken: 'test-token', user: { id: account } }),
      readEnv: () => ({}), defaultApiBaseUrl: 'https://example.test', send: (_, event) => events.push(event),
      exportAnalysisResult: async () => analysis, importAnalysisResult: async () => { throw Error('unexpected import') },
      request: async () => {
        if (failure === 'http') return Response.json({ message: 'analysis unavailable' }, { status: 503 })
        if (failure === 'account-changed') account = 'two'
        return Response.json({ material_id: failure === 'wrong-material' ? 'different' : material.materialId,
          analysis_status: failure === 'not-completed' ? 'pending' : 'completed' })
      },
    })
    await service.processQueue()
    const file = store.describeKnownFile({ path: localPath })
    assert.equal(file.analysisStatus, 'ready')
    assert.equal(file.cloudStatus, 'ready')
    assert.notEqual(file.cloudAnalysisStatus, 'ready')
    assert.equal(file.analysisTransferStatus, 'queued')
    assert.ok(file.analysisTransferError)
    assert.ok(events.some(event => event.type === 'cloud-analysis-status' && event.status === 'failed'
      && event.direction === 'upload' && event.message === file.analysisTransferError))
  })
}

test('failed index restore preserves cloud analysis and exposes the import failure for a model-free retry', async t => {
  const { store, localPath, material } = fixture(t)
  store.markCloudAnalysisReady(material)
  store.setAnalysisStatusForFile(localPath, 'pending', '', false)
  store.queueCloudOperation('restore_analysis', material.materialId)
  const events = []
  const service = createMaterialCloudService({ deviceId: 'isolated-device', store,
    readAuthState: () => ({ accessToken: 'test-token' }), readEnv: () => ({}), defaultApiBaseUrl: 'https://example.test',
    send: (_, event) => events.push(event),
    exportAnalysisResult: async () => { throw Error('unexpected model/export call') },
    importAnalysisResult: async () => { throw Error('本地索引写入失败：磁盘已满') },
    request: async () => Response.json({ ...analysis, material_id: material.materialId, asset_id: material.assetId,
      asset_version: material.assetVersion, source_sha256: material.sourceSha256, file_size_bytes: material.sourceSize, has_more: false }),
  })
  await service.processQueue()
  const file = store.describeKnownFile({ path: localPath })
  assert.equal(file.cloudAnalysisStatus, 'ready')
  assert.equal(file.analysisStatus, 'pending')
  assert.equal(file.analysisTransferDirection, 'download')
  assert.match(file.analysisTransferError, /磁盘已满/)
  assert.ok(events.some(event => event.type === 'cloud-analysis-status' && event.status === 'failed'
    && event.direction === 'download' && /磁盘已满/.test(event.message)))
})

test('independent sync and restore reuse saved chunks and update status immediately', async t => {
  const { store, localPath, material } = fixture(t)
  const requests = [], imported = [], events = []
  let exported = 0, token = 'test-token'
  const service = createMaterialCloudService({ deviceId: 'isolated-device', store,
    readAuthState: () => ({ accessToken: token, user: { id: 'one' } }),
    readEnv: () => ({}), defaultApiBaseUrl: 'https://example.test', send: (_, event) => events.push(event),
    exportAnalysisResult: async () => { exported++; return analysis },
    importAnalysisResult: async (filePath, result) => { imported.push({ filePath, result }) },
    request: async (url, init) => {
      requests.push({ url, init })
      assert.ok(new URL(url).pathname.endsWith('/analysis-results'))
      if (init.method === 'POST') return Response.json({ material_id: material.materialId, analysis_status: 'completed' })
      return Response.json({ ...analysis, material_id: material.materialId, asset_id: material.assetId,
        asset_version: material.assetVersion, source_sha256: material.sourceSha256,
        file_size_bytes: material.sourceSize, has_more: false })
    },
  })
  async function settled() {
    for (let n = 0; n < 50 && !events.some(event => event.type === 'cloud-analysis-status' && event.status === 'ready'); n++) {
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.ok(events.some(event => event.type === 'cloud-analysis-status' && event.status === 'ready'))
    events.length = 0
  }
  assert.deepEqual(service.retryAnalysisTransfer({ materialId: material.materialId, direction: 'upload' }), { ok: true, queued: true })
  await settled()
  assert.equal(store.describeKnownFile({ path: localPath }).cloudAnalysisStatus, 'ready')
  assert.equal(store.describeKnownFile({ path: localPath }).analysisTransferStatus, 'ready')
  assert.equal(exported, 1)
  assert.deepEqual(JSON.parse(requests[0].init.body).chunks, analysis.chunks)
  store.setAnalysisStatusForFile(localPath, 'pending', '', false)
  assert.deepEqual(service.retryAnalysisTransfer({ materialId: material.materialId, direction: 'download' }), { ok: true, queued: true })
  await settled()
  assert.equal(exported, 1)
  assert.equal(imported.length, 1)
  assert.equal(imported[0].filePath, localPath)
  assert.deepEqual(imported[0].result.chunks, analysis.chunks)
  assert.equal(store.describeKnownFile({ path: localPath }).analysisStatus, 'ready')
  assert.equal(store.describeKnownFile({ path: localPath }).analysisTransferDirection, 'download')
  assert.equal(requests.length, 2)
  token = ''
  assert.match(service.retryAnalysisTransfer({ materialId: material.materialId, direction: 'upload' }).message, /请先登录/)
  token = 'test-token'
  fs.unlinkSync(localPath)
  assert.match(service.retryAnalysisTransfer({ materialId: material.materialId, direction: 'download' }).message, /请先下载/)
  assert.equal(requests.length, 2)
})
