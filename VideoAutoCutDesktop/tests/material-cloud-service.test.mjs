import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createMaterialAnalysisExporter,
  parseAnalysisExport,
} from '../dist-electron/material-analysis-exporter.js'
import {
  createMaterialCloudService,
  chromiumUploadHeaders,
  downloadContentRangeMatches,
  transferSpeedBytesPerSecond,
  uploadFileRangeWithFetch,
} from '../dist-electron/material-cloud-service.js'

test('upload speed uses only bytes transferred during the current resume attempt', () => {
  assert.equal(transferSpeedBytesPerSecond(100, 100, 1_000, 2_000), 0)
  assert.equal(transferSpeedBytesPerSecond(100, 4_100, 1_000, 3_000), 2_000)
  assert.equal(transferSpeedBytesPerSecond(4_100, 100, 1_000, 3_000), 0)
  assert.equal(transferSpeedBytesPerSecond(100, 4_100, 3_000, 1_000), 0)
})

test('download range validation rejects shifted or unverifiable responses', () => {
  assert.equal(downloadContentRangeMatches('bytes 5-15/16', 5, 16), true)
  assert.equal(downloadContentRangeMatches('bytes 4-15/16', 5, 16), false)
  assert.equal(downloadContentRangeMatches('bytes 5-16/16', 5, 16), false)
  assert.equal(downloadContentRangeMatches('bytes 5-15/*', 5, 16), false)
  assert.equal(downloadContentRangeMatches('', 5, 16), false)
})

test('Chromium upload transport sends only the requested file range and removes its forbidden content length', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-upload-transport-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'source.mp4')
  fs.writeFileSync(filePath, Buffer.from('0123456789'))
  let captured

  const result = await uploadFileRangeWithFetch(
    async (url, init) => {
      captured = { url: String(url), init, body: Buffer.from(init.body) }
      return new Response('', { status: 200, headers: { ETag: '"etag-123"' } })
    },
    {
      partNumber: 2,
      method: 'PUT',
      url: 'https://storage.example.com/temporary-upload',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': '5', 'X-Upload-Token': 'temporary' },
    },
    filePath,
    3,
    7,
  )

  assert.equal(captured.url, 'https://storage.example.com/temporary-upload')
  assert.deepEqual(captured.body, Buffer.from('34567'))
  assert.equal(captured.init.headers['X-Upload-Token'], 'temporary')
  assert.equal(captured.init.headers['Content-Length'], undefined)
  assert.deepEqual(result, { etag: 'etag-123', bytes: 5 })
})

test('Chromium upload header filtering is case insensitive and preserves COS authorization', () => {
  assert.deepEqual(chromiumUploadHeaders({
    'content-LENGTH': '10',
    Authorization: 'temporary-signature',
    'x-cos-meta-upload-session': 'session',
  }), {
    Authorization: 'temporary-signature',
    'x-cos-meta-upload-session': 'session',
  })
})

test('cloud download resumes the verified temporary file and persists final byte progress', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-download-resume-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const content = Buffer.from('verified-cloud-video-content')
  const localPath = path.join(directory, 'restored.mp4')
  const temporaryPath = `${localPath}.download.part`
  const resumeOffset = 9
  fs.writeFileSync(temporaryPath, content.subarray(0, resumeOffset))
  const material = {
    materialId: 'mat_download_resume_01',
    assetId: 'asset_download_resume_01',
    assetVersion: 1,
    folderId: 'fld_cloud',
    displayName: '云端恢复.mp4',
    mimeType: 'video/mp4',
    sourceSha256: createHash('sha256').update(content).digest('hex'),
    sourceSize: content.length,
    localPath,
    localStatus: 'missing',
    analysisStatus: 'pending',
    cloudAnalysisStatus: 'pending',
    cloudStatus: 'ready',
  }
  const savedSessions = []
  const events = []
  let completedDownload
  const store = {
    ...createStore(material),
    completeCloudDownload: (...args) => { completedDownload = args },
    saveTransferSession: (session) => { savedSessions.push({ ...session }) },
  }
  const service = createMaterialCloudService({
    deviceId: `dev_${'8'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: (_channel, event) => { events.push(event) },
    store,
    exportAnalysisResult: async () => { throw new Error('not used') },
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (url, init = {}) => {
      assert.equal(url, `http://127.0.0.1:8091/v1/materials/${material.materialId}/download-session`)
      assert.equal(init.method, 'POST')
      return new Response(JSON.stringify({
        download_session_id: 'dls_resume_01',
        url: 'https://cos.example.com/temporary-object',
        file_size_bytes: material.sourceSize,
        source_sha256: material.sourceSha256,
        range_supported: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
    downloadFile: async (_url, destination, start, expectedSize, onProgress) => {
      assert.equal(destination, temporaryPath)
      assert.equal(start, resumeOffset)
      assert.equal(expectedSize, content.length)
      fs.appendFileSync(destination, content.subarray(start))
      onProgress?.(content.length)
      return content.length - start
    },
  })

  const result = await service.downloadMaterial({ materialId: material.materialId })

  assert.equal(result.ok, true)
  assert.equal(result.path, localPath)
  assert.deepEqual(fs.readFileSync(localPath), content)
  assert.equal(fs.existsSync(temporaryPath), false)
  assert.deepEqual(completedDownload, [material.materialId, localPath, material.sourceSha256, material.sourceSize])
  assert.equal(savedSessions.at(-1).status, 'ready')
  assert.equal(savedSessions.at(-1).bytesTransferred, content.length)
  assert.ok(events.some((event) => event.type === 'cloud-progress' && event.direction === 'download'))
  assert.ok(events.some((event) => event.type === 'cloud-status' && event.status === 'verifying'))
})

function createStore(material) {
  return {
    applyCloudDeletion: () => undefined,
    cancelCloudUpload: () => false,
    claimCloudOperations: () => [],
    cloudOperationCounts: () => ({ pending: 0, failed: 0 }),
    completeCloudDownload: () => undefined,
    completeCloudOperation: () => undefined,
    getCloudState: () => '',
    getCloudFolderRecord: () => null,
    folderChainForMaterial: () => [],
    getMaterialCloudFileById: (materialId) => materialId === material.materialId ? material : null,
    getMaterialCloudFileByPath: () => material,
    getTransferSession: () => null,
    listCloudUploadCandidates: () => [],
    materialIdsForGeneration: () => [],
    pauseCloudUpload: () => false,
    prepareGenerationManifest: () => ({}),
    prepareGenerationManifestFromSnapshot: () => ({}),
    queueAnalysisSyncIfReady: () => false,
    markCloudAnalysisReady: () => { material.cloudAnalysisStatus = 'ready' },
    queueCloudOperation: () => ({ operationId: 'op_1' }),
    retryCloudOperation: () => undefined,
    releaseCloudOperation: () => undefined,
    resumeCloudUpload: () => false,
    saveTransferSession: () => undefined,
    setCloudState: () => undefined,
    setCloudRevisionForFolder: () => undefined,
    setCloudRevisionForMaterial: () => undefined,
    setAnalysisStatusForFile: () => undefined,
    setCloudStatusForMaterial: () => undefined,
    upsertCloudFolder: () => undefined,
    upsertCloudMaterial: () => undefined,
  }
}

function validLocalAnalysis() {
  return {
    analysis_profile_id: 'profile_test', embedding_backend: 'qwen-cloud',
    model_name: 'qwen3-vl-embedding', model_version: '1', dimension: 2, result_schema_version: 1,
    chunks: [{ chunk_id: 'chunk_test', start_ms: 0, end_ms: 1000, caption: 'factory', embedding: [0.1, 0.2] }],
  }
}

function analysisFirstUploadFixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-analysis-first-'))
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const localPath = path.join(directory, 'source.mp4')
  const bytes = Buffer.from('upload orchestration fixture, not business media')
  fs.writeFileSync(localPath, bytes)
  const material = { materialId: 'mat_analysis_first', assetId: 'asset_analysis_first', assetVersion: 1,
    folderId: 'folder', displayName: 'source.mp4', mimeType: 'video/mp4', origin: 'user_upload',
    addedFrom: 'user_import', revision: 1, sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    sourceSize: bytes.length, localPath, localStatus: 'present', analysisStatus: 'ready',
    cloudStatus: 'not_uploaded', cloudAnalysisStatus: 'pending', ...overrides }
  const operation = { operationId: 'op_analysis_first', operationType: 'upload', entityId: material.materialId,
    payload: {}, status: 'queued', attemptCount: 0 }
  const operations = [operation], calls = [], events = [], released = [], retries = [], analysesRequested = []
  const store = { ...createStore(material),
    claimCloudOperations: () => operations.filter(op => op.status === 'queued').map(op => (op.status = 'processing', op)),
    completeCloudOperation: id => { operations.find(op => op.operationId === id).status = 'succeeded' },
    releaseCloudOperation: id => { released.push(id); operations.find(op => op.operationId === id).status = 'queued' },
    retryCloudOperation: (id, error) => { retries.push(error); operations.find(op => op.operationId === id).status = 'queued' },
    setAnalysisStatusForFile: (_path, status, error) => { material.analysisStatus = status; material.analysisError = error },
    setCloudStatusForMaterial: (_id, status) => { material.cloudStatus = status },
    setCloudRevisionForMaterial: (_id, revision) => { material.cloudRevision = revision },
  }
  let completedParts = [], rejectAnalysis = false, failBytes = false, exportFailure = false
  const options = { deviceId: 'test_device', readAuthState: () => ({ accessToken: 'test-token', user: { id: 'test-account' } }),
    readEnv: () => ({}), defaultApiBaseUrl: 'https://example.test', store,
    send: (_channel, event) => events.push(event),
    requestLocalAnalysis: paths => analysesRequested.push(...paths),
    exportAnalysisResult: async () => { calls.push('export'); if (exportFailure) throw Error('No Qwen Cloud analysis exists for this file.'); return validLocalAnalysis() },
    importAnalysisResult: async () => { throw Error('unexpected download') },
    uploadFile: async (_authorization, _path, start, end) => {
      calls.push('bytes'); if (failBytes) throw Error('network interrupted')
      return { etag: 'etag', bytes: end - start + 1 }
    },
    request: async (url, init = {}) => {
      const pathname = new URL(url).pathname
      calls.push(pathname)
      if (pathname === '/v1/sync/batch') return Response.json({ results: [{ entity_type: 'material', entity_id: material.materialId, ok: true, revision: 1 }] })
      if (pathname.endsWith('/analysis-results')) return Response.json({ material_id: material.materialId, analysis_status: rejectAnalysis ? 'pending' : 'completed' })
      if (pathname === '/v1/upload-sessions') return Response.json({ upload_session_id: 'upload_1', part_size_bytes: bytes.length, reuse: { type: 'none' } })
      if (pathname.endsWith('/resume')) return Response.json({ upload_session_id: 'upload_1', part_size_bytes: bytes.length, completed_parts: completedParts })
      if (pathname.endsWith('/part-authorizations')) return Response.json({ authorizations: [{ part_number: 1, method: 'PUT', url: 'https://storage.example.test/part', headers: {} }] })
      if (pathname.endsWith('/parts/complete')) { completedParts = JSON.parse(init.body).part_number === 1 ? [1] : []; return Response.json({}) }
      if (pathname.endsWith('/complete')) return Response.json({ cloud_status: 'ready' })
      throw Error(`unexpected request ${pathname}`)
    },
  }
  return { material, operation, operations, store, options, calls, events, released, retries, analysesRequested,
    create: () => createMaterialCloudService(options),
    setExportFailure: value => { exportFailure = value }, setRejectAnalysis: value => { rejectAnalysis = value },
    setFailBytes: value => { failBytes = value }, setCompletedParts: value => { completedParts = value } }
}

test('pending local analysis cannot register or upload even when a legacy store claims the operation', async t => {
  const f = analysisFirstUploadFixture(t, { analysisStatus: 'pending' })
  await f.create().processQueue()
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.released, [f.operation.operationId])
  assert.deepEqual(f.retries, [])
  assert.equal(f.operation.status, 'queued')
  assert.ok(!f.events.some(event => event.status === 'failed'))
})

