import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createMaterialDirectoryBrowser } from '../dist-electron/material-directory.js'
import { createMaterialLocalStore } from '../dist-electron/material-local-store.js'

function createWorkspace() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-material-store-'))
  const materialsDir = path.join(dataRoot, 'video', 'materials')
  const runsDir = path.join(dataRoot, 'video', 'runs')
  const manifestsDir = path.join(dataRoot, 'video', 'material-manifests')
  fs.mkdirSync(materialsDir, { recursive: true })
  fs.mkdirSync(runsDir, { recursive: true })
  return {
    dataRoot,
    materialsDir,
    runsDir,
    manifestsDir,
    databasePath: path.join(dataRoot, 'video', 'material-library.sqlite'),
  }
}

function closeAndRemove(store, workspace) {
  store.close()
  const resolvedRoot = path.resolve(workspace.dataRoot)
  const resolvedTemp = path.resolve(os.tmpdir())
  assert.equal(resolvedRoot.startsWith(`${resolvedTemp}${path.sep}`), true)
  fs.rmSync(resolvedRoot, { recursive: true, force: true })
}

function folderByName(listing, name) {
  const folder = listing.folders.find((item) => item.name === name)
  assert.ok(folder, `missing folder ${name}`)
  return folder
}

test('selection summaries register only the selected scara scope and count the same asset union as generation', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({ ...workspace, identityStore: store })
  const scara = store.getOrCreateFolder({ scope: 'user', storageKey: 'scara', name: 'scara' })
  const arm = store.getOrCreateFolder({ scope: 'user', storageKey: 'scara/arm', name: 'arm', parentFolderId: scara })
  const files = []
  for (let index = 0; index < 21; index++) {
    const file = path.join(workspace.materialsDir, 'scara', index < 7 ? 'arm' : 'assembly/nested', `${index}.mp4`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `different-video-${index}`)
    files.push(file)
  }
  const unrelated = path.join(workspace.materialsDir, 'unrelated')
  fs.mkdirSync(unrelated)
  fs.writeFileSync(path.join(unrelated, 'other.mp4'), 'not-selected')
  const direct = { binding_type: 'folder', folder_id: scara, include_subfolders: false }
  assert.deepEqual(browser.summarizeMaterialSelection({ bindings: [direct] }), {
    candidateCount: 0, entries: [{ key: `folder:${scara}`, candidateKeys: [] }],
  })
  assert.equal(browser.summarizeMaterialSelection({ bindings: [{ binding_type: 'folder', folder_id: scara }] }).candidateCount, 0)

  const readdir = fs.readdirSync
  const scans = new Map()
  t.mock.method(fs, 'readdirSync', function (directory, ...args) {
    const key = path.resolve(String(directory))
    scans.set(key, (scans.get(key) || 0) + 1)
    return readdir.call(fs, directory, ...args)
  })
  const recursive = { ...direct, include_subfolders: true }
  const summary = browser.summarizeMaterialSelection({ bindings: [recursive] })
  assert.equal(summary.candidateCount, 21)
  assert.equal(summary.entries[0].candidateKeys.length, 21)
  assert.equal(scans.has(path.resolve(workspace.materialsDir)), false)
  assert.equal(scans.has(path.resolve(workspace.runsDir)), false)
  assert.equal(scans.has(path.resolve(unrelated)), false)
  assert.equal([...scans.values()].every((count) => count === 1), true)

  const first = store.getMaterialCloudFileByPath(files[0])
  const bindings = [recursive, { binding_type: 'folder', folder_id: arm, include_subfolders: true },
    { binding_type: 'material', material_id: first.materialId }]
  scans.clear()
  const combined = browser.summarizeMaterialSelection({ bindings })
  assert.equal(combined.candidateCount, 21)
  assert.deepEqual(combined.entries.map((entry) => entry.candidateKeys.length), [21, 7, 1])
  assert.equal([...scans.values()].every((count) => count === 1), true)
  const generationOptions = { taskId: 'task_scara', taskRevision: 1, shots: [
    { shot_id: 'shot_scara', download_material: false, material_bindings: bindings },
  ] }
  const generationKeys = store.materialIdsForGeneration(generationOptions).map((id) => {
    const material = store.getMaterialCloudFileById(id)
    return `asset:${material.assetId}:${material.assetVersion}`
  })
  assert.deepEqual([...new Set(generationKeys)].sort(), summary.entries[0].candidateKeys)
  for (const file of files) store.setAnalysisStatusForFile(file, 'ready')
  const prepared = store.prepareGenerationManifest(generationOptions)
  assert.deepEqual(prepared.manifest.shots[0].materials.map((item) => `asset:${item.asset_id}:${item.asset_version}`).sort(), summary.entries[0].candidateKeys)
  assert.equal(browser.summarizeMaterialSelection({ bindings: [direct] }).candidateCount, 0)
  assert.deepEqual(store.summarizeMaterialSelection([]), { candidateCount: 0, entries: [] })
})

test('folder range wildcards are literal and selection entries deduplicate identical assets', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  for (const [selectedName, unrelatedName] of [['scara_robot', 'scaraXrobot'], ['scara%robot', 'scaraZZrobot'], ['scara!robot', 'scara!!robot']]) {
    const selected = store.getOrCreateFolder({ scope: 'user', storageKey: selectedName, name: selectedName })
    const children = [selectedName, unrelatedName].map((name) => {
      const folder = store.getOrCreateFolder({ scope: 'user', storageKey: `${name}/child`, name: 'child' })
      const directory = path.join(workspace.materialsDir, name, 'child')
      fs.mkdirSync(directory, { recursive: true })
      const file = path.join(directory, 'video.mp4')
      fs.writeFileSync(file, `video-${name}`)
      return store.registerMaterialFile(file, { folderId: folder, origin: 'user_upload', addedFrom: 'user_import' })
    })
    const bindings = [{ binding_type: 'folder', folder_id: selected, include_subfolders: true }]
    assert.deepEqual(store.materialIdsForGeneration({ taskId: 'scope', taskRevision: 1, shots: [{ download_material: false, material_bindings: bindings }] }), [children[0].materialId])
    assert.deepEqual(store.summarizeMaterialSelection(bindings).entries[0].candidateKeys, [`asset:${children[0].assetId}:${children[0].assetVersion}`])
  }
  const folder = store.getOrCreateFolder({ scope: 'user', storageKey: 'same-assets', name: 'same-assets' })
  const identities = ['one', 'two'].map((name) => {
    const file = path.join(workspace.materialsDir, 'same-assets', `${name}.mp4`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'identical-video')
    return store.registerMaterialFile(file, { folderId: folder, origin: 'user_upload', addedFrom: 'user_import' })
  })
  assert.notEqual(identities[0].materialId, identities[1].materialId)
  assert.equal(identities[0].assetId, identities[1].assetId)
  const summary = store.summarizeMaterialSelection([
    { binding_type: 'folder', folder_id: folder, include_subfolders: false },
    ...identities.map((item) => ({ binding_type: 'material', material_id: item.materialId })),
  ])
  assert.equal(summary.candidateCount, 1)
  assert.deepEqual(summary.entries.map((entry) => entry.candidateKeys.length), [1, 1, 1])
})

test('local download folder aliases expose canonical binding ids and restored scopes need no global browse', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const file = path.join(workspace.runsDir, 'run-example', 'raw', 'child', 'video.mp4')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'downloaded-video')
  const browser = createMaterialDirectoryBrowser({ ...workspace, identityStore: store })
  const root = browser.browseMaterials()
  const local = browser.browseMaterials({ folderId: folderByName(root, '本地素材').id })
  const alias = folderByName(local, 'run-example')
  assert.ok(alias.bindingFolderId)
  assert.notEqual(alias.bindingFolderId, alias.id)
  const original = browser.summarizeMaterialSelection({ bindings: [
    { binding_type: 'folder', folder_id: alias.id, include_subfolders: true },
  ] })
  assert.equal(original.candidateCount, 1)
  assert.equal(original.entries[0].key, `folder:${alias.id}`)
  const freshBrowser = createMaterialDirectoryBrowser({ ...workspace, identityStore: store })
  const binding = { binding_type: 'folder', folder_id: alias.bindingFolderId, include_subfolders: true }
  const restored = freshBrowser.summarizeMaterialSelection({ bindings: [binding] })
  assert.equal(restored.candidateCount, 1)
  assert.equal(restored.entries[0].key, `folder:${alias.bindingFolderId}`)
  assert.deepEqual(restored.entries[0].candidateKeys, original.entries[0].candidateKeys)
  assert.equal(store.materialIdsForGeneration({ taskId: 'restore', taskRevision: 1, shots: [
    { download_material: false, material_bindings: [binding] },
  ] }).length, 1)
  assert.equal(freshBrowser.summarizeMaterialSelection({ bindings: [{ ...binding, include_subfolders: false }] }).candidateCount, 0)
  assert.throws(() => freshBrowser.summarizeMaterialSelection({ bindings: [
    { binding_type: 'folder', folder_id: 'fld_missing', include_subfolders: true },
  ] }), /素材文件夹不存在/)
  assert.throws(() => store.summarizeMaterialSelection([
    { binding_type: 'material', material_id: 'mat_missing' },
  ]), /素材不存在或已删除/)
})

