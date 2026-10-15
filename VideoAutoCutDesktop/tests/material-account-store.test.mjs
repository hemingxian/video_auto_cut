import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createAccountScopedMaterialStore, materialAccountScopeKey } from '../dist-electron/material-account-store.js'
import { createMaterialLocalStore } from '../dist-electron/material-local-store.js'
import { createMaterialDirectoryBrowser } from '../dist-electron/material-directory.js'
import { createFileEntry } from '../dist-electron/file-entry.js'

const accountA = { serviceUrl: 'https://materials.example/api/', userId: 'user-A' }
const accountB = { serviceUrl: 'https://materials.example/api', userId: 'user-B' }

function workspace(t) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-account-store-'))
  const options = {
    dataRoot,
    materialsDir: path.join(dataRoot, 'video', 'materials'),
    runsDir: path.join(dataRoot, 'video', 'runs'),
    manifestsDir: path.join(dataRoot, 'video', 'material-manifests'),
    databasePath: path.join(dataRoot, 'video', 'material-library.sqlite'),
  }
  fs.mkdirSync(options.materialsDir, { recursive: true })
  fs.mkdirSync(options.runsDir, { recursive: true })
  const stores = []
  t.after(() => {
    for (const store of stores.reverse()) store.close()
    assert.equal(path.dirname(dataRoot), path.resolve(os.tmpdir()))
    fs.rmSync(dataRoot, { recursive: true, force: true })
  })
  return { options, track: store => { stores.push(store); return store } }
}

function addLocal(store, options, relativePath, addedFrom = 'user_import') {
  const localPath = path.join(options.materialsDir, relativePath)
  fs.mkdirSync(path.dirname(localPath), { recursive: true })
  fs.writeFileSync(localPath, `real local bytes for ${relativePath}`)
  const folderId = store.getOrCreateFolder({
    scope: 'user', storageKey: path.dirname(relativePath), name: path.basename(path.dirname(relativePath)),
  })
  const material = store.registerMaterialFile(localPath, { folderId, origin: 'user_upload', addedFrom })
  return { ...material, localPath }
}

test('persistent scope uses service plus stable user ID and does not expose that ID in filenames', () => {
  const key = materialAccountScopeKey(accountA)
  assert.match(key, /^[a-f0-9]{64}$/)
  assert.equal(materialAccountScopeKey({ ...accountA, serviceUrl: 'https://MATERIALS.example:443/api' }), key)
  assert.notEqual(materialAccountScopeKey(accountB), key)
  assert.notEqual(materialAccountScopeKey({ ...accountA, serviceUrl: 'https://other.example/api' }), key)
  assert.notEqual(materialAccountScopeKey({ ...accountA, serviceUrl: 'https://materials.example/other' }), key)
  assert.equal(materialAccountScopeKey({ ...accountA, userId: '' }), 'guest')
  assert.equal(materialAccountScopeKey(undefined), 'guest')
})

test('A → B → A keeps cloud folders, cursors, drafts, transfer sessions and outbox separate across restart', t => {
  const { options, track } = workspace(t)
  let account = accountA
  const store = track(createAccountScopedMaterialStore(options, () => account))
  const scopeA = store.captureScope()
  const materialA = addLocal(store, options, 'scara/video.mp4')
  store.upsertCloudFolder({ folderId: 'fld_cloud_A', name: 'scara', revision: 4 })
  store.setCloudState('remote_change_cursor', 'cursor-A')
  store.setCloudState('auto_sync_enabled', 'true')
  store.setAnalysisStatusForFile(materialA.localPath, 'ready', '', false)
  store.queueCloudOperation('upload', materialA.materialId, { owner: 'A' })
  store.saveTaskDraft({ taskId: 'task-A', schemaVersion: 1, snapshot: { material: materialA.materialId } })
  store.saveTransferSession({
    sessionId: 'transfer-A', direction: 'upload', materialId: materialA.materialId,
    status: 'uploading', bytesTransferred: 3, totalBytes: 20, partSize: 5, completedParts: [1],
  })
  const operationA = store.claimCloudOperations(1)[0]
  assert.ok(operationA)

  account = accountB
  assert.notEqual(store.captureScope(), scopeA)
  assert.equal(store.getFolder('fld_cloud_A'), null)
  assert.equal(store.getMaterialCloudFileById(materialA.materialId), null)
  assert.equal(store.getCloudState('remote_change_cursor'), '')
  assert.equal(store.getCloudState('auto_sync_enabled'), '')
  assert.equal(store.loadTaskDraft('task-A'), null)
  assert.equal(store.getTransferSession(materialA.materialId, 'upload'), null)
  assert.deepEqual(store.claimCloudOperations(10), [])
  const materialB = store.getMaterialCloudFileByPath(materialA.localPath)
  assert.ok(materialB, 'physical local inventory may be shared without sharing identities')
  assert.notEqual(materialB.materialId, materialA.materialId)
  assert.notEqual(materialB.assetId, materialA.assetId)
  assert.notEqual(materialB.folderId, materialA.folderId)
  assert.equal(materialB.cloudStatus, 'not_uploaded')
  store.upsertCloudFolder({ folderId: 'fld_cloud_B', name: 'scara', revision: 2 })
  store.setCloudState('remote_change_cursor', 'cursor-B')
  store.queueCloudOperation('sync_folder', 'fld_cloud_B', {})

  account = accountA
  assert.equal(store.captureScope(), scopeA)
  assert.ok(store.getFolder('fld_cloud_A'))
  assert.equal(store.getFolder('fld_cloud_B'), null)
  assert.equal(store.getCloudState('remote_change_cursor'), 'cursor-A')
  assert.equal(store.getCloudState('auto_sync_enabled'), 'true')
  assert.equal(store.getMaterialCloudFileByPath(materialA.localPath).materialId, materialA.materialId)
  assert.equal(store.loadTaskDraft('task-A').snapshot.material, materialA.materialId)
  store.close()
  const reopened = track(createAccountScopedMaterialStore(options, () => account))
  assert.equal(reopened.claimCloudOperations(10)[0].operationId, operationA.operationId,
    'only A gets its unfinished operation back on restart')
  assert.equal(reopened.getCloudState('remote_change_cursor'), 'cursor-A')
  account = accountB
  assert.equal(reopened.getCloudState('remote_change_cursor'), 'cursor-B')
  assert.deepEqual(reopened.claimCloudOperations(10).map(operation => operation.entityId), ['fld_cloud_B'])
  assert.equal(fs.existsSync(materialA.localPath), true)
})

