import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createMaterialLocalStore } from '../dist-electron/material-local-store.js'
import { createMaterialCloudService } from '../dist-electron/material-cloud-service.js'

function fixture(t) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-resume-manifest-'))
  const materialsDir = path.join(dataRoot, 'materials'), runsDir = path.join(dataRoot, 'runs')
  fs.mkdirSync(materialsDir); fs.mkdirSync(runsDir)
  const store = createMaterialLocalStore({ dataRoot, materialsDir, runsDir, manifestsDir: path.join(dataRoot, 'manifests'), databasePath: path.join(dataRoot, 'library.sqlite') })
  t.after(() => {
    store.close()
    assert.ok(path.resolve(dataRoot).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(dataRoot, { recursive: true, force: true })
  })
  const folder = store.getOrCreateFolder({ scope: 'user', storageKey: '.', name: 'Source' })
  const source = path.join(materialsDir, 'source.mp4')
  fs.writeFileSync(source, 'verified source video')
  const identity = store.registerMaterialFile(source, { folderId: folder, origin: 'user_upload', addedFrom: 'user_import' })
  store.setAnalysisStatusForFile(source, 'ready')
  const baseline = { shot_id: 'shot_second', visual_query: 'original product', download_material: false, material_bindings: [{ binding_type: 'material', material_id: identity.materialId }] }
  const original = store.prepareGenerationManifest({ taskId: 'preview', taskRevision: 1, shots: [baseline] }).manifest
  const taskId = 'run_original', run = path.join(runsDir, taskId)
  const raw = path.join(run, 'raw', 'shot-cache', 'source.mp4')
  fs.mkdirSync(path.dirname(raw), { recursive: true }); fs.copyFileSync(source, raw)
  const write = (name, value) => fs.writeFileSync(path.join(run, name), JSON.stringify(value))
  const shots = [{ shot_id: 'shot_first', visual_query: 'changed scene', download_material: true, material_bindings: [] }, { ...baseline, subtitle: 'new subtitle' }]
  const options = { taskId, taskRevision: 2, resumeRunPath: run, shots }
  const journal = { schema_version: 1, records: { 'download:shot_second': { input_hash: 'd'.repeat(64), output: baseline, files: { [raw]: identity.sourceSha256 } } } }
  write('shots.json', { schema_version: 2, task_revision: 2, material_source_mode: 'library-first', shots })
  write('material-source-mode.json', { material_source_mode: 'library-first' })
  write('material_manifest.json', { ...original, run_id: taskId, task_id: taskId }); write('incremental.json', journal)
  fs.unlinkSync(source)
  return { dataRoot, store, source, identity, raw, run, options, baseline, journal, write, original }
}

test('local resume freezes verified staged source for an unchanged bound shot after original disappears', t => {
  const f = fixture(t)
  const pinned = f.store.resumeMaterialShots(f.options)
  assert.equal(pinned.length, 1)
  assert.equal(pinned[0].materials[0].local_path, fs.realpathSync(f.raw))
  const prepared = f.store.prepareGenerationManifest(f.options)
  assert.deepEqual(prepared.manifest.shots.map(shot => shot.shot_id), ['shot_first', 'shot_second'])
  assert.equal(prepared.manifest.shots[1].materials[0].source_sha256, f.identity.sourceSha256)
  assert.equal(fs.existsSync(f.source), false)
  assert.equal(prepared.manifest.task_revision, 2)
})

test('resume binds a generation run directory to its distinct stable task id through the frozen manifest', t => {
  const f = fixture(t)
  const stableTaskId = 'import-task'
  f.options.taskId = stableTaskId
  f.write('material_manifest.json', { ...f.original, run_id: 'new-freeze-request', task_id: stableTaskId })
  assert.equal(f.store.resumeMaterialShots(f.options).length, 1)
  f.write('material_manifest.json', { ...f.original, run_id: path.basename(f.run), task_id: 'other-task' })
  assert.throws(() => f.store.resumeMaterialShots(f.options), /目录与当前任务不一致/)
})