test('a stale ready marker without exportable vectors waits locally without remote registration or network retries', async t => {
  const f = analysisFirstUploadFixture(t)
  f.setExportFailure(true)
  const service = f.create()
  await service.processQueue()
  assert.deepEqual(f.calls, ['export'])
  assert.equal(f.material.analysisStatus, 'failed')
  assert.match(f.material.analysisError, /No Qwen Cloud analysis/)
  assert.deepEqual(f.retries, [])
  assert.equal(f.operation.status, 'queued')
  assert.deepEqual(f.analysesRequested, [f.material.localPath])
  // A legacy analyzer reporting ready again without producing valid vectors
  // must not create an unbounded repair/upload loop.
  f.material.analysisStatus = 'ready'
  await service.processQueue()
  assert.ok(f.calls.every(value => value === 'export'))
  assert.deepEqual(f.analysesRequested, [f.material.localPath])
})

test('a readiness wake during an active batch drains the newly queued work immediately afterwards', async t => {
  const f = analysisFirstUploadFixture(t)
  let started, release, finished
  const analyzing = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const drained = new Promise(resolve => { finished = resolve })
  const complete = f.store.completeCloudOperation
  f.store.completeCloudOperation = id => { complete(id); if (id === 'op_later_ready') finished() }
  f.options.exportAnalysisResult = async () => { started(); await gate; return validLocalAnalysis() }
  const service = f.create()
  const active = service.processQueue()
  await analyzing
  f.operations.push({ ...f.operation, operationId: 'op_later_ready', operationType: 'sync_analysis', status: 'queued' })
  service.wakeQueue()
  release()
  await active
  let timer
  try {
    await Promise.race([drained, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('queue wake was lost')), 2000) })])
  } finally { clearTimeout(timer) }
  assert.ok(f.operations.every(op => op.status === 'succeeded'))
})

test('valid local analysis is acknowledged before any video session or bytes and duplicate analysis queue work is skipped', async t => {
  const f = analysisFirstUploadFixture(t)
  f.operations.push({ ...f.operation, operationId: 'op_separate_analysis', operationType: 'sync_analysis' })
  await f.create().processQueue()
  const analysisRequest = f.calls.findIndex(value => value.endsWith('/analysis-results'))
  assert.ok(analysisRequest > f.calls.indexOf('export'))
  assert.ok(analysisRequest < f.calls.indexOf('/v1/upload-sessions'))
  assert.ok(analysisRequest < f.calls.indexOf('bytes'))
  assert.equal(f.calls.filter(value => value === 'export').length, 1)
  assert.equal(f.calls.filter(value => value.endsWith('/analysis-results')).length, 1)
  assert.equal(f.material.cloudAnalysisStatus, 'ready')
  assert.equal(f.material.cloudStatus, 'ready')
  assert.ok(f.operations.every(op => op.status === 'succeeded'))
})

test('unacknowledged vectors prevent video upload and preserve a retryable operation', async t => {
  const f = analysisFirstUploadFixture(t)
  f.setRejectAnalysis(true)
  await f.create().processQueue()
  assert.ok(f.calls.some(value => value.endsWith('/analysis-results')))
  assert.ok(!f.calls.some(value => value === 'bytes' || value === '/v1/upload-sessions'))
  assert.equal(f.material.cloudAnalysisStatus, 'pending')
  assert.equal(f.retries.length, 1)
  assert.equal(f.operation.status, 'queued')
})

test('analysis queued before upload shares its validated export within the batch', async t => {
  const f = analysisFirstUploadFixture(t)
  f.operations.unshift({ ...f.operation, operationId: 'op_analysis_before_upload', operationType: 'sync_analysis' })
  await f.create().processQueue()
  assert.equal(f.calls.filter(value => value === 'export').length, 1)
  assert.equal(f.calls.filter(value => value.endsWith('/analysis-results')).length, 1)
  assert.ok(f.calls.indexOf('bytes') > f.calls.findIndex(value => value.endsWith('/analysis-results')))
  assert.ok(f.operations.every(op => op.status === 'succeeded'))
})

test('restart resumes video parts after saved vector success without submitting the vectors again', async t => {
  const f = analysisFirstUploadFixture(t)
  f.setFailBytes(true)
  await f.create().processQueue()
  assert.equal(f.material.cloudAnalysisStatus, 'ready')
  assert.equal(f.operation.status, 'queued')
  f.setFailBytes(false)
  f.setCompletedParts([1])
  f.calls.length = 0
  await f.create().processQueue()
  assert.equal(f.operation.status, 'succeeded')
  assert.equal(f.material.cloudStatus, 'ready')
  assert.deepEqual(f.calls.filter(value => value === 'export'), ['export'])
  assert.ok(f.calls.some(value => value.endsWith('/resume')))
  assert.ok(!f.calls.some(value => value.endsWith('/analysis-results') || value === 'bytes'))
})

test('a cloud video missing vectors can be repaired without uploading its bytes again', async t => {
  const f = analysisFirstUploadFixture(t, { cloudStatus: 'ready' })
  await f.create().processQueue()
  assert.equal(f.material.cloudAnalysisStatus, 'ready')
  assert.equal(f.operation.status, 'succeeded')
  assert.ok(f.calls.some(value => value.endsWith('/analysis-results')))
  assert.ok(!f.calls.some(value => value === '/v1/upload-sessions' || value === 'bytes'))
})

test('manual upload requests local analysis while automatic scans preserve paused and canceled uploads', async t => {
  const f = analysisFirstUploadFixture(t, { analysisStatus: 'pending' })
  const payloads = []
  let preservedStatus = 'paused'
  f.store.queueCloudOperation = (_kind, _id, payload) => { payloads.push(payload); return { ...f.operation, status: payload.explicitResume ? 'queued' : preservedStatus } }
  const service = f.create()
  const automatic = service.queueUploads({ paths: [f.material.localPath], automatic: true })
  assert.equal(automatic.queued, 0)
  preservedStatus = 'canceled'
  assert.equal(service.queueUploads({ paths: [f.material.localPath], automatic: true }).queued, 0)
  assert.deepEqual(f.analysesRequested, [])
  const manual = service.queueUploads({ paths: [f.material.localPath] })
  assert.equal(manual.queued, 1)
  assert.deepEqual(f.analysesRequested, [f.material.localPath])
  assert.deepEqual(payloads, [{ explicitResume: false }, { explicitResume: false }, { explicitResume: true }])
})

test('resuming a backup waiting for analysis starts local repair instead of waiting permanently', async t => {
  const f = analysisFirstUploadFixture(t, { analysisStatus: 'failed' })
  f.operation.status = 'paused'
  f.store.resumeCloudUpload = () => { f.operation.status = 'queued'; return true }
  const result = await f.create().controlUpload({ materialId: f.material.materialId, action: 'resume' })
  assert.equal(result.ok, true)
  assert.deepEqual(f.analysesRequested, [f.material.localPath])
  assert.deepEqual(f.calls, [])
  assert.equal(f.material.cloudStatus, 'not_uploaded')
})

test('catalog batches once, then fetches only changes and preserves the cursor on failure', async () => {
  const states = new Map(), requests = [], imported = [], deleted = [], events = []
  states.set(`catalog_v3_${createHash('sha256').update('https://example.test:one').digest('hex')}`, '999')
  let changes = [], cursor = 10, fail = false, account = 'one'
  const detail = id => ({material_id:id,asset_id:'asset_'+id,asset_version:1,folder_id:'folder',display_name:id+'.mp4',source_sha256:'a'.repeat(64),source_size:12,cloud_status:'ready',revision:1})
  const service = createMaterialCloudService({
    deviceId:'device', readAuthState:()=>({accessToken:'token',user:{id:account}}),
    readEnv:()=>({}), defaultApiBaseUrl:'https://example.test',
    send:(_, event)=>events.push(event),
    store:{...createStore({}),getCloudState:key=>states.get(key)||'',setCloudState:(key,value)=>states.set(key,value),upsertCloudMaterial:item=>imported.push(item.materialId),applyCloudDeletion:(_,id)=>deleted.push(id)},
    exportAnalysisResult:async()=>{throw Error('unused')},importAnalysisResult:async()=>{},
    request:async url=>{
      const u=new URL(url);requests.push(u.pathname+u.search)
      if(u.pathname==='/v1/material-config')return Response.json({})
      if(u.pathname==='/v1/sync/changes')return Response.json({changes,next_cursor:cursor,has_more:false})
      if(u.pathname==='/v1/folders')return Response.json({items:[{folder_id:'folder',name:'Folder',revision:1}]})
      if(u.pathname==='/v1/materials')return Response.json({items:[detail('m1'),detail('m1'),detail('m2')]})
      if(u.pathname==='/v1/materials/m3')return fail?Response.json({message:'temporary failure'},{status:503}):Response.json(detail('m3'))
      throw Error('Unexpected request '+u.pathname)
    },
  })
  assert.equal((await service.syncNow()).lastError,undefined)
  assert.deepEqual(imported,['m1','m2'])
  assert.equal(requests.some(p=>p.startsWith('/v1/materials/')),false)
  requests.length=0
  await service.syncNow()
  assert.deepEqual(requests,['/v1/sync/changes?cursor=10&limit=500'])
  assert.equal(events.filter(e=>e.type==='cloud-sync-completed').at(-1).catalogChanged,false)
  changes=[{entity_type:'material',entity_id:'m3',operation:'upsert',revision:2},{entity_type:'material',entity_id:'m1',operation:'delete',revision:2}];cursor=12;fail=true
  assert.match((await service.syncNow()).lastError,/temporary failure/)
  const key=[...states.keys()].find(k=>k.startsWith('catalog_v4_'))
  assert.equal(states.get(key),'10')
  fail=false;requests.length=0
  assert.equal((await service.syncNow()).syncing,false)
  assert.equal(states.get(key),'12')
  assert.ok(deleted.includes('m1'))
  assert.equal(requests.some(p=>p.startsWith('/v1/materials?')),false)
  assert.ok(events.some(e=>e.cloud?.progress?.total===2&&e.cloud.progress.completed===2))
  account='two';changes=[];requests.length=0
  await service.syncNow()
  assert.ok(requests.includes('/v1/material-config'))
  assert.ok(requests.some(p=>p.startsWith('/v1/materials?')))
})

test('legacy detail reads are deduplicated and bounded to six concurrent requests', async () => {
  let active=0,peak=0,calls=0
  const service=createMaterialCloudService({deviceId:'device',readAuthState:()=>({accessToken:'token'}),readEnv:()=>({}),defaultApiBaseUrl:'https://example.test',send:()=>{},store:createStore({}),exportAnalysisResult:async()=>{throw Error('unused')},importAnalysisResult:async()=>{},request:async url=>{
    const p=new URL(url).pathname
    if(p==='/v1/material-config')return Response.json({})
    if(p==='/v1/sync/changes')return Response.json({changes:[],next_cursor:0})
    if(p==='/v1/folders')return Response.json({items:[]})
    if(p==='/v1/materials')return Response.json({items:Array.from({length:16},(_,i)=>({material_id:'m'+(i%8)}))})
    active++;peak=Math.max(peak,active);calls++
    await new Promise(resolve=>setTimeout(resolve,10));active--
    return Response.json({material_id:p.split('/').pop(),asset_id:p,asset_version:1,folder_id:'f',display_name:'v.mp4',source_sha256:'a'.repeat(64),source_size:12,revision:1})
  }})
  await service.syncNow()
  assert.equal(calls,8)
  assert.equal(peak,6)
})