test('download scope fallback includes unuploaded originals without mixing explicit cloud folder membership', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const localFolder = store.getOrCreateFolder({ scope: 'downloads', storageKey: 'run/raw', name: 'raw' })
  const cloudRoot = store.getOrCreateFolder({ scope: 'virtual', storageKey: 'downloads-root', name: '云端素材' })
  const file = path.join(workspace.runsDir, 'run', 'raw', 'video.mp4')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'original-not-yet-uploaded')
  const identity = store.registerMaterialFile(file, { folderId: localFolder, origin: 'platform_download', addedFrom: 'task_download' })
  const localBinding = { binding_type: 'folder', folder_id: localFolder, include_subfolders: false }
  const rootBinding = { binding_type: 'folder', folder_id: cloudRoot, include_subfolders: false }
  assert.equal(store.summarizeMaterialSelection([localBinding]).candidateCount, 1)
  // The cloud collection's existing semantics exclude originals never backed up to the cloud.
  assert.equal(store.summarizeMaterialSelection([rootBinding]).candidateCount, 0)
  assert.deepEqual(store.materialIdsForGeneration({ taskId: 'local', taskRevision: 1, shots: [
    { download_material: false, material_bindings: [localBinding] },
  ] }), [identity.materialId])
  store.upsertCloudFolder({ folderId: 'fld_elsewhere', name: '其他云端目录', revision: 1 })
  const material = store.getMaterialCloudFileById(identity.materialId)
  store.upsertCloudMaterial({ ...material, folderId: 'fld_elsewhere', cloudStatus: 'ready', revision: material.revision + 1 })
  assert.equal(store.getMaterialCloudFileById(identity.materialId).cloudFolderId, 'fld_elsewhere')
  assert.equal(store.summarizeMaterialSelection([localBinding]).candidateCount, 0)
  assert.equal(store.summarizeMaterialSelection([
    { binding_type: 'folder', folder_id: 'fld_elsewhere', include_subfolders: true },
  ]).candidateCount, 1)
  assert.equal(store.summarizeMaterialSelection([rootBinding]).candidateCount, 1)
})