test('distinct stable task ids require a valid frozen ownership record', t => {
  const f = fixture(t)
  f.options.taskId = 'import-task'
  fs.rmSync(path.join(f.run, 'material_manifest.json'))
  assert.throws(() => f.store.resumeMaterialShots(f.options), /缺少稳定任务归属记录/)
  f.write('material_manifest.json', { ...f.original, schema_version: 9, run_id: 'freeze', task_id: 'import-task' })
  assert.throws(() => f.store.resumeMaterialShots(f.options), /缺少稳定任务归属记录/)
  assert.throws(() => f.store.resumeMaterialShots({ ...f.options, resumeRunPath: os.tmpdir() }), /目录与当前任务不一致/)
})

test('resume rejects changed ranges, damaged or foreign staged paths, and source content changes', t => {
  const f = fixture(t)
  const edited = structuredClone(f.options)
  edited.shots[1].material_bindings = [{ binding_type: 'material', material_id: 'different' }]
  f.write('shots.json', { task_revision: 2, material_source_mode: 'library-first', shots: edited.shots })
  assert.deepEqual(f.store.resumeMaterialShots(edited), [])
  assert.throws(() => f.store.resumeMaterialShots(f.options), /素材输入与已保存分镜不一致/)
  f.write('shots.json', { task_revision: 2, material_source_mode: 'library-first', shots: f.options.shots })
  fs.writeFileSync(f.raw, 'corrupted')
  assert.deepEqual(f.store.resumeMaterialShots(f.options), [])
  fs.writeFileSync(f.raw, 'verified source video')
  const foreign = path.join(f.dataRoot, 'foreign.mp4')
  fs.writeFileSync(foreign, 'verified source video')
  f.journal.records['download:shot_second'].files = { [foreign]: f.identity.sourceSha256 }
  f.write('incremental.json', f.journal)
  assert.deepEqual(f.store.resumeMaterialShots(f.options), [])
  f.journal.records['download:shot_second'].files = { [f.raw]: f.identity.sourceSha256 }
  f.write('incremental.json', f.journal)
  fs.writeFileSync(f.source, 'source was replaced')
  assert.deepEqual(f.store.resumeMaterialShots(f.options), [])
  assert.throws(() => f.store.prepareGenerationManifest(f.options), /素材当前设备不可用/)
})

test('visual-description edits can reuse identical raw bindings, while mode, revision and task boundaries cannot', t => {
  const f = fixture(t)
  f.options.shots[1].visual_query = 'new camera angle'
  f.write('shots.json', { task_revision: 2, material_source_mode: 'library-first', shots: f.options.shots })
  assert.equal(f.store.resumeMaterialShots(f.options).length, 1)
  f.write('material-source-mode.json', { material_source_mode: 'library-only' })
  assert.deepEqual(f.store.resumeMaterialShots(f.options), [])
  assert.throws(() => f.store.resumeMaterialShots({ ...f.options, taskRevision: 3 }), /版本已变化/)
  assert.throws(() => f.store.resumeMaterialShots({ ...f.options, taskId: 'another' }), /目录与当前任务不一致/)
  assert.throws(() => f.store.resumeMaterialShots({ ...f.options, resumeRunPath: os.tmpdir(), taskId: path.basename(os.tmpdir()) }), /目录与当前任务不一致/)
})

test('Windows canonical namespaced receipts remain valid without widening the task boundary', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t)
  f.journal.records['download:shot_second'].files = { [path.toNamespacedPath(f.raw)]: f.identity.sourceSha256 }
  f.write('incremental.json', f.journal)
  const result = f.store.resumeMaterialShots({ ...f.options, resumeRunPath: path.toNamespacedPath(f.run) })
  assert.equal(result.length, 1)
  assert.equal(result[0].materials[0].local_path, fs.realpathSync.native(f.raw))
})