test('cloud download resolves an unregistered local alias to the registered cloud material', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-download-resume-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const content = Buffer.from('verified-cloud-video-content')
  const localPath = path.join(directory, 'restored.mp4')
  const temporaryPath = `${localPath}.download.part`
  const resumeOffset = 9
  fs.writeFileSync(temporaryPath, content.subarray(0, resumeOffset))
  const material = {
    materialId: 'mat_download_resume_01',
    assetId: 'asset_download_resume_01',
    assetVersion: 1,
    folderId: 'fld_cloud',
    displayName: '云端恢复.mp4',
    mimeType: 'video/mp4',
    sourceSha256: createHash('sha256').update(content).digest('hex'),
    sourceSize: content.length,
    localPath,
    localStatus: 'missing',
    analysisStatus: 'pending',
    cloudAnalysisStatus: 'pending',
    cloudStatus: 'ready',
  }
  const savedSessions = []
  const events = []
  let completedDownload
  const store = {
    ...createStore(material),
    getCloudDownloadSource: () => ({ ...material, materialId: 'mat_registered_cloud' }),
    completeCloudDownload: (...args) => { completedDownload = args },
    saveTransferSession: (session) => { savedSessions.push({ ...session }) },
  }
  const service = createMaterialCloudService({
    deviceId: `dev_${'8'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: (_channel, event) => { events.push(event) },
    store,
    exportAnalysisResult: async () => { throw new Error('not used') },
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (url, init = {}) => {
      assert.equal(url, `http://127.0.0.1:8091/v1/materials/mat_registered_cloud/download-session`)
      assert.equal(init.method, 'POST')
      return new Response(JSON.stringify({
        download_session_id: 'dls_resume_01',
        url: 'https://cos.example.com/temporary-object',
        file_size_bytes: material.sourceSize,
        source_sha256: material.sourceSha256,
        range_supported: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
    downloadFile: async (_url, destination, start, expectedSize, onProgress) => {
      assert.equal(destination, temporaryPath)
      assert.equal(start, resumeOffset)
      assert.equal(expectedSize, content.length)
      fs.appendFileSync(destination, content.subarray(start))
      onProgress?.(content.length)
      return content.length - start
    },
  })

  const result = await service.downloadMaterial({ materialId: material.materialId })

  assert.equal(result.ok, true)
  assert.equal(result.path, localPath)
  assert.deepEqual(fs.readFileSync(localPath), content)
  assert.equal(fs.existsSync(temporaryPath), false)
  assert.deepEqual(completedDownload, [material.materialId, localPath, material.sourceSha256, material.sourceSize])
  assert.equal(savedSessions.at(-1).status, 'ready')
  assert.equal(savedSessions.at(-1).bytesTransferred, content.length)
  assert.ok(events.some((event) => event.type === 'cloud-progress' && event.direction === 'download'))
  assert.ok(events.some((event) => event.type === 'cloud-status' && event.status === 'verifying'))
})


test('a successful parallel operation cannot erase another operation failure', async () => {
  const material = { materialId: 'mat_pending', analysisStatus: 'pending' }
  const service = createMaterialCloudService({
    deviceId: 'dev_test', readAuthState: () => ({ accessToken: 'test' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => {},
    store: { ...createStore(material), claimCloudOperations: () => [
      { operationId: 'fail', operationType: 'sync_analysis', entityId: material.materialId, attemptCount: 0 },
      { operationId: 'ok', operationType: 'sync_folder', entityId: 'missing_folder', attemptCount: 0 },
    ] },
    request: async () => { throw new Error('unexpected network') },
  })
  const status = await service.processQueue()
  assert.ok(status.lastError)
  assert.equal(status.online, false)
})

test('selecting a private local file that has not uploaded needs no cloud lookup', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-material-selection-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const localPath = path.join(root, 'source.mp4')
  fs.writeFileSync(localPath, 'fixture')
  const material = { materialId: 'mat_local', localPath, localStatus: 'present', cloudStatus: 'failed' }
  const service = createMaterialCloudService({
    deviceId: 'dev_test', readAuthState: () => ({}),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    store: createStore(material), send: () => {},
    request: async () => { throw new Error('unexpected network') },
  })
  assert.equal((await service.resolveMaterialSelection({ materialIds: ['mat_local'] })).ok, true)
  material.cloudStatus = 'ready'
  assert.equal((await service.resolveMaterialSelection({ materialIds: ['mat_local'] })).ok, false)
})

test('upload controls pause, resume and cancel the same reliable transfer', async () => {
  const material = {
    materialId: 'mat_control_01',
    localPath: 'D:\\managed\\control.mp4',
    localStatus: 'present',
    analysisStatus: 'ready',
    cloudStatus: 'uploading',
  }
  let operationStatus = 'processing'
  let transferStatus = 'uploading'
  const cloudStatuses = []
  const requests = []
  const store = {
    ...createStore(material),
    getTransferSession: () => ({
      sessionId: 'upl_control_01',
      direction: 'upload',
      materialId: material.materialId,
      status: transferStatus,
      bytesTransferred: 8,
      totalBytes: 16,
      partSize: 8,
      completedParts: [1],
    }),
    pauseCloudUpload: () => {
      if (!['queued', 'processing', 'failed', 'paused'].includes(operationStatus)) return false
      operationStatus = 'paused'
      transferStatus = 'paused'
      return true
    },
    resumeCloudUpload: () => {
      if (operationStatus !== 'paused') return false
      operationStatus = 'queued'
      transferStatus = 'queued'
      return true
    },
    cancelCloudUpload: () => {
      operationStatus = 'canceled'
      transferStatus = 'canceled'
      return true
    },
    setCloudStatusForMaterial: (_materialId, status) => { cloudStatuses.push(status) },
  }
  const service = createMaterialCloudService({
    deviceId: `dev_${'4'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => undefined,
    store,
    exportAnalysisResult: async () => { throw new Error('not used') },
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (url, init = {}) => {
      requests.push({ url, init })
      return new Response(JSON.stringify({ upload_session_id: 'upl_control_01', status: 'canceled' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  const paused = await service.controlUpload({ materialId: material.materialId, action: 'pause' })
  assert.equal(paused.ok, true)
  assert.equal(operationStatus, 'paused')

  const resumed = await service.controlUpload({ materialId: material.materialId, action: 'resume' })
  assert.equal(resumed.ok, true)
  assert.equal(operationStatus, 'queued')
  assert.deepEqual(cloudStatuses, ['uploading'])

  await service.controlUpload({ materialId: material.materialId, action: 'pause' })
  const canceled = await service.controlUpload({ materialId: material.materialId, action: 'cancel' })
  assert.equal(canceled.ok, true)
  assert.equal(operationStatus, 'canceled')
  assert.equal(transferStatus, 'canceled')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'http://127.0.0.1:8091/v1/upload-sessions/upl_control_01/cancel')
  assert.equal(requests[0].init.method, 'POST')
  assert.deepEqual(cloudStatuses, ['uploading', 'not_uploaded'])
})

test('cloud semantic search uses login identity headers and returns local material identity', async () => {
  const material = {
    materialId: 'mat_01',
    assetId: 'asset_01',
    assetVersion: 1,
    displayName: '产品主镜头.mp4',
    localPath: 'D:\\managed\\产品主镜头.mp4',
    localStatus: 'missing',
    sourceSha256: 'a'.repeat(64),
    sourceSize: 128,
    analysisStatus: 'ready',
    cloudStatus: 'ready',
  }
  let captured
  const service = createMaterialCloudService({
    deviceId: `dev_${'b'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => undefined,
    store: createStore(material),
    exportAnalysisResult: async () => { throw new Error('not used') },
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (url, init) => {
      captured = { url, init }
      return new Response(JSON.stringify({
        results: [{ material_id: material.materialId, score: 0.91, rank: 1 }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  const result = await service.semanticSearch({ query: '工业机械臂', results: 20 })

  assert.equal(result.ok, true)
  assert.equal(result.results[0].materialId, material.materialId)
  assert.equal(result.results[0].localStatus, 'missing')
  assert.equal(captured.url, 'http://127.0.0.1:8091/v1/materials/search/semantic')
  assert.equal(captured.init.headers.Authorization, 'Bearer login-token')
  assert.equal(captured.init.headers['X-Device-Id'], `dev_${'b'.repeat(32)}`)
  const body = JSON.parse(captured.init.body)
  assert.deepEqual(body, { query: '工业机械臂', limit: 20 })
  assert.equal('user_id' in body, false)
  assert.equal('bucket' in body, false)
})

test('desktop platform uses the built-in material service instead of user file configuration', async () => {
  let requestUrl = ''
  const service = createMaterialCloudService({
    deviceId: `dev_${'p'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    readPlatformEnv: () => ({}),
    defaultApiBaseUrl: 'https://material-upload.evstai.com',
    send: () => undefined,
    store: createStore({ materialId: 'mat_platform_default_01' }),
    exportAnalysisResult: async () => { throw new Error('not used') },
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (url) => {
      requestUrl = url
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  const result = await service.semanticSearch({ query: '产品展示' })

  assert.equal(result.ok, true)
  assert.equal(requestUrl, 'https://material-upload.evstai.com/v1/materials/search/semantic')
})

test('non-HTTPS remote material API configuration is rejected', () => {
  const material = { materialId: 'mat_01' }
  const service = createMaterialCloudService({
    deviceId: `dev_${'c'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://material.example.com' }),
    send: () => undefined,
    store: createStore(material),
    exportAnalysisResult: async () => { throw new Error('not used') },
    importAnalysisResult: async () => { throw new Error('not used') },
  })

  assert.equal(service.status().configured, false)
})

test('upload recovery trusts server parts and completes without re-uploading them', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-upload-resume-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const localPath = path.join(directory, 'source.mp4')
  fs.writeFileSync(localPath, 'already-uploaded-content')
  const material = {
    materialId: 'mat_upload_resume_01',
    assetId: 'asset_upload_resume_01',
    assetVersion: 1,
    folderId: 'fld_products',
    displayName: '断点恢复.mp4',
    mimeType: 'video/mp4',
    sourceSha256: createHash('sha256').update('already-uploaded-content').digest('hex'),
    sourceSize: fs.statSync(localPath).size,
    origin: 'user_upload',
    addedFrom: 'user_import',
    revision: 2,
    localPath,
    localStatus: 'present',
    analysisStatus: 'ready',
    cloudStatus: 'not_uploaded',
  }
  const operation = {
    operationId: 'op_upload_resume_01',
    operationType: 'upload',
    entityId: material.materialId,
    payload: {},
    status: 'processing',
    attemptCount: 0,
    nextRetryAt: new Date(0).toISOString(),
  }
  let claimed = false
  let completed = ''
  const requests = []
  const savedSessions = []
  const store = {
    ...createStore(material),
    claimCloudOperations: () => claimed ? [] : (claimed = true, [operation]),
    completeCloudOperation: (operationId) => { completed = operationId },
    folderChainForMaterial: () => [],
    saveTransferSession: (session) => { savedSessions.push(session) },
  }
  const service = createMaterialCloudService({
    deviceId: `dev_${'5'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => undefined,
    store,
    exportAnalysisResult: async () => validLocalAnalysis(),
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (url, init = {}) => {
      const parsed = new URL(url)
      requests.push({ pathname: parsed.pathname, method: init.method || 'GET' })
      if (parsed.pathname.endsWith('/analysis-results')) return Response.json({ material_id: material.materialId, analysis_status: 'completed' })
      let response = {}
      if (parsed.pathname === '/v1/sync/batch') {
        response = { results: [{ entity_type: 'material', entity_id: material.materialId, ok: true, revision: 2 }] }
      } else if (parsed.pathname === '/v1/upload-sessions') {
        response = {
          upload_session_id: 'upl_resume_01',
          status: 'created',
          upload_mode: 'single',
          part_size_bytes: material.sourceSize,
          reuse: { type: 'none' },
        }
      } else if (parsed.pathname === '/v1/upload-sessions/upl_resume_01/resume') {
        response = {
          upload_session_id: 'upl_resume_01',
          status: 'created',
          upload_mode: 'single',
          part_size_bytes: material.sourceSize,
          uploaded_bytes: material.sourceSize,
          completed_parts: [1],
        }
      } else if (parsed.pathname === '/v1/upload-sessions/upl_resume_01/complete') {
        response = { status: 'ready', cloud_status: 'ready' }
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  await service.processQueue()

  assert.equal(completed, operation.operationId)
  assert.equal(requests.some((item) => item.pathname.includes('part-authorizations')), false)
  assert.equal(requests.some((item) => item.pathname.endsWith('/resume')), true)
  assert.equal(requests.some((item) => item.pathname.endsWith('/complete')), true)
  assert.deepEqual(savedSessions.at(-1).completedParts, [1])
  assert.equal(savedSessions.at(-1).status, 'ready')
})

test('cross-device upload reuses the existing cloud folder chain by hierarchy and name', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-upload-folder-reuse-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const localPath = path.join(directory, 'source.mp4')
  fs.writeFileSync(localPath, 'folder-reuse-content')
  const material = {
    materialId: 'mat_folder_reuse_01', assetId: 'asset_folder_reuse_01', assetVersion: 1,
    folderId: 'fld_local_project', displayName: '跨设备素材.mp4', mimeType: 'video/mp4',
    sourceSha256: createHash('sha256').update('folder-reuse-content').digest('hex'),
    sourceSize: fs.statSync(localPath).size, origin: 'user_upload', addedFrom: 'user_import',
    revision: 1, localPath, localStatus: 'present', analysisStatus: 'ready', cloudStatus: 'not_uploaded',
  }
  const operation = {
    operationId: 'op_folder_reuse_01', operationType: 'upload', entityId: material.materialId,
    payload: {}, status: 'processing', attemptCount: 0, nextRetryAt: new Date(0).toISOString(),
  }
  let claimed = false
  let syncBody
  const store = {
    ...createStore(material),
    claimCloudOperations: () => claimed ? [] : (claimed = true, [operation]),
    folderChainForMaterial: () => [
      { folderId: 'fld_local_root', name: '本地素材', revision: 1 },
      { folderId: 'fld_local_project', parentFolderId: 'fld_local_root', name: '项目甲', revision: 1 },
    ],
  }
  const service = createMaterialCloudService({
    deviceId: `dev_${'8'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => undefined,
    store,
    exportAnalysisResult: async () => validLocalAnalysis(),
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (url, init = {}) => {
      const pathname = new URL(url).pathname
      if (pathname.endsWith('/analysis-results')) return Response.json({ material_id: material.materialId, analysis_status: 'completed' })
      if (pathname === '/v1/folders') {
        return Response.json({ items: [
          { folder_id: 'fld_cloud_root', parent_folder_id: null, name: '本地素材', revision: 4 },
          { folder_id: 'fld_cloud_project', parent_folder_id: 'fld_cloud_root', name: '项目甲', revision: 2 },
        ], has_more: false })
      }
      if (pathname === '/v1/sync/batch') {
        syncBody = JSON.parse(init.body)
        return Response.json({ results: [
          { entity_type: 'folder', entity_id: 'fld_cloud_root', ok: true, revision: 4 },
          { entity_type: 'folder', entity_id: 'fld_cloud_project', ok: true, revision: 2 },
          { entity_type: 'material', entity_id: material.materialId, ok: true, revision: 1 },
        ] })
      }
      if (pathname === '/v1/upload-sessions') {
        return Response.json({ upload_session_id: 'upl_folder_reuse_01', reuse: { type: 'own_asset' } })
      }
      throw new Error(`unexpected request ${pathname}`)
    },
  })

  await service.processQueue()
  assert.deepEqual(syncBody.folders.map((item) => item.folder_id), ['fld_cloud_root', 'fld_cloud_project'])
  assert.equal(syncBody.materials[0].folder_id, 'fld_cloud_project')
})

test('folder creation on a fresh device reuses the existing cloud parent', async () => {
  const localRoot = { folderId: 'local_root', name: '本地素材', revision: 1 }
  const localChild = { folderId: 'new_child', parentFolderId: 'local_root', name: 'Candidate verification', revision: 1 }
  let claimed = false
  let syncBody
  const store = {
    ...createStore({}),
    getCloudFolderRecord: id => id === localRoot.folderId ? localRoot : id === localChild.folderId ? localChild : null,
    claimCloudOperations: () => claimed ? [] : (claimed = true, [{ operationId: 'folder_create', operationType: 'sync_folder', entityId: localChild.folderId, payload: {}, attemptCount: 0 }]),
  }
  const service = createMaterialCloudService({
    deviceId: 'candidate_device', readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => {}, store, exportAnalysisResult: async () => { throw Error('unused') }, importAnalysisResult: async () => {},
    request: async (url, init = {}) => {
      if (new URL(url).pathname === '/v1/folders') return Response.json({ items: [{ folder_id: 'remote_root', name: '本地素材', revision: 4 }], has_more: false })
      if (new URL(url).pathname === '/v1/sync/batch') {
        syncBody = JSON.parse(init.body)
        if (syncBody.folders.some(f => f.folder_id === 'local_root')) return Response.json({ results: [{ ok: false, error: { message: '同级文件夹名称已存在' } }] })
        return Response.json({ results: syncBody.folders.map(f => ({ ok: true, entity_type: 'folder', entity_id: f.folder_id, revision: f.revision })) })
      }
      throw Error('Unexpected request')
    },
  })
  const status = await service.processQueue()
  assert.equal(status.lastError, undefined)
  assert.deepEqual(syncBody.folders.map(f => [f.folder_id, f.parent_folder_id]), [['remote_root', null], ['new_child', 'remote_root']])
})

test('upload transport failures persist a resumable failed transfer instead of a stuck upload', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-upload-failure-state-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const localPath = path.join(directory, 'source.mp4')
  fs.writeFileSync(localPath, 'upload-failure-content')
  const material = {
    materialId: 'mat_upload_failure_01', assetId: 'asset_upload_failure_01', assetVersion: 1,
    folderId: 'fld_failure', displayName: '上传失败.mp4', mimeType: 'video/mp4',
    sourceSha256: createHash('sha256').update('upload-failure-content').digest('hex'),
    sourceSize: fs.statSync(localPath).size, origin: 'user_upload', addedFrom: 'user_import', revision: 1,
    localPath, localStatus: 'present', analysisStatus: 'ready', cloudStatus: 'not_uploaded',
  }
  const operation = {
    operationId: 'op_upload_failure_01', operationType: 'upload', entityId: material.materialId,
    payload: {}, status: 'processing', attemptCount: 0, nextRetryAt: new Date(0).toISOString(),
  }
  let claimed = false
  let transfer = null
  let retried = ''
  const store = {
    ...createStore(material),
    claimCloudOperations: () => claimed ? [] : (claimed = true, [operation]),
    getTransferSession: () => transfer,
    saveTransferSession: (value) => { transfer = value },
    retryCloudOperation: (_operationId, message) => { retried = message },
  }
  const service = createMaterialCloudService({
    deviceId: `dev_${'9'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => undefined,
    store,
    exportAnalysisResult: async () => validLocalAnalysis(),
    importAnalysisResult: async () => { throw new Error('not used') },
    uploadFile: async () => { throw Object.assign(new Error('net::ERR_INVALID_ARGUMENT'), { code: 'ERR_INVALID_ARGUMENT' }) },
    request: async (url) => {
      const pathname = new URL(url).pathname
      if (pathname.endsWith('/analysis-results')) return Response.json({ material_id: material.materialId, analysis_status: 'completed' })
      if (pathname === '/v1/sync/batch') return Response.json({ results: [{ entity_type: 'material', entity_id: material.materialId, ok: true, revision: 1 }] })
      if (pathname === '/v1/upload-sessions') return Response.json({ upload_session_id: 'upl_failure_01', part_size_bytes: material.sourceSize, reuse: { type: 'none' } })
      if (pathname.endsWith('/resume')) return Response.json({ upload_session_id: 'upl_failure_01', part_size_bytes: material.sourceSize, completed_parts: [] })
      if (pathname.endsWith('/part-authorizations')) return Response.json({ authorizations: [{ part_number: 1, method: 'PUT', url: 'https://storage.example.com/upload', headers: {} }] })
      throw new Error(`unexpected request ${pathname}`)
    },
  })

  await service.processQueue()
  assert.equal(transfer.status, 'failed')
  assert.match(transfer.lastError, /ERR_INVALID_ARGUMENT/)
  assert.match(retried, /ERR_INVALID_ARGUMENT/)
})

test('public material catalog and publication actions use authenticated idempotent cloud requests', async () => {
  const material = {
    materialId: 'mat_publish_01',
    assetId: 'asset_publish_01',
    assetVersion: 1,
    folderId: 'fld_products',
    displayName: '产品主镜头.mp4',
    localPath: 'D:\\managed\\产品主镜头.mp4',
    localStatus: 'present',
    sourceSha256: 'a'.repeat(64),
    sourceSize: 128,
    analysisStatus: 'ready',
    cloudAnalysisStatus: 'ready',
    cloudStatus: 'ready',
    cloudRevision: 6,
    publicationStatus: 'private',
  }
  const requests = []
  const service = createMaterialCloudService({
    deviceId: `dev_${'7'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => undefined,
    store: createStore(material),
    exportAnalysisResult: async () => { throw new Error('not used') },
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (url, init = {}) => {
      const parsed = new URL(url)
      const body = init.body ? JSON.parse(init.body) : undefined
      requests.push({ pathname: parsed.pathname, search: parsed.search, init, body })
      let response = {}
      if (parsed.pathname === '/v1/public-materials' && init.method !== 'POST') {
        response = {
          items: [{
            publication_id: 'pub_catalog_01',
            display_name: '公开产品镜头.mp4',
            duration_ms: 42000,
          }],
          has_more: false,
        }
      } else if (parsed.pathname === '/v1/public-materials/pub_catalog_01/add') {
        response = { material_id: 'mat_imported_01', created: true }
      } else if (parsed.pathname === '/v1/public-materials/pub_catalog_01/reports') {
        response = { report_id: 'rpt_01', status: 'pending', created: true }
      } else if (parsed.pathname === '/v1/material-config') {
        response = {
          platform_downloads: { auto_sync_enabled: true },
          publications: { consent_version: 'rights-v1' },
        }
      } else if (parsed.pathname === '/v1/materials/mat_publish_01/publications') {
        response = { publication_id: 'pub_publish_01', status: 'pending_review', revision: 1 }
      } else if (parsed.pathname === '/v1/publications/pub_publish_01') {
        response = { publication_id: 'pub_publish_01', status: 'withdrawn', revision: 2 }
      } else if (parsed.pathname === '/v1/sync/changes') {
        response = { changes: [], next_cursor: 0, has_more: false }
      } else if (parsed.pathname === '/v1/folders' || parsed.pathname === '/v1/materials') {
        response = { items: [], has_more: false }
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  const listed = await service.listPublicMaterials({ keyword: '工业 机械臂', limit: 24 })
  assert.equal(listed.ok, true)
  assert.equal(listed.items[0].publication_id, 'pub_catalog_01')

  const added = await service.addPublicMaterial({
    publicationId: 'pub_catalog_01',
    folderId: 'fld_products',
  })
  assert.equal(added.ok, true)
  assert.equal(added.material_id, 'mat_imported_01')

  const reported = await service.reportPublicMaterial({
    publicationId: 'pub_catalog_01',
    category: 'copyright',
    description: '该素材未经授权使用了我的原创视频。',
  })
  assert.equal(reported.ok, true)
  assert.equal(reported.report_id, 'rpt_01')

  const published = await service.publishMaterial({ materialId: material.materialId })
  assert.equal(published.ok, true)
  material.publicationId = 'pub_publish_01'
  material.publicationRevision = 1
  material.publicationStatus = 'publishing'
  const withdrawn = await service.withdrawPublication({
    materialId: material.materialId,
    reason: '用户主动取消',
  })
  assert.equal(withdrawn.ok, true)

  const catalogRequest = requests.find((item) => item.pathname === '/v1/public-materials')
  assert.equal(catalogRequest.search, '?limit=24&keyword=%E5%B7%A5%E4%B8%9A%20%E6%9C%BA%E6%A2%B0%E8%87%82')
  assert.equal(catalogRequest.init.headers.Authorization, 'Bearer login-token')
  assert.equal(catalogRequest.init.headers['X-Device-Id'], `dev_${'7'.repeat(32)}`)

  const addRequest = requests.find((item) => item.pathname.endsWith('/pub_catalog_01/add'))
  assert.equal(addRequest.init.method, 'POST')
  assert.deepEqual(addRequest.body, { folder_id: 'fld_products' })
  assert.match(addRequest.init.headers['Idempotency-Key'], /^public-add-[a-f0-9]{48}$/)

  const reportRequest = requests.find((item) => item.pathname.endsWith('/pub_catalog_01/reports'))
  assert.equal(reportRequest.init.method, 'POST')
  assert.deepEqual(reportRequest.body, {
    category: 'copyright',
    description: '该素材未经授权使用了我的原创视频。',
  })
  assert.match(reportRequest.init.headers['Idempotency-Key'], /^public-report-[a-f0-9]{48}$/)

  const publishRequest = requests.find((item) => item.pathname.endsWith('/mat_publish_01/publications'))
  assert.equal(publishRequest.init.method, 'POST')
  assert.deepEqual(publishRequest.body, {
    revision: 6,
    consent_version: 'rights-v1',
    rights_confirmed: true,
  })
  assert.match(publishRequest.init.headers['Idempotency-Key'], /^publication-submit-[a-f0-9]{48}$/)

  const withdrawRequest = requests.find((item) => item.pathname === '/v1/publications/pub_publish_01')
  assert.equal(withdrawRequest.init.method, 'DELETE')
  assert.deepEqual(withdrawRequest.body, { revision: 1, reason: '用户主动取消' })
  assert.match(withdrawRequest.init.headers['Idempotency-Key'], /^publication-withdraw-[a-f0-9]{48}$/)
})

test('picker confirmation revalidates selected material permissions with the cloud service', async () => {
  const material = { materialId: 'mat_01' }
  let capturedBody
  const service = createMaterialCloudService({
    deviceId: `dev_${'d'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => undefined,
    store: createStore(material),
    exportAnalysisResult: async () => { throw new Error('not used') },
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (_url, init) => {
      capturedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ items: [], unavailable: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  const result = await service.resolveMaterialSelection({ materialIds: ['mat_01'] })

  assert.equal(result.ok, true)
  assert.deepEqual(capturedBody, { material_ids: ['mat_01'] })
})

test('generation revalidates permissions and freezes each shot before returning a local manifest', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-cloud-generation-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const localPath = path.join(directory, 'source.mp4')
  const manifestPath = path.join(directory, 'run_12345.json')
  fs.writeFileSync(localPath, 'video')
  fs.writeFileSync(manifestPath, '{}')
  const material = {
    materialId: 'mat_01',
    assetId: 'asset_01',
    assetVersion: 1,
    folderId: 'fld_generation',
    displayName: '生成素材.mp4',
    mimeType: 'video/mp4',
    sourceSha256: createHash('sha256').update('video').digest('hex'),
    sourceSize: 5,
    origin: 'user_upload',
    addedFrom: 'user_import',
    revision: 1,
    localPath,
    localStatus: 'present',
    cloudStatus: 'ready',
  }
  const store = {
    ...createStore(material),
    materialIdsForGeneration: () => ['mat_01'],
    prepareGenerationManifestFromSnapshot: (snapshot) => ({ manifestPath, snapshot }),
  }
  const requests = []
  const service = createMaterialCloudService({
    deviceId: `dev_${'e'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => undefined,
    store,
    exportAnalysisResult: async () => { throw new Error('not used') },
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined
      requests.push({ url, init, body })
      let data
      if (String(url).endsWith('/v1/sync/batch')) {
        data = { results: [{ entity_type: 'material', entity_id: material.materialId, ok: true, revision: 1 }] }
      } else if (String(url).endsWith('/v1/shot-material-validations')) {
        data = {
          valid: true,
          shots: [{
            shot_id: 'shot_12345',
            valid: true,
            materials: [{ material_id: 'mat_01' }],
            issues: [],
          }],
        }
      } else if (String(url).endsWith('/v1/generation-runs')) {
        data = { run_id: 'run_12345', manifest_checksum: 'f'.repeat(64) }
      } else {
        data = {
          run_id: 'run_12345',
          task_id: 'task_12345',
          task_revision: 1,
          manifest_checksum: 'f'.repeat(64),
          shots: [{
            shot_id: 'shot_12345',
            materials: [{
              material_id: 'mat_01',
              asset_id: 'asset_01',
              asset_version: 1,
              source_sha256: 'a'.repeat(64),
            }],
          }],
        }
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  const result = await service.prepareGenerationManifest({
    taskId: 'task_12345',
    taskRevision: 1,
    shots: [{
      shot_id: 'shot_12345',
      download_material: false,
      material_bindings: [{ binding_type: 'material', material_id: 'mat_01' }],
    }],
  })

  assert.equal(result.manifestPath, manifestPath)
  assert.equal(requests.length, 4)
  assert.ok(requests[0].url.endsWith('/v1/sync/batch'))
  assert.equal(requests[0].body.materials[0].material_id, material.materialId)
  assert.equal(requests[0].body.materials[0].source_sha256, material.sourceSha256)
  assert.equal(requests[0].body.materials[0].file_size_bytes, material.sourceSize)
  assert.ok(requests[1].url.endsWith('/v1/shot-material-validations'))
  assert.equal(requests[1].body.require_analysis_ready, false)
  assert.ok(requests[2].url.endsWith('/v1/generation-runs'))
  assert.equal(requests[2].body.task_id, 'task_12345')
  assert.equal(requests[2].init.headers['Idempotency-Key'].startsWith('generation-run-'), true)
  assert.ok(requests[3].url.endsWith('/v1/generation-runs/run_12345/material-manifest'))
  assert.equal(result.snapshot.runId, 'run_12345')
  assert.equal(result.snapshot.shots[0].shot_id, 'shot_12345')
  assert.equal(result.snapshot.shots[0].materials[0].material_id, 'mat_01')
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function createGenerationRegistrationFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-generation-registration-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const materials = Array.from({ length: options.materialCount || 1 }, (_, index) => {
    const content = `generation-material-${index}`
    const localPath = path.join(directory, `material-${index}.mp4`)
    fs.writeFileSync(localPath, content)
    return {
      materialId: `mat_registration_${index}`,
      assetId: `asset_registration_${index}`,
      assetVersion: 1,
      folderId: 'fld_registration',
      displayName: `机器人镜头${index + 1}.mp4`,
      mimeType: 'video/mp4',
      sourceSha256: createHash('sha256').update(content).digest('hex'),
      sourceSize: Buffer.byteLength(content),
      origin: 'user_upload',
      addedFrom: 'user_import',
      revision: options.materialRevision || 1,
      localPath,
      localStatus: 'present',
      analysisStatus: 'pending',
      cloudStatus: 'not_uploaded',
    }
  })
  const requests = [], registered = new Map(), queued = [], events = []
  const selectedIds = options.selectedIds || materials.map(material => material.materialId)
  let claimed = false
  const store = {
    ...createStore(materials[0]),
    folderChainForMaterial: id => typeof options.folderChain === 'function' ? options.folderChain(id) : options.folderChain || [],
    getMaterialCloudFileById: id => materials.find(material => material.materialId === id) || null,
    materialIdsForGeneration: () => selectedIds,
    setCloudRevisionForMaterial: (id, revision) => registered.set(id, revision),
    prepareGenerationManifestFromSnapshot: snapshot => ({ manifestPath: path.join(directory, 'manifest.json'), snapshot }),
    claimCloudOperations: () => {
      if (claimed) return []
      claimed = true
      return (options.backgroundMaterialIds || []).map((id, index) => ({
        operationId: `op_registration_${index}`,
        operationType: 'sync_material',
        entityId: id,
        payload: {},
        status: 'processing',
        attemptCount: 0,
      }))
    },
    queueCloudOperation: (...args) => {
      queued.push(args)
      return { operationId: `unexpected_queue_${queued.length}` }
    },
  }
  const service = createMaterialCloudService({
    deviceId: 'dev_generation_registration',
    readAuthState: options.readAuthState || (() => ({ accessToken: 'login-token' })),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: (_channel, event) => events.push(event),
    store,
    exportAnalysisResult: async () => { throw new Error('not used') },
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (url, init = {}) => {
      const pathname = new URL(url).pathname
      const body = init.body ? JSON.parse(init.body) : undefined
      requests.push({ pathname, body })
      if (pathname === '/v1/folders') {
        await options.folderRequest?.()
        return Response.json({ items: options.remoteFolders || [], has_more: false })
      }
      if (pathname === '/v1/sync/batch') {
        const customResponse = await options.syncRequest?.(body)
        return customResponse || Response.json({ results: body.materials.map(material => ({
          entity_type: 'material', entity_id: material.material_id, ok: true, revision: material.revision,
        })) })
      }
      if (pathname === '/v1/shot-material-validations') {
        assert.ok(selectedIds.every(id => registered.has(id)), 'validation must wait until every selected material is acknowledged')
        const customResponse = await options.validationRequest?.(body)
        if (customResponse) return customResponse
        return Response.json({ valid: true, shots: [] })
      }
      if (pathname === '/v1/generation-runs') return Response.json({ run_id: 'run_registration' })
      if (pathname === '/v1/generation-runs/run_registration/material-manifest') {
        return Response.json({ run_id: 'run_registration', shots: [{
          shot_id: 'shot_registration',
          materials: materials.filter(material => (options.frozenMaterialIds || selectedIds).includes(material.materialId)).map(material => ({
            material_id: material.materialId,
            asset_id: material.assetId,
            asset_version: material.assetVersion,
            source_sha256: material.sourceSha256,
          })),
        }] })
      }
      throw new Error(`unexpected request ${pathname}`)
    },
  })
  const prepare = (shots) => service.prepareGenerationManifest({
    taskId: 'task_registration', taskRevision: 1,
    shots: shots || [{
      shot_id: 'shot_registration', download_material: false,
      material_bindings: [{ binding_type: 'folder', folder_id: 'fld_registration', include_subfolders: true }],
    }],
  })
  return { service, prepare, materials, requests, registered, queued, events }
}

test('generation validates the same folder identity acknowledged during cross-device registration', async t => {
  const fixture = createGenerationRegistrationFixture(t, {
    folderChain: [{ folderId: 'fld_registration', name: '机器人素材', revision: 1 }],
    remoteFolders: [{ folder_id: 'fld_cloud_existing', name: '机器人素材', revision: 4 }],
    validationRequest: body => {
      const bindings = body.shots[0].material_bindings
      // The real server resolves folders by ID, not by their display name.
      if (bindings.some(binding => binding.folder_id === 'fld_registration')) {
        return Response.json({ valid: false, shots: [{ shot_id: 'shot_registration', issues: [{ severity: 'blocker', message: '素材文件夹展开后的候选数量为 0' }] }] })
      }
      assert.deepEqual(bindings, [{ binding_type: 'folder', folder_id: 'fld_cloud_existing', include_subfolders: true }],
        'validate exactly the logical folder used when registering its materials')
    },
  })
  const result = await fixture.prepare()
  const registration = fixture.requests.find(item => item.pathname === '/v1/sync/batch')
  assert.equal(registration.body.materials[0].folder_id, 'fld_cloud_existing')
  const creation = fixture.requests.find(item => item.pathname === '/v1/generation-runs')
  assert.deepEqual(creation.body.shots[0].material_bindings, [{ binding_type: 'folder', folder_id: 'fld_cloud_existing', include_subfolders: true }])
  assert.deepEqual(result.snapshot.shots[0].materials.map(item => item.material_id), ['mat_registration_0'])
})

test('generation preserves the server rejection of an empty selected folder', async t => {
  const fixture = createGenerationRegistrationFixture(t, {
    selectedIds: [],
    validationRequest: () => Response.json({ valid: false, shots: [{
      shot_id: 'shot_registration', issues: [{ severity: 'blocker', message: '素材文件夹展开后的候选数量为 0' }],
    }] }),
  })
  await assert.rejects(fixture.prepare(), /shot_registration.*候选数量为 0/)
  assert.deepEqual(fixture.requests.map(item => item.pathname), ['/v1/shot-material-validations'],
    'an empty folder must not silently broaden its scope or start generation')
})

test('generation maps each shot independently and still enforces cloud permission validation', async t => {
  const fixture = createGenerationRegistrationFixture(t, {
    materialCount: 2,
    folderChain: id => [{ folderId: id === 'mat_registration_0' ? 'fld_first' : 'fld_second', name: id, revision: 1 }],
    remoteFolders: [
      { folder_id: 'fld_cloud_first', name: 'mat_registration_0', revision: 1 },
      { folder_id: 'fld_cloud_second', name: 'mat_registration_1', revision: 1 },
    ],
    validationRequest: body => {
      assert.deepEqual(body.shots.map(shot => shot.material_bindings), [
        [{ binding_type: 'folder', folder_id: 'fld_cloud_first', include_subfolders: false }],
        [{ binding_type: 'folder', folder_id: 'fld_cloud_second', include_subfolders: true }],
      ])
      return Response.json({ valid: false, shots: [{ shot_id: 'shot_second', issues: [{ severity: 'blocker', message: '素材权限已撤回' }] }] })
    },
  })
  await assert.rejects(fixture.prepare([
    { shot_id: 'shot_first', download_material: false, material_bindings: [{ binding_type: 'folder', folder_id: 'fld_first', include_subfolders: false }] },
    { shot_id: 'shot_second', download_material: false, material_bindings: [{ binding_type: 'folder', folder_id: 'fld_second', include_subfolders: true }] },
  ]), /素材权限已撤回/)
  assert.equal(fixture.requests.some(item => item.pathname === '/v1/generation-runs'), false)
})

test('generation preserves cloud folder expansion when the local catalog is incomplete', async t => {
  const fixture = createGenerationRegistrationFixture(t, {
    materialCount: 2,
    selectedIds: ['mat_registration_0'],
    frozenMaterialIds: ['mat_registration_0', 'mat_registration_1'],
    validationRequest: body => assert.deepEqual(body.shots[0].material_bindings,
      [{ binding_type: 'folder', folder_id: 'fld_registration', include_subfolders: true }]),
  })
  const result = await fixture.prepare()
  assert.deepEqual(result.snapshot.shots[0].materials.map(item => item.material_id), ['mat_registration_0', 'mat_registration_1'])
})

test('generation keeps a large material range within the server folder binding limit', async t => {
  const fixture = createGenerationRegistrationFixture(t, {
    materialCount: 101,
    validationRequest: body => assert.equal(body.shots[0].material_bindings.length, 1),
  })
  const result = await fixture.prepare()
  assert.equal(fixture.registered.size, 101)
  assert.equal(result.snapshot.shots[0].materials.length, 101)
})

test('generation keeps conflicting download and material binding settings subject to validation', async t => {
  const fixture = createGenerationRegistrationFixture(t, {
    selectedIds: [],
    validationRequest: body => {
      assert.equal(body.shots[0].download_material, true)
      assert.deepEqual(body.shots[0].material_bindings,
        [{ binding_type: 'folder', folder_id: 'fld_registration', include_subfolders: false }])
      return Response.json({ valid: false, shots: [{ shot_id: 'shot_download', issues: [
        { severity: 'blocker', message: '自动下载分镜不能同时绑定素材' },
      ] }] })
    },
  })
  await assert.rejects(fixture.prepare([{ shot_id: 'shot_download', download_material: true,
    material_bindings: [{ binding_type: 'folder', folder_id: 'fld_registration', include_subfolders: false }],
  }]), /自动下载分镜不能同时绑定素材/)
  assert.equal(fixture.requests.some(item => item.pathname === '/v1/generation-runs'), false)
})

test('generation registers all folder candidates beyond one queue batch before validation', { timeout: 5_000 }, async t => {
  const gates = Array.from({ length: 5 }, deferred)
  const started = Array.from({ length: 5 }, deferred)
  t.after(() => gates.forEach(gate => gate.resolve()))
  let active = 0, peak = 0
  const fixture = createGenerationRegistrationFixture(t, {
    materialCount: 5,
    syncRequest: async body => {
      const index = Number(body.materials[0].material_id.split('_').at(-1))
      active += 1
      peak = Math.max(peak, active)
      started[index].resolve()
      await gates[index].promise
      active -= 1
    },
  })
  const pending = fixture.prepare()
  await Promise.all(started.slice(0, 2).map(item => item.promise))
  assert.equal(fixture.requests.length, 2)
  assert.equal(fixture.registered.size, 0)
  gates[0].resolve()
  gates[1].resolve()
  await Promise.all(started.slice(2, 4).map(item => item.promise))
  assert.equal(fixture.requests.some(item => item.pathname === '/v1/shot-material-validations'), false)
  assert.equal(fixture.registered.size, 2)
  gates[2].resolve()
  gates[3].resolve()
  await started[4].promise
  assert.equal(fixture.registered.size, 4)
  assert.equal(fixture.requests.some(item => item.pathname === '/v1/shot-material-validations'), false)
  gates[4].resolve()
  const result = await pending
  assert.equal(fixture.registered.size, 5)
  assert.equal(result.snapshot.shots[0].materials.length, 5)
  assert.equal(peak, 2)
  assert.equal(fixture.requests.filter(item => item.pathname === '/v1/sync/batch').length, 5)
  assert.deepEqual(fixture.queued, [], 'foreground registration must not rely on the background operation queue')
})

test('generation waits for its target while an unrelated background operation remains busy', { timeout: 5_000 }, async t => {
  const unrelatedGate = deferred(), targetGate = deferred(), unrelatedStarted = deferred(), targetStarted = deferred()
  t.after(() => { unrelatedGate.resolve(); targetGate.resolve() })
  const fixture = createGenerationRegistrationFixture(t, {
    materialCount: 2,
    selectedIds: ['mat_registration_0'],
    backgroundMaterialIds: ['mat_registration_1'],
    syncRequest: async body => {
      if (body.materials[0].material_id === 'mat_registration_1') {
        unrelatedStarted.resolve()
        await unrelatedGate.promise
      } else {
        targetStarted.resolve()
        await targetGate.promise
      }
    },
  })
  let backgroundFinished = false
  const background = fixture.service.processQueue().then(() => { backgroundFinished = true })
  await unrelatedStarted.promise
  const pending = fixture.prepare()
  await targetStarted.promise
  assert.equal(fixture.requests.some(item => item.pathname === '/v1/shot-material-validations'), false)
  targetGate.resolve()
  await pending
  assert.equal(backgroundFinished, false, 'an unrelated operation must not block this task')
  assert.deepEqual([...fixture.registered.keys()], ['mat_registration_0'])
  unrelatedGate.resolve()
  await background
})

test('generation shares an in-flight registration of the same material with the background queue', { timeout: 5_000 }, async t => {
  const gate = deferred(), started = deferred()
  t.after(() => gate.resolve())
  const fixture = createGenerationRegistrationFixture(t, {
    backgroundMaterialIds: ['mat_registration_0'],
    syncRequest: async () => { started.resolve(); await gate.promise },
  })
  const background = fixture.service.processQueue()
  await started.promise
  const pending = fixture.prepare()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.requests.filter(item => item.pathname === '/v1/sync/batch').length, 1)
  assert.equal(fixture.requests.some(item => item.pathname === '/v1/shot-material-validations'), false)
  gate.resolve()
  await Promise.all([background, pending])
  assert.equal(fixture.requests.filter(item => item.pathname === '/v1/sync/batch').length, 1)
  assert.equal(fixture.requests.filter(item => item.pathname === '/v1/shot-material-validations').length, 1)
})

for (const failure of [
  { name: 'HTTP failure', response: () => Response.json({ message: '登记服务暂时不可用 Bearer secret-token https://temporary.example/signed?token=private' }, { status: 503 }), reason: /登记服务暂时不可用/ },
  { name: 'rejected acknowledgement', response: material => Response.json({ results: [{ entity_type: 'material', entity_id: material.materialId, ok: false, error: { message: '目标素材写入被拒绝' } }] }), reason: /目标素材写入被拒绝/ },
  { name: 'missing acknowledgement', response: () => Response.json({ results: [] }) },
  { name: 'acknowledgement for another material', response: () => Response.json({ results: [{ entity_type: 'material', entity_id: 'unrelated_material', ok: true, revision: 1 }] }) },
  { name: 'zero revision', response: material => Response.json({ results: [{ entity_type: 'material', entity_id: material.materialId, ok: true, revision: 0 }] }) },
  { name: 'fractional revision', response: material => Response.json({ results: [{ entity_type: 'material', entity_id: material.materialId, ok: true, revision: 1.5 }] }) },
  { name: 'outdated revision', materialRevision: 2, response: material => Response.json({ results: [{ entity_type: 'material', entity_id: material.materialId, ok: true, revision: 1 }] }) },
]) {
  test(`generation stops before validation on ${failure.name} and retries registration on the next attempt`, async t => {
    let fail = true
    const fixture = createGenerationRegistrationFixture(t, {
      materialRevision: failure.materialRevision,
      syncRequest: () => fail ? failure.response(fixture.materials[0]) : undefined,
    })
    const material = fixture.materials[0]
    await assert.rejects(fixture.prepare(), error => {
      assert.ok(error.message.includes(material.materialId))
      assert.ok(error.message.includes(material.displayName))
      if (failure.reason) assert.match(error.message, failure.reason)
      assert.doesNotMatch(error.message, /secret-token|temporary\.example|token=private/)
      return true
    })
    assert.equal(fixture.requests.some(item => item.pathname === '/v1/shot-material-validations'), false)
    assert.equal(fixture.requests.some(item => item.pathname === '/v1/generation-runs'), false)
    fail = false
    const result = await fixture.prepare()
    assert.equal(result.snapshot.runId, 'run_registration')
    assert.equal(fixture.requests.filter(item => item.pathname === '/v1/sync/batch').length, 2)
    assert.equal(fixture.requests.filter(item => item.pathname === '/v1/shot-material-validations').length, 1)
  })
}

test('generation does not share an older in-flight metadata snapshot of the same material', { timeout: 5_000 }, async t => {
  const oldGate = deferred(), oldStarted = deferred(), updatedStarted = deferred()
  t.after(() => oldGate.resolve())
  const fixture = createGenerationRegistrationFixture(t, {
    backgroundMaterialIds: ['mat_registration_0'],
    syncRequest: async body => {
      if (body.materials[0].revision === 1) {
        oldStarted.resolve()
        await oldGate.promise
      } else updatedStarted.resolve()
    },
  })
  const background = fixture.service.processQueue()
  await oldStarted.promise
  fixture.materials[0].revision = 2
  fixture.materials[0].displayName = '更新后的机器人镜头.mp4'
  const pending = fixture.prepare()
  await updatedStarted.promise
  await pending
  const registrations = fixture.requests.filter(item => item.pathname === '/v1/sync/batch')
  assert.equal(registrations.length, 2)
  assert.deepEqual(registrations.map(item => item.body.materials[0].revision), [1, 2])
  assert.equal(fixture.registered.get('mat_registration_0'), 2)
  oldGate.resolve()
  await background
})

for (const phase of ['folder resolution', 'material acknowledgement']) {
  test(`generation rejects an account change during ${phase} before validation`, { timeout: 5_000 }, async t => {
    const gate = deferred(), started = deferred()
    t.after(() => gate.resolve())
    let account = 'original-account'
    const waitForAccountChange = async () => { started.resolve(); await gate.promise }
    const fixture = createGenerationRegistrationFixture(t, {
      readAuthState: () => ({ accessToken: `token-${account}`, user: { id: account } }),
      folderChain: phase === 'folder resolution' ? [{ folderId: 'fld_registration', name: '机器人素材', revision: 1 }] : [],
      folderRequest: phase === 'folder resolution' ? waitForAccountChange : undefined,
      syncRequest: phase === 'material acknowledgement' ? waitForAccountChange : undefined,
    })
    const pending = fixture.prepare()
    await started.promise
    account = 'another-account'
    gate.resolve()
    await assert.rejects(pending, /账号|账户|登录/)
    assert.equal(fixture.requests.some(item => item.pathname === '/v1/shot-material-validations'), false)
    assert.equal(fixture.requests.some(item => item.pathname === '/v1/generation-runs'), false)
    assert.equal(fixture.registered.size, 0)
    if (phase === 'folder resolution') {
      assert.equal(fixture.requests.some(item => item.pathname === '/v1/sync/batch'), false)
    }
  })
}

test('Qwen analysis export is validated and receives a deterministic profile identity', () => {
  const result = parseAnalysisExport({
    embedding_backend: 'qwen-cloud',
    model_name: 'qwen3-vl-embedding',
    model_version: 'qwen3-vl-embedding',
    dimension: 3,
    result_schema_version: 1,
    chunks: [{
      chunk_id: 'chunk_01',
      start_ms: 0,
      end_ms: 1000,
      caption: '工业机械臂',
      embedding: [0.1, 0.2, 0.3],
    }],
  })

  assert.match(result.analysis_profile_id, /^profile_[a-f0-9]{32}$/)
  assert.equal(result.chunks[0].caption, '工业机械臂')
})

test('analysis provenance roundtrip preserves configuration and gives different profiles distinct identities', () => {
  const provenance = { schema_version: 1,
    source_identity: { source_sha256: 'a'.repeat(64), source_size: 100, normalization_profile: null },
    analysis_profile: { contract: 'sentry-analysis-v1', backend: 'qwen-cloud', model: 'qwen3-vl-embedding', dimensions: 3, chunk_duration: 30, custom: { enabled: true } },
    duration: 2, spans: [[0, 2]], still_spans: [] }
  const base = { embedding_backend: 'qwen-cloud', model_name: 'qwen3-vl-embedding', model_version: 'v1', dimension: 3,
    result_schema_version: 1, chunks: [{ chunk_id: 'chunk_1', start_ms: 0, end_ms: 2000, caption: '', embedding: [0.1, 0.2, 0.3] }] }
  const first = parseAnalysisExport({ ...base, analysis_provenance: provenance })
  assert.deepEqual(first.analysis_provenance, provenance)
  const reordered = structuredClone(provenance)
  reordered.analysis_profile = Object.fromEntries(Object.entries(reordered.analysis_profile).reverse())
  assert.equal(parseAnalysisExport({ ...base, analysis_provenance: reordered }).analysis_profile_id, first.analysis_profile_id)
  reordered.analysis_profile.chunk_duration = 10
  assert.notEqual(parseAnalysisExport({ ...base, analysis_provenance: reordered }).analysis_profile_id, first.analysis_profile_id)
  assert.notEqual(parseAnalysisExport(base).analysis_profile_id, first.analysis_profile_id)
  assert.throws(() => parseAnalysisExport({ ...base, analysis_provenance: { ...provenance, duration: Number.NaN } }))
  assert.throws(() => parseAnalysisExport({ ...base, analysis_provenance: { ...provenance, spans: [[0, 900]] } }))
})

test('analysis export reuses the indexed Pexels copy while keeping the original material identity', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-analysis-alias-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source.mp4')
  const indexed = path.join(directory, '_indexed_h264', '001_source.mp4')
  const executable = path.join(directory, 'sentrysearch.exe')
  fs.mkdirSync(path.dirname(indexed), { recursive: true })
  fs.writeFileSync(source, 'source-video')
  fs.writeFileSync(indexed, 'normalized-video')
  fs.writeFileSync(executable, '')
  const candidates = []
  const exporter = createMaterialAnalysisExporter({
    dataRoot: directory,
    getSentrySearchPaths: () => ({ exe: executable, python: '', entry: '' }),
    createVideoAutoEnv: () => ({ ...process.env }),
    runCapture: async (_command, args) => {
      const candidate = args[1]
      candidates.push(candidate)
      if (path.resolve(candidate) === path.resolve(source)) {
        return { code: 1, stdout: '', stderr: 'not indexed' }
      }
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          embedding_backend: 'qwen-cloud',
          model_name: 'qwen3-vl-embedding',
          model_version: 'qwen3-vl-embedding',
          dimension: 3,
          result_schema_version: 1,
          chunks: [{
            chunk_id: 'chunk_01',
            start_ms: 0,
            end_ms: 1000,
            caption: 'Pexels 工业镜头',
            embedding: [0.1, 0.2, 0.3],
          }],
        }),
      }
    },
  })

  const result = await exporter.exportForFile(source)

  assert.deepEqual(candidates.map((item) => path.resolve(item)), [
    path.resolve(source),
    path.resolve(indexed),
  ])
  assert.equal(result.chunks[0].caption, 'Pexels 工业镜头')
})

test('analysis export rejects an indexed alias whose verified source identity belongs to another material', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-analysis-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source.mp4')
  const executable = path.join(directory, 'sentrysearch.exe')
  fs.mkdirSync(path.join(directory, '_indexed_h264'))
  fs.writeFileSync(source, 'source-video')
  fs.writeFileSync(executable, '')
  fs.writeFileSync(path.join(directory, '_indexed_h264', '001_source.mp4'), 'wrong-source')
  const exporter = createMaterialAnalysisExporter({ dataRoot: directory,
    getSentrySearchPaths: () => ({ exe: executable, python: '', entry: '' }),
    createVideoAutoEnv: () => ({ ...process.env }),
    runCapture: async (_command, args) => args[1] === source ? { code: 1, stdout: '', stderr: 'not indexed' } : {
      code: 0, stderr: '', stdout: JSON.stringify({ embedding_backend: 'qwen-cloud', model_name: 'qwen3-vl-embedding',
        model_version: 'v1', dimension: 3, result_schema_version: 1,
        chunks: [{ chunk_id: 'chunk_1', start_ms: 0, end_ms: 2000, caption: '', embedding: [0.1, 0.2, 0.3] }],
        analysis_provenance: { schema_version: 1, source_identity: { source_sha256: 'b'.repeat(64), source_size: 12, normalization_profile: null },
          analysis_profile: { contract: 'sentry-analysis-v1', backend: 'qwen-cloud', model: 'qwen3-vl-embedding', dimensions: 3 },
          duration: 2, spans: [[0, 2]], still_spans: [] } }) } })
  await assert.rejects(exporter.exportForFile(source), /素材内容不一致/)
  assert.equal(await exporter.hasForFile(source), false)
})

test('cloud analysis import verifies the restored file and removes its temporary payload', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-analysis-import-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source.mp4')
  const executable = path.join(directory, 'sentrysearch.exe')
  const content = Buffer.from('restored-cloud-video')
  fs.writeFileSync(source, content)
  fs.writeFileSync(executable, '')
  let temporaryPayload = ''
  let importedPayload
  const exporter = createMaterialAnalysisExporter({
    dataRoot: directory,
    getSentrySearchPaths: () => ({ exe: executable, python: '', entry: '' }),
    createVideoAutoEnv: () => ({ ...process.env }),
    runCapture: async (_command, args) => {
      temporaryPayload = args[2]
      importedPayload = JSON.parse(fs.readFileSync(temporaryPayload, 'utf8'))
      return { code: 0, stdout: '{"imported_chunks":1}', stderr: '' }
    },
  })
  const payload = {
    material_id: 'mat_cloud_01',
    asset_id: 'asset_cloud_01',
    asset_version: 1,
    source_sha256: createHash('sha256').update(content).digest('hex'),
    file_size_bytes: content.length,
    analysis_id: 'analysis_cloud_01',
    analysis_profile_id: 'profile_cloud_01',
    embedding_backend: 'qwen-cloud',
    model_name: 'qwen3-vl-embedding',
    model_version: 'qwen3-vl-embedding',
    dimension: 3,
    result_schema_version: 1,
    chunks: [{
      chunk_id: 'chunk_01',
      start_ms: 0,
      end_ms: 1000,
      caption: '云端恢复镜头',
      embedding: [0.1, 0.2, 0.3],
    }],
  }

  await exporter.importForFile(source, payload)

  assert.equal(importedPayload.source_sha256, payload.source_sha256)
  assert.equal(fs.existsSync(temporaryPayload), false)
})

test('analysis transfer uses the same long source identity and supports a long temporary JSON path', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-analysis-long-path-'))
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const dataRoot = path.join(directory, '项目素材目录'.repeat(12), '分析结果目录'.repeat(12), '中文和空格 '.repeat(12).trimEnd())
  fs.mkdirSync(dataRoot, { recursive: true })
  const source = path.join(dataRoot, '素材.mp4')
  const executable = path.join(directory, 'sentrysearch.exe')
  const content = Buffer.from('video-bytes-for-path-transport-test')
  fs.writeFileSync(source, content)
  fs.writeFileSync(executable, '')
  assert.ok(source.length >= 260)
  const expectedPath = process.platform === 'win32' ? path.toNamespacedPath(source) : source
  const payload = {
    material_id: 'mat_long_path', asset_id: 'asset_long_path', asset_version: 1,
    source_sha256: createHash('sha256').update(content).digest('hex'), file_size_bytes: content.length,
    analysis_id: 'analysis_long_path', embedding_backend: 'qwen-cloud', model_name: 'qwen3-vl-embedding',
    model_version: 'qwen3-vl-embedding', dimension: 3, result_schema_version: 1,
    chunks: [{ chunk_id: 'chunk_01', start_ms: 0, end_ms: 1000, caption: '中文结果', embedding: [0.1, 0.2, 0.3] }],
  }
  let temporaryPayload = ''
  const calls = []
  const exporter = createMaterialAnalysisExporter({
    dataRoot, getSentrySearchPaths: () => ({ exe: executable, python: '', entry: '' }),
    createVideoAutoEnv: () => ({ PYTHONIOENCODING: 'gbk' }),
    runCapture: async (_command, args, options) => {
      calls.push(args[0])
      assert.equal(args[1], expectedPath)
      assert.equal(fs.statSync(args[1]).size, content.length)
      assert.equal(options.env.PYTHONIOENCODING, 'utf-8')
      if (args[0] === 'import-analysis') {
        temporaryPayload = args[2]
        assert.ok(temporaryPayload.length >= 260)
        if (process.platform === 'win32') assert.ok(temporaryPayload.startsWith('\\\\?\\'))
        assert.equal(JSON.parse(fs.readFileSync(temporaryPayload, 'utf8')).source_sha256, payload.source_sha256)
        return { code: 0, stdout: '{}', stderr: '' }
      }
      return { code: 0, stdout: JSON.stringify(payload), stderr: '' }
    },
  })
  await exporter.importForFile(source, payload)
  const result = await exporter.exportForFile(source)
  assert.equal(result.chunks[0].caption, '中文结果')
  assert.deepEqual(calls, ['import-analysis', 'export-analysis'])
  assert.equal(fs.existsSync(temporaryPayload), false)
})

test('analysis result queue submits local Qwen chunks with stable idempotency', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-analysis-sync-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const localPath = path.join(directory, 'source.mp4')
  fs.writeFileSync(localPath, 'video-analysis-content')
  const material = {
    materialId: 'mat_analysis_01',
    assetId: 'asset_analysis_01',
    assetVersion: 1,
    folderId: 'fld_products',
    displayName: '产品镜头.mp4',
    mimeType: 'video/mp4',
    sourceSha256: 'a'.repeat(64),
    sourceSize: fs.statSync(localPath).size,
    origin: 'user_upload',
    addedFrom: 'user_import',
    revision: 2,
    localPath,
    localStatus: 'present',
    analysisStatus: 'ready',
    cloudStatus: 'ready',
  }
  const operation = {
    operationId: 'op_analysis_01',
    operationType: 'sync_analysis',
    entityId: material.materialId,
    payload: {},
    status: 'processing',
    attemptCount: 0,
    nextRetryAt: new Date(0).toISOString(),
  }
  let claimed = false
  let completed = ''
  let captured
  const store = {
    ...createStore(material),
    claimCloudOperations: () => {
      if (claimed) return []
      claimed = true
      return [operation]
    },
    completeCloudOperation: (operationId) => { completed = operationId },
    markCloudAnalysisReady: (snapshot) => {
      assert.equal(snapshot.materialId, material.materialId)
      material.cloudAnalysisStatus = 'ready'
    },
  }
  const service = createMaterialCloudService({
    deviceId: `dev_${'f'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => undefined,
    store,
    exportAnalysisResult: async () => ({
      analysis_profile_id: 'profile_qwen_01',
      embedding_backend: 'qwen-cloud',
      model_name: 'qwen3-vl-embedding',
      model_version: 'qwen3-vl-embedding',
      dimension: 3,
      result_schema_version: 1,
      chunks: [{
        chunk_id: 'chunk_01',
        start_ms: 0,
        end_ms: 1000,
        caption: '工业机械臂',
        embedding: [0.1, 0.2, 0.3],
      }],
    }),
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (url, init) => {
      captured = { url, init }
      return new Response(JSON.stringify({ material_id: material.materialId, analysis_status: 'completed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  await service.processQueue()

  assert.equal(completed, operation.operationId)
  assert.equal(captured.url, `http://127.0.0.1:8091/v1/materials/${material.materialId}/analysis-results`)
  assert.equal(captured.init.headers['Idempotency-Key'], operation.operationId)
  const body = JSON.parse(captured.init.body)
  assert.equal(body.asset_id, material.assetId)
  assert.equal(body.source_sha256, material.sourceSha256)
  assert.equal(body.chunks[0].caption, '工业机械臂')
  assert.equal('localPath' in body, false)
  assert.equal(material.cloudAnalysisStatus, 'ready')
})

test('cloud-copy deletion queue preserves the local file and uses revision idempotency', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-cloud-copy-delete-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const localPath = path.join(directory, 'local-source.mp4')
  fs.writeFileSync(localPath, 'local-video-remains')
  const material = {
    materialId: 'mat_delete_copy_01',
    assetId: 'asset_delete_copy_01',
    assetVersion: 1,
    folderId: 'fld_private',
    displayName: '本地保留.mp4',
    mimeType: 'video/mp4',
    sourceSha256: createHash('sha256').update('local-video-remains').digest('hex'),
    sourceSize: fs.statSync(localPath).size,
    origin: 'user_upload',
    addedFrom: 'user_import',
    revision: 4,
    cloudRevision: 4,
    localPath,
    localStatus: 'present',
    analysisStatus: 'ready',
    cloudStatus: 'ready',
  }
  const operation = {
    operationId: 'op_delete_copy_01',
    operationType: 'delete_cloud_copy',
    entityId: material.materialId,
    payload: { revision: 4 },
    status: 'processing',
    attemptCount: 0,
    nextRetryAt: new Date(0).toISOString(),
  }
  let claimed = false
  let completed = ''
  const statuses = []
  let revision = 0
  let captured
  const store = {
    ...createStore(material),
    claimCloudOperations: () => claimed ? [] : (claimed = true, [operation]),
    completeCloudOperation: (operationId) => { completed = operationId },
    setCloudRevisionForMaterial: (_materialId, value) => { revision = Number(value) },
    setCloudStatusForMaterial: (_materialId, value) => { statuses.push(value) },
  }
  const service = createMaterialCloudService({
    deviceId: `dev_${'8'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => undefined,
    store,
    exportAnalysisResult: async () => { throw new Error('not used') },
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (url, init) => {
      captured = { url, init }
      return new Response(JSON.stringify({
        material_id: material.materialId,
        cloud_status: 'not_uploaded',
        revision: 5,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  await service.processQueue()

  assert.equal(completed, operation.operationId)
  assert.equal(fs.readFileSync(localPath, 'utf8'), 'local-video-remains')
  assert.equal(captured.url, `http://127.0.0.1:8091/v1/materials/${material.materialId}/cloud-copy`)
  assert.equal(captured.init.method, 'DELETE')
  assert.equal(captured.init.headers['Idempotency-Key'], operation.operationId)
  assert.deepEqual(JSON.parse(captured.init.body), { revision: 4 })
  assert.deepEqual(statuses, ['deleting', 'not_uploaded'])
  assert.equal(revision, 5)
})

test('generation status queue reads the current revision and never regresses progress', async () => {
  const material = { materialId: 'mat_status_01' }
  const operation = {
    operationId: 'op_generation_status_01',
    operationType: 'update_generation',
    entityId: 'run_cloud_12345',
    payload: { status: 'running', stage: 'compose', progress: 20 },
    status: 'processing',
    attemptCount: 0,
    nextRetryAt: new Date(0).toISOString(),
  }
  let claimed = false
  let completed = ''
  const requests = []
  const store = {
    ...createStore(material),
    claimCloudOperations: () => claimed ? [] : (claimed = true, [operation]),
    completeCloudOperation: (operationId) => { completed = operationId },
  }
  const service = createMaterialCloudService({
    deviceId: `dev_${'6'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => undefined,
    store,
    exportAnalysisResult: async () => { throw new Error('not used') },
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (url, init = {}) => {
      requests.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined })
      const response = init.method === 'PATCH'
        ? { run_id: operation.entityId, revision: 3, status: 'running', progress: 30 }
        : { run_id: operation.entityId, revision: 2, status: 'running', progress: 30 }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  await service.processQueue()

  assert.equal(completed, operation.operationId)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].init.method || 'GET', 'GET')
  assert.equal(requests[1].init.method, 'PATCH')
  assert.equal(requests[1].init.headers['Idempotency-Key'], operation.operationId)
  assert.deepEqual(requests[1].body, {
    revision: 2,
    status: 'running',
    stage: 'compose',
    progress: 30,
  })
})

test('restore-analysis queue downloads paged cloud vectors into the local index', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-analysis-restore-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const localPath = path.join(directory, 'restored.mp4')
  const content = Buffer.from('restored-video')
  fs.writeFileSync(localPath, content)
  const sourceSha256 = createHash('sha256').update(content).digest('hex')
  const material = {
    materialId: 'mat_restore_01',
    assetId: 'asset_restore_01',
    assetVersion: 1,
    folderId: 'fld_cloud',
    displayName: '云端镜头.mp4',
    mimeType: 'video/mp4',
    sourceSha256,
    sourceSize: content.length,
    origin: 'user_upload',
    addedFrom: 'cloud_restore',
    revision: 1,
    localPath,
    localStatus: 'present',
    analysisStatus: 'pending',
    cloudAnalysisStatus: 'ready',
    cloudStatus: 'ready',
  }
  const operation = {
    operationId: 'op_restore_01',
    operationType: 'restore_analysis',
    entityId: material.materialId,
    payload: {},
    status: 'processing',
    attemptCount: 0,
    nextRetryAt: new Date(0).toISOString(),
  }
  let claimed = false
  let completed = ''
  let analysisStatus = ''
  let imported
  const store = {
    ...createStore(material),
    claimCloudOperations: () => claimed ? [] : (claimed = true, [operation]),
    completeCloudOperation: (operationId) => { completed = operationId },
    setAnalysisStatusForFile: (_filePath, status) => { analysisStatus = status },
  }
  const service = createMaterialCloudService({
    deviceId: `dev_${'9'.repeat(32)}`,
    readAuthState: () => ({ accessToken: 'login-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => undefined,
    store,
    exportAnalysisResult: async () => { throw new Error('not used') },
    importAnalysisResult: async (filePath, payload) => { imported = { filePath, payload } },
    request: async (url) => {
      assert.equal(
        url,
        `http://127.0.0.1:8091/v1/materials/${material.materialId}/analysis-results?limit=100`,
      )
      return new Response(JSON.stringify({
        material_id: material.materialId,
        asset_id: material.assetId,
        asset_version: material.assetVersion,
        source_sha256: material.sourceSha256,
        file_size_bytes: material.sourceSize,
        analysis_id: 'analysis_restore_01',
        analysis_profile_id: 'profile_restore_01',
        embedding_backend: 'qwen-cloud',
        model_name: 'qwen3-vl-embedding',
        model_version: 'qwen3-vl-embedding',
        dimension: 3,
        result_schema_version: 1,
        chunks: [{
          chunk_id: 'chunk_01',
          start_ms: 0,
          end_ms: 1000,
          caption: '云端恢复镜头',
          embedding: [0.1, 0.2, 0.3],
        }],
        next_cursor: null,
        has_more: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  await service.processQueue()

  assert.equal(completed, operation.operationId)
  assert.equal(analysisStatus, 'ready')
  assert.equal(imported.filePath, localPath)
  assert.equal(imported.payload.chunks[0].caption, '云端恢复镜头')
})


test('cloud vector search hydrates hits on a fresh device without requiring an existing local catalog', async () => {
  let material = null
  const calls = []
  const store = {
    ...createStore({ materialId: 'unused' }),
    getMaterialCloudFileById: () => material,
    upsertCloudFolder: (folder) => { assert.equal(folder.folderId, 'fld_cloud') },
    upsertCloudMaterial: (record) => {
      material = { ...record, localPath: 'D:/new-device/cloud.mp4', localStatus: 'missing',
        analysisStatus: 'pending', cloudAnalysisStatus: record.analysisStatus }
    },
  }
  const service = createMaterialCloudService({
    deviceId: `dev_${'c'.repeat(32)}`, readAuthState: () => ({ accessToken: 'same-account-login' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }),
    send: () => undefined, store,
    exportAnalysisResult: async () => { throw new Error('not used') },
    importAnalysisResult: async () => { throw new Error('not used') },
    request: async (url, init) => {
      calls.push(url)
      assert.equal(init.headers.Authorization, 'Bearer same-account-login')
      const result = url.endsWith('/search/semantic')
        ? { results: [{ material_id: 'mat_remote', score: 0.94 }] }
        : url.includes('/v1/folders?') ? { items: [{ folder_id: 'fld_cloud', name: '设备素材', revision: 1 }] }
        : url.endsWith('/v1/materials/mat_remote') ? { material_id: 'mat_remote', asset_id: 'asset_remote',
          asset_version: 1, folder_id: 'fld_cloud', display_name: 'cloud.mp4', source_sha256: 'a'.repeat(64),
          file_size_bytes: 100, analysis_status: 'ready', cloud_status: 'ready', revision: 1 }
        : assert.fail(`unexpected request: ${url}`)
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
    },
  })
  const result = await service.semanticSearch({ query: '工业机械臂' })
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].materialId, 'mat_remote')
  assert.equal(result.results[0].localStatus, 'missing')
  assert.equal(result.results[0].analysisStatus, 'ready')
  assert.equal(calls.length, 3)
})