test('captured async scope and extracted store methods never write a new account after switching', async t => {
  const { options, track } = workspace(t)
  let account = accountA
  const store = track(createAccountScopedMaterialStore(options, () => account))
  const scopeA = store.captureScope()
  const setCloudState = store.setCloudState
  let resume
  const pending = store.runInScope(scopeA, async () => {
    await new Promise(resolve => { resume = resolve })
    assert.equal(store.effectiveScope(), scopeA)
    assert.notEqual(store.captureScope(), scopeA, 'live account can be checked separately for cancellation')
    setCloudState('late-result', 'belongs-to-A')
    store.upsertCloudFolder({ folderId: 'fld_late_A', name: 'old response', revision: 1 })
  })
  account = accountB
  assert.equal(store.getCloudState('late-result'), '')
  resume()
  await pending
  assert.equal(store.getCloudState('late-result'), '')
  assert.equal(store.getFolder('fld_late_A'), null)
  account = accountA
  assert.equal(store.getCloudState('late-result'), 'belongs-to-A')
  assert.ok(store.getFolder('fld_late_A'))
  assert.throws(() => store.runInScope('../another-account', () => {}), /账号范围无效/)
})

test('legacy WAL database is preserved and only valid ordinary local inventory is reidentified', t => {
  const { options, track } = workspace(t)
  const legacy = track(createMaterialLocalStore(options))
  const ordinary = addLocal(legacy, options, 'scara/arm/video.mp4')
  const cloudContent = Buffer.from('old account private video')
  const cloudSha = createHash('sha256').update(cloudContent).digest('hex')
  legacy.upsertCloudFolder({ folderId: 'fld_legacy_cache', name: '旧云素材', revision: 1 })
  legacy.upsertCloudMaterial({
    materialId: 'mat_legacy_cache', assetId: 'asset_legacy_cache', assetVersion: 1,
    folderId: 'fld_legacy_cache', displayName: 'cached.mp4', origin: 'user_upload', addedFrom: 'cloud_restore',
    sourceSha256: cloudSha, sourceSize: cloudContent.length, mimeType: 'video/mp4',
    analysisStatus: 'ready', cloudStatus: 'ready', revision: 1,
  })
  const cloudCache = legacy.getMaterialCloudFileById('mat_legacy_cache')
  fs.mkdirSync(path.dirname(cloudCache.localPath), { recursive: true })
  fs.writeFileSync(cloudCache.localPath, cloudContent)
  legacy.completeCloudDownload(cloudCache.materialId, cloudCache.localPath, cloudSha, cloudContent.length)
  const missing = addLocal(legacy, options, 'scara/missing.mp4')
  fs.unlinkSync(missing.localPath)
  legacy.setAnalysisStatusForFile(ordinary.localPath, 'ready')
  legacy.setCloudStatusForMaterial(ordinary.materialId, 'ready')
  legacy.queueCloudOperation('sync_analysis', ordinary.materialId, {})
  legacy.upsertCloudFolder({ folderId: 'fld_legacy_other_owner', name: 'cloud', revision: 7 })
  legacy.setCloudState('remote_change_cursor', 'legacy-other-owner-cursor')
  legacy.saveTaskDraft({ taskId: 'legacy-task', schemaVersion: 1, snapshot: { material: ordinary.materialId } })
  const originalCount = legacy.cloudOperationCounts()

  // Keep the legacy connection open so the snapshot must include its WAL content.
  const current = track(createAccountScopedMaterialStore(options, () => accountB))
  const migrated = current.getMaterialCloudFileByPath(ordinary.localPath)
  assert.ok(migrated)
  assert.notEqual(migrated.materialId, ordinary.materialId)
  assert.notEqual(migrated.assetId, ordinary.assetId)
  assert.notEqual(migrated.folderId, ordinary.folderId)
  assert.equal(migrated.cloudStatus, 'not_uploaded')
  assert.equal(migrated.cloudRevision, 0)
  assert.equal(migrated.analysisStatus, 'pending')
  assert.equal(migrated.cloudFolderId, undefined)
  assert.deepEqual(current.claimCloudOperations(20), [])
  assert.equal(current.getCloudState('remote_change_cursor'), '')
  assert.equal(current.loadTaskDraft('legacy-task'), null)
  assert.equal(current.getFolder('fld_legacy_other_owner'), null)
  assert.equal(current.getMaterialCloudFileByPath(cloudCache.localPath), null)
  assert.equal(current.getMaterialCloudFileByPath(missing.localPath), null)
  const arm = current.getFolder(migrated.folderId)
  assert.equal(arm.storageKey, 'scara/arm')
  assert.equal(current.getFolder(arm.parentFolderId).storageKey, 'scara')

  const snapshotPath = path.join(path.dirname(options.databasePath), 'material-accounts', 'legacy-unscoped', 'material-library.sqlite')
  assert.ok(fs.existsSync(snapshotPath))
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
  try {
    assert.equal(snapshot.prepare('SELECT count(*) AS n FROM material WHERE material_id = ?').get(ordinary.materialId).n, 1)
    assert.equal(snapshot.prepare('SELECT count(*) AS n FROM local_sync_outbox').get().n > 0, true)
  } finally { snapshot.close() }
  assert.deepEqual(legacy.cloudOperationCounts(), originalCount)
  assert.equal(legacy.getCloudState('remote_change_cursor'), 'legacy-other-owner-cursor')
  assert.equal(legacy.getMaterialCloudFileById(ordinary.materialId).analysisStatus, 'ready')
  assert.equal(fs.existsSync(ordinary.localPath), true)
  assert.equal(fs.existsSync(cloudCache.localPath), true)
  assert.equal(fs.existsSync(options.databasePath), true)
  assert.equal(current.getMaterialCloudFileByPath(ordinary.localPath).materialId, migrated.materialId,
    'reading again must not repeat migration or replace IDs')
})