function cloud(f, transform = value => value, denied = false, onFrozen = () => {}) {
  const requests = []
  let submitted
  const service = createMaterialCloudService({
    deviceId: 'dev_resume_validation', readAuthState: () => ({ accessToken: 'mock-account-token' }),
    readEnv: () => ({ VIDEOAUTO_MATERIAL_API_BASE_URL: 'http://127.0.0.1:8091' }), send: () => {}, store: f.store,
    exportAnalysisResult: async () => { throw new Error('unused') }, importAnalysisResult: async () => { throw new Error('unused') },
    request: async (url, init = {}) => {
      const endpoint = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : undefined
      requests.push({ endpoint, body })
      let result
      if (endpoint === '/v1/folders') result = { items: [{ folder_id: 'fld_cloud_pinned', name: 'Pinned', revision: 1 }], has_more: false }
      else if (endpoint === '/v1/shot-material-validations') result = { valid: !denied, shots: [] }
      else if (endpoint === '/v1/generation-runs') { submitted = body; result = { run_id: 'run_new_resume' } }
      else if (endpoint.endsWith('/material-manifest')) {
        onFrozen()
        result = { shots: submitted.shots.map(shot => ({ shot_id: shot.shot_id, materials: shot.shot_id === 'shot_second' ? transform(f.original.shots[0].materials.map(({ local_path, ...identity }) => identity)) : [] })) }
      } else throw new Error(`Unexpected original download/registration: ${endpoint}`)
      return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  return { service, requests }
}

test('cloud resume validates and freezes all shots while avoiding download of the verified staged original', async t => {
  const f = fixture(t), c = cloud(f)
  const result = await c.service.prepareGenerationManifest(f.options)
  assert.deepEqual(c.requests.map(item => item.endpoint), ['/v1/shot-material-validations', '/v1/generation-runs', '/v1/generation-runs/run_new_resume/material-manifest'])
  assert.equal(c.requests[0].body.shots.length, 2)
  assert.deepEqual(c.requests[0].body.shots[1].material_bindings, [{ binding_type: 'material', material_id: f.identity.materialId }])
  assert.equal(result.manifest.shots[1].materials[0].local_path, fs.realpathSync(f.raw))
  assert.equal(result.manifest.run_id, 'run_new_resume')
  assert.equal(result.manifest.task_revision, 2)
  assert.equal(fs.existsSync(f.source), false)
})

test('cloud permission or frozen-version changes cannot be bypassed by staged receipts', async t => {
  const f = fixture(t)
  await assert.rejects(cloud(f, undefined, true).service.prepareGenerationManifest(f.options), /分镜素材校验未通过/)
  await assert.rejects(cloud(f, materials => materials.map(item => ({ ...item, source_sha256: 'f'.repeat(64) }))).service.prepareGenerationManifest(f.options), /素材版本与原任务冻结记录不一致/)
  await assert.rejects(cloud(f, materials => [...materials, ...materials]).service.prepareGenerationManifest(f.options), /素材版本与原任务冻结记录不一致/)
  assert.equal(fs.existsSync(path.join(f.dataRoot, 'manifests', 'run_new_resume.json')), false)
})

test('staged files are checked again after cloud validation before local manifest persistence', async t => {
  const f = fixture(t), c = cloud(f, undefined, false, () => fs.writeFileSync(f.raw, 'changed during cloud prepare'))
  await assert.rejects(c.service.prepareGenerationManifest(f.options), /素材当前设备不可用/)
  assert.equal(fs.existsSync(path.join(f.dataRoot, 'manifests', 'run_new_resume.json')), false)
})

test('large trusted resume scopes remain folder requests and frozen membership must match exactly', async t => {
  const f = fixture(t)
  // Adapter boundary: disk and identity verification are covered above; supply a large trusted result.
  const items = Array.from({ length: 101 }, (_, index) => ({ material_id: `mat_pinned_${index}`, asset_id: `asset_pinned_${index}`,
    asset_version: 1, source_sha256: createHash('sha256').update(`source${index}`).digest('hex'), local_path: f.raw }))
  f.options.shots[1].material_bindings = [{ binding_type: 'folder', folder_id: 'fld_local_pinned', include_subfolders: true }]
  f.original.shots[0].materials = items
  f.store.resumeMaterialShots = () => [{ shot_id: 'shot_second', materials: items }]
  f.store.folderChainForMaterial = () => [{ folderId: 'fld_local_pinned', name: 'Pinned', revision: 1 }]
  f.store.prepareGenerationManifestFromSnapshot = snapshot => ({ snapshot })
  const c = cloud(f)
  const result = await c.service.prepareGenerationManifest(f.options)
  const validation = c.requests.find(item => item.endpoint === '/v1/shot-material-validations')
  assert.deepEqual(validation.body.shots[1].material_bindings, [{ binding_type: 'folder', folder_id: 'fld_cloud_pinned', include_subfolders: true }])
  assert.equal(result.snapshot.shots[1].materials.length, 101)
  await assert.rejects(cloud(f, materials => [materials[0], ...materials.slice(0, -1)]).service.prepareGenerationManifest(f.options), /素材版本与原任务冻结记录不一致/)
})