test('schema v2 upgrades in place with folder cloud revisions and queued-only outbox coalescing', (t) => {
  const workspace = createWorkspace()
  t.after(() => fs.rmSync(workspace.dataRoot, { recursive: true, force: true }))
  const database = new DatabaseSync(workspace.databasePath)
  database.exec(`
    CREATE TABLE schema_meta(schema_version INTEGER NOT NULL);
    INSERT INTO schema_meta(schema_version) VALUES (2);
    CREATE TABLE material_folder (
      folder_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      parent_folder_id TEXT,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      UNIQUE(scope, storage_key)
    );
    CREATE TABLE material (
      material_id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      asset_version INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      added_from TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE local_sync_outbox (
      operation_id TEXT PRIMARY KEY,
      operation_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX uk_local_sync_outbox_queued
      ON local_sync_outbox(operation_type, entity_id)
      WHERE status = 'queued';
    INSERT INTO local_sync_outbox VALUES
      ('op_existing_processing', 'update_generation', 'run_existing', '{}', 'processing', 0, '2026-08-31T18:52:42.587Z', NULL, '2026-08-31T18:52:42.587Z', '2026-08-31T18:52:42.587Z'),
      ('op_existing_queued', 'update_generation', 'run_existing', '{}', 'queued', 0, '2026-08-31T18:52:42.610Z', NULL, '2026-08-31T18:52:42.610Z', '2026-08-31T18:52:42.610Z'),
      ('op_processing_old', 'sync_material', 'mat_recover', '{}', 'processing', 0, '2026-08-31T18:52:42.500Z', NULL, '2026-08-31T18:52:42.500Z', '2026-08-31T18:52:42.500Z'),
      ('op_processing_new', 'sync_material', 'mat_recover', '{}', 'processing', 0, '2026-08-31T18:52:42.700Z', NULL, '2026-08-31T18:52:42.700Z', '2026-08-31T18:52:42.700Z');
  `)
  database.close()

  const store = createMaterialLocalStore(workspace)
  store.close()

  const upgraded = new DatabaseSync(workspace.databasePath)
  const version = upgraded.prepare('SELECT schema_version FROM schema_meta').get().schema_version
  const columns = upgraded.prepare('PRAGMA table_info(material_folder)').all()
  const materialColumns = upgraded.prepare('PRAGMA table_info(material)').all()
  const indexes = upgraded.prepare('PRAGMA index_list(local_sync_outbox)').all()
  const conflictTable = upgraded.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_sync_conflict'
  `).get()
  const recoveredOperations = upgraded.prepare(`
    SELECT operation_id, status
    FROM local_sync_outbox
    WHERE operation_id IN (
      'op_existing_processing', 'op_existing_queued',
      'op_processing_old', 'op_processing_new'
    )
    ORDER BY operation_id
  `).all()
  upgraded.close()
  assert.equal(version, 7)
  assert.ok(columns.some((column) => column.name === 'cloud_revision'))
  assert.ok(materialColumns.some((column) => column.name === 'local_folder_id'))
  assert.ok(materialColumns.some((column) => column.name === 'cloud_folder_id'))
  assert.ok(indexes.some((index) => index.name === 'uk_local_sync_outbox_queued'))
  assert.ok(!indexes.some((index) => index.name === 'uk_local_sync_outbox_active'))
  assert.equal(conflictTable.name, 'local_sync_conflict')
  assert.deepEqual(recoveredOperations.map((operation) => ({ ...operation })), [
    { operation_id: 'op_existing_processing', status: 'canceled' },
    { operation_id: 'op_existing_queued', status: 'queued' },
    { operation_id: 'op_processing_new', status: 'queued' },
    { operation_id: 'op_processing_old', status: 'canceled' },
  ])
})

test('stable identities survive folder moves and generation freezes asset versions', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })

  const root = browser.browseMaterials()
  const userRoot = folderByName(root, '本地素材')
  const created = browser.createMaterialFolder(userRoot.id, '产品')
  const source = path.join(workspace.dataRoot, 'source.mp4')
  fs.writeFileSync(source, 'same-video-content', 'utf8')
  const target = browser.getMaterialImportTarget(created.id)
  const first = store.importMaterialFile(source, target.directory, target.folderId)
  const second = store.importMaterialFile(source, target.directory, target.folderId)

  assert.match(first.materialId, /^mat_/)
  assert.equal(first.assetId, second.assetId)
  assert.equal(first.assetVersion, 1)
  assert.equal(first.sourceSha256, second.sourceSha256)
  store.setAnalysisStatusForFile(first.path, 'ready')

  const beforeRename = browser.browseMaterials({ folderId: created.id })
  const firstBeforeRename = beforeRename.files.find((item) => item.materialId === first.materialId)
  assert.ok(firstBeforeRename)

  const renamed = browser.renameMaterialFolder(created.id, '产品素材')
  assert.equal(renamed.folder.id, created.id)
  const afterRename = browser.browseMaterials({ folderId: created.id })
  const firstAfterRename = afterRename.files.find((item) => item.materialId === first.materialId)
  assert.ok(firstAfterRename)

  const archive = browser.createMaterialFolder(userRoot.id, '归档')
  const movedFiles = browser.moveMaterialFiles(created.id, archive.id, [firstAfterRename.path])
  assert.equal(movedFiles.moved, 1)
  assert.equal(movedFiles.files[0].materialId, first.materialId)
  assert.equal(browser.browseMaterials({ folderId: archive.id }).files[0].materialId, first.materialId)
  assert.equal(browser.browseMaterials({ folderId: created.id }).files.some((item) => item.materialId === first.materialId), false)

  const movedFolder = browser.moveMaterialFolder(created.id, archive.id)
  assert.equal(movedFolder.changed, true)
  assert.equal(movedFolder.folder.id, created.id)
  assert.ok(browser.browseMaterials({ folderId: archive.id }).folders.some((item) => item.id === created.id))

  const prepared = store.prepareGenerationManifest({
    taskId: 'task-1',
    taskRevision: 3,
    shots: [{
      shot_id: 'shot-1',
      download_material: false,
      material_bindings: [{
        binding_type: 'folder',
        folder_id: created.id,
        include_subfolders: true,
      }],
    }],
  })
  assert.equal(prepared.manifest.task_revision, 3)
  assert.equal(prepared.manifest.shots[0].materials.length, 1)
  assert.equal(prepared.manifest.shots[0].materials[0].asset_id, first.assetId)
  assert.equal(fs.existsSync(prepared.manifestPath), true)

  browser.deleteMaterialFolder(created.id)
  assert.throws(() => store.prepareGenerationManifest({
    taskId: 'task-1',
    taskRevision: 4,
    shots: [{
      shot_id: 'shot-1',
      download_material: false,
      material_bindings: [{
        binding_type: 'folder',
        folder_id: created.id,
        include_subfolders: true,
      }],
    }],
  }), /素材文件夹/)
})

test('a cloud parent alias preserves the matching local folder hierarchy on sync roundtrip', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({ materialsDir: workspace.materialsDir, runsDir: workspace.runsDir, identityStore: store })
  const localRoot = folderByName(browser.browseMaterials(), '本地素材')
  const child = browser.createMaterialFolder(localRoot.id, '候选验收')
  store.upsertCloudFolder({ folderId: 'remote_root_alias', name: '本地素材', revision: 4 })
  store.upsertCloudFolder({ folderId: child.id, parentFolderId: 'remote_root_alias', name: '候选验收', revision: 2 })
  assert.equal(store.getCloudFolderRecord(child.id).parentFolderId, localRoot.id)
  assert.equal(store.cloudConflictCount(), 0)
  assert.equal(fs.existsSync(path.join(workspace.materialsDir, '候选验收')), true)
  store.upsertCloudFolder({ folderId: 'different_remote_parent', name: '其他目录', revision: 1 })
  assert.throws(() => store.upsertCloudFolder({ folderId: child.id, parentFolderId: 'different_remote_parent', name: '候选验收', revision: 3 }), /父级不存在/)
})

test('multi-device folder and material conflicts preserve local edits until the next cloud revision', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })
  const userRoot = folderByName(browser.browseMaterials(), '本地素材')
  const shared = browser.createMaterialFolder(userRoot.id, '共享目录')
  store.upsertCloudFolder({
    folderId: shared.id,
    parentFolderId: userRoot.id,
    name: '共享目录',
    revision: 1,
  })
  browser.renameMaterialFolder(shared.id, '设备A目录')

  store.upsertCloudFolder({
    folderId: shared.id,
    parentFolderId: userRoot.id,
    name: '设备B目录',
    revision: 2,
  })

  const localFolder = store.getCloudFolderRecord(shared.id)
  assert.equal(localFolder.name, '设备A目录')
  assert.equal(localFolder.revision, 3)
  assert.equal(store.cloudConflictCount(), 1)
  store.setCloudRevisionForFolder(shared.id, 2)
  assert.equal(store.cloudConflictCount(), 1)
  store.setCloudRevisionForFolder(shared.id, 3)
  assert.equal(store.cloudConflictCount(), 0)

  const localDestination = browser.createMaterialFolder(userRoot.id, '设备A素材')
  const cloudDestination = browser.createMaterialFolder(userRoot.id, '设备B素材')
  const target = browser.getMaterialImportTarget(shared.id)
  const source = path.join(workspace.dataRoot, 'conflict-source.mp4')
  fs.writeFileSync(source, 'conflict-source-content')
  const imported = store.importMaterialFile(source, target.directory, target.folderId)
  const baseline = {
    materialId: imported.materialId,
    assetId: imported.assetId,
    assetVersion: imported.assetVersion,
    folderId: shared.id,
    displayName: imported.name,
    origin: 'user_upload',
    addedFrom: 'user_import',
    sourceSha256: imported.sourceSha256,
    sourceSize: imported.size,
    mimeType: 'video/mp4',
    analysisStatus: 'pending',
    cloudStatus: 'ready',
    revision: 1,
    publicationStatus: 'private',
  }
  store.upsertCloudMaterial(baseline)
  store.moveMaterial(imported.materialId, localDestination.id)

  store.upsertCloudMaterial({
    ...baseline,
    folderId: cloudDestination.id,
    revision: 2,
  })

  const localMaterial = store.getMaterialCloudFileById(imported.materialId)
  assert.equal(localMaterial.folderId, localDestination.id)
  assert.equal(localMaterial.revision, 3)
  assert.equal(localMaterial.cloudRevision, 2)
  assert.equal(store.cloudConflictCount(), 1)
  assert.ok(store.claimCloudOperations(50).some((operation) => (
    operation.operationType === 'sync_material' && operation.entityId === imported.materialId
  )))
  store.setCloudRevisionForMaterial(imported.materialId, 2)
  assert.equal(store.cloudConflictCount(), 1)
  store.setCloudRevisionForMaterial(imported.materialId, 3)
  assert.equal(store.cloudConflictCount(), 0)
})

test('cloud generation snapshots verify immutable identity and file content before persistence', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })
  const userRoot = folderByName(browser.browseMaterials(), '本地素材')
  const folder = browser.createMaterialFolder(userRoot.id, '生成校验')
  const source = path.join(workspace.dataRoot, 'snapshot-source.mp4')
  fs.writeFileSync(source, 'immutable-video-content')
  const target = browser.getMaterialImportTarget(folder.id)
  const imported = store.importMaterialFile(source, target.directory, target.folderId)
  store.setAnalysisStatusForFile(imported.path, 'ready')

  const prepared = store.prepareGenerationManifestFromSnapshot({
    runId: 'run_cloud_12345',
    taskId: 'task-local-1',
    taskRevision: 2,
    shots: [{
      shot_id: 'shot-local-1',
      materials: [{
        material_id: imported.materialId,
        asset_id: imported.assetId,
        asset_version: imported.assetVersion,
        source_sha256: imported.sourceSha256,
      }],
    }],
  })
  assert.equal(prepared.manifest.run_id, 'run_cloud_12345')
  assert.equal(prepared.manifest.shots[0].materials[0].local_path, imported.path)
  assert.equal(fs.existsSync(prepared.manifestPath), true)

  fs.appendFileSync(imported.path, '-changed')
  assert.throws(() => store.prepareGenerationManifestFromSnapshot({
    runId: 'run_cloud_67890',
    taskId: 'task-local-1',
    taskRevision: 3,
    shots: [{
      shot_id: 'shot-local-1',
      materials: [{
        material_id: imported.materialId,
        asset_id: imported.assetId,
        asset_version: imported.assetVersion,
        source_sha256: imported.sourceSha256,
      }],
    }],
  }), /内容校验失败/)
})

test('local task drafts use revisions and reject stale writes', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))

  const first = store.saveTaskDraft({
    taskId: 'task-2',
    schemaVersion: 1,
    expectedRevision: 0,
    snapshot: { shots: [] },
  })
  assert.equal(first.revision, 1)
  assert.deepEqual(store.loadTaskDraft('task-2')?.snapshot, { shots: [] })
  assert.throws(() => store.saveTaskDraft({
    taskId: 'task-2',
    schemaVersion: 1,
    expectedRevision: 0,
    snapshot: { shots: [{ shot_id: 'stale' }] },
  }), /版本冲突/)
})

test('new task drafts adopt a safe snapshot revision floor but existing drafts only increment once', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))

  const created = store.saveTaskDraft({
    taskId: 'resume-floor', schemaVersion: 2, expectedRevision: 0,
    snapshot: { task_revision: 49, shots: [] },
  })
  assert.equal(created.revision, 49)
  const updated = store.saveTaskDraft({
    taskId: 'resume-floor', schemaVersion: 2, expectedRevision: 49,
    snapshot: { task_revision: 999, shots: [] },
  })
  assert.equal(updated.revision, 50)
})

test('completed local analysis joins an existing cloud backup queue exactly once', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })
  const userRoot = folderByName(browser.browseMaterials(), '本地素材')
  const folder = browser.createMaterialFolder(userRoot.id, '待同步')
  const target = browser.getMaterialImportTarget(folder.id)
  const source = path.join(workspace.dataRoot, 'analysis-source.mp4')
  fs.writeFileSync(source, 'analysis-source-content')
  const material = store.importMaterialFile(source, target.directory, target.folderId)

  store.queueCloudOperation('upload', material.materialId, {})
  store.setAnalysisStatusForFile(material.path, 'ready')
  store.setAnalysisStatusForFile(material.path, 'ready')

  const claimed = store.claimCloudOperations(5)
  assert.deepEqual(
    claimed.map((operation) => operation.operationType).sort(),
    ['sync_analysis', 'upload'],
  )
})

test('fingerprint index hits require byte-identical content before asset reuse', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })
  const userRoot = folderByName(browser.browseMaterials(), '本地素材')
  const created = browser.createMaterialFolder(userRoot.id, '碰撞校验')
  const target = browser.getMaterialImportTarget(created.id)
  const leftPath = path.join(target.directory, 'left.mp4')
  const rightPath = path.join(target.directory, 'right.mp4')
  fs.writeFileSync(leftPath, 'content-a', 'utf8')
  fs.writeFileSync(rightPath, 'content-b', 'utf8')
  const forcedFingerprint = '0'.repeat(64)
  const options = {
    folderId: target.folderId,
    origin: 'user_upload',
    addedFrom: 'user_import',
    sourceSha256: forcedFingerprint,
    sourceSize: 9,
  }

  const left = store.registerMaterialFile(leftPath, options)
  const right = store.registerMaterialFile(rightPath, options)

  assert.notEqual(left.assetId, right.assetId)
})

test('cloud placeholders, reliable queue and verified restore survive in the local read model', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })
  const content = Buffer.from('cloud-video-content', 'utf8')
  const sourceSha256 = createHash('sha256').update(content).digest('hex')
  const cloudFolderId = 'fld_cloud_products'
  const materialId = 'mat_cloud_video'

  store.upsertCloudFolder({
    folderId: cloudFolderId,
    name: '云端产品',
    revision: 4,
  })
  store.upsertCloudMaterial({
    materialId,
    assetId: 'asset_cloud_video',
    assetVersion: 1,
    folderId: cloudFolderId,
    displayName: '云端主镜头.mp4',
    origin: 'user_upload',
    addedFrom: 'cloud_restore',
    sourceSha256,
    sourceSize: content.length,
    mimeType: 'video/mp4',
    analysisStatus: 'ready',
    cloudStatus: 'ready',
    revision: 7,
    publicationStatus: 'public',
    publicationId: 'pub_cloud_video',
    publicationRevision: 3,
    publicationReviewReason: '审核通过',
  })
  const cloudIdentity = store.getMaterialCloudFileById(materialId)
  assert.equal(cloudIdentity.analysisStatus, 'pending')
  assert.equal(cloudIdentity.cloudAnalysisStatus, 'ready')

  const cloudRoot = folderByName(browser.browseMaterials(), '云端素材')
  const cloudRootListing = browser.browseMaterials({ folderId: cloudRoot.id })
  assert.ok(cloudRootListing.folders.some((folder) => folder.id === cloudFolderId))
  const cloudListing = browser.browseMaterials({ folderId: cloudFolderId })
  assert.equal(cloudListing.files.length, 1)
  assert.equal(cloudListing.files[0].localStatus, 'missing')
  assert.equal(cloudListing.files[0].cloudStatus, 'ready')
  assert.equal(cloudListing.files[0].publicationStatus, 'public')
  assert.equal(cloudListing.files[0].publicationId, 'pub_cloud_video')
  assert.equal(cloudListing.files[0].publicationRevision, 3)
  assert.equal(cloudListing.files[0].publicationReviewReason, '审核通过')

  store.saveTransferSession({
    sessionId: 'dls_cloud_video',
    direction: 'download',
    materialId,
    status: 'downloading',
    bytesTransferred: 7,
    totalBytes: content.length,
    partSize: 0,
    completedParts: [],
    tempRelativePath: `${cloudListing.files[0].path}.download.part`,
  })
  const downloading = browser.browseMaterials({ folderId: cloudFolderId }).files[0]
  assert.equal(downloading.downloadTransferStatus, 'downloading')
  assert.equal(downloading.downloadBytesTransferred, 7)
  assert.equal(downloading.downloadTotalBytes, content.length)

  store.setAnalysisStatusForFile(cloudListing.files[0].path, 'ready', '', false)
  const first = store.queueCloudOperation('upload', materialId, {})
  const duplicate = store.queueCloudOperation('upload', materialId, {})
  assert.equal(first.operationId, duplicate.operationId)
  const claimed = store.claimCloudOperations(2)
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].entityId, materialId)
  store.completeCloudOperation(first.operationId)
  assert.deepEqual(store.cloudOperationCounts(), { pending: 0, failed: 0 })

  const restoredPath = cloudListing.files[0].path
  fs.mkdirSync(path.dirname(restoredPath), { recursive: true })
  fs.writeFileSync(restoredPath, content)
  store.completeCloudDownload(materialId, restoredPath, sourceSha256, content.length)
  const restored = browser.browseMaterials({ folderId: cloudFolderId }).files[0]
  assert.equal(restored.localStatus, 'present')
  assert.equal(restored.url.startsWith('videoauto-media:'), true)

  const renamedPath = path.join(path.dirname(restored.path), '云端主镜头-改名.mp4')
  fs.renameSync(restored.path, renamedPath)
  store.moveFile(restored.path, renamedPath)
  const metadataSync = store.claimCloudOperations(2)
  assert.equal(metadataSync.length, 1)
  assert.equal(metadataSync[0].operationType, 'sync_material')
  assert.equal(metadataSync[0].entityId, materialId)
})

test('cloud refresh keeps downloaded run folders at the business root', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const runFolder = path.join(workspace.runsDir, 'run-download', 'raw', 'shot_001')
  const source = path.join(runFolder, 'pexels-source.mp4')
  fs.mkdirSync(runFolder, { recursive: true })
  fs.writeFileSync(source, 'pexels-downloaded-video')
  const folderId = store.getOrCreateFolder({
    scope: 'downloads',
    storageKey: path.relative(workspace.runsDir, runFolder),
    name: 'shot_001',
  })
  const material = store.registerMaterialFile(source, {
    folderId,
    origin: 'platform_download',
    addedFrom: 'task_download',
  })

  assert.equal(store.getCloudFolderRecord(folderId).parentFolderId, undefined)
  store.upsertCloudFolder({
    folderId,
    name: 'shot_001',
    revision: 1,
  })

  assert.equal(store.getCloudFolderRecord(folderId).parentFolderId, undefined)
  assert.deepEqual(store.folderChainForMaterial(material.materialId), [{
    folderId,
    parentFolderId: undefined,
    name: 'shot_001',
    revision: 1,
  }])
})

test('rescanning a known download repairs its material to the current folder identity', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const runFolder = path.join(workspace.runsDir, 'run-repaired', 'raw', 'shot_001')
  const source = path.join(runFolder, 'pexels-source.mp4')
  fs.mkdirSync(runFolder, { recursive: true })
  fs.writeFileSync(source, 'pexels-downloaded-video')
  const previousFolderId = store.getOrCreateFolder({
    scope: 'downloads',
    storageKey: 'obsolete/shot_001',
    name: 'shot_001',
  })
  const material = store.registerMaterialFile(source, {
    folderId: previousFolderId,
    origin: 'platform_download',
    addedFrom: 'task_download',
  })
  const currentFolderId = store.getOrCreateFolder({
    scope: 'downloads',
    storageKey: path.relative(workspace.runsDir, runFolder),
    name: 'shot_001',
  })

  const repaired = store.registerMaterialFile(source, {
    folderId: currentFolderId,
    origin: 'platform_download',
    addedFrom: 'task_download',
  })

  assert.equal(repaired.materialId, material.materialId)
  assert.equal(repaired.folderId, currentFolderId)
  assert.deepEqual(store.folderChainForMaterial(material.materialId), [{
    folderId: currentFolderId,
    parentFolderId: undefined,
    name: 'shot_001',
    revision: 1,
  }])
})

test('aggregate material library deduplicates matching local and cloud content', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const localSource = path.join(workspace.materialsDir, 'shared-local.mp4')
  const cloudSource = path.join(workspace.runsDir, 'run-shared', 'raw', 'shared-cloud.mp4')
  fs.mkdirSync(path.dirname(cloudSource), { recursive: true })
  fs.writeFileSync(localSource, 'byte-identical-material')
  fs.writeFileSync(cloudSource, 'byte-identical-material')
  const localRootId = store.getOrCreateFolder({ scope: 'user', storageKey: '.', name: '本地素材' })
  const cloudFolderId = store.getOrCreateFolder({
    scope: 'downloads',
    storageKey: path.relative(workspace.runsDir, path.dirname(cloudSource)),
    name: 'run-shared',
  })
  store.registerMaterialFile(localSource, {
    folderId: localRootId,
    origin: 'user_upload',
    addedFrom: 'user_import',
  })
  const sharedCloud = store.registerMaterialFile(cloudSource, {
    folderId: cloudFolderId,
    origin: 'platform_download',
    addedFrom: 'task_download',
  })
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })

  const root = browser.browseMaterials()
  const local = browser.browseMaterials({ folderId: folderByName(root, '本地素材').id })
  const cloud = browser.browseMaterials({ folderId: folderByName(root, '云端素材').id })
  assert.equal(local.files.length, 1)
  assert.equal(cloud.files.length, 0) // A downloaded file is local until its cloud copy is ready.
  store.setCloudStatusForMaterial(sharedCloud.materialId, 'ready')
  assert.equal(browser.browseMaterials({ folderId: cloud.current.id }).files.length, 1)
  assert.equal(root.files.length, 1)
  assert.equal(root.current.videoCount, 1)
  assert.deepEqual(root.rootFolders.map((folder) => folder.name), ['本地素材', '云端素材'])
})

test('all count surfaces use the same local/cloud union across nested folders and alias records', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  fs.writeFileSync(path.join(workspace.materialsDir, 'local-only.mp4'), 'local-only')
  store.upsertCloudFolder({folderId:'fld_count',name:'云端目录',revision:1})
  store.upsertCloudFolder({folderId:'fld_nested_count',parentId:'fld_count',name:'子目录',revision:1})
  for (const [id, asset, folder] of [['mat_c1','asset_c1','fld_count'],['mat_c2','asset_c2','fld_nested_count'],['mat_c2_alias','asset_c2','fld_count']]) {
    const content=Buffer.from(asset)
    store.upsertCloudMaterial({materialId:id,assetId:asset,assetVersion:1,folderId:folder,displayName:asset+'.mp4',origin:'user_upload',addedFrom:'cloud_restore',sourceSha256:createHash('sha256').update(content).digest('hex'),sourceSize:content.length,mimeType:'video/mp4',analysisStatus:'ready',cloudStatus:'ready',revision:1})
  }
  const downloaded=store.getMaterialCloudFileById('mat_c1')
  fs.mkdirSync(path.dirname(downloaded.localPath),{recursive:true})
  fs.writeFileSync(downloaded.localPath,'asset_c1')
  store.completeCloudDownload(downloaded.materialId,downloaded.localPath,downloaded.sourceSha256,downloaded.sourceSize)
  const browser=createMaterialDirectoryBrowser({...workspace,identityStore:store})
  const root=browser.browseMaterials()
  assert.equal(root.current.videoCount,3)
  assert.deepEqual(root.rootFolders.map(f=>f.videoCount),[2,2])
  assert.deepEqual(root.folders.map(f=>f.videoCount),[2,2])
  for(const scope of root.rootFolders){
    const page=browser.browseMaterials({folderId:scope.id})
    assert.equal(page.current.videoCount,2)
    assert.equal(page.files.length,2)
    assert.equal(page.root.videoCount,3)
    assert.equal(browser.getMaterialFolderDetails(scope.id).videoCount,2)
  }
})

test('cloud download and local upload add storage availability without removing the other side', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })
  const root = browser.browseMaterials()
  const localRoot = folderByName(root, '本地素材')
  const cloudRoot = folderByName(root, '云端素材')

  const cloudFolderId = 'fld_dual_cloud'
  const cloudContent = Buffer.from('download-keeps-cloud-membership')
  const cloudHash = createHash('sha256').update(cloudContent).digest('hex')
  store.upsertCloudFolder({ folderId: cloudFolderId, name: '云端原目录', revision: 1 })
  store.upsertCloudMaterial({
    materialId: 'mat_dual_cloud',
    assetId: 'asset_dual_cloud',
    assetVersion: 1,
    folderId: cloudFolderId,
    displayName: '云端下载.mp4',
    origin: 'user_upload',
    addedFrom: 'cloud_restore',
    sourceSha256: cloudHash,
    sourceSize: cloudContent.length,
    mimeType: 'video/mp4',
    analysisStatus: 'ready',
    cloudStatus: 'ready',
    revision: 1,
  })
  const cloudPlaceholder = store.getMaterialCloudFileById('mat_dual_cloud')
  fs.mkdirSync(path.dirname(cloudPlaceholder.localPath), { recursive: true })
  fs.writeFileSync(cloudPlaceholder.localPath, cloudContent)
  store.completeCloudDownload('mat_dual_cloud', cloudPlaceholder.localPath, cloudHash, cloudContent.length)
  store.describeKnownFile({
    name: path.basename(cloudPlaceholder.localPath),
    path: cloudPlaceholder.localPath,
    url: '',
    size: cloudContent.length,
    mtime: fs.statSync(cloudPlaceholder.localPath).mtimeMs,
    ext: '.mp4',
  })

  assert.equal(
    browser.browseMaterials({ folderId: cloudRoot.id }).files.some((file) => file.materialId === 'mat_dual_cloud'),
    true,
  )
  assert.equal(
    browser.browseMaterials({ folderId: localRoot.id }).files.some((file) => file.materialId === 'mat_dual_cloud'),
    true,
  )

  const localFile = path.join(workspace.materialsDir, '本地上传.mp4')
  fs.writeFileSync(localFile, 'upload-keeps-local-membership')
  const localMaterial = store.describeKnownFile({
    name: path.basename(localFile),
    path: localFile,
    url: '',
    size: fs.statSync(localFile).size,
    mtime: fs.statSync(localFile).mtimeMs,
    ext: '.mp4',
  })
  store.setCloudStatusForMaterial(localMaterial.materialId, 'ready')
  store.setCloudRevisionForMaterial(localMaterial.materialId, 1)

  assert.equal(
    browser.browseMaterials({ folderId: localRoot.id }).files.some((file) => file.materialId === localMaterial.materialId),
    true,
  )
  assert.equal(
    browser.browseMaterials({ folderId: cloudRoot.id }).files.some((file) => file.materialId === localMaterial.materialId),
    true,
  )
  assert.equal(browser.browseMaterials().files.filter((file) => (
    file.assetId === localMaterial.assetId
  )).length, 1)
  assert.deepEqual(
    new Set(store.materialIdsForGeneration({
      taskId: 'task_cloud_root_scope',
      taskRevision: 1,
      shots: [{
        shot_id: 'shot_cloud_root_scope',
        download_material: false,
        material_bindings: [{
          binding_type: 'folder',
          folder_id: cloudRoot.id,
          include_subfolders: false,
        }],
      }],
    })),
    new Set(['mat_dual_cloud', localMaterial.materialId]),
  )
})

test('local download aliases delete locally and queue cloud metadata tombstones without deleting COS copies', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const source = path.join(workspace.runsDir, 'run-local-alias', 'raw', 'shot_001', 'source.mp4')
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, 'local-alias-source')
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })

  const root = browser.browseMaterials()
  const localRoot = folderByName(root, '本地素材')
  const localBatch = folderByName(browser.browseMaterials({ folderId: localRoot.id }), 'run-local-alias')
  const localShot = folderByName(browser.browseMaterials({ folderId: localBatch.id }), 'shot_001')
  const identityFolderId = browser.getMaterialFolderIdentityId(localShot.id)
  assert.equal(localShot.storageScope, 'downloads')
  assert.equal(localShot.canCreate, true)
  assert.equal(localShot.canImport, true)
  assert.equal(localShot.canRename, true)
  assert.equal(localShot.canDelete, true)

  const deleted = browser.deleteMaterialFolder(localShot.id)
  assert.equal(fs.existsSync(source), false)
  assert.equal(fs.existsSync(deleted.stagedDirectory), true)
  assert.equal(store.getFolder(identityFolderId), null)
  assert.equal(
    browser.browseMaterials({ folderId: localBatch.id }).folders.some((folder) => folder.name === 'shot_001'),
    false,
  )
  const operations = store.claimCloudOperations(20)
  const folderDeletion = operations.find((operation) => (
    operation.operationType === 'sync_folder' && operation.entityId === identityFolderId
  ))
  assert.equal(folderDeletion?.payload.deleted, true)
  assert.equal(operations.some((operation) => operation.operationType === 'delete_cloud_copy'), false)
})

test('cloud folders support logical create, rename, move and record-only delete', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const source = path.join(workspace.runsDir, 'run-cloud-folder', 'raw', 'shot_001', 'source.mp4')
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, 'cloud-folder-source')
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })

  const root = browser.browseMaterials()
  const cloudRoot = folderByName(root, '云端素材')
  store.setCloudStatusForMaterial(store.getMaterialCloudFileByPath(source).materialId, 'ready')
  assert.deepEqual({
    canCreate: cloudRoot.canCreate,
    canImport: cloudRoot.canImport,
    canRename: cloudRoot.canRename,
    canDelete: cloudRoot.canDelete,
  }, {
    canCreate: true,
    canImport: false,
    canRename: false,
    canDelete: false,
  })

  const archive = browser.createMaterialFolder(cloudRoot.id, '待归档')
  const renamed = browser.renameMaterialFolder(archive.id, '云端归档')
  assert.equal(renamed.folder.name, '云端归档')
  const cloudListing = browser.browseMaterials({ folderId: cloudRoot.id })
  const runFolder = folderByName(cloudListing, 'run-cloud-folder')
  const batch = browser.browseMaterials({ folderId: runFolder.id })
  const shot = folderByName(batch, 'shot_001')
  assert.deepEqual({
    canCreate: shot.canCreate,
    canRename: shot.canRename,
    canDelete: shot.canDelete,
  }, {
    canCreate: true,
    canRename: true,
    canDelete: true,
  })
  assert.equal(browser.browseMaterials({ folderId: shot.id }).files.length, 1)

  const moved = browser.moveMaterialFolder(runFolder.id, renamed.folder.id)
  assert.equal(moved.changed, true)
  assert.equal(
    browser.browseMaterials({ folderId: renamed.folder.id }).folders.some((item) => item.id === runFolder.id),
    true,
  )
  const impact = store.getDeletionImpact([], [renamed.folder.id])
  assert.deepEqual({
    folderCount: impact.folderCount,
    materialCount: impact.materialCount,
    localFileCount: impact.localFileCount,
  }, {
    folderCount: 3,
    materialCount: 1,
    localFileCount: 1,
  })

  browser.deleteMaterialFolder(renamed.folder.id)
  assert.equal(fs.existsSync(source), true)
  assert.equal(store.getFolder(renamed.folder.id), null)
  assert.equal(store.getFolder(runFolder.id), null)
  assert.equal(
    browser.browseMaterials({ folderId: cloudRoot.id }).folders.some((item) => item.id === runFolder.id),
    false,
  )
  assert.equal(
    store.claimCloudOperations(50).some((operation) => operation.operationType === 'delete_cloud_copy'),
    false,
  )
})

test('cloud-only materials move logically without changing their managed cache path', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })
  const userRoot = folderByName(browser.browseMaterials(), '本地素材')
  const source = browser.createMaterialFolder(userRoot.id, '云端待整理')
  const destination = browser.createMaterialFolder(userRoot.id, '云端归档')
  const content = Buffer.from('cloud-only-move', 'utf8')
  const sourceSha256 = createHash('sha256').update(content).digest('hex')

  store.upsertCloudMaterial({
    materialId: 'mat_cloud_move',
    assetId: 'asset_cloud_move',
    assetVersion: 1,
    folderId: source.id,
    displayName: '云端归档镜头.mp4',
    origin: 'user_upload',
    addedFrom: 'cloud_restore',
    sourceSha256,
    sourceSize: content.length,
    mimeType: 'video/mp4',
    analysisStatus: 'ready',
    cloudStatus: 'ready',
    revision: 2,
  })
  const before = browser.browseMaterials({ folderId: source.id }).files[0]
  assert.equal(before.localStatus, 'missing')

  const moved = browser.moveMaterialFiles(source.id, destination.id, [before.path])
  assert.equal(moved.moved, 1)
  assert.equal(moved.files[0].materialId, 'mat_cloud_move')
  assert.equal(moved.files[0].path, before.path)
  assert.equal(browser.browseMaterials({ folderId: source.id }).files.length, 0)
  assert.equal(browser.browseMaterials({ folderId: destination.id }).files[0].materialId, 'mat_cloud_move')

  const operations = store.claimCloudOperations(10)
  assert.equal(operations.some((operation) => (
    operation.operationType === 'sync_material' && operation.entityId === 'mat_cloud_move'
  )), true)
})

test('deletion impact counts local, cloud, public and task references by stable identity', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })
  const userRoot = folderByName(browser.browseMaterials(), '本地素材')
  const folder = browser.createMaterialFolder(userRoot.id, '待删除项目')
  browser.createMaterialFolder(folder.id, '空子目录')
  const target = browser.getMaterialImportTarget(folder.id)
  const source = path.join(workspace.dataRoot, 'delete-impact.mp4')
  fs.writeFileSync(source, 'local-delete-impact')
  const local = store.importMaterialFile(source, target.directory, folder.id)
  const cloudContent = Buffer.from('public-cloud-delete-impact')
  store.upsertCloudMaterial({
    materialId: 'mat_public_delete_impact',
    assetId: 'asset_public_delete_impact',
    assetVersion: 1,
    folderId: folder.id,
    displayName: '公开素材.mp4',
    origin: 'user_upload',
    addedFrom: 'cloud_restore',
    sourceSha256: createHash('sha256').update(cloudContent).digest('hex'),
    sourceSize: cloudContent.length,
    mimeType: 'video/mp4',
    analysisStatus: 'ready',
    cloudStatus: 'ready',
    revision: 4,
    publicationStatus: 'public',
    publicationId: 'pub_delete_impact',
    publicationRevision: 2,
  })
  store.saveTaskDraft({
    taskId: 'task-material-reference',
    schemaVersion: 1,
    snapshot: { shots: [{ material_bindings: [{ binding_type: 'material', material_id: local.materialId }] }] },
  })
  store.saveTaskDraft({
    taskId: 'task-folder-reference',
    schemaVersion: 1,
    snapshot: { shots: [{ material_bindings: [{ binding_type: 'folder', folder_id: folder.id, include_subfolders: true }] }] },
  })

  const impact = store.getDeletionImpact([local.materialId], [folder.id])
  assert.deepEqual({
    materialCount: impact.materialCount,
    folderCount: impact.folderCount,
    localFileCount: impact.localFileCount,
    cloudCopyCount: impact.cloudCopyCount,
    publicMaterialCount: impact.publicMaterialCount,
    taskReferenceCount: impact.taskReferenceCount,
    canDelete: impact.canDelete,
  }, {
    materialCount: 2,
    folderCount: 2,
    localFileCount: 1,
    cloudCopyCount: 1,
    publicMaterialCount: 1,
    taskReferenceCount: 2,
    canDelete: false,
  })
  assert.match(impact.blockers[0], /先取消公开/)
})

test('removing a local copy keeps the cloud material identity available for restore', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })
  const userRoot = folderByName(browser.browseMaterials(), '本地素材')
  const folder = browser.createMaterialFolder(userRoot.id, '云端留存')
  const content = Buffer.from('local-copy-can-be-restored')
  const sourceSha256 = createHash('sha256').update(content).digest('hex')
  store.upsertCloudMaterial({
    materialId: 'mat_local_copy_restore',
    assetId: 'asset_local_copy_restore',
    assetVersion: 1,
    folderId: folder.id,
    displayName: '可恢复素材.mp4',
    origin: 'user_upload',
    addedFrom: 'cloud_restore',
    sourceSha256,
    sourceSize: content.length,
    mimeType: 'video/mp4',
    analysisStatus: 'ready',
    cloudStatus: 'ready',
    revision: 3,
  })
  const placeholder = store.getMaterialCloudFileById('mat_local_copy_restore')
  fs.mkdirSync(path.dirname(placeholder.localPath), { recursive: true })
  fs.writeFileSync(placeholder.localPath, content)
  store.completeCloudDownload('mat_local_copy_restore', placeholder.localPath, sourceSha256, content.length)

  store.removeLocalCopy('mat_local_copy_restore')
  const retained = store.getMaterialCloudFileById('mat_local_copy_restore')
  assert.equal(retained.materialId, 'mat_local_copy_restore')
  assert.equal(retained.cloudStatus, 'ready')
  assert.equal(retained.localStatus, 'missing')
  assert.equal(browser.browseMaterials({ folderId: folder.id }).files[0].localStatus, 'missing')
})

test('local file state self-heals across deletion, corruption and byte-identical restore', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })
  const userRoot = folderByName(browser.browseMaterials(), '本地素材')
  const folder = browser.createMaterialFolder(userRoot.id, '存在性校验')
  const target = browser.getMaterialImportTarget(folder.id)
  const content = Buffer.from('verified-local-video-content')
  const source = path.join(workspace.dataRoot, 'verify-source.mp4')
  fs.writeFileSync(source, content)
  const imported = store.importMaterialFile(source, target.directory, target.folderId)
  store.setAnalysisStatusForFile(imported.path, 'ready')
  store.setCloudStatusForMaterial(imported.materialId, 'ready')

  fs.unlinkSync(imported.path)
  assert.equal(store.getMaterialCloudFileById(imported.materialId).localStatus, 'missing')
  assert.equal(store.listFolderFiles(folder.id)[0].localStatus, 'missing')

  fs.writeFileSync(imported.path, Buffer.alloc(content.length, 0x78))
  assert.equal(store.getMaterialCloudFileById(imported.materialId).localStatus, 'damaged')
  assert.equal(store.listFolderFiles(folder.id)[0].localStatus, 'damaged')
  assert.throws(() => store.prepareGenerationManifest({
    taskId: 'task-damaged-local-file',
    taskRevision: 1,
    shots: [{
      shot_id: 'shot-1',
      download_material: false,
      material_bindings: [{ binding_type: 'material', material_id: imported.materialId }],
    }],
  }), /当前设备不可用/)

  fs.writeFileSync(imported.path, content)
  assert.equal(store.getMaterialCloudFileById(imported.materialId).localStatus, 'present')
  const prepared = store.prepareGenerationManifest({
    taskId: 'task-restored-local-file',
    taskRevision: 1,
    shots: [{
      shot_id: 'shot-1',
      download_material: false,
      material_bindings: [{ binding_type: 'material', material_id: imported.materialId }],
    }],
  })
  assert.equal(prepared.manifest.shots[0].materials[0].material_id, imported.materialId)
})

test('staged imports report progress, verify content and clean partial files after cancellation', async (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })
  const userRoot = folderByName(browser.browseMaterials(), '本地素材')
  const folder = browser.createMaterialFolder(userRoot.id, '分段导入')
  const target = browser.getMaterialImportTarget(folder.id)
  const staging = path.join(workspace.materialsDir, '.staging', 'test-session')
  const source = path.join(workspace.dataRoot, 'large-import.mp4')
  const content = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a)
  fs.writeFileSync(source, content)
  const phases = new Set()

  const imported = await store.importMaterialFileWithProgress(
    source,
    target.directory,
    folder.id,
    {
      stagingDirectory: staging,
      onProgress: (progress) => phases.add(progress.phase),
    },
  )
  assert.equal(fs.readFileSync(imported.path).equals(content), true)
  assert.deepEqual([...phases].sort(), ['copying', 'verifying'])
  assert.equal(store.getMaterialCloudFileById(imported.materialId).sourceSha256, createHash('sha256').update(content).digest('hex'))

  const canceledSource = path.join(workspace.dataRoot, 'canceled-import.mp4')
  fs.writeFileSync(canceledSource, Buffer.alloc(3 * 1024 * 1024, 0x33))
  let canceled = false
  await assert.rejects(() => store.importMaterialFileWithProgress(
    canceledSource,
    target.directory,
    folder.id,
    {
      stagingDirectory: staging,
      isCanceled: () => canceled,
      onProgress: (progress) => {
        if (progress.phase === 'copying' && progress.bytesProcessed >= 1024 * 1024) canceled = true
      },
    },
  ), /已取消/)
  assert.equal(browser.browseMaterials({ folderId: folder.id }).files.length, 1)
  assert.deepEqual(fs.readdirSync(staging), [])
})

test('upload pause, resume and cancel survive queue claims without becoming failures', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })
  const userRoot = folderByName(browser.browseMaterials(), '本地素材')
  const folder = browser.createMaterialFolder(userRoot.id, '上传控制')
  const source = path.join(workspace.dataRoot, 'control-source.mp4')
  fs.writeFileSync(source, 'controlled-upload-content')
  const target = browser.getMaterialImportTarget(folder.id)
  const material = store.importMaterialFile(source, target.directory, target.folderId)
  store.setAnalysisStatusForFile(material.path, 'ready', '', false)
  const operation = store.queueCloudOperation('upload', material.materialId, {})
  store.saveTransferSession({
    sessionId: 'upl_local_control_01',
    direction: 'upload',
    materialId: material.materialId,
    status: 'uploading',
    bytesTransferred: 8,
    totalBytes: material.size,
    partSize: 8,
    completedParts: [1],
  })

  assert.equal(store.pauseCloudUpload(material.materialId), true)
  assert.deepEqual(store.claimCloudOperations(1), [])
  assert.deepEqual(store.cloudOperationCounts(), { pending: 1, failed: 0 })
  assert.equal(browser.browseMaterials({ folderId: folder.id }).files[0].uploadTransferStatus, 'paused')

  assert.equal(store.resumeCloudUpload(material.materialId), true)
  const firstClaim = store.claimCloudOperations(1)
  assert.equal(firstClaim.length, 1)
  assert.equal(firstClaim[0].operationId, operation.operationId)
  assert.equal(browser.browseMaterials({ folderId: folder.id }).files[0].uploadTransferStatus, 'uploading')

  assert.equal(store.pauseCloudUpload(material.materialId), true)
  store.completeCloudOperation(firstClaim[0].operationId)
  assert.deepEqual(store.cloudOperationCounts(), { pending: 1, failed: 0 })
  assert.equal(store.resumeCloudUpload(material.materialId), true)
  const secondClaim = store.claimCloudOperations(1)
  assert.equal(secondClaim.length, 1)

  assert.equal(store.cancelCloudUpload(material.materialId), true)
  store.retryCloudOperation(secondClaim[0].operationId, 'should not overwrite cancel', new Date().toISOString())
  assert.deepEqual(store.cloudOperationCounts(), { pending: 0, failed: 0 })
  assert.equal(browser.browseMaterials({ folderId: folder.id }).files[0].uploadTransferStatus, 'canceled')
})

test('cloud-ready materials reconcile stale verifying upload sessions', (t) => {
  const workspace = createWorkspace()
  let store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  let browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })
  const userRoot = folderByName(browser.browseMaterials(), '本地素材')
  const folder = browser.createMaterialFolder(userRoot.id, '云端收口')
  const source = path.join(workspace.dataRoot, 'verified-source.mp4')
  fs.writeFileSync(source, 'verified-upload-content')
  const target = browser.getMaterialImportTarget(folder.id)
  const material = store.importMaterialFile(source, target.directory, target.folderId)

  store.saveTransferSession({
    sessionId: 'upl_stale_verifying_01',
    direction: 'upload',
    materialId: material.materialId,
    status: 'verifying',
    bytesTransferred: material.size,
    totalBytes: material.size,
    partSize: material.size,
    completedParts: [1],
  })
  store.setCloudStatusForMaterial(material.materialId, 'ready')

  assert.equal(store.getTransferSession(material.materialId, 'upload')?.status, 'verifying')
  assert.equal(browser.browseMaterials({ folderId: folder.id }).files[0].uploadTransferStatus, 'ready')

  store.close()
  store = createMaterialLocalStore(workspace)
  browser = createMaterialDirectoryBrowser({
    materialsDir: workspace.materialsDir,
    runsDir: workspace.runsDir,
    identityStore: store,
  })
  browser.browseMaterials()
  assert.equal(store.getTransferSession(material.materialId, 'upload')?.status, 'ready')
  assert.equal(browser.browseMaterials({ folderId: folder.id }).files[0].uploadTransferStatus, 'ready')

  const secondSource = path.join(workspace.dataRoot, 'verified-sync-source.mp4')
  fs.writeFileSync(secondSource, 'verified-sync-content')
  const second = store.importMaterialFile(secondSource, target.directory, target.folderId)
  store.saveTransferSession({
    sessionId: 'upl_stale_verifying_02',
    direction: 'upload',
    materialId: second.materialId,
    status: 'verifying',
    bytesTransferred: second.size,
    totalBytes: second.size,
    partSize: second.size,
    completedParts: [1],
  })
  store.upsertCloudMaterial({
    materialId: second.materialId,
    assetId: second.assetId,
    assetVersion: second.assetVersion,
    folderId: folder.id,
    displayName: second.name,
    origin: 'user_upload',
    addedFrom: 'user_import',
    sourceSha256: second.sourceSha256,
    sourceSize: second.size,
    mimeType: 'video/mp4',
    analysisStatus: 'ready',
    cloudStatus: 'ready',
    revision: 1,
    publicationStatus: 'private',
  })
  assert.equal(store.getTransferSession(second.materialId, 'upload')?.status, 'ready')
})


test('cloud download source uses a registered material of the same asset version for a legacy alias', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  store.upsertCloudFolder({ folderId: 'fld_cloud', name: 'cloud', revision: 1 })
  const record = { materialId: 'mat_registered', assetId: 'asset_shared', assetVersion: 1,
    folderId: 'fld_cloud', displayName: 'cloud.mp4', origin: 'user_upload', addedFrom: 'cloud_restore',
    sourceSha256: 'a'.repeat(64), sourceSize: 12, mimeType: 'video/mp4', analysisStatus: 'pending', cloudStatus: 'ready', revision: 1 }
  store.upsertCloudMaterial(record)
  store.upsertCloudFolder({ folderId: 'fld_alias', name: 'alias', revision: 1 })
  store.upsertCloudMaterial({ ...record, materialId: 'mat_alias', folderId: 'fld_alias', displayName: 'alias.mp4' })
  const db = new DatabaseSync(workspace.databasePath)
  db.prepare('UPDATE material SET cloud_revision = 0 WHERE material_id = ?').run('mat_alias')
  db.close()
  assert.equal(store.getCloudDownloadSource('mat_alias').materialId, 'mat_registered')
  assert.equal(store.getCloudDownloadSource('mat_registered').materialId, 'mat_registered')
  assert.equal(store.getCloudDownloadSource('missing'), null)
})

test('upload intent waits durably for ready analysis without consuming retries or blocking other materials', (t) => {
  const workspace = createWorkspace()
  let store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const folderId = store.getOrCreateFolder({ scope: 'user', storageKey: '.', name: '本地素材' })
  const register = (name) => {
    const source = path.join(workspace.materialsDir, name)
    fs.writeFileSync(source, name)
    return store.registerMaterialFile(source, { folderId, origin: 'user_upload', addedFrom: 'user_import' })
  }
  const waiting = register('waiting.mp4')
  const available = register('available.mp4')
  const pending = store.queueCloudOperation('upload', waiting.materialId)
  const pendingAnalysis = store.queueCloudOperation('sync_analysis', waiting.materialId)
  store.setAnalysisStatusForFile(available.localPath, 'ready', '', false)
  const runnable = store.queueCloudOperation('upload', available.materialId)
  const claimed = store.claimCloudOperations(1)
  assert.deepEqual(claimed.map(item => item.operationId), [runnable.operationId])
  store.completeCloudOperation(runnable.operationId)
  assert.deepEqual(store.claimCloudOperations(20), [])
  store.close()
  store = createMaterialLocalStore(workspace)
  assert.deepEqual(store.claimCloudOperations(20), [])
  assert.equal(store.queueCloudOperation('upload', waiting.materialId).attemptCount, 0)
  store.setAnalysisStatusForFile(waiting.localPath, 'ready')
  const ready = store.claimCloudOperations(20)
  assert.deepEqual(ready.map(item => item.operationId).sort(), [pending.operationId, pendingAnalysis.operationId].sort())
  assert.ok(ready.every(item => item.attemptCount === 0))
})

test('automatic discovery preserves paused and canceled backup intent until explicit user action', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const folderId = store.getOrCreateFolder({ scope: 'user', storageKey: '.', name: '本地素材' })
  const source = path.join(workspace.materialsDir, 'controlled.mp4')
  fs.writeFileSync(source, 'controlled')
  const material = store.registerMaterialFile(source, { folderId, origin: 'user_upload', addedFrom: 'user_import' })
  store.setAnalysisStatusForFile(source, 'ready', '', false)
  const original = store.queueCloudOperation('upload', material.materialId)
  store.pauseCloudUpload(material.materialId)
  assert.equal(store.queueCloudOperation('upload', material.materialId, { policy: true }).status, 'paused')
  assert.deepEqual(store.claimCloudOperations(10), [])
  assert.equal(store.resumeCloudUpload(material.materialId), true)
  assert.equal(store.claimCloudOperations(1)[0].operationId, original.operationId)
  store.cancelCloudUpload(material.materialId)
  assert.equal(store.queueCloudOperation('upload', material.materialId, { policy: true }).status, 'canceled')
  assert.deepEqual(store.claimCloudOperations(10), [])
  const restarted = store.queueCloudOperation('upload', material.materialId, { explicitResume: true })
  assert.notEqual(restarted.operationId, original.operationId, 'a canceled remote session needs a new idempotency key')
  assert.equal(store.claimCloudOperations(1)[0].operationId, restarted.operationId)
})

test('material read snapshots batch transfer state and refresh on the next read', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  store.upsertCloudFolder({ folderId: 'cloud_batch', name: 'Batch', revision: 1 })
  for (let index = 0; index < 120; index++) {
    store.upsertCloudMaterial({
      materialId: `mat_batch_${index}`, assetId: `asset_batch_${index}`, assetVersion: 1,
      folderId: 'cloud_batch', displayName: `${index}.mp4`, origin: 'user_upload',
      addedFrom: 'cloud_restore', sourceSha256: index.toString(16).padStart(64, '0'),
      sourceSize: 120, mimeType: 'video/mp4', analysisStatus: 'ready', cloudStatus: 'ready',
      revision: 1, publicationStatus: 'private',
    })
  }
  store.queueCloudOperation('restore_analysis', 'mat_batch_0', {})
  const transfer = { sessionId: 'download_batch_0', direction: 'download', materialId: 'mat_batch_0',
    status: 'downloading', bytesTransferred: 30, totalBytes: 120, partSize: 120, completedParts: [] }
  store.saveTransferSession(transfer)
  const prepare = DatabaseSync.prototype.prepare
  let stateReads = 0
  const statusSql = []
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    if (/SELECT/i.test(sql) && /FROM local_(sync_outbox|transfer_session)/i.test(sql)) {
      stateReads++
      statusSql.push(sql)
    }
    return prepare.call(this, sql)
  })
  const lstat = fs.lstatSync
  let cloudFileChecks = 0
  t.mock.method(fs, 'lstatSync', function (filePath, ...args) {
    if (String(filePath).includes(`${path.sep}cloud${path.sep}`)) cloudFileChecks++
    return lstat.call(fs, filePath, ...args)
  })
  const before = store.getMaterialReadRevision()
  store.withMaterialReadSnapshot(() => {
    assert.deepEqual(store.listFolderFiles('empty_folder'), [])
    assert.equal(stateReads, 0, 'an empty list must not load any transfer table')
    const first = store.listCloudFiles()
    const second = store.listFolderFiles('cloud_batch')
    assert.equal(first.length, 120)
    assert.equal(second.length, 120)
    const file = first.find((item) => item.materialId === 'mat_batch_0')
    assert.equal(file.analysisTransferDirection, 'download')
    assert.equal(file.analysisTransferStatus, 'queued')
    assert.equal(file.downloadBytesTransferred, 30)
    assert.equal(file.uploadTransferStatus, 'ready')
    assert.equal(file.cloudAnalysisStatus, 'ready')
    assert.ok(stateReads < 10, `120 materials caused ${stateReads} transfer state reads`)
    assert.ok(statusSql.every(sql => /(?:entity_id|material_id) IN \(/.test(sql)), 'a small batch must not load unrelated transfer history')
    assert.equal(cloudFileChecks, 120, 'repeated list views in one read must reconcile each material only once')
  })
  assert.equal(store.getMaterialReadRevision(), before, 'unchanged directory reads must not invalidate root counts')
  store.saveTransferSession({ ...transfer, bytesTransferred: 90 })
  assert.notEqual(store.getMaterialReadRevision(), before)
  const refreshed = store.withMaterialReadSnapshot(() => store.listCloudFiles())
    .find((item) => item.materialId === 'mat_batch_0')
  assert.equal(refreshed.downloadBytesTransferred, 90)
  const beforeExternal = store.getMaterialReadRevision()
  const external = new DatabaseSync(workspace.databasePath)
  external.prepare("UPDATE asset SET cloud_analysis_status='failed' WHERE asset_id=?").run('asset_batch_0')
  external.close()
  assert.notEqual(store.getMaterialReadRevision(), beforeExternal, 'other SQLite connections must invalidate the read revision')
  assert.equal(store.listCloudFiles().find((item) => item.materialId === 'mat_batch_0').cloudAnalysisStatus, 'failed')
  store.withMaterialReadSnapshot(() => {
    assert.equal(store.listFolderFiles('cloud_batch').find(item => item.materialId === 'mat_batch_0').downloadBytesTransferred, 90)
    store.saveTransferSession({ ...transfer, bytesTransferred: 105 })
    assert.equal(store.listFolderFiles('cloud_batch').find(item => item.materialId === 'mat_batch_0').downloadBytesTransferred, 105)
    const otherConnection = new DatabaseSync(workspace.databasePath)
    otherConnection.prepare("UPDATE asset SET cloud_analysis_status='ready' WHERE asset_id=?").run('asset_batch_0')
    otherConnection.close()
    assert.equal(store.listFolderFiles('cloud_batch').find(item => item.materialId === 'mat_batch_0').cloudAnalysisStatus, 'ready')
  })
})

test('a read snapshot bounds status queries when a physical directory is described file by file', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  const folderId = store.getOrCreateFolder({ scope: 'user', storageKey: '.', name: '本地素材' })
  const files = []
  for (let index = 0; index < 80; index++) {
    const filePath = path.join(workspace.materialsDir, `local_${index}.mp4`)
    fs.writeFileSync(filePath, `unique-video-${index}`)
    store.registerMaterialFile(filePath, { folderId, origin: 'user_upload', addedFrom: 'user_import' })
    files.push({ name: path.basename(filePath), path: filePath, size: fs.statSync(filePath).size, isDirectory: false })
  }
  const prepare = DatabaseSync.prototype.prepare
  let statusReads = 0
  let wholeTableReads = 0
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    if (/SELECT/i.test(sql) && /FROM local_(sync_outbox|transfer_session)/i.test(sql)) {
      statusReads++
      if (!/(?:entity_id|material_id) IN \(/.test(sql)) wholeTableReads++
    }
    return prepare.call(this, sql)
  })
  const before = store.getMaterialReadRevision()
  const described = store.withMaterialReadSnapshot(() => files.map(file => store.describeKnownFile(file)))
  assert.equal(described.length, 80)
  assert.ok(described.every(file => file.materialId && file.localStatus === 'present'))
  assert.equal(store.getMaterialReadRevision(), before)
  assert.equal(statusReads, 3, `80 individually described files caused ${statusReads} status reads`)
  assert.equal(wholeTableReads, 0, 'a local directory must not load unrelated transfer history')
})

test('large selections batch identity queries while preserving deduplication and missing-material errors', (t) => {
  const workspace = createWorkspace()
  const store = createMaterialLocalStore(workspace)
  t.after(() => closeAndRemove(store, workspace))
  store.upsertCloudFolder({ folderId: 'cloud_selection', name: 'Selection', revision: 1 })
  const bindings = []
  for (let index = 0; index < 550; index++) {
    store.upsertCloudMaterial({
      materialId: `mat_selection_${index}`, assetId: `asset_selection_${Math.floor(index / 2)}`, assetVersion: 1,
      folderId: 'cloud_selection', displayName: `${index}.mp4`, origin: 'user_upload',
      addedFrom: 'cloud_restore', sourceSha256: Math.floor(index / 2).toString(16).padStart(64, '0'),
      sourceSize: 120, mimeType: 'video/mp4', analysisStatus: 'ready', cloudStatus: 'ready',
      revision: 1, publicationStatus: 'private',
    })
    bindings.push({ binding_type: 'material', material_id: `mat_selection_${index}` })
  }
  const prepare = DatabaseSync.prototype.prepare
  let identityReads = 0
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    if (/SELECT material_id, asset_id, asset_version FROM material/i.test(sql)) identityReads++
    return prepare.call(this, sql)
  })
  const summary = store.summarizeMaterialSelection(bindings)
  assert.equal(summary.candidateCount, 275)
  assert.equal(summary.entries.length, 550)
  assert.equal(summary.entries.every((item) => item.candidateKeys.length === 1), true)
  assert.ok(identityReads <= 3, `550 material IDs caused ${identityReads} identity reads`)
  assert.throws(() => store.summarizeMaterialSelection([
    ...bindings, { binding_type: 'material', material_id: 'deleted_or_unknown' },
  ]), /素材不存在或已删除：deleted_or_unknown/)
})