test('signed-out storage cannot expose the preceding account cloud namespace', t => {
  const { options, track } = workspace(t)
  let account = accountA
  const store = track(createAccountScopedMaterialStore(options, () => account))
  store.upsertCloudFolder({ folderId: 'fld_private_A', name: 'private', revision: 1 })
  store.setCloudState('private-cursor', 'A')
  account = undefined
  assert.equal(store.captureScope(), 'guest')
  assert.equal(store.getFolder('fld_private_A'), null)
  assert.equal(store.getCloudState('private-cursor'), '')
  account = { ...accountA, serviceUrl: 'https://different.example/api' }
  assert.equal(store.getFolder('fld_private_A'), null)
  assert.equal(store.getCloudState('private-cursor'), '')
})

test('directory browsing and generation skip other-account cloud byte caches while retaining owned downloads and ordinary local videos', t => {
  const { options, track } = workspace(t)
  let account = accountA
  const store = track(createAccountScopedMaterialStore(options, () => account))
  const ordinary = addLocal(store, options, 'scara/video.mp4')
  const nested = addLocal(store, options, 'scara/cloud/ordinary.mp4')

  function restoreOwnedCloud(owner) {
    const content = Buffer.from(`owned-cloud-content-${owner}`)
    const sourceSha256 = createHash('sha256').update(content).digest('hex')
    const materialId = `mat_${owner}`
    store.upsertCloudFolder({ folderId: `fld_${owner}`, name: '云端目录', revision: 1 })
    store.upsertCloudMaterial({
      materialId, assetId: `asset_${owner}`, assetVersion: 1, folderId: `fld_${owner}`,
      displayName: `${owner}.mp4`, origin: 'user_upload', addedFrom: 'cloud_restore',
      sourceSha256, sourceSize: content.length, mimeType: 'video/mp4',
      analysisStatus: 'ready', cloudStatus: 'ready', revision: 1,
    })
    const file = store.getMaterialCloudFileById(materialId)
    fs.mkdirSync(path.dirname(file.localPath), { recursive: true })
    fs.writeFileSync(file.localPath, content)
    store.completeCloudDownload(materialId, file.localPath, sourceSha256, content.length)
    return file.localPath
  }
  const oldCache = restoreOwnedCloud('A')
  const browserA = createMaterialDirectoryBrowser({ ...options, identityStore: store })
  assert.equal(browserA.browseMaterials().root.videoCount, 3)
  account = accountB
  const browserB = createMaterialDirectoryBrowser({ ...options, identityStore: store })
  const listing = browserB.browseMaterials()
  assert.equal(listing.root.videoCount, 2)
  assert.deepEqual(new Set(listing.files.map(file => file.path)), new Set([ordinary.localPath, nested.localPath]))
  assert.equal(store.getMaterialCloudFileByPath(oldCache), null)
  const localRoot = listing.rootFolders.find(folder => folder.name === '本地素材')
  const bindings = [{ binding_type: 'folder', folder_id: localRoot.id, include_subfolders: true }]
  assert.equal(browserB.summarizeMaterialSelection({ bindings }).candidateCount, 2)
  store.setAnalysisStatusForFile(ordinary.localPath, 'ready')
  store.setAnalysisStatusForFile(nested.localPath, 'ready')
  const manifest = store.prepareGenerationManifest({
    taskId: 'task-B-local', taskRevision: 1,
    shots: [{ shot_id: 'shot-B', download_material: false, material_bindings: bindings }],
  }).manifest
  assert.deepEqual(new Set(manifest.shots[0].materials.map(file => file.local_path)), new Set([ordinary.localPath, nested.localPath]))
  assert.equal(store.getMaterialCloudFileByPath(oldCache), null, 'generation must not re-register the hidden cache')
  const ownCache = restoreOwnedCloud('B')
  const beforeDescribe = store.getMaterialCloudFileByPath(ownCache)
  const enriched = store.describeKnownFile(createFileEntry(ownCache))
  assert.equal(enriched.materialId, beforeDescribe.materialId)
  assert.equal(store.getMaterialCloudFileByPath(ownCache).localFolderId, beforeDescribe.localFolderId)
  assert.equal(store.getMaterialCloudFileByPath(ownCache).cloudFolderId, beforeDescribe.cloudFolderId)
  assert.equal(store.getFolder(store.getMaterialCloudFileByPath(ownCache).folderId).name, '云端目录')
  const reRegistered = store.registerMaterialFile(ownCache, {
    folderId: localRoot.id, origin: 'user_upload', addedFrom: 'user_import',
  })
  assert.equal(reRegistered.folderId, beforeDescribe.folderId, 'generation reuse cannot move a cloud record to a cache folder')
  assert.throws(() => store.registerMaterialFile(oldCache, {
    folderId: localRoot.id, origin: 'user_upload', addedFrom: 'user_import',
  }), /当前账号没有此云端素材记录/)
  assert.equal(store.describeKnownFile(createFileEntry(oldCache)).materialId, undefined)
  assert.equal(browserB.browseMaterials().root.videoCount, 3)
  assert.ok(browserB.browseMaterials().files.some(file => file.path === ownCache))
  assert.equal(browserB.browseMaterials().files.some(file => file.path === oldCache), false)
  assert.equal(fs.existsSync(oldCache), true, 'switching must not delete A’s downloaded bytes')
  account = accountA
  const reopenedBrowserA = createMaterialDirectoryBrowser({ ...options, identityStore: store })
  assert.equal(reopenedBrowserA.browseMaterials().root.videoCount, 3)
  assert.equal(reopenedBrowserA.browseMaterials().files.some(file => file.path === ownCache), false)
})

test('switching releases unfinished sync work without spending retry attempts or reviving completed work', t => {
  const { options, track } = workspace(t)
  const store = track(createAccountScopedMaterialStore(options, () => accountA))
  const queued = store.queueCloudOperation('sync_folder', 'fld_A', {})
  const first = store.claimCloudOperations(1)[0]
  assert.equal(first.operationId, queued.operationId)
  store.releaseCloudOperation(first.operationId)
  const resumed = store.claimCloudOperations(1)[0]
  assert.equal(resumed.operationId, first.operationId)
  assert.equal(resumed.attemptCount, first.attemptCount)
  store.completeCloudOperation(resumed.operationId)
  store.releaseCloudOperation(resumed.operationId)
  assert.deepEqual(store.claimCloudOperations(10), [])
  assert.deepEqual(store.cloudOperationCounts(), { pending: 0, failed: 0 })
})
